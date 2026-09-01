import { randomUUID } from 'node:crypto';
import type { ChatBackend, MailBridgeContext, MailBridgeResult, SavePersonaRequest } from '../backend/types';
import type {
  BackendEventEnvelope,
  MailComposeInput,
  MailListResult,
  TurnAttachment
} from '../../shared/types';
import { attachmentPreviews } from '../pi/attachments';
import * as activity from '../activity';
import { degrade } from '../degrade';
import { noteTurnStart } from '../live-turns';
import {
  deletePersona,
  getPersona,
  listPersonas,
  savePersonaFor,
  updatePersonaFields,
  type BridgePersonaFields
} from '../workspace/personas';
import {
  listPersonaNotes,
  personaOwnsMemory,
  savePersonaNote
} from '../workspace/persona-memory';
import { reflectOnDelivery } from './reflect';
import { repoLocks } from './repo-lock';
import { readSettings } from '../workspace/settings';
import {
  addParticipant,
  appendMailItem,
  CapError,
  createConversation,
  readMail,
  setConversationSession,
  setConversationStatus
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

/** A delivery that never settles must not wedge its conversation forever. */
const DELIVERY_TIMEOUT_MS = 30 * 60 * 1000; // 30m — mail is async; be generous.

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
  /** Failures/timeouts/detours, appended to the assembly mail. */
  notes: string[];
  timer: NodeJS.Timeout;
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
}

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
   * that sent anything gets no implicit reply; one that mailed only the user
   * has stopped the chain on them (status awaiting-user once the queue drains).
   */
  private readonly turnMailSent = new Map<string, { persona: boolean; user: boolean }>();
  /** Deliveries queued or in flight per conversation — the status authority. */
  private readonly pending = new Map<string, number>();
  /** The status to write when a conversation's deliveries drain (default idle). */
  private readonly drainStatus = new Map<string, 'idle' | 'awaiting-user'>();
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

    const conversation = await createConversation(input.subject ?? '', to, body);
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
    const { conversations } = await readMail();
    const conversation = conversations.find((c) => c.id === conversationId);
    if (!conversation) throw new Error('That mail conversation no longer exists.');
    const driver = conversation.participants[0];
    const result = await appendMailItem({
      conversationId,
      from: 'user',
      to: conversation.participants,
      body: trimmed,
      ...(files ? { attachments: await attachmentPreviews(files) } : {})
    });
    const source = result.items[result.items.length - 1];
    this.enqueueDelivery(conversationId, driver, trimmed, 'user', source.at, source.id, files);
    return result;
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
   * add control — the human counterpart of add_persona, so no capability
   * gate). The persona joins the participant set and becomes reachable by
   * send_mail and addressed by future replies; it gets no turn of its own
   * until someone mails it — same contract as add_persona.
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
    if (!active.length && !queued && !waitDropped) return { stopped: false };
    this.stopping.add(conversationId);
    if (lane && queued) {
      // Dropped tasks never reach deliver(), so their pending counts settle here.
      lane.queue.length = 0;
      const left = (this.pending.get(conversationId) ?? queued) - queued;
      if (left > 0) this.pending.set(conversationId, left);
      else this.pending.delete(conversationId);
    }
    for (const [key, join] of this.joins) {
      if (key.startsWith(`${conversationId}\n`)) {
        clearTimeout(join.timer);
        this.joins.delete(key);
      }
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
    subject: string;
    body: string;
    taskId: string;
    personaId?: string;
  }): Promise<void> {
    // One conversation per task, found by the task id on its items; created on
    // the first notify. Keeps every firing of a watch task in one thread of mail.
    const { conversations, items } = await readMail();
    const existing = items.find((i) => i.taskId === input.taskId);
    const conversation = existing
      ? conversations.find((c) => c.id === existing.conversationId)
      : undefined;
    const from = input.personaId ?? `task:${input.taskId}`;
    const target =
      conversation ?? (await createConversation(input.subject, [input.personaId ?? 'normal'], input.body));
    await appendMailItem({
      conversationId: target.id,
      from,
      to: ['user'],
      body: input.body,
      taskId: input.taskId
    });
    this.opts.onChange();
  }

  // ---- the mail bridge (send_mail / add_persona from inside a delivery turn) ----

  /**
   * send_mail: append the item and queue a delivery turn per persona recipient.
   * Recipients are validated against the conversation's LIVE participant set
   * (add_persona may have grown it this very turn); the cap is checked fresh
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
    const reachable = new Set([...conversation.participants, 'user']);
    const bad = to.filter((t) => !reachable.has(t));
    if (bad.length) {
      return {
        ok: false,
        error:
          `Not reachable from this conversation: ${bad.join(', ')}. ` +
          `Recipients must be its participants (${conversation.participants.join(', ')}) or "user".`
      };
    }
    // Hub and spoke: only the driver (participants[0]) coordinates. A consulted
    // persona may reply to whoever mailed it — nothing else — so one job can
    // never be briefed twice by two coordinators, and parallel branches exist
    // only where the driver deliberately fanned out.
    const driverId = conversation.participants[0];
    const initiator = this.turnInitiators.get(ctx.turnId) ?? 'user';
    if (ctx.personaId !== driverId) {
      const disallowed = to.filter((t) => t !== 'user' && t !== initiator);
      if (disallowed.length) {
        return {
          ok: false,
          error:
            `Only the driver (${driverId}) mails the personas in this conversation. You can reply to ` +
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
    const caller = await getPersona(ctx.personaId);
    if (personaTo.length) {
      const cap = await this.exchangeCap();
      if (conversation.exchangeCount + personaTo.length > cap) return { ok: false, error: capRefusal };
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
    // Fanning out — two or more deliveries from one send — opens (or widens)
    // this sender's join: the replies come back as one assembly turn.
    if (delivered.length >= 2 || (delivered.length >= 1 && this.joinFor(ctx.conversationId, ctx.personaId))) {
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
   * add_persona: grow the conversation's participant set. Gated by the calling
   * persona's capability flag — the To: list is the conversation's reachability
   * boundary, and widening it is a power the user grants per persona.
   */
  async bridgeAddPersona(personaId: string, ctx: MailBridgeContext): Promise<MailBridgeResult> {
    const caller = await getPersona(ctx.personaId);
    if (!caller?.canManagePersonas) {
      return {
        ok: false,
        error:
          'Your persona does not have the manage-personas capability. Tell the user who should be added instead ' +
          '(they can add the persona, or grant the capability in the Personas tab).'
      };
    }
    const wanted = personaId.trim();
    if (!wanted) return { ok: false, error: 'Give add_persona a persona id.' };
    // Resolve by id first, then by (unique, case-insensitive) name — the model
    // usually knows personas by name.
    const personas = await listPersonas();
    const target =
      personas.find((p) => p.id === wanted) ??
      personas.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
    if (!target) return { ok: false, error: `No persona "${wanted}" exists.` };
    const { conversations } = await readMail();
    const conversation = conversations.find((c) => c.id === ctx.conversationId);
    if (!conversation) return { ok: false, error: 'This mail conversation no longer exists.' };
    if (conversation.participants.includes(target.id)) {
      return { ok: true, text: `${target.name} is already in this conversation.` };
    }
    await addParticipant(ctx.conversationId, target.id);
    this.opts.onChange();
    return { ok: true, text: `Added ${target.name} (${target.id}). Mail it with send_mail to bring it in.` };
  }

  /**
   * save_persona: a persona creating (or editing) its own helper personas.
   * Gated like add_persona; only the plain fields land (name/prompt/model/
   * effort — never a harness pin or a capability flag), and edits are limited
   * to personas the caller itself created.
   */
  async bridgeSavePersona(req: SavePersonaRequest, ctx: MailBridgeContext): Promise<MailBridgeResult> {
    const caller = await getPersona(ctx.personaId);
    if (!caller?.canManagePersonas) {
      return {
        ok: false,
        error:
          'Your persona does not have the manage-personas capability. Describe the persona to the user ' +
          'instead (they can create it, or grant the capability in the Personas tab).'
      };
    }
    const fields: BridgePersonaFields = {
      ...(typeof req.name === 'string' ? { name: req.name } : {}),
      ...(typeof req.prompt === 'string' ? { prompt: req.prompt } : {}),
      ...(typeof req.model === 'string' ? { model: req.model } : {}),
      ...(typeof req.effort === 'string' ? { effort: req.effort } : {})
    };
    try {
      if (!req.id?.trim()) {
        const persona = await savePersonaFor(ctx.personaId, fields);
        return {
          ok: true,
          text:
            `Created ${persona.name} (${persona.id}). Bring it into this conversation with ` +
            'add_persona before mailing it.'
        };
      }
      const target = await this.resolvePersona(req.id);
      if (!target) return { ok: false, error: `No persona "${req.id}" exists.` };
      if (target.createdBy !== ctx.personaId) {
        return { ok: false, error: `You may only edit personas you created; "${target.name}" is not one.` };
      }
      const updated = await updatePersonaFields(target.id, fields);
      return { ok: true, text: `Updated ${updated.name} (${updated.id}). Changes apply from its next mail.` };
    } catch (error) {
      // quiet: the tool result IS the error channel — the calling persona gets
      // the store's refusal (name clash, unwritable file) verbatim and reacts.
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * delete_persona: a persona cleaning up helpers it created. Refused while
   * the target still has mail in flight anywhere — a queued delivery to a
   * deleted persona could only fail.
   */
  async bridgeDeletePersona(personaId: string, ctx: MailBridgeContext): Promise<MailBridgeResult> {
    const caller = await getPersona(ctx.personaId);
    if (!caller?.canManagePersonas) {
      return { ok: false, error: 'Your persona does not have the manage-personas capability.' };
    }
    const wanted = personaId.trim();
    if (!wanted) return { ok: false, error: 'Give delete_persona a persona id.' };
    const target = await this.resolvePersona(wanted);
    if (!target) return { ok: false, error: `No persona "${wanted}" exists.` };
    if (target.createdBy !== ctx.personaId) {
      return { ok: false, error: `You may only delete personas you created; "${target.name}" is not one.` };
    }
    for (const lane of this.lanes.values()) {
      if (lane.active.has(target.id) || lane.queue.some((t) => t.personaId === target.id)) {
        return { ok: false, error: `${target.name} still has mail in flight; wait for it to finish.` };
      }
    }
    for (const join of this.joins.values()) {
      if (join.awaiting.has(target.id) || join.senderId === target.id) {
        return { ok: false, error: `${target.name} is still part of an open fan-out; wait for it to finish.` };
      }
    }
    try {
      await deletePersona(target.id);
    } catch (error) {
      // quiet: the tool result IS the error channel — the calling persona gets
      // the store's refusal verbatim and reacts.
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, text: `Deleted ${target.name}.` };
  }

  /**
   * remember_note: the calling persona saves one lesson into its OWN memory
   * store — the payload names no persona, so nothing can write elsewhere.
   * Refused for personas without a store (agent-created helpers): their whole
   * point is to be disposable, and the refusal says where a lasting lesson
   * should go instead.
   */
  async bridgeRememberNote(
    req: { title?: string; body?: string },
    ctx: MailBridgeContext
  ): Promise<MailBridgeResult> {
    const caller = await getPersona(ctx.personaId);
    if (!caller) return { ok: false, error: 'Your persona no longer exists.' };
    if (!personaOwnsMemory(caller)) {
      return {
        ok: false,
        error: caller.createdBy
          ? 'Your persona is a temporary helper and keeps no memory. If this lesson should outlive you, ' +
            'put it in your reply so the persona that created you can remember it.'
          : 'Your persona keeps no private memory — it is switched off for this persona. If the lesson ' +
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
    const caller = await getPersona(ctx.personaId);
    if (!caller) return { ok: false, error: 'Your persona no longer exists.' };
    if (!personaOwnsMemory(caller)) {
      return {
        ok: false,
        error: caller.createdBy
          ? 'Your persona is a temporary helper and keeps no memory.'
          : 'Your persona keeps no private memory — it is switched off for this persona.'
      };
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

  /** Resolve by id first, then by (unique, case-insensitive) name. */
  private async resolvePersona(idOrName: string) {
    const personas = await listPersonas();
    return (
      personas.find((p) => p.id === idOrName) ??
      personas.find((p) => p.name.toLowerCase() === idOrName.toLowerCase())
    );
  }

  private async personaName(personaId: string): Promise<string> {
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
    const nameOf = (id: string) => personas.find((p) => p.id === id)?.name ?? id;
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
      notes: [],
      // The backstop for a branch that wanders off (delegates onward and never
      // reports back): individual deliveries already time out on their own.
      timer: setTimeout(() => {
        for (const name of join.awaiting.values()) {
          join.notes.push(`${name} never replied before the wave timed out.`);
        }
        join.awaiting.clear();
        this.maybeAssemble(conversationId, join);
      }, DELIVERY_TIMEOUT_MS)
    };
    // A backstop must never be what keeps the process alive.
    join.timer.unref?.();
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
    clearTimeout(join.timer);
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
    try {
      const persona = await getPersona(personaId);
      if (!persona) {
        this.settleBranchFailure(conversationId, from, personaId, 'no longer exists.');
        await this.appendReply(
          conversationId,
          personaId,
          `The persona this mail was addressed to no longer exists.`,
          'awaiting-user',
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

      // Two harnessed deliveries must never work the same repo tree at once
      // (same device, either cwd inside the other) — this waits until the tree
      // is free. Before waitForSettle on purpose: waiting for the lock must not
      // eat into the turn's settle timeout.
      releaseRepoLock = await repoLocks.acquire(persona.harness);
      // The wait can outlive a user Stop — nothing should start a turn for a
      // conversation the user already stopped while it queued for the tree.
      if (this.stopping.has(conversationId)) return;

      // The turn id is minted up front and the settle subscription opens
      // BEFORE starting the turn: an instantly-failing turn can settle in the
      // gap between startTurn resolving and a later subscription, and a missed
      // settle wedges the conversation for the whole timeout.
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
      // The persona's memory index (id + title per note) rides the turn so the
      // preamble can render "what you know" every delivery. Present (possibly
      // empty) exactly when the persona owns a store — presence is also what
      // makes the preamble mention remember_note.
      // quiet: an unreadable store already degrades inside listPersonaNotes;
      // the delivery proceeds with an empty index rather than failing.
      const noteRows = personaOwnsMemory(persona) ? await listPersonaNotes(persona.id).catch(() => []) : undefined;
      const notes = noteRows?.map((n) => ({ id: n.id, title: n.title }));
      const threadIdRef = { current: threadId ?? null };
      const settling = this.waitForSettle(turnId, threadIdRef);
      let started;
      try {
        started = await this.opts.runtime.startTurn({
          input: body,
          turnId,
          ...(threadId ? { threadId } : {}),
          ...(persona.model ? { model: persona.model } : {}),
          ...(persona.effort ? { effort: persona.effort } : {}),
          ...(attachments?.length ? { attachments } : {}),
          webSearch: true,
          persona: {
            id: persona.id,
            prompt: persona.prompt,
            ...(persona.harness ? { harness: persona.harness } : {}),
            ...(notes ? { notes } : {})
          },
          mail: {
            conversationId,
            subject: conversation.subject,
            from,
            participants: conversation.participants,
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
          'awaiting-user',
          epoch
        );
        return;
      }
      threadIdRef.current = runThreadId;
      this.liveThreads.add(runThreadId);
      if (runThreadId !== threadId) await setConversationSession(conversationId, personaId, runThreadId);
      noteTurnStart(runThreadId, started.turnId);

      const settle = await settling.done.finally(() => this.liveThreads.delete(runThreadId));
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
          'awaiting-user',
          epoch
        );
      } else if (!sent) {
        const reply =
          (await this.lastAssistantText(runThreadId)) || '(The persona finished without writing a reply.)';
        await this.routeImplicitReply(conversationId, personaId, from, reply, epoch, sourceItemId);
      } else if (sent.user && !sent.persona) {
        // The turn ended after mailing only the user: the chain has stopped on
        // them (a blocked ask, or an explicit final answer) — say so at drain.
        this.drainStatus.set(conversationId, 'awaiting-user');
      }
      // else: persona mail sent — the chain continues on the queued deliveries.

      // The reflection pass: what did this turn teach the persona? Only for
      // turns that settled ok (the failed branch above falls through to here),
      // strictly after the reply has been routed, and strictly fire-and-forget
      // — it never rejects (see reflect.ts) and a slow model must not hold the
      // lane.
      if (notes && settle.status === 'ok') {
        void reflectOnDelivery(this.opts.runtime, { personaId, assignment: body, threadId: runThreadId });
      }
    } catch (error) {
      // The reply IS the error channel: a mail that silently disappears is the
      // one outcome the Inbox must not produce.
      const message = error instanceof Error ? error.message : String(error);
      degrade('mail', 'delivered a failure notice instead of a reply', error);
      this.settleBranchFailure(conversationId, from, personaId, `its delivery failed (${message}).`);
      await this.appendReply(conversationId, personaId, `The delivery failed: ${message}`, 'awaiting-user', epoch).catch(() => {
        // quiet: the degrade above already recorded the failure; a store that
        // cannot be written has nothing left to say it in.
      });
    } finally {
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
    if (initiator !== 'user') {
      const { conversations } = await readMail();
      const conversation = conversations.find((c) => c.id === conversationId);
      if (!conversation) return;
      const join = this.joinFor(conversationId, initiator);
      const cap = await this.exchangeCap();
      if (conversation.exchangeCount + 1 <= cap) {
        try {
          // Exempt from the sender's budget: finishing an assignment must
          // always be possible, however capped the persona's own sends are.
          await appendMailItem({
            conversationId,
            from: personaId,
            to: [initiator],
            body: reply,
            guard: { exchangeCap: cap, budgetExempt: true }
          });
        } catch (error) {
          // A racing parallel send spent the cap between the check and the
          // append: fall through to the cap-spent path below.
          if (!(error instanceof CapError)) throw error;
          this.settleCappedBranch(conversationId, join, personaId);
          await this.appendReply(conversationId, personaId, reply, 'awaiting-user', epoch);
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
      await this.appendReply(conversationId, personaId, reply, 'awaiting-user', epoch);
      return;
    }
    await this.appendReply(conversationId, personaId, reply, 'idle', epoch);
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
    drainStatus: 'idle' | 'awaiting-user',
    epoch: number
  ): Promise<void> {
    await appendMailItem({ conversationId, from: personaId, to: ['user'], body, staleIfUserSentAfter: epoch });
    // Awaiting-user is sticky for the wave: a failure already recorded must not
    // be papered over by a later hop landing cleanly.
    if (this.drainStatus.get(conversationId) !== 'awaiting-user') this.drainStatus.set(conversationId, drainStatus);
    this.opts.onChange();
  }

  /**
   * Everything the settled turn said — the implicit reply. A turn that uses
   * tools writes SEVERAL assistant messages (text between tool calls), so the
   * reply is all of them since the last user message, not just the final one:
   * taking the last alone once mailed back only a turn's closing sentence.
   */
  private async lastAssistantText(threadId: string): Promise<string> {
    try {
      const { messages } = await this.opts.runtime.readThread(threadId);
      let start = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          start = i + 1;
          break;
        }
      }
      return messages
        .slice(start)
        .filter((m) => m.role === 'assistant' && m.content.trim())
        .map((m) => m.content.trim())
        .join('\n\n');
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
  ): { done: Promise<{ status: 'ok' | 'failed'; error?: string }>; abandon: () => void } {
    let finish!: (status: 'ok' | 'failed', error?: string) => void;
    const done = new Promise<{ status: 'ok' | 'failed'; error?: string }>((resolve) => {
      let settled = false;
      finish = (status, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.opts.runtime.off('event', onEvent);
        resolve({ status, ...(error ? { error } : {}) });
      };
      const onEvent = (event: BackendEventEnvelope) => {
        // A process exit is attributed: its threadId names the turn the dying
        // worker was carrying (null when it sat idle — a reaped extra worker).
        // Only OUR thread's death fails this delivery; before the attribution,
        // an idle worker's routine retirement was failing every in-flight
        // delivery, and the real reply (which completed minutes later) was
        // silently dropped. An unattributed exit (an older backend) still fails
        // conservatively: a false failure costs a "run failed" mail; a missed
        // real one wedges the conversation for the whole timeout.
        if (event.method === 'process/exit') {
          const p = event.params as { threadId?: string | null } | undefined;
          const attributed = !!p && 'threadId' in p;
          if (!attributed || (p.threadId != null && p.threadId === threadIdRef.current)) {
            finish('failed', 'the backend process exited');
          }
          return;
        }
        const p = event.params as { threadId?: string; turn?: { id?: string }; error?: string } | undefined;
        const matches = p?.turn?.id
          ? p.turn.id === turnId
          : threadIdRef.current != null && p?.threadId === threadIdRef.current;
        if (!matches) return;
        if (event.method === 'turn/completed') finish('ok');
        else if (event.method === 'turn/failed') finish('failed', typeof p?.error === 'string' ? p.error : undefined);
        else if (event.method === 'turn/aborted') finish('failed', 'the turn was aborted');
      };
      const timeout = setTimeout(() => {
        void this.opts.runtime.interruptTurn(turnId).catch((err) =>
          degrade('mail', 'left a timed-out delivery running', err)
        );
        finish('failed', 'the run timed out');
      }, DELIVERY_TIMEOUT_MS);
      this.opts.runtime.on('event', onEvent);
    });
    return { done, abandon: () => finish('failed', 'the turn never started') };
  }
}
