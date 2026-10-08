import { randomUUID } from 'node:crypto';
import type { ChatBackend, MailBridgeContext, MailBridgeResult, ParkRequest, SpawnAgentRequest } from '../backend/types';
import type {
  GeneratedImageRef,
  BackendEventEnvelope,
  MailApproval,
  MailComposeInput,
  MailConversation,
  MailListResult,
  Persona,
  TurnAttachment
} from '../../shared/types';
import { attachmentPreviews } from '../pi/attachments';
import * as activity from '../activity';
import { degrade } from '../degrade';
import { noteTurnStart } from '../live-turns';
import { getPersona, listPersonas } from '../workspace/personas';
import { agentId, agentName, agentPersona, agentSlug, isAgentId, isPinned, MAX_AGENTS, spawnableRoles } from './agents';
import {
  listPersonaNotes,
  personaOwnsMemory,
  savePersonaNote
} from '../workspace/persona-memory';
import { reflectOnDelivery } from './reflect';
import { captureStandingAnswer } from './standing-answers';
import { personaTurnFields } from '../workspace/persona-turn';
import { repoLocks } from './repo-lock';
import { attachScheduledWork, beginMailWork, type WorkHandle } from './work';
import { readSettings } from '../workspace/settings';
import { cleanMailSubject } from '../../shared/mail-subject';
import {
  addAgent,
  addParticipant,
  appendMailItem,
  settleMailApproval,
  CapError,
  createConversation,
  exchangeHops,
  readMail,
  setConversationSession,
  setConversationStatus,
  setConversationSubject,
  setMailItemResult
} from '../workspace/mail';
import {
  dropQueuedMail,
  queueMailForDevice,
  queuedMailConversationIds,
  queuedMailDeviceIds,
  takeQueuedMailForDevice
} from '../workspace/mail-device-queue';

// The mail router: the one place a MailItem turns into an agent turn and a
// settled turn turns back into a MailItem. Composing appends the user's item
// and delivers it to the conversation's driver persona; the delivery runs as a
// normal backend turn on the persona's hidden thread (worker-per-persona, mail
// preamble, nobody-watching exec semantics), and the turn's final assistant
// message is the reply mail — the implicit-reply rule, so a persona cannot
// swallow its result. Failures reply too: a mail that silently went nowhere is
// the one outcome the Inbox must not produce.
//
// Chains are asynchronous, turn-per-mail: a persona's send_mail (routed here as
// the mail bridge) appends the item and queues a delivery turn per persona
// recipient — the SENDING turn then just ends, its implicit reply suppressed
// because it already spoke. The chain terminates when a turn finishes without
// send_mail (implicit reply to whoever mailed it) or mails only the user. The
// exchange cap bounds one wave: each user send resets the counter (see
// workspace/mail.ts), and at the cap the next hop is forced back to the user.
//
// Fan-out: a turn that send_mails SEVERAL personas at once opens a join — the
// branches' deliveries run in parallel (up to WAVE_CONCURRENCY per
// conversation, same-persona deliveries kept serial), and their replies are
// buffered rather than each starting a sender turn: the sender's next turn is
// the assembly, one turn carrying every branch's reply, started when the last
// branch settles (replied, failed, answered the user directly, or timed out).
// The assembly's implicit reply routes to whoever initiated the fanning-out
// turn — typically the user — so an orchestrating persona splits, waits once,
// and answers once.
//
// One voice back: only the conversation's DRIVER (participants[0]) addresses
// the user. Another persona's send_mail to ["user"] is rerouted to the driver
// as material for its answer — the first real fan-out thread got three separate
// personas apologizing for the same mistake. The reroute yields to the exchange
// cap (at the cap the send falls through to the user — the runaway safety
// valve), and the router's own failure notices still reach the user directly:
// a mail that silently went nowhere stays the one forbidden outcome.
//
// Hub and spoke: the driver is also the only persona that may MAIL the others.
// A consulted persona can reply to whoever mailed it and nothing more — the
// same thread later had two coordinators independently briefing one worker
// with the same implementation task. Parallelism therefore only exists where
// the driver deliberately fans out; a spoke needing another spoke's input says
// so in its reply, and the driver arranges it.
//
// Agents (mail/agents.ts) are the other way work fans out: a persona with the
// spawn capability starts named instances of other personas with spawn_agent.
// An agent belongs to whoever started it — only that persona or agent mails
// it, and its reply goes back there — so a consulted coordinator runs its own
// workers and answers whoever consulted it once. Every send that reaches an
// agent opens (or widens) the sender's join, so agents started one call at a
// time in one turn still come back as one assembly. Agents live on the
// conversation, never in the persona registry.
//
// Stale replies: every delivery carries the userSentAt of the user mail its
// wave answers (the epoch), inherited hop to hop. A reply landing on the user
// after a NEWER user send is stamped stale — the user who has already moved on
// sees "answers your earlier message" instead of mistaking a slow branch's
// reply for the answer to their latest one. In-flight work is never aborted:
// a new user mail supersedes the old wave's replies, it does not kill them.
//
// Source context: alongside the epoch, every delivery carries the ID of the
// user mail that began its wave (sourceItemId — the item whose `at` the epoch
// is). A delivery to a NON-driver persona gets that mail's body injected into
// its preamble as quoted context, so the driver's send_mail body stays the
// short assignment and the spoke still reads the user's exact words — no
// restating, no paraphrase drift. The driver never gets the injection: its
// wave always began with the user mail delivered to it verbatim, and repeating
// it on every hop back (implicit replies, assemblies) would stack the same
// text into its thread once per hop.

/**
 * Parallel deliveries per conversation. Bounds how much of the worker pool one
 * conversation's fan-out can occupy — the pool itself (bound 6) still serves
 * interactive chats and scheduled runs first-come.
 */
const WAVE_CONCURRENCY = 3;

/** One queued delivery: a mail waiting for its persona's turn. */
interface DeliveryTask {
  personaId: string;
  body: string;
  from: string;
  /**
   * The userSentAt of the user mail this delivery's wave answers, inherited
   * hop to hop. A reply landing on the user after a newer user send compares
   * against this and is stamped stale.
   */
  epoch: number;
  /**
   * The id of the user MailItem that began this delivery's wave, inherited hop
   * to hop like the epoch (whose value is that item's `at`). A delivery to a
   * non-driver persona quotes the item's body in its preamble as source
   * context (see deliver()); the item ID, not the timestamp, is the wave's
   * unambiguous source reference.
   */
  sourceItemId: string;
  /**
   * Files riding this delivery's turn. Only user sends carry them — the
   * synthetic bodies (implicit-reply hops, join assemblies) never do.
   */
  attachments?: TurnAttachment[];
}

/**
 * A conversation's delivery lane: up to WAVE_CONCURRENCY deliveries run at
 * once, but never two for the same persona — a persona's hidden thread is one
 * session, and two concurrent turns on it would race the session bookkeeping.
 * `active` maps the running deliveries' persona ids to display names (blank
 * until the delivery resolves its persona) for the activity row.
 */
interface Lane {
  active: Map<string, string>;
  queue: DeliveryTask[];
}

/**
 * One open fan-out: the sender's branches and what they have answered so far.
 * In-memory like the delivery queue itself — a restart kills the wave, the
 * already-buffered replies survive as ordinary items, and the user nudges the
 * conversation with a reply.
 */
interface JoinState {
  senderId: string;
  /** Who initiated the fanning-out turn — where the assembly's reply routes. */
  initiator: string;
  /** The wave's epoch (see DeliveryTask.epoch) — the assembly turn inherits it. */
  epoch: number;
  /** The wave's source user item (see DeliveryTask.sourceItemId) — inherited by the assembly. */
  sourceItemId: string;
  /** Branch persona id -> display name, removed as each branch settles. */
  awaiting: Map<string, string>;
  buffered: { name: string; body: string; note?: string }[];
  /** Failures/detours, appended to the assembly mail. */
  notes: string[];
}

/** How a delivery's turn ended: ok, failed, or parked for the user's Allow/Deny. */
interface DeliverySettle {
  status: 'ok' | 'failed' | 'parked';
  error?: string;
  parked?: ParkRequest;
}

export interface MailRouterOptions {
  runtime: ChatBackend;
  /** Pushed to every client whenever mail changes (a delivery landed, etc.). */
  onChange: () => void;
  /**
   * Resolve a persona pin's device reference (id or label) to a paired
   * computer and whether it can run coding agents RIGHT NOW (connected, with
   * its consent switch on). Null when the reference names no usable target at
   * all (unpaired, ambiguous, a phone) — then the delivery runs normally and
   * coding_agent reports the problem itself. Absent in tests that don't care.
   */
  codingDevice?: (deviceRef: string) => Promise<{ deviceId: string; label: string; online: boolean } | null>;
  /**
   * Take the coding agent's own replies collected on a persona's hidden thread
   * since the last take (HarnessService.takeAgentReplies). A code persona's
   * reply mail carries them as `agentReplies`, so the user sees the relay and
   * its source side by side. Absent in tests that don't care.
   */
  agentReplies?: (threadId: string) => string[];
  /**
   * Take the pictures generate_image made on a thread since the last take
   * (PiRuntime.takeGeneratedImages): a persona's reply mail and a scheduled
   * run's mail carry them. Absent in tests that don't care.
   */
  generatedImages?: (threadId: string) => GeneratedImageRef[];
  /**
   * The user allowed a parked command: let exactly it run once on that thread
   * without the safety check (ExecService / HarnessService grantOnce). Absent
   * in tests that don't care.
   */
  grantOnce?: (
    kind: 'exec' | 'harness',
    threadId: string,
    grant: { command: string; cwd?: string | null; deviceId?: string | null }
  ) => void;
  /** Resume a scheduled run the user answered (the scheduler owns its threads). */
  resumeScheduledRun?: (taskId: string, threadId: string, body: string) => Promise<void>;
}

