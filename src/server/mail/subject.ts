import type { MailConversation, MailItem } from '../../shared/types';
import { cleanMailSubject, deriveMailSubject, NO_SUBJECT } from '../../shared/mail-subject';
import { subjectPrompt, writeSubject } from '../chats/subject';
import { backgroundRunOf, readSettings } from '../workspace/settings';
import { mailSubjectPassDone, markMailSubjectPassDone, readMail, replaceMailSubject } from '../workspace/mail';
import { log } from '../log';

// Naming a mail conversation. A mail composed without a subject is named from
// its body's first line (shared/mail-subject deriveMailSubject), which is the
// user's own prompt cut at 60 characters — a long sentence repeating what the
// first mail already says. Once the first reply lands, the same small model
// that writes chat subjects names the conversation in two to six words.
//
// The rule chat naming lives by holds here too: only a subject Stem made up is
// ours to replace. That is a subject still equal to what the first user mail
// derives to (or the shrug), recognised by recomputing the derivation — there
// is no stored fingerprint to consult, and none is needed. A subject the user
// typed, a forwarded mail's "Fwd: …" and a scheduled task's headline all differ
// from it; task conversations are skipped outright, because each firing retitles
// them on purpose. Private conversations are named like private chats are: the
// naming call learns nothing and keeps nothing.
//
// Conversations that predate this get one sweep, the first time a signed-in
// server comes up on this version: newest first, one call at a time, at most
// PASS_CAP of them. The store remembers the sweep finished, so it never repeats
// (one cut short by a restart picks up the rest next boot), and a call that
// fails simply leaves that conversation with the name it had.

/** How much of any single mail the subject writer is shown. */
const PROMPT_INPUT_CAP = 2_000;
/** The writer is a two-sentence task on a small model; don't wait on a wedged one. */
const SUBJECT_TIMEOUT_MS = 20_000;
/** The one-time sweep names at most this many conversations, newest first. */
export const PASS_CAP = 100;

/** What naming needs from the backend, injected so it stays testable. */
export interface MailSubjectDeps {
  complete(
    prompt: string,
    opts: { model?: string | null; effort?: string | null; timeoutMs?: number }
  ): Promise<string>;
}

/** A conversation's items, oldest first. */
function itemsOf(conversationId: string, items: MailItem[]): MailItem[] {
  return items.filter((i) => i.conversationId === conversationId).sort((a, b) => a.at - b.at);
}

/** A reply that landed on the user: persona (or failure-notice) mail addressed to them. */
function isReplyToUser(item: MailItem): boolean {
  return item.from !== 'user' && item.to.includes('user');
}

/**
 * True while the conversation still wears a subject Stem made up: blank, the
 * shrug, or exactly what its first user mail derives to. `mails` is the
 * conversation's items, oldest first. Compose derives from the first mail's
 * body, and the store heals a blank subject from the first user mail that
 * derives to anything (an attachments-only opener derives to nothing), so the
 * derivation is recomputed the same way here.
 */
export function isMadeUpMailSubject(subject: string, mails: MailItem[]): boolean {
  const current = subject.trim();
  if (!current || current === NO_SUBJECT) return true;
  const derived = mails
    .filter((i) => i.from === 'user')
    .map((i) => deriveMailSubject(i.body))
    .find(Boolean);
  // The stored copy was cleaned on read; compare against both spellings.
  return !!derived && (current === derived || current === cleanMailSubject(derived));
}

/**
 * Whether this conversation is one the model may name: not a scheduled task's,
 * opened by the user, answered at least once, and still wearing a made-up subject.
 */
export function mailSubjectEligible(conversation: MailConversation, mails: MailItem[]): boolean {
  // Inter-Stem: the subject is the sender's, and their mail never goes to a
  // model before the user releases it.
  if (conversation.external) return false;
  if (mails.some((i) => i.taskId)) return false;
  if (!mails.some((i) => i.from === 'user')) return false;
  if (!mails.some(isReplyToUser)) return false;
  return isMadeUpMailSubject(conversation.subject, mails);
}

function capped(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > PROMPT_INPUT_CAP ? `${trimmed.slice(0, PROMPT_INPUT_CAP - 1).trimEnd()}…` : trimmed;
}

