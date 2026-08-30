import { randomUUID } from 'node:crypto';
import type { ChatBackend } from '../backend/types';
import type { BackendEventEnvelope, MailComposeInput, MailListResult } from '../../shared/types';
import { degrade } from '../degrade';
import { noteTurnStart } from '../live-turns';
import { getPersona } from '../workspace/personas';
import {
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
// P1 is single-persona: the driver is the only recipient the router delivers
// to, and there is no persona→persona traffic yet. The item schema and the
// exchange counter already carry the multi-persona shape.

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

  /** Queue one delivery behind the conversation's previous one. */
  private enqueueDelivery(conversationId: string, personaId: string, body: string, from: string): void {
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
   * to settle, and append its final assistant message as the reply mail. Every
   * exit path replies — success with the answer, failure with what went wrong.
   */
  private async deliver(conversationId: string, personaId: string, body: string, from: string): Promise<void> {
    const persona = await getPersona(personaId);
    if (!persona) {
      await this.replyToUser(conversationId, personaId, `The persona this mail was addressed to no longer exists.`);
      return;
    }
    await setConversationStatus(conversationId, 'working');
    this.opts.onChange();
    try {
      const { conversations } = await readMail();
      const conversation = conversations.find((c) => c.id === conversationId);
      if (!conversation) return; // deleted while queued
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
          mail: { conversationId, subject: conversation.subject, from }
        });
      } catch (error) {
        settling.abandon();
        throw error;
      }
      const runThreadId = started.threadId ?? threadId;
      if (!runThreadId || !started.turnId) {
        settling.abandon();
        await this.replyToUser(conversationId, personaId, 'The delivery never started a turn — nothing ran.');
        return;
      }
      threadIdRef.current = runThreadId;
      this.liveThreads.add(runThreadId);
      if (runThreadId !== threadId) await setConversationSession(conversationId, personaId, runThreadId);
      noteTurnStart(runThreadId, started.turnId);

      const settle = await settling.done.finally(() => this.liveThreads.delete(runThreadId));
      const reply =
        settle.status === 'ok'
          ? await this.lastAssistantText(runThreadId)
          : `The persona's run failed: ${settle.error ?? 'the turn did not finish.'}`;
      await this.replyToUser(
        conversationId,
        personaId,
        reply || '(The persona finished without writing a reply.)',
        settle.status === 'ok' ? 'idle' : 'awaiting-user'
      );
    } catch (error) {
      // The reply IS the error channel: a mail that silently disappears is the
      // one outcome the Inbox must not produce.
      const message = error instanceof Error ? error.message : String(error);
      degrade('mail', 'delivered a failure notice instead of a reply', error);
      await this.replyToUser(conversationId, personaId, `The delivery failed: ${message}`).catch(() => {
        // quiet: the degrade above already recorded the failure; a store that
        // cannot be written has nothing left to say it in.
      });
    }
  }

  /** Append a persona→user item and settle the conversation's status. */
  private async replyToUser(
    conversationId: string,
    personaId: string,
    body: string,
    status: 'idle' | 'awaiting-user' = 'awaiting-user'
  ): Promise<void> {
    await appendMailItem({ conversationId, from: personaId, to: ['user'], body });
    await setConversationStatus(conversationId, status);
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
        // Process exits carry no thread/turn identifiers (and with the pool the
        // exiting child may not even be this delivery's). Fail conservatively,
        // as the scheduler does: a false failure costs a "run failed" mail; a
        // missed real one wedges the conversation for the whole timeout.
        if (event.method === 'process/exit') {
          finish('failed', 'the backend process exited');
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