/**
 * What a conversation's status settles to once its deliveries drain. Ranked:
 * a failure outranks a hold on the user, which outranks a clean answer.
 */
type DrainStatus = 'idle' | 'awaiting-user' | 'failed';
const DRAIN_RANK: Record<DrainStatus, number> = { idle: 0, 'awaiting-user': 1, failed: 2 };

export class MailRouter {
  /** Per-conversation delivery lanes: bounded parallelism, same-persona serial. */
  private readonly lanes = new Map<string, Lane>();
  /** Open fan-outs, keyed `${conversationId}\n${senderId}`. */
  private readonly joins = new Map<string, JoinState>();
  /**
   * Who initiated each live delivery turn, keyed by turn id — the bridge reads
   * it to key a send_mail fan-out's join to the right initiator.
   */
  private readonly turnInitiators = new Map<string, string>();
  /** Each live delivery turn's epoch (see DeliveryTask.epoch), keyed by turn id. */
  private readonly turnEpochs = new Map<string, number>();
  /** Each live delivery turn's wave-source item id (see DeliveryTask.sourceItemId), keyed by turn id. */
  private readonly turnSources = new Map<string, string>();
  /** Threads with a delivery in flight — the mail-turn suppressions read this. */
  private readonly liveThreads = new Set<string>();
  /**
   * What each live delivery turn sent via the bridge, keyed by turn id. A turn
   * that sent anything gets no implicit reply.
   */
  private readonly turnMailSent = new Map<string, { persona: boolean; user: boolean }>();
  /** Deliveries queued or in flight per conversation — the status authority. */
  private readonly pending = new Map<string, number>();
  /** The status to write when a conversation's deliveries drain (default idle). */
  private readonly drainStatus = new Map<string, DrainStatus>();
  /**
   * One background-activity row per working conversation, labeled by its
   * subject and counting the turns of the wave — mail otherwise works entirely
   * out of sight, and invisible agent turns were exactly what the activity
   * popover exists to show. Closed when the conversation's deliveries drain.
   */
  private readonly activityRows = new Map<string, { handle: activity.ActivityHandle; turns: number }>();
  /** Turns currently delivering, by turn id — what stopConversation interrupts. */
  private readonly activeTurns = new Map<string, { conversationId: string }>();
  /**
   * Conversations mid-stop: their aborted turns settle without failure notices
   * (the user who pressed Stop is the one reader a "run failed" mail would
   * tell nothing). Cleared when the last delivery drains.
   */
  private readonly stopping = new Set<string>();

  constructor(private readonly opts: MailRouterOptions) {}

  /**
   * Whether a live delivery owns this thread right now. The turn-finished phone
   * push reads it: a mail turn's ending is not "your answer is ready" — the
   * reply mail is the news, and it lands via mail:changed. In-memory on purpose
   * (deliveries never survive a restart, so neither must this).
   */
  ownsThread(threadId: string): boolean {
    return this.liveThreads.has(threadId);
  }

  /** Compose a new conversation and deliver the first mail to its driver. */
  async compose(input: MailComposeInput): Promise<MailListResult> {
    const to = [...new Set(input.to.filter((id) => id.trim()))];
    if (!to.length) to.push('normal'); // the built-in default addressee
    const personas = await Promise.all(to.map((id) => getPersona(id)));
    const missing = to.filter((_, i) => !personas[i]);
    if (missing.length) throw new Error(`No such persona: ${missing.join(', ')}.`);
    const body = input.body.trim();
    const attachments = input.attachments?.length ? input.attachments : undefined;
    if (!body && !attachments) throw new Error('Write the mail before sending it.');

    const conversation = await createConversation(input.subject ?? '', to, body, { private: input.private === true });
    const result = await appendMailItem({
      conversationId: conversation.id,
      from: 'user',
      to,
      body,
      ...(attachments ? { attachments: await attachmentPreviews(attachments) } : {})
    });
    // The appended user item IS the wave: its timestamp is the epoch every
    // delivery inherits, its id the wave's source reference.
    const source = result.items[result.items.length - 1];
    this.enqueueDelivery(conversation.id, to[0], body, 'user', source.at, source.id, attachments);
    return result;
  }

  /** Reply into a conversation: appends the user's item, resumes the driver. */
  async reply(
    conversationId: string,
    body: string,
    attachments?: TurnAttachment[]
  ): Promise<MailListResult> {
    const trimmed = body.trim();
    const files = attachments?.length ? attachments : undefined;
    if (!trimmed && !files) throw new Error('Write the reply before sending it.');
    const { conversations, items } = await readMail();
    const conversation = conversations.find((c) => c.id === conversationId);
    if (!conversation) throw new Error('That mail conversation no longer exists.');
    const driver = conversation.participants[0];
    // A code persona's driver just relayed the agent's question and this is
    // the answer: keep it as a standing answer (never in a private
    // conversation — nothing there is captured).
    if (!conversation.private) {
      const persona = await getPersona(driver);
      if (persona?.harness) {
        await captureStandingAnswer({
          persona,
          items: items.filter((i) => i.conversationId === conversationId).sort((a, b) => a.at - b.at),
          reply: trimmed
        });
      }
    }
    const result = await appendMailItem({
      conversationId,
      from: 'user',
      to: conversation.participants,
      body: trimmed,
      ...(files ? { attachments: await attachmentPreviews(files) } : {})
    });
    const source = result.items[result.items.length - 1];
    // A run parked for the user's Allow/Deny that they answered with a mail
    // instead: the mail goes to the parked persona, on its own thread, with a
    // note that its request went unanswered — the user's new words reach the
    // safety check from there. The driver gets it only when nothing is parked.
    const parked = await this.supersedeParks(conversationId);
    if (parked.length) {
      for (const park of parked) {
        const note =
          `[Stem] Your request to run \`${park.command}\` was not answered; the user wrote this instead. ` +
          'If it settles the question, act on it; otherwise carry on without that command.';
        this.enqueueDelivery(
          conversationId,
          park.resume.personaId,
          `${note}\n\n${trimmed}`,
          park.resume.from,
          source.at,
          park.resume.sourceItemId || source.id,
          files
        );
      }
      return result;
    }
    this.enqueueDelivery(conversationId, driver, trimmed, 'user', source.at, source.id, files);
    return result;
  }

  /**
   * The user's answer to a parked run (an approval item's Allow/Deny). Settles
   * the item once — a second answer finds it settled and is refused — then
   * resumes the persona's own thread: an allowed command may run exactly once
   * without the safety check, a denied one is reported as the user's no.
   */
  async resolveApproval(itemId: string, decision: 'allow' | 'deny'): Promise<{ ok: boolean; error?: string }> {
    const approval = await settleMailApproval(itemId, decision === 'allow' ? 'allowed' : 'denied');
    if (!approval) return { ok: false, error: 'That approval was already answered.' };
    const { conversations, items } = await readMail();
    const item = items.find((i) => i.id === itemId);
    const conversation = conversations.find((c) => c.id === item?.conversationId);
    if (!item || !conversation) return { ok: false, error: 'That mail conversation no longer exists.' };
    const r = approval.resume;
    // Exactly what the user saw: the command, in that folder, on that machine.
    if (decision === 'allow') {
      this.opts.grantOnce?.(approval.kind, r.threadId, {
        command: approval.command,
        cwd: approval.cwd ?? null,
        deviceId: r.deviceId ?? null
      });
    }
    const body =
      decision === 'allow'
        ? `[Stem] The user allowed \`${approval.command}\`. Run it now, exactly as before, and carry on with the task.`
        : `[Stem] The user denied \`${approval.command}\`. Carry on without it, and do not reach the same effect another way.`;
    if (r.taskId) {
      if (!this.opts.resumeScheduledRun) return { ok: false, error: 'Scheduled runs cannot be resumed here.' };
      await this.opts.resumeScheduledRun(r.taskId, r.threadId, body);
    } else {
      this.enqueueDelivery(conversation.id, r.personaId, body, r.from, r.epoch, r.sourceItemId);
    }
    this.opts.onChange();
    return { ok: true };
  }

  /** Mark this conversation's pending approvals superseded; returns them as they were. */
  private async supersedeParks(conversationId: string, status: 'superseded' | 'cancelled' = 'superseded'): Promise<MailApproval[]> {
    const { items } = await readMail();
    const pending = items.filter((i) => i.conversationId === conversationId && i.approval?.status === 'pending');
    const settled: MailApproval[] = [];
    for (const item of pending) {
      const approval = await settleMailApproval(item.id, status);
      if (approval) settled.push(approval);
    }
    return settled;
  }