/**
 * The opening exchange as the model sees it: the user's first mail and the
 * first reply it drew — the same "User:/Assistant:" shape chat naming feeds
 * {@link subjectPrompt}. Attachment names stand in for an attachments-only mail.
 */
export function mailOpeningExcerpt(mails: MailItem[]): string {
  const first = mails.find((i) => i.from === 'user');
  if (!first) return '';
  const reply = mails.find((i) => i.at >= first.at && i !== first && isReplyToUser(i));
  const files = (first.attachments ?? []).map((a) => a.name).filter(Boolean);
  const userText = first.body.trim() || (files.length ? `(attached: ${files.join(', ')})` : '');
  return [userText ? `User: ${capped(userText)}` : '', reply?.body.trim() ? `Assistant: ${capped(reply.body)}` : '']
    .filter(Boolean)
    .join('\n');
}

/**
 * Name one conversation, if it is still ours to name. Always resolves: a
 * conversation that gets no subject keeps the one it has. Returns the written
 * subject, or null.
 */
export async function nameMailConversation(deps: MailSubjectDeps, conversationId: string): Promise<string | null> {
  try {
    const chats = (await readSettings()).chats;
    if (chats.subjects === 'off') return null;
    const { conversations, items } = await readMail();
    const conversation = conversations.find((c) => c.id === conversationId);
    if (!conversation) return null;
    const mails = itemsOf(conversationId, items);
    if (!mailSubjectEligible(conversation, mails)) return null;
    const excerpt = mailOpeningExcerpt(mails);
    if (!excerpt) return null;
    const subject = cleanMailSubject(
      await writeSubject(
        deps.complete,
        subjectPrompt(excerpt),
        {
          ...(await backgroundRunOf('subject', () => ({ model: chats.subjectModel, effort: chats.subjectEffort }))),
          timeoutMs: SUBJECT_TIMEOUT_MS
        },
        excerpt
      )
    );
    if (!subject) return null;
    // Compare-and-set against the subject the model was asked about: the call
    // took seconds, and anything that retitled the conversation meanwhile wins.
    return (await replaceMailSubject(conversationId, conversation.subject, subject)) ? subject : null;
  } catch (e) {
    log('mail', 'subject write failed', { conversationId, error: String(e) });
    return null;
  }
}

/** Conversations naming is still in flight for — one call per conversation at a time. */
const inFlight = new Set<string>();

/**
 * The live trigger, fed every reply that lands on the user (onMailReceived):
 * names the conversation when this is its FIRST such reply. Later replies never
 * retry — a failed call leaves the made-up subject, as the sweep does.
 */
export async function nameAfterFirstReply(deps: MailSubjectDeps, item: MailItem): Promise<string | null> {
  if (item.taskId || inFlight.has(item.conversationId)) return null;
  try {
    const { items } = await readMail();
    const replies = items.filter((i) => i.conversationId === item.conversationId && isReplyToUser(i));
    if (replies.length !== 1 || replies[0].id !== item.id) return null;
    inFlight.add(item.conversationId);
    return await nameMailConversation(deps, item.conversationId);
  } catch (e) {
    log('mail', 'subject trigger failed', { conversationId: item.conversationId, error: String(e) });
    return null;
  } finally {
    inFlight.delete(item.conversationId);
  }
}

/**
 * The one-time sweep over conversations that predate written subjects. The
 * newest PASS_CAP eligible ones are named one at a time, then the store is
 * marked so no later boot repeats it. With subjects off the sweep is marked
 * done without naming anything, like chat naming, which keeps no count while
 * off: turning subjects on later names new mail, not a backlog.
 * Returns how many conversations got a subject.
 */
export async function runMailSubjectPass(deps: MailSubjectDeps): Promise<number> {
  if (await mailSubjectPassDone()) return 0;
  let named = 0;
  if ((await readSettings()).chats.subjects !== 'off') {
    const { conversations, items } = await readMail();
    const due = conversations
      .filter((c) => mailSubjectEligible(c, itemsOf(c.id, items)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, PASS_CAP);
    for (const conversation of due) {
      if (inFlight.has(conversation.id)) continue;
      inFlight.add(conversation.id);
      try {
        if (await nameMailConversation(deps, conversation.id)) named += 1;
      } finally {
        inFlight.delete(conversation.id);
      }
    }
  }
  await markMailSubjectPassDone();
  return named;
}
