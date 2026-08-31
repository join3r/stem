import { randomUUID } from 'node:crypto';
import type { ChatBackend, MailBridgeContext, MailBridgeResult } from '../backend/types';
import type { BackendEventEnvelope, MailComposeInput, MailListResult } from '../../shared/types';
import * as activity from '../activity';
import { degrade } from '../degrade';
import { noteTurnStart } from '../live-turns';
import { getPersona, listPersonas } from '../workspace/personas';
import { readSettings } from '../workspace/settings';
import {
  addParticipant,
  appendMailItem,
  createConversation,
  readMail,
  setConversationSession,
  setConversationStatus
} from '../workspace/mail';

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

/** A delivery that never settles must not wedge its conversation forever. */
const DELIVERY_TIMEOUT_MS = 30 * 60 * 1000; // 30m — mail is async; be generous.

export interface MailRouterOptions {
  runtime: ChatBackend;
  /** Pushed to every client whenever mail changes (a delivery landed, etc.). */
  onChange: () => void;
}

export class MailRouter {
  /** Serializes deliveries per conversation, so a reply can't overtake its turn. */
  private readonly queues = new Map<string, Promise<unknown>>();
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
    if (!body) throw new Error('Write the mail before sending it.');

    const conversation = await createConversation(input.subject, to);
    const result = await appendMailItem({ conversationId: conversation.id, from: 'user', to, body });
    this.enqueueDelivery(conversation.id, to[0], body, 'user');
    return result;
  }

  /** Reply into a conversation: appends the user's item, resumes the driver. */
  async reply(conversationId: string, body: string): Promise<MailListResult> {
    const trimmed = body.trim();
    if (!trimmed) throw new Error('Write the reply before sending it.');
    const { conversations } = await readMail();
    const conversation = conversations.find((c) => c.id === conversationId);
    if (!conversation) throw new Error('That mail conversation no longer exists.');
    const driver = conversation.participants[0];
    const result = await appendMailItem({
      conversationId,
      from: 'user',
      to: conversation.participants,
      body: trimmed
    });
    this.enqueueDelivery(conversationId, driver, trimmed, 'user');
    return result;
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
      conversation ?? (await createConversation(input.subject, [input.personaId ?? 'normal']));
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
    const { conversations } = await readMail();
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
    const personaTo = to.filter((t) => t !== 'user');
    if (personaTo.length) {
      const cap = await this.exchangeCap();
      if (conversation.exchangeCount + personaTo.length > cap) {
        return {
          ok: false,
          error:
            'The inter-persona exchange cap for this conversation is used up. Write your result for the ' +
            'user instead — send_mail to ["user"], or just finish your reply.'
        };
      }
    }
    await appendMailItem({ conversationId: ctx.conversationId, from: ctx.personaId, to, body });
    const sent = this.turnMailSent.get(ctx.turnId) ?? { persona: false, user: false };
    if (personaTo.length) sent.persona = true;
    if (to.includes('user')) sent.user = true;
    this.turnMailSent.set(ctx.turnId, sent);
    for (const recipient of personaTo) this.enqueueDelivery(ctx.conversationId, recipient, body, ctx.personaId);
    this.opts.onChange();
    return {
      ok: true,
      text:
        `Mail sent to ${to.join(', ')}.` +
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
    if (!caller?.canAddPersonas) {
      return {
        ok: false,
        error:
          'Your persona does not have the add-personas capability. Tell the user who should be added instead ' +
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

  // ---- delivery internals ----

  /** The cap, read fresh per decision — a settings change applies to the very next hop. */
  private async exchangeCap(): Promise<number> {
    // quiet: readSettings answers with defaults and degrades itself rather than
    // rejecting; the fallback keeps the guard working even if it ever does.
    return (await readSettings().catch(() => null))?.mail.exchangeCap ?? 10;
  }

  /** Queue one delivery behind the conversation's previous one. */
  private enqueueDelivery(conversationId: string, personaId: string, body: string, from: string): void {
    this.pending.set(conversationId, (this.pending.get(conversationId) ?? 0) + 1);
    const prev = this.queues.get(conversationId) ?? Promise.resolve();
    const run = prev.then(
      () => this.deliver(conversationId, personaId, body, from),
      () => this.deliver(conversationId, personaId, body, from)
    );
    this.queues.set(
      conversationId,
      run.then(
        () => undefined,
        () => undefined
      )
    );
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
  private async deliver(conversationId: string, personaId: string, body: string, from: string): Promise<void> {
    try {
      const persona = await getPersona(personaId);
      if (!persona) {
        await this.appendReply(
          conversationId,
          personaId,
          `The persona this mail was addressed to no longer exists.`,
          'awaiting-user'
        );
        return;
      }
      await setConversationStatus(conversationId, 'working');
      this.opts.onChange();
      const { conversations } = await readMail();
      const conversation = conversations.find((c) => c.id === conversationId);
      if (!conversation) return; // deleted while queued
      const row = this.activityRows.get(conversationId) ?? {
        handle: activity.begin('mail.deliver', `Mail: ${conversation.subject || '(no subject)'}`),
        turns: 0
      };
      row.turns += 1;
      this.activityRows.set(conversationId, row);
      // Deliveries serialize per conversation, so one persona works at a time;
      // the rest of the wave sits queued behind it.
      const queued = (this.pending.get(conversationId) ?? 1) - 1;
      activity.setDetail(
        row.handle,
        `${persona.name} working · turn ${row.turns}${queued > 0 ? ` · ${queued} queued` : ''}`
      );
      const threadId = conversation.sessions[personaId];

      // Mint the turn id and subscribe for its settle BEFORE starting the turn:
      // an instantly-failing turn can settle in the gap between startTurn
      // resolving and a later subscription, and a missed settle wedges the
      // conversation for the whole timeout.
      const turnId = randomUUID();
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
          webSearch: true,
          persona: {
            id: persona.id,
            prompt: persona.prompt,
            ...(persona.harness ? { harness: persona.harness } : {})
          },
          mail: {
            conversationId,
            subject: conversation.subject,
            from,
            participants: conversation.participants
          }
        });
      } catch (error) {
        settling.abandon();
        throw error;
      }
      const runThreadId = started.threadId ?? threadId;
      if (!runThreadId || !started.turnId) {
        settling.abandon();
        await this.appendReply(conversationId, personaId, 'The delivery never started a turn — nothing ran.', 'awaiting-user');
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
        await this.appendReply(
          conversationId,
          personaId,
          `The persona's run failed: ${settle.error ?? 'the turn did not finish.'}`,
          'awaiting-user'
        );
      } else if (!sent) {
        const reply =
          (await this.lastAssistantText(runThreadId)) || '(The persona finished without writing a reply.)';
        await this.routeImplicitReply(conversationId, personaId, from, reply);
      } else if (sent.user && !sent.persona) {
        // The turn ended after mailing only the user: the chain has stopped on
        // them (a blocked ask, or an explicit final answer) — say so at drain.
        this.drainStatus.set(conversationId, 'awaiting-user');
      }
      // else: persona mail sent — the chain continues on the queued deliveries.
    } catch (error) {
      // The reply IS the error channel: a mail that silently disappears is the
      // one outcome the Inbox must not produce.
      const message = error instanceof Error ? error.message : String(error);
      degrade('mail', 'delivered a failure notice instead of a reply', error);
      await this.appendReply(conversationId, personaId, `The delivery failed: ${message}`, 'awaiting-user').catch(() => {
        // quiet: the degrade above already recorded the failure; a store that
        // cannot be written has nothing left to say it in.
      });
    } finally {
      const left = (this.pending.get(conversationId) ?? 1) - 1;
      if (left > 0) this.pending.set(conversationId, left);
      else {
        // The conversation's last delivery drained: settle its status.
        this.pending.delete(conversationId);
        const row = this.activityRows.get(conversationId);
        if (row) {
          this.activityRows.delete(conversationId);
          activity.end(row.handle, { worked: true, detail: `${row.turns} turn${row.turns === 1 ? '' : 's'}` });
        }
        const status = this.drainStatus.get(conversationId) ?? 'idle';
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
    reply: string
  ): Promise<void> {
    if (initiator !== 'user') {
      const { conversations } = await readMail();
      const conversation = conversations.find((c) => c.id === conversationId);
      if (!conversation) return;
      const cap = await this.exchangeCap();
      if (conversation.exchangeCount + 1 <= cap) {
        await appendMailItem({ conversationId, from: personaId, to: [initiator], body: reply });
        this.enqueueDelivery(conversationId, initiator, reply, personaId);
        this.opts.onChange();
        return;
      }
      // Cap spent: the reply lands on the user instead of looping on.
      await this.appendReply(conversationId, personaId, reply, 'awaiting-user');
      return;
    }
    await this.appendReply(conversationId, personaId, reply, 'idle');
  }

  /** Append a persona→user item and record the status to write once the queue drains. */
  private async appendReply(
    conversationId: string,
    personaId: string,
    body: string,
    drainStatus: 'idle' | 'awaiting-user'
  ): Promise<void> {
    await appendMailItem({ conversationId, from: personaId, to: ['user'], body });
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