  /**
   * Hold a delivery whose run parked: append the approval item to the user and
   * leave the wave's join untouched, so the resumed turn settles the branch
   * the ordinary way. The conversation drains as awaiting the user.
   */
  private async parkDelivery(p: {
    conversationId: string;
    personaId: string;
    threadId: string;
    from: string;
    epoch: number;
    sourceItemId: string;
    request: ParkRequest;
  }): Promise<void> {
    const name = await this.personaName(p.personaId);
    const where = p.request.deviceLabel ? ` on ${p.request.deviceLabel}` : '';
    await appendMailItem({
      conversationId: p.conversationId,
      from: p.personaId,
      to: ['user'],
      body:
        `${name} paused this task: Stem's safety check would not run a command${where} without you. ` +
        'Allow it to let the task continue, or deny it.',
      approval: {
        id: randomUUID(),
        kind: p.request.kind,
        command: p.request.command,
        ...(p.request.cwd ? { cwd: p.request.cwd } : {}),
        ...(p.request.deviceLabel ? { deviceLabel: p.request.deviceLabel } : {}),
        ...(p.request.reason ? { reason: p.request.reason } : {}),
        status: 'pending',
        resume: {
          personaId: p.personaId,
          threadId: p.threadId,
          from: p.from,
          epoch: p.epoch,
          sourceItemId: p.sourceItemId,
          ...(p.request.deviceId ? { deviceId: p.request.deviceId } : {})
        }
      }
    });
    const current = this.drainStatus.get(p.conversationId) ?? 'idle';
    if (DRAIN_RANK['awaiting-user'] > DRAIN_RANK[current]) this.drainStatus.set(p.conversationId, 'awaiting-user');
    this.opts.onChange();
  }

  /**
   * Boot-time redelivery. A server restart (deploy, crash) takes any delivery
   * in flight down with the process, and a process death writes no failure
   * mail — before this pass, the user's send just sat unanswered forever with
   * nothing in the Inbox to say so. On startup, redeliver the latest user mail
   * of every conversation where the user spoke last and nothing has addressed
   * them since (userSentAt > userUpdatedAt): the redelivery resumes the
   * persona's existing hidden thread, so whatever the killed turn already did
   * is context, not loss. Skips aborted conversations (Stop was the user's
   * answer) and any conversation this router already has deliveries for (a
   * user reply can race the boot pass). Attachment bytes never persist, so a
   * redelivered mail rides without them — the placeholder body for an
   * attachment-only mail says exactly that.
   */
  async recoverDroppedDeliveries(): Promise<number> {
    const { conversations, items } = await readMail();
    // Conversations already waiting for a paired computer have their own
    // recovery channel (flushDeviceQueue) — redelivering them here would just
    // trip the offline hold again and write a duplicate notice.
    const waiting = await queuedMailConversationIds();
    let recovered = 0;
    for (const conversation of conversations) {
      if (conversation.status === 'aborted') continue;
      if (conversation.userSentAt <= conversation.userUpdatedAt) continue;
      if (this.pending.has(conversation.id)) continue;
      if (waiting.has(conversation.id)) continue;
      const driver = conversation.participants[0];
      if (!driver) continue;
      const mail = items.filter((i) => i.conversationId === conversation.id && i.from === 'user').at(-1);
      if (!mail) continue;
      const body =
        mail.body.trim() ||
        '(This mail carried only attachments; a server restart lost their contents before delivery. Ask the user to resend them.)';
      this.enqueueDelivery(conversation.id, driver, body, 'user', mail.at, mail.id);
      recovered++;
    }
    return recovered;
  }

  /**
   * A paired computer announced it runs coding agents: deliver the mail that
   * was waiting for it (deliveries held by the offline hold in deliver()).
   * Re-derives each conversation's latest user item from the store — the wait
   * entry records only THAT a wait exists — and inherits boot redelivery's
   * guards: conversations with deliveries already in flight, aborted ones, and
   * deleted ones are skipped, their wait entries consumed.
   */
  async flushDeviceQueue(deviceId: string): Promise<number> {
    const entries = await takeQueuedMailForDevice(deviceId);
    if (!entries.length) return 0;
    const { conversations, items } = await readMail();
    let flushed = 0;
    for (const entry of entries) {
      if (this.pending.has(entry.conversationId)) continue;
      const conversation = conversations.find((c) => c.id === entry.conversationId);
      if (!conversation || conversation.status === 'aborted') continue;
      const mail = items.filter((i) => i.conversationId === entry.conversationId && i.from === 'user').at(-1);
      if (!mail) continue;
      const body =
        mail.body.trim() ||
        '(This mail carried only attachments; their contents were lost while it waited for your computer. Ask the user to resend them.)';
      this.enqueueDelivery(entry.conversationId, entry.personaId, body, 'user', mail.at, mail.id);
      flushed++;
    }
    return flushed;
  }

  /**
   * Boot sweep over the persisted waits: a device that is ALREADY online (it
   * announced before this process was ready, or while the server was down its
   * wait became satisfiable) would otherwise hold its mail until the next
   * reconnect re-announced it.
   */
  async flushDeviceQueuesAtBoot(): Promise<number> {
    if (!this.opts.codingDevice) return 0;
    let flushed = 0;
    for (const deviceId of await queuedMailDeviceIds()) {
      // quiet: an unresolvable device just stays queued — the announce that
      // eventually names it is the flush that matters.
      const device = await this.opts.codingDevice(deviceId).catch(() => null);
      if (device?.online) flushed += await this.flushDeviceQueue(deviceId);
    }
    return flushed;
  }

  /**
   * The user pulling a persona into an existing conversation (the header's
   * add control, so no capability gate). The persona joins the participant
   * set and becomes reachable by send_mail and addressed by future replies; it
   * gets no turn of its own until someone mails it.
   */
  async addParticipant(conversationId: string, personaId: string): Promise<MailListResult> {
    const persona = await getPersona(personaId);
    if (!persona) throw new Error(`No persona "${personaId}" exists.`);
    const result = await addParticipant(conversationId, persona.id);
    this.opts.onChange();
    return result;
  }

  /**
   * The user's Stop control: drop this conversation's queued deliveries,
   * interrupt its running turns, and tear down its open joins so no assembly
   * fires later. The interrupted turns settle as aborted and drain into the
   * 'aborted' status — visible in the Inbox, but without failure notices,
   * because the stop IS the outcome the user asked for. Answers
   * `stopped: false` when nothing was in flight.
   */
  async stopConversation(conversationId: string): Promise<{ stopped: boolean }> {
    const lane = this.lanes.get(conversationId);
    const active = [...this.activeTurns].filter(([, t]) => t.conversationId === conversationId);
    const queued = lane?.queue.length ?? 0;
    // A conversation waiting for an offline computer has nothing running, but
    // the persisted wait IS something to stop — dropped here so the device
    // coming back does not deliver a mail the user withdrew.
    // quiet: an unwritable queue store leaves the wait standing, and the stop
    // still reports honestly on what it could reach below.
    const waitDropped = await dropQueuedMail(conversationId).catch(() => false);
    // A parked run is stopped by cancelling its approval: nothing resumes it.
    // quiet: an unwritable store leaves the approval answerable; the stop still reports on the rest.
    const parksCancelled = (await this.supersedeParks(conversationId, 'cancelled').catch(() => [])).length > 0;
    if (!active.length && !queued && !waitDropped && !parksCancelled) return { stopped: false };
    this.stopping.add(conversationId);
    if (lane && queued) {
      // Dropped tasks never reach deliver(), so their pending counts settle here.
      lane.queue.length = 0;
      const left = (this.pending.get(conversationId) ?? queued) - queued;
      if (left > 0) this.pending.set(conversationId, left);
      else this.pending.delete(conversationId);
    }
    for (const key of [...this.joins.keys()]) {
      if (key.startsWith(`${conversationId}\n`)) this.joins.delete(key);
    }
    await Promise.all(
      active.map(([turnId]) =>
        this.opts.runtime.interruptTurn(turnId).catch((err) => {
          degrade('mail', 'left a stopped delivery running', err);
        })
      )
    );
    if (!active.length) {
      // Nothing running to settle later (queued-only, a shape restarts can
      // leave): drain here so the status and the activity row never wedge.
      this.pending.delete(conversationId);
      this.stopping.delete(conversationId);
      const row = this.activityRows.get(conversationId);
      if (row) {
        this.activityRows.delete(conversationId);
        activity.end(row.handle, {
          worked: true,
          detail: `stopped after ${row.turns} turn${row.turns === 1 ? '' : 's'}`
        });
      }
      this.drainStatus.delete(conversationId);
      await setConversationStatus(conversationId, 'aborted').catch(() => {
        // quiet: a deleted conversation has no row left for a status to show on.
      });
    }
    this.updateActivityDetail(conversationId);
    this.opts.onChange();
    return { stopped: true };
  }

  /**
   * Deliver a mail produced by a scheduled run (`notify_user` under
   * schedule-as-mail): appended as from its persona (or the task itself),
   * addressed to the user — no agent turn runs, the run already did the work.
   */
  async deliverTaskMail(input: {
    /** The thread's subject when this firing opens it: the notify title, else the task's title. */
    subject: string;
    body: string;
    taskId: string;
    personaId?: string;
    /**
     * The run's own fresh thread. Recorded on the item as `runThreadId`, which
     * is what keeps that thread alive (and hidden) once the run ends — the Work
     * beneath the mail is recovered from it.
     */
    threadId?: string;
    /**
     * The notify_user title, when the run gave one: kept on the item as this
     * firing's own headline, and the thread is retitled after it so the Inbox
     * row reads the newest headline rather than the one the task opened with.
     */
    headline?: string;
    /** Pictures to carry; absent = whatever the run's thread made since the last take. */
    images?: GeneratedImageRef[];
    /** A parked run: the item carries its Allow/Deny, answered by resolveApproval. */
    park?: ParkRequest;
  }): Promise<string> {
    // One conversation per task, found by the task id on its items; created on
    // the first notify. Keeps every firing of a watch task in one thread of mail.
    const { conversations, items } = await readMail();
    const existing = items.find((i) => i.taskId === input.taskId);
    const conversation = existing
      ? conversations.find((c) => c.id === existing.conversationId)
      : undefined;
    const from = input.personaId ?? `task:${input.taskId}`;
    const headline = input.headline ? cleanMailSubject(input.headline) : '';
    const target =
      conversation ?? (await createConversation(input.subject, [input.personaId ?? 'normal'], input.body));
    if (conversation && headline && headline !== conversation.subject) {
      await setConversationSubject(conversation.id, headline);
    }
    const delivered = await appendMailItem({
      conversationId: target.id,
      from,
      to: ['user'],
      body: input.body,
      taskId: input.taskId,
      ...(input.threadId ? { runThreadId: input.threadId } : {}),
      ...(headline ? { subject: headline } : {}),
      // Pictures the run made before this notify go with it; later ones join
      // the result (attachTaskResult).
      ...(input.images?.length ? { images: input.images } : this.imagesField(input.threadId)),
      ...(input.park && input.threadId
        ? {
            approval: {
              id: randomUUID(),
              kind: input.park.kind,
              command: input.park.command,
              ...(input.park.cwd ? { cwd: input.park.cwd } : {}),
              ...(input.park.deviceLabel ? { deviceLabel: input.park.deviceLabel } : {}),
              ...(input.park.reason ? { reason: input.park.reason } : {}),
              status: 'pending' as const,
              resume: {
                personaId: input.personaId ?? 'normal',
                threadId: input.threadId,
                from: 'user',
                epoch: Date.now(),
                sourceItemId: '',
                taskId: input.taskId,
                ...(input.park.deviceId ? { deviceId: input.park.deviceId } : {})
              }
            }
          }
        : {})
    });
    const notification = delivered.items.at(-1);
    if (input.threadId && notification) await attachScheduledWork(input.threadId, target.id, notification.id, from);
    this.opts.onChange();
    return target.id;
  }

  /**
   * The run behind a scheduled notification settled with a reply: attach it to
   * the mail, so the report or drafts its short notify line pointed at are in
   * the Inbox, not only in the run's chat.
   */
  async attachTaskResult(input: { itemId: string; result: string; threadId?: string }): Promise<void> {
    const images = input.threadId ? (this.opts.generatedImages?.(input.threadId) ?? []) : [];
    if (!input.result && !images.length) return;
    await setMailItemResult(input.itemId, input.result, images);
    this.opts.onChange();
  }

  // ---- the mail bridge (send_mail / spawn_agent from inside a delivery turn) ----

  /**
   * send_mail: append the item and queue a delivery turn per persona recipient.
   * Recipients are validated against the conversation's LIVE participants and
   * agents (spawn_agent may have added one this very turn); the cap is checked fresh
   * per call, and at the cap a persona-addressed send is refused with
   * instructions to return to the user instead.
   */
  async bridgeSend(req: { to: string[]; body: string }, ctx: MailBridgeContext): Promise<MailBridgeResult> {
    const to = [...new Set(req.to.map((t) => t.trim()).filter(Boolean))];
    if (!to.length) return { ok: false, error: 'Give send_mail at least one recipient.' };
    const body = req.body.trim();
    if (!body) return { ok: false, error: 'Give send_mail a body.' };
    const { conversations, items } = await readMail();
    const conversation = conversations.find((c) => c.id === ctx.conversationId);
    if (!conversation) return { ok: false, error: 'This mail conversation no longer exists.' };
    if (to.includes(ctx.personaId)) return { ok: false, error: 'You cannot mail yourself.' };
    const agents = conversation.agents ?? [];
    const reachable = new Set([...conversation.participants, ...agents.map((a) => a.id), 'user']);
    const bad = to.filter((t) => !reachable.has(t));
    if (bad.length) {
      return {
        ok: false,
        error:
          `Not reachable from this conversation: ${bad.join(', ')}. ` +
          `Recipients must be its participants (${conversation.participants.join(', ')}), agents you started, or "user".`
      };
    }
    // Hub and spoke: only the driver (participants[0]) coordinates. A consulted
    // persona may reply to whoever mailed it — nothing else — so one job can
    // never be briefed twice by two coordinators, and parallel branches exist
    // only where the driver deliberately fanned out.
    //
    // Agents sit beside that rule: each belongs to whoever started it, and
    // only its starter mails it — the driver included, for agents a consulted
    // persona started — so one job still has exactly one coordinator.
    const driverId = conversation.participants[0];
    const initiator = this.turnInitiators.get(ctx.turnId) ?? 'user';
    const caller = await this.resolveMember(conversation, ctx.personaId);
    const own = new Set(agents.filter((a) => a.spawnedBy === ctx.personaId).map((a) => a.id));
    const othersAgents = to.filter((t) => isAgentId(t) && !own.has(t) && t !== initiator);
    if (othersAgents.length) {
      return {
        ok: false,
        error:
          `${othersAgents.join(', ')} ${othersAgents.length === 1 ? 'was' : 'were'} started by another persona, ` +
          'and only whoever starts an agent mails it. Mail your own agents, or say in your reply what you need.'
      };
    }
    if (ctx.personaId !== driverId) {
      const disallowed = to.filter((t) => t !== 'user' && t !== initiator && !own.has(t));
      if (disallowed.length) {
        return {
          ok: false,
          error:
            `Only the driver (${driverId}) mails the personas in this conversation; you may mail agents you ` +
            `started yourself. You can reply to ` +
            `${initiator === 'user' ? 'the user' : initiator} — send_mail, or just finish your turn — and if ` +
            `${disallowed.join(', ')} should be involved, say so in that reply so the driver can arrange it.`
        };
      }
    }
    // One voice back: only the driver addresses the user. Another persona's
    // user-mail is rerouted to the driver — material for THE answer — unless
    // the extra hop would overflow the exchange cap, where the send falls
    // through to the user (the existing runaway safety valve).
    const epoch = this.turnEpochs.get(ctx.turnId) ?? conversation.userSentAt;
    // Belt-and-braces like the epoch fallback above: a live bridge call always
    // finds its turn's entry, but if it ever doesn't, the newest user item is
    // the least-wrong source — never an empty identity that drops injection.
    const sourceItemId =
      this.turnSources.get(ctx.turnId) ??
      [...items].reverse().find((i) => i.conversationId === ctx.conversationId && i.from === 'user')?.id ??
      '';
    let finalTo = to;
    let rerouted = false;
    if (to.includes('user') && ctx.personaId !== driverId) {
      const swapped = [...new Set(to.map((t) => (t === 'user' ? driverId : t)))];
      if (conversation.exchangeCount + swapped.length <= (await this.exchangeCap())) {
        finalTo = swapped;
        rerouted = true;
      }
    }
    // A pure answer-the-user send that got rerouted is exempt from the sender's
    // budget, like an implicit reply: finishing must always be possible.
    const rerouteOnly = rerouted && to.every((t) => t === 'user');
    const personaTo = finalTo.filter((t) => t !== 'user');
    const capRefusal =
      'The inter-persona exchange cap for this conversation is used up. Write your result for the ' +
      'user instead — send_mail to ["user"], or just finish your reply.';
    const budgetRefusal =
      'Your persona’s send budget for this wave is used up. Finish your assignment — your final ' +
      'reply goes to whoever mailed you — or send_mail to ["user"].';
    if (personaTo.length) {
      const cap = await this.exchangeCap();
      if (conversation.exchangeCount + exchangeHops(conversation, ctx.personaId, personaTo) > cap) {
        return { ok: false, error: capRefusal };
      }
      const budget = caller?.sendBudget;
      if (budget !== undefined && !rerouteOnly) {
        const spent = conversation.sendCounts[ctx.personaId] ?? 0;
        if (spent + personaTo.length > budget) return { ok: false, error: budgetRefusal };
      }
    }
    try {
      await appendMailItem({
        conversationId: ctx.conversationId,
        from: ctx.personaId,
        to: finalTo,
        body,
        ...this.agentRepliesField(conversation.sessions[ctx.personaId]),
        guard: {
          exchangeCap: await this.exchangeCap(),
          ...(caller?.sendBudget !== undefined ? { senderBudget: caller.sendBudget } : {}),
          ...(rerouteOnly ? { budgetExempt: true } : {})
        },
        ...(finalTo.includes('user') ? { staleIfUserSentAfter: epoch } : {})
      });
    } catch (error) {
      // With deliveries running in parallel, a racing send can pass the
      // pre-check above and lose here — the store's guard is the authority.
      if (error instanceof CapError) {
        return { ok: false, error: error.kind === 'budget' ? budgetRefusal : capRefusal };
      }
      throw error;
    }
    const sent = this.turnMailSent.get(ctx.turnId) ?? { persona: false, user: false };
    if (personaTo.length) sent.persona = true;
    if (finalTo.includes('user')) sent.user = true;
    this.turnMailSent.set(ctx.turnId, sent);

    // A user-only send from an awaited branch ends that branch: its turn gets
    // no implicit reply, so nothing later can settle it.
    if (!personaTo.length) {
      const join = initiator !== 'user' ? this.joinFor(ctx.conversationId, initiator) : undefined;
      const name = join?.awaiting.get(ctx.personaId);
      if (join && name !== undefined) {
        join.awaiting.delete(ctx.personaId);
        join.notes.push(`${name} answered you nothing and mailed the user directly.`);
        this.maybeAssemble(ctx.conversationId, join);
      }
    }
    // Persona recipients: a recipient mid-fan-out must not get a turn before
    // its assembly, so mail addressed to an open join's sender is buffered into
    // that join instead of delivered — a branch's explicit reply settles its
    // branch, anything else rides along labeled for what it is.
    const delivered: string[] = [];
    for (const recipient of personaTo) {
      const join = this.joinFor(ctx.conversationId, recipient);
      if (join) {
        const name = join.awaiting.get(ctx.personaId);
        const senderName = name ?? (await this.personaName(ctx.personaId));
        join.buffered.push({
          name: senderName,
          body,
          ...(name === undefined ? { note: 'not a delegation reply' } : {})
        });
        if (name !== undefined) {
          join.awaiting.delete(ctx.personaId);
          this.maybeAssemble(ctx.conversationId, join);
        }
        continue;
      }
      delivered.push(recipient);
      this.enqueueDelivery(ctx.conversationId, recipient, body, ctx.personaId, epoch, sourceItemId);
    }
    // Fanning out — two or more deliveries from one send, or any send to an
    // agent — opens (or widens) this sender's join: the replies come back as
    // one assembly turn. Agents always join because spawn_agent starts them one
    // call at a time; without it, a lead starting three reviewers in one turn
    // would get three separate reply turns instead of one.
    if (
      delivered.length >= 2 ||
      (delivered.length >= 1 && this.joinFor(ctx.conversationId, ctx.personaId)) ||
      delivered.some(isAgentId)
    ) {
      await this.openJoin(ctx.conversationId, ctx.personaId, initiator, epoch, sourceItemId, delivered);
    }
    this.updateActivityDetail(ctx.conversationId);
    this.opts.onChange();
    return {
      ok: true,
      text:
        `Mail sent to ${finalTo.join(', ')}.` +
        (rerouted
          ? ` Only the driver (${driverId}) answers the user directly, so your user-mail was routed there.`
          : '') +
        (personaTo.length ? ' Their reply will arrive as a later mail — finish your turn now.' : '')
    };
  }

  /**
   * spawn_agent: start a named agent — an instance of an existing persona —
   * in this conversation and hand it its brief. Gated by the caller's canSpawn
   * (an agent's own canSpawn already folds in the depth limit, see
   * agentPersona). The brief goes out through bridgeSend, so the caps, the
   * one-coordinator rule and the join all apply exactly as to any send.
   */
  async bridgeSpawn(req: SpawnAgentRequest, ctx: MailBridgeContext): Promise<MailBridgeResult> {
    const brief = req.brief?.trim();
    if (!brief) return { ok: false, error: 'Give spawn_agent a brief: the piece of work this agent should do.' };
    const { conversations } = await readMail();
    const conversation = conversations.find((c) => c.id === ctx.conversationId);
    if (!conversation) return { ok: false, error: 'This mail conversation no longer exists.' };
    const caller = await this.resolveMember(conversation, ctx.personaId);
    if (!caller?.canSpawn) {
      return {
        ok: false,
        error: isAgentId(ctx.personaId)
          ? 'An agent started by an agent cannot start agents of its own. Do the work yourself, or say in your reply what else is needed.'
          : 'Your persona cannot start agents — the user grants that per persona in the Personas tab. Do the work ' +
            'yourself, or say in your reply who should help.'
      };
    }
    const wanted = req.role?.trim() ?? '';
    const personas = await listPersonas();
    const role =
      personas.find((p) => p.id === wanted) ??
      personas.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
    if (!role) {
      return {
        ok: false,
        error:
          `${wanted ? `No persona "${wanted}" exists` : 'Give spawn_agent a role'}. Roles are the existing ` +
          `personas: ${personas.map((p) => `${p.name} (${p.id})`).join(', ')}.`
      };
    }
    // A persona pinned to the user's computer (coding agent, screen, browser)
    // carries a grant the user made for it alone. Starting it as an agent is
    // allowed only in a conversation the user put it in — otherwise any
    // persona that can start agents could run code or drive the screen on the
    // user's Mac.
    if (isPinned(role) && !conversation.participants.includes(role.id)) {
      return {
        ok: false,
        error:
          `${role.name} works on the user's computer, so only the user can bring it into a conversation, and it ` +
          'is not in this one. Tell the user it should take this part (they can add it to the conversation or ' +
          'mail it), or do the work without it.'
      };
    }
    const name = agentSlug(req.name ?? '');
    if (!name) return { ok: false, error: 'Give the agent a short name (letters, digits, dashes), like reviewer-a.' };
    const id = agentId(role.id, name);
    // Early, friendly refusals from this read; addAgent re-checks the name and
    // the limit inside its write, where a racing spawn cannot slip past.
    const agents = conversation.agents ?? [];
    const taken = agents.find((a) => a.name === name);
    if (taken) {
      return {
        ok: false,
        error:
          taken.id === id && taken.spawnedBy === ctx.personaId
            ? `${name} is already running here. Continue it with send_mail to "${id}" instead of starting it again.`
            : `An agent named ${name} already exists in this conversation. Pick another name.`
      };
    }
    if (agents.length >= MAX_AGENTS) {
      const yours = agents.filter((a) => a.spawnedBy === ctx.personaId).map((a) => a.id);
      return {
        ok: false,
        error:
          `This conversation already has ${MAX_AGENTS} agents, the most it may have.` +
          (yours.length ? ` Continue one of yours with send_mail: ${yours.join(', ')}.` : ' Do the rest of the work yourself.')
      };
    }
    // A recall-off caller (a blind reviewer that may spawn) only starts blind
    // agents: it must not reach the user's history through one.
    const blind = req.blind === true || caller.recall === false;
    try {
      await addAgent(
        conversation.id,
        { id, role: role.id, name, spawnedBy: ctx.personaId, ...(blind ? { blind: true } : {}) },
        MAX_AGENTS
      );
    } catch (error) {
      // quiet: the tool result IS the error channel (a racing spawn took the name or the last slot).
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const sent = await this.bridgeSend({ to: [id], body: brief }, ctx);
    if (!sent.ok) return { ok: false, error: `${name} was created but its brief was not sent: ${sent.error}` };
    this.opts.onChange();
    return {
      ok: true,
      text:
        `Started ${name} (${role.name}${blind ? ', blind' : ''}) as "${id}". Its reply comes back to you together ` +
        'with every other agent you start in this turn — start them all now, then finish your turn.'
    };
  }

  /**
   * remember_note: the calling persona saves one lesson into its OWN memory
   * store — the payload names no persona, so nothing can write elsewhere.
   * Refused for agents and personas without a store: an agent is one job's
   * worker, and the refusal says where a lasting lesson should go instead.
   */
  async bridgeRememberNote(
    req: { title?: string; body?: string },
    ctx: MailBridgeContext
  ): Promise<MailBridgeResult> {
    if (isAgentId(ctx.personaId)) {
      return {
        ok: false,
        error:
          'You are an agent started for one job and keep no memory. If this lesson should outlive the job, ' +
          'put it in your reply so whoever started you can keep it.'
      };
    }
    const caller = await getPersona(ctx.personaId);
    if (!caller) return { ok: false, error: 'Your persona no longer exists.' };
    if (!personaOwnsMemory(caller)) {
      return {
        ok: false,
        error:
          'Your persona keeps no private memory — it is switched off for this persona. If the lesson ' +
          'matters, put it in your reply instead.'
      };
    }
    const body = req.body?.trim();
    if (!body) return { ok: false, error: 'Give remember_note a body.' };
    try {
      const note = await savePersonaNote(caller.id, { title: req.title, body }, 'tool');
      return { ok: true, text: `Noted (${note.id}: ${note.title}). It will be in your index from your next mail.` };
    } catch (error) {
      // quiet: the tool result IS the error channel — the calling persona gets
      // the store's refusal (full store, unreadable file) verbatim and reacts.
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** read_notes: full bodies from the calling persona's own store, by note id. */
  async bridgeReadNotes(ids: string[], ctx: MailBridgeContext): Promise<MailBridgeResult> {
    if (isAgentId(ctx.personaId)) return { ok: false, error: 'You are an agent started for one job and keep no memory.' };
    const caller = await getPersona(ctx.personaId);
    if (!caller) return { ok: false, error: 'Your persona no longer exists.' };
    if (!personaOwnsMemory(caller)) {
      return { ok: false, error: 'Your persona keeps no private memory — it is switched off for this persona.' };
    }
    const wanted = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 10);
    if (!wanted.length) return { ok: false, error: 'Give read_notes at least one note id from your index.' };
    const notes = await listPersonaNotes(caller.id);
    const sections: string[] = [];
    const missing: string[] = [];
    for (const id of wanted) {
      const note = notes.find((n) => n.id === id);
      if (note) sections.push(`--- ${note.id} · ${note.title} ---\n${note.body}`);
      else missing.push(id);
    }
    if (!sections.length) return { ok: false, error: `No such note: ${missing.join(', ')}.` };
    return {
      ok: true,
      text:
        sections.join('\n\n') + (missing.length ? `\n\n(No such note: ${missing.join(', ')}.)` : '')
    };
  }

  /**
   * A participant or agent of this conversation, as the persona row its turns
   * run with: a participant is its registry row; an agent is its role's row
   * under the agent's id and name, bounded by its starter (agentPersona) —
   * both resolved fresh, so an editor change applies from the next mail.
   * Null when the agent can no longer run: its role or starter is gone, or
   * its role has since been pinned to the user's computer without being in
   * this conversation (the same rule spawn_agent applies at start).
   */
  private async resolveMember(conversation: MailConversation | undefined, id: string, depth = 0): Promise<Persona | null> {
    if (!isAgentId(id)) return getPersona(id);
    const agent = conversation?.agents?.find((a) => a.id === id);
    // Agents nest two deep; anything deeper is a corrupt record, not a chain to follow.
    if (!conversation || !agent || depth > 2) return null;
    const role = await getPersona(agent.role);
    if (!role || (isPinned(role) && !conversation.participants.includes(role.id))) return null;
    const starter = await this.resolveMember(conversation, agent.spawnedBy, depth + 1);
    return starter ? agentPersona(role, agent, starter) : null;
  }

  private async personaName(personaId: string): Promise<string> {
    if (isAgentId(personaId)) return agentName(personaId);
    return (await getPersona(personaId))?.name ?? personaId;
  }

  // ---- delivery internals ----

  /** The cap, read fresh per decision — a settings change applies to the very next hop. */
  private async exchangeCap(): Promise<number> {
    // quiet: readSettings answers with defaults and degrades itself rather than
    // rejecting; the fallback keeps the guard working even if it ever does.
    return (await readSettings().catch(() => null))?.mail.exchangeCap ?? 10;
  }

  /** Queue one delivery on the conversation's lane and run what fits. */
  private enqueueDelivery(
    conversationId: string,
    personaId: string,
    body: string,
    from: string,
    epoch: number,
    sourceItemId: string,
    attachments?: TurnAttachment[]
  ): void {
    this.pending.set(conversationId, (this.pending.get(conversationId) ?? 0) + 1);
    const lane: Lane = this.lanes.get(conversationId) ?? { active: new Map(), queue: [] };
    this.lanes.set(conversationId, lane);
    lane.queue.push({ personaId, body, from, epoch, sourceItemId, ...(attachments?.length ? { attachments } : {}) });
    this.pump(conversationId);
  }

  /**
   * Start queued deliveries up to the wave limit, skipping (not reordering)
   * any whose persona is already mid-delivery — same-persona stays serial.
   */
  private pump(conversationId: string): void {
    const lane = this.lanes.get(conversationId);
    if (!lane) return;
    while (lane.active.size < WAVE_CONCURRENCY) {
      const at = lane.queue.findIndex((task) => !lane.active.has(task.personaId));
      if (at < 0) break;
      const [task] = lane.queue.splice(at, 1);
      lane.active.set(task.personaId, '');
      void this.deliver(conversationId, task.personaId, task.body, task.from, task.epoch, task.sourceItemId, task.attachments)
        // quiet: deliver() reports every failure as a mail the user sees; a
        // rejection reaching here has already been told.
        .catch(() => undefined)
        .finally(() => {
          lane.active.delete(task.personaId);
          if (!lane.active.size && !lane.queue.length) this.lanes.delete(conversationId);
          else this.pump(conversationId);
        });
    }
  }

  /**
   * The activity row's live detail: who is working, how deep the wave is, and
   * which fan-out branches the conversation is still waiting on.
   */
  private updateActivityDetail(conversationId: string): void {
    const row = this.activityRows.get(conversationId);
    if (!row) return;
    const lane = this.lanes.get(conversationId);
    const working = lane ? [...lane.active.values()].filter(Boolean) : [];
    const queued = (this.pending.get(conversationId) ?? 0) - (lane?.active.size ?? 0);
    const waiting: string[] = [];
    for (const [key, join] of this.joins) {
      if (key.startsWith(`${conversationId}\n`)) waiting.push(...join.awaiting.values());
    }
    const parts = [
      `${working.length ? `${working.join(', ')} working` : 'working'} · turn ${row.turns}`,
      ...(queued > 0 ? [`${queued} queued`] : []),
      ...(waiting.length ? [`waiting on ${waiting.join(', ')}`] : [])
    ];
    activity.setDetail(row.handle, parts.join(' · '));
  }

  // ---- fan-out joins ----

  private joinFor(conversationId: string, senderId: string): JoinState | undefined {
    return this.joins.get(`${conversationId}\n${senderId}`);
  }

  /** Open the sender's join over these branches, or widen the one already open. */
  private async openJoin(
    conversationId: string,
    senderId: string,
    initiator: string,
    epoch: number,
    sourceItemId: string,
    branchIds: string[]
  ): Promise<void> {
    const personas = await listPersonas();
    const nameOf = (id: string) => (isAgentId(id) ? agentName(id) : personas.find((p) => p.id === id)?.name ?? id);
    const existing = this.joinFor(conversationId, senderId);
    if (existing) {
      for (const id of branchIds) existing.awaiting.set(id, nameOf(id));
      return;
    }
    const join: JoinState = {
      senderId,
      initiator,
      epoch,
      sourceItemId,
      awaiting: new Map(branchIds.map((id) => [id, nameOf(id)])),
      buffered: [],
      notes: []
      // No wall clock on the wave either: a branch settles when its delivery
      // does — reply, failure, or the settleBranchFailure note — and a delivery
      // is bounded by its turn, not by a timer. A join that assembled at 30
      // minutes was answering the user without its slowest branch (a coding
      // run) and then labelling the real reply late.
    };
    this.joins.set(`${conversationId}\n${senderId}`, join);
  }

  /**
   * A branch of `from`'s join failed before it could answer — settle it with a
   * note so the wave doesn't hang on a branch that can no longer speak.
   */
  private settleBranchFailure(conversationId: string, from: string, personaId: string, note: string): void {
    const join = from !== 'user' ? this.joinFor(conversationId, from) : undefined;
    const name = join?.awaiting.get(personaId);
    if (!join || name === undefined) return;
    join.awaiting.delete(personaId);
    join.notes.push(`${name}: ${note}`);
    this.maybeAssemble(conversationId, join);
  }

  /**
   * Assemble when the last branch settles: one delivery to the sender carrying
   * every buffered reply. No new MailItem — the replies already are items — so
   * assembly spends nothing against the caps; `from` is the wave's initiator,
   * so the assembly turn's implicit reply routes back to them.
   */
  private maybeAssemble(conversationId: string, join: JoinState): void {
    this.updateActivityDetail(conversationId);
    if (join.awaiting.size) return;
    this.joins.delete(`${conversationId}\n${join.senderId}`);
    const sections = join.buffered.map(
      (b) => `--- from ${b.name}${b.note ? ` (${b.note})` : ''} ---\n${b.body}`
    );
    const parts = ['Replies to your delegations:', ...sections];
    if (join.notes.length) parts.push(`Notes:\n${join.notes.map((n) => `- ${n}`).join('\n')}`);
    this.enqueueDelivery(conversationId, join.senderId, parts.join('\n\n'), join.initiator, join.epoch, join.sourceItemId);
  }

  /**
   * Run one delivery: start a turn on the persona's hidden thread, wait for it
   * to settle, and route what it produced. A turn that sent mail via the bridge
   * already spoke — no implicit reply; one that didn't gets its final assistant
   * text mailed to whoever initiated the delivery (the user, or the persona
   * whose send_mail caused it — the next hop of the chain, cap permitting).
   * Failures surface to the USER whoever initiated: every exit path produces a
   * mail somebody sees.
   */
  private async deliver(
    conversationId: string,
    personaId: string,
    body: string,
    from: string,
    epoch: number,
    sourceItemId: string,
    attachments?: TurnAttachment[]
  ): Promise<void> {
    // Minted out here so the finally below can clear the turn's bookkeeping on
    // every exit path.
    const turnId = randomUUID();
    this.activeTurns.set(turnId, { conversationId });
    let releaseRepoLock: (() => void) | undefined;
    let work: WorkHandle | undefined;
    try {
      const persona = await this.resolveMember(
        (await readMail()).conversations.find((c) => c.id === conversationId),
        personaId
      );
      if (!persona) {
        this.settleBranchFailure(conversationId, from, personaId, 'no longer exists.');
        await this.appendReply(
          conversationId,
          personaId,
          isAgentId(personaId)
            ? 'This agent can no longer run: the persona it was started from, or whoever started it, was deleted — ' +
              'or its persona now works on the user’s computer and is not in this conversation.'
            : 'The persona this mail was addressed to no longer exists.',
          'failed',
          epoch
        );
        return;
      }
      // A code persona pinned to a paired computer needs that computer for the
      // work itself, so a user mail arriving while it is unreachable is HELD,
      // not run: a turn would only discover the offline device mid-run and
      // settle as an answered mail nothing ever retries. The wait persists
      // (workspace/mail-device-queue.ts) and flushes when the device announces
      // itself; the notice mail says what the wave is waiting for. Only
      // user-initiated deliveries hold — a fan-out branch or reply hop must
      // not wedge its join, so those run and let coding_agent report the
      // offline device itself.
      if (from === 'user' && persona.harness?.device && this.opts.codingDevice) {
        // quiet: an oracle that fails answers like an unusable target — the
        // delivery runs and coding_agent reports the device problem itself.
        const device = await this.opts.codingDevice(persona.harness.device).catch(() => null);
        if (device && !device.online) {
          await queueMailForDevice({
            conversationId,
            personaId,
            deviceId: device.deviceId,
            deviceLabel: device.label
          });
          await this.appendReply(
            conversationId,
            personaId,
            `“${device.label}” is not reachable right now, and this persona's coding work runs there. ` +
              'Your mail is queued and will be delivered automatically once that computer is back — awake, ' +
              'running Stem, with "Run coding agents on this computer" switched on.',
            'awaiting-user',
            epoch
          );
          return;
        }
        // Online again: a wait recorded while it was offline is superseded by
        // this delivery — left behind, the next flush would re-deliver an
        // already-answered mail.
        // quiet: a wait that cannot be dropped costs one duplicate redelivery
        // to a thread that has the context to shrug it off; the delivery in
        // hand matters more.
        if (device) await dropQueuedMail(conversationId).catch(() => undefined);
      }
      await setConversationStatus(conversationId, 'working');
      this.opts.onChange();
      const { conversations, items } = await readMail();
      const conversation = conversations.find((c) => c.id === conversationId);
      if (!conversation) return; // deleted while queued
      const row = this.activityRows.get(conversationId) ?? {
        handle: activity.begin('mail.deliver', `Mail: ${conversation.subject || '(no subject)'}`, {
          conversationId
        }),
        turns: 0
      };
      row.turns += 1;
      this.activityRows.set(conversationId, row);
      // Up to WAVE_CONCURRENCY personas work this conversation at once; the
      // lane holds their names for the activity row.
      this.lanes.get(conversationId)?.active.set(personaId, persona.name);
      this.updateActivityDetail(conversationId);
      const threadId = conversation.sessions[personaId];
      work = await beginMailWork(this.opts.runtime, { conversationId, sourceItemId, personaId, turnId, threadId });

      // Two harnessed deliveries must never work the same repo tree at once
      // (same device, either cwd inside the other) — this waits until the tree
      // is free. Before waitForSettle on purpose: the wait belongs to queueing,
      // not to the turn.
      if (persona.harness) work.activity({ id: `repo:${turnId}`, kind: 'progress', label: 'Waiting for repository access', at: Date.now(), status: 'running' });
      releaseRepoLock = await repoLocks.acquire(persona.harness);
      if (persona.harness) work.activity({ id: `repo:${turnId}`, kind: 'progress', label: 'Repository access acquired', at: work.run.startedAt, endedAt: Date.now(), status: 'ok' });
      // The wait can outlive a user Stop — nothing should start a turn for a
      // conversation the user already stopped while it queued for the tree.
      if (this.stopping.has(conversationId)) return;

      // The turn id is minted up front and the settle subscription opens
      // BEFORE starting the turn: an instantly-failing turn can settle in the
      // gap between startTurn resolving and a later subscription, and a missed
      // settle wedges the conversation for good.
      this.turnInitiators.set(turnId, from);
      this.turnEpochs.set(turnId, epoch);
      this.turnSources.set(turnId, sourceItemId);
      // Source context rides only NON-driver deliveries: a wave always begins
      // with the user mail delivered to the driver verbatim, so injecting it
      // again for the driver (implicit-reply hops, assemblies) would stack the
      // same text into its thread once per hop. A missing item (deleted, or a
      // fallback that found nothing) just skips the injection.
      const sourceItem =
        conversation.participants[0] !== personaId
          ? items.find((i) => i.id === sourceItemId && i.from === 'user')
          : undefined;
      const sourceNames =
        sourceItem?.attachments?.map((a) => a.name).filter((n): n is string => !!n) ?? [];
      const source =
        sourceItem && (sourceItem.body || sourceNames.length)
          ? {
              itemId: sourceItem.id,
              body: sourceItem.body,
              ...(sourceNames.length ? { attachmentNames: sourceNames } : {})
            }
          : undefined;
      // The persona's pins and its persona block (role prompt, harness pin,
      // memory index, recall flag) — built by the shared helper so a delivery
      // and a scheduled run of the same persona behave the same.
      const personaFields = await personaTurnFields(persona);
      const notes = personaFields.persona.notes;
      // Participants and agents by name, self included: the preamble tells the
      // persona who it is ("You are reviewer-b") — a worker briefed by id with
      // "558d… owns reviews/a/" otherwise cannot tell which one it is — and
      // which agents of its own it may mail.
      const registry = await listPersonas();
      const agents = conversation.agents ?? [];
      const names: Record<string, string> = {};
      for (const id of conversation.participants) {
        const name = registry.find((p) => p.id === id)?.name;
        if (name) names[id] = name;
      }
      for (const a of agents) names[a.id] = a.name;
      names[personaId] = persona.name;
      const self = agents.find((a) => a.id === personaId);
      const own = agents.filter((a) => a.spawnedBy === personaId).map((a) => a.id);
      const selfAgent = self
        ? { role: registry.find((p) => p.id === self.role)?.name ?? self.role, spawnedBy: self.spawnedBy }
        : undefined;
      const threadIdRef = { current: threadId ?? null };
      const settling = this.waitForSettle(turnId, threadIdRef);
      let started;
      try {
        started = await this.opts.runtime.startTurn({
          input: body,
          turnId,
          ...(threadId ? { threadId } : {}),
          ...personaFields,
          ...(attachments?.length ? { attachments } : {}),
          webSearch: true,
          // A private conversation's every delivery is a private turn: the
          // hidden run threads are not in the chat store, so the flag rides
          // the input (the runtime honors it on mail turns, see startTurn).
          ...(conversation.private ? { private: true } : {}),
          mail: {
            conversationId,
            subject: conversation.subject,
            from,
            participants: conversation.participants,
            names,
            ...(persona.canSpawn ? { canSpawn: true } : {}),
            ...(own.length ? { agents: own } : {}),
            ...(persona.canSpawn ? { roles: spawnableRoles(registry, conversation.participants) } : {}),
            ...(selfAgent ? { agent: selfAgent } : {}),
            ...(source ? { source } : {})
          }
        });
      } catch (error) {
        settling.abandon();
        throw error;
      }
      const runThreadId = started.threadId ?? threadId;
      if (!runThreadId || !started.turnId) {
        settling.abandon();
        this.settleBranchFailure(conversationId, from, personaId, 'its delivery never started a turn.');
        await this.appendReply(
          conversationId,
          personaId,
          'The delivery never started a turn — nothing ran.',
          'failed',
          epoch
        );
        return;
      }
      threadIdRef.current = runThreadId;
      work.bindThread(runThreadId);
      this.liveThreads.add(runThreadId);
      if (runThreadId !== threadId) await setConversationSession(conversationId, personaId, runThreadId);
      noteTurnStart(runThreadId, started.turnId);

      const settle = await settling.done.finally(() => this.liveThreads.delete(runThreadId));
      if (settle.parked && !this.stopping.has(conversationId)) {
        // The run stopped for the user's Allow/Deny. Its branch stays open in
        // the join (if one is waiting on it); the approval item is the park,
        // and the answer resumes this same thread (resolveApproval).
        await work.finish('ok');
        this.turnMailSent.delete(turnId);
        await this.parkDelivery({
          conversationId,
          personaId,
          threadId: runThreadId,
          from,
          epoch,
          sourceItemId,
          request: settle.parked
        });
        return;
      }
      await work.finish(this.stopping.has(conversationId) ? 'aborted' : settle.status === 'ok' ? 'ok' : 'failed', settle.error);
      const sent = this.turnMailSent.get(turnId);
      this.turnMailSent.delete(turnId);
      if (settle.status !== 'ok') {
        // A user-requested stop aborts the turn on purpose — the abort is the
        // expected outcome, not news to deliver.
        if (this.stopping.has(conversationId)) return;
        this.settleBranchFailure(
          conversationId,
          from,
          personaId,
          `its run failed (${settle.error ?? 'the turn did not finish'}).`
        );
        await this.appendReply(
          conversationId,
          personaId,
          `The persona's run failed: ${settle.error ?? 'the turn did not finish.'}`,
          'failed',
          epoch
        );
      } else if (!sent) {
        const reply =
          (await this.lastAssistantText(runThreadId)) || '(The persona finished without writing a reply.)';
        await this.routeImplicitReply(conversationId, personaId, from, reply, epoch, sourceItemId);
      }
      // else: the turn mailed on its own. A user-addressed mail is an answer
      // like an implicit one and settles idle — it used to settle awaiting-user,
      // which tagged every driver's ordinary reply "needs you" while a
      // single-persona answer went untagged. A persona-addressed mail keeps the
      // chain going on the queued deliveries.

      // The reflection pass: what did this turn teach the persona? Only for
      // turns that settled ok (the failed branch above falls through to here),
      // strictly after the reply has been routed, and strictly fire-and-forget
      // — it never rejects (see reflect.ts) and a slow model must not hold the
      // lane.
      // A private conversation also leaves the persona's own notes untouched:
      // what it learned here would be a memory of the thread by another name.
      if (notes && settle.status === 'ok' && !conversation.private) {
        void reflectOnDelivery(this.opts.runtime, { personaId, assignment: body, threadId: runThreadId });
      }
    } catch (error) {
      // The reply IS the error channel: a mail that silently disappears is the
      // one outcome the Inbox must not produce.
      const message = error instanceof Error ? error.message : String(error);
      await work?.finish('failed', message);
      degrade('mail', 'delivered a failure notice instead of a reply', error);
      this.settleBranchFailure(conversationId, from, personaId, `its delivery failed (${message}).`);
      await this.appendReply(conversationId, personaId, `The delivery failed: ${message}`, 'failed', epoch).catch(() => {
        // quiet: the degrade above already recorded the failure; a store that
        // cannot be written has nothing left to say it in.
      });
    } finally {
      await work?.finish(this.stopping.has(conversationId) ? 'aborted' : 'failed', 'The delivery ended before recording a result.');
      releaseRepoLock?.();
      this.activeTurns.delete(turnId);
      this.turnInitiators.delete(turnId);
      this.turnEpochs.delete(turnId);
      this.turnSources.delete(turnId);
      const left = (this.pending.get(conversationId) ?? 1) - 1;
      if (left > 0) this.pending.set(conversationId, left);
      else {
        // The conversation's last delivery drained: settle its status. A
        // user-stopped wave settles as 'aborted' — the Inbox row is where the
        // stop shows, since no failure mail was written to say it.
        this.pending.delete(conversationId);
        const stopped = this.stopping.delete(conversationId);
        const row = this.activityRows.get(conversationId);
        if (row) {
          this.activityRows.delete(conversationId);
          const turns = `${row.turns} turn${row.turns === 1 ? '' : 's'}`;
          activity.end(row.handle, { worked: true, detail: stopped ? `stopped after ${turns}` : turns });
        }
        const status = stopped ? 'aborted' : this.drainStatus.get(conversationId) ?? 'idle';
        this.drainStatus.delete(conversationId);
        await setConversationStatus(conversationId, status).catch(() => {
          // quiet: the conversation was deleted while its deliveries ran — there
          // is no row left for a status to show on.
        });
        this.opts.onChange();
      }
    }
  }

  /**
   * The implicit reply of a turn that sent no mail. To a user-initiated
   * delivery it IS the answer (status idle at drain). To a persona-initiated
   * one it is the next hop of the chain — unless the cap is spent, in which
   * case it is forced back to the user (Q19: the runaway wave ends on you).
   */
  private async routeImplicitReply(
    conversationId: string,
    personaId: string,
    initiator: string,
    reply: string,
    epoch: number,
    sourceItemId: string
  ): Promise<void> {
    // Taken once, up front: the cap-spent fallback below appends a second time
    // after the first append threw, and the replies must ride whichever lands.
    const agentReplies = await this.agentRepliesFor(conversationId, personaId);
    if (initiator !== 'user') {
      const { conversations } = await readMail();
      const conversation = conversations.find((c) => c.id === conversationId);
      if (!conversation) return;
      const join = this.joinFor(conversationId, initiator);
      const cap = await this.exchangeCap();
      if (conversation.exchangeCount + exchangeHops(conversation, personaId, [initiator]) <= cap) {
        try {
          // Exempt from the sender's budget: finishing an assignment must
          // always be possible, however capped the persona's own sends are.
          await appendMailItem({
            conversationId,
            from: personaId,
            to: [initiator],
            body: reply,
            ...agentReplies,
            guard: { exchangeCap: cap, budgetExempt: true }
          });
        } catch (error) {
          // A racing parallel send spent the cap between the check and the
          // append: fall through to the cap-spent path below.
          if (!(error instanceof CapError)) throw error;
          this.settleCappedBranch(conversationId, join, personaId);
          await this.appendReply(conversationId, personaId, reply, 'awaiting-user', epoch, agentReplies);
          return;
        }
        if (join) {
          // The initiator is mid-fan-out: buffer the reply for its assembly
          // turn instead of starting a turn per branch.
          const name = join.awaiting.get(personaId);
          join.buffered.push({
            name: name ?? (await this.personaName(personaId)),
            body: reply,
            ...(name === undefined ? { note: 'not a delegation reply' } : {})
          });
          if (name !== undefined) join.awaiting.delete(personaId);
          this.maybeAssemble(conversationId, join);
          this.opts.onChange();
          return;
        }
        this.enqueueDelivery(conversationId, initiator, reply, personaId, epoch, sourceItemId);
        this.opts.onChange();
        return;
      }
      // Cap spent: the reply lands on the user instead of looping on.
      this.settleCappedBranch(conversationId, join, personaId);
      await this.appendReply(conversationId, personaId, reply, 'awaiting-user', epoch, agentReplies);
      return;
    }
    await this.appendReply(conversationId, personaId, reply, 'idle', epoch, agentReplies);
  }

  /**
   * What a persona's item carries beside its body: the coding agent's own
   * replies (`agentReplies`) and the pictures the turn made (`images`) —
   * nothing when the turn made neither.
   */
  private agentRepliesField(threadId: string | undefined): { agentReplies?: string[]; images?: GeneratedImageRef[] } {
    if (!threadId) return {};
    const replies = this.opts.agentReplies?.(threadId) ?? [];
    const images = this.opts.generatedImages?.(threadId) ?? [];
    return { ...(replies.length ? { agentReplies: replies } : {}), ...(images.length ? { images } : {}) };
  }

  private async agentRepliesFor(
    conversationId: string,
    personaId: string
  ): Promise<{ agentReplies?: string[]; images?: GeneratedImageRef[] }> {
    if (!this.opts.agentReplies && !this.opts.generatedImages) return {};
    const { conversations } = await readMail();
    return this.agentRepliesField(conversations.find((c) => c.id === conversationId)?.sessions[personaId]);
  }

  private imagesField(threadId: string | undefined): { images?: GeneratedImageRef[] } {
    const images = threadId ? (this.opts.generatedImages?.(threadId) ?? []) : [];
    return images.length ? { images } : {};
  }

  /** A branch whose reply was forced to the user by the cap must still settle. */
  private settleCappedBranch(conversationId: string, join: JoinState | undefined, personaId: string): void {
    const name = join?.awaiting.get(personaId);
    if (!join || name === undefined) return;
    join.awaiting.delete(personaId);
    join.notes.push(`${name}'s reply landed on the user — the exchange cap was spent.`);
    this.maybeAssemble(conversationId, join);
  }

  /** Append a persona→user item and record the status to write once the queue drains. */
  private async appendReply(
    conversationId: string,
    personaId: string,
    body: string,
    drainStatus: DrainStatus,
    epoch: number,
    agentReplies?: { agentReplies?: string[]; images?: GeneratedImageRef[] }
  ): Promise<void> {
    // A failure notice (no agentReplies passed) still carries what the agent
    // said before things went wrong — that is often the only clue.
    const replies = agentReplies ?? (await this.agentRepliesFor(conversationId, personaId));
    await appendMailItem({ conversationId, from: personaId, to: ['user'], body, ...replies, staleIfUserSentAfter: epoch });
    // The worse status is sticky for the wave: a failure already recorded must
    // not be papered over by a later hop landing cleanly.
    const current = this.drainStatus.get(conversationId) ?? 'idle';
    if (DRAIN_RANK[drainStatus] > DRAIN_RANK[current]) this.drainStatus.set(conversationId, drainStatus);
    this.opts.onChange();
  }

  /**
   * The final assistant message becomes the reply. Intermediate commentary
   * belongs to the Work timeline; raw history preserves message boundaries
   * that readThread's chat aggregation intentionally combines.
   */
  private async lastAssistantText(threadId: string): Promise<string> {
    try {
      if (this.opts.runtime.readWorkHistory) {
        const turns = await this.opts.runtime.readWorkHistory(threadId);
        const final = turns.at(-1)?.finalText;
        if (final !== undefined) return final;
      }
      const { messages } = await this.opts.runtime.readThread(threadId);
      let start = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          start = i + 1;
          break;
        }
      }
      return messages.slice(start).filter((m) => m.role === 'assistant' && m.content.trim()).at(-1)?.content.trim() ?? '';
    } catch (error) {
      degrade('mail', 'replied without the turn transcript', error);
      return '';
    }
  }

  /**
   * Watch for the delivery's turn to settle — the scheduler's pattern, except
   * the subscription opens BEFORE startTurn is called (the caller mints the
   * turn id), so an instantly-failing turn cannot settle unheard. `threadIdRef`
   * is filled in once startTurn answers which thread the turn actually runs on;
   * until then only the turn id matches. `abandon()` tears the watch down when
   * the start itself failed and there is no turn to wait for.
   */
  private waitForSettle(
    turnId: string,
    threadIdRef: { current: string | null }
  ): { done: Promise<DeliverySettle>; abandon: () => void } {
    let finish!: (status: DeliverySettle['status'], error?: string, parked?: ParkRequest) => void;
    const done = new Promise<DeliverySettle>((resolve) => {
      let settled = false;
      finish = (status, error, parked) => {
        if (settled) return;
        settled = true;
        this.opts.runtime.off('event', onEvent);
        resolve({ status, ...(error ? { error } : {}), ...(parked ? { parked } : {}) });
      };
      const onEvent = (event: BackendEventEnvelope) => {
        // A process exit is attributed: its threadId names the turn the dying
        // worker was carrying (null when it sat idle — a reaped extra worker).
        // Only OUR thread's death fails this delivery; before the attribution,
        // an idle worker's routine retirement was failing every in-flight
        // delivery, and the real reply (which completed minutes later) was
        // silently dropped. An unattributed exit (an older backend) still fails
        // conservatively: a false failure costs a "run failed" mail; a missed
        // real one wedges the conversation for good.
        if (event.method === 'process/exit') {
          const p = event.params as { threadId?: string | null } | undefined;
          const attributed = !!p && 'threadId' in p;
          if (!attributed || (p.threadId != null && p.threadId === threadIdRef.current)) {
            finish('failed', 'the backend process exited');
          }
          return;
        }
        const p = event.params as
          | { threadId?: string; turn?: { id?: string }; error?: string; parked?: ParkRequest }
          | undefined;
        const matches = p?.turn?.id
          ? p.turn.id === turnId
          : threadIdRef.current != null && p?.threadId === threadIdRef.current;
        if (!matches) return;
        // Stopped for the user's Allow/Deny (PiRuntime.parkTurn): not a failure.
        const terminal = event.method === 'turn/completed' || event.method === 'turn/failed' || event.method === 'turn/aborted';
        if (terminal && p?.parked) finish('parked', undefined, p.parked);
        else if (event.method === 'turn/completed') finish('ok');
        else if (event.method === 'turn/failed') finish('failed', typeof p?.error === 'string' ? p.error : undefined);
        else if (event.method === 'turn/aborted') finish('failed', 'the turn was aborted');
      };
      // No wall clock here, deliberately. A delivery is bounded by the turn it
      // waits on — a coding-agent run may take hours — and every way that turn
      // can end (completed, failed, aborted, worker death) is heard above. The
      // 30-minute clamp this once carried killed a legitimate iOS build mid-run
      // and reported it as a cancellation.
      this.opts.runtime.on('event', onEvent);
    });
    return { done, abandon: () => finish('failed', 'the turn never started') };
  }
}
