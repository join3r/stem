import type { ChatMessage, ChatsSettings } from '../../shared/types';
import type { NamingState } from '../workspace/chats';
import { bumpNaming, getNaming, getSubjects, setNaming, setSubject } from '../workspace/chats';
import { backgroundRunOf, readSettings } from '../workspace/settings';
import { log } from '../log';
import { plainLine } from '../../shared/plain-text';

// Naming a thread. pi never names a session, so Stem always has to; the cheap
// answer is the first line the user typed (autoTitle, below), and the good one
// is a subject a small model writes from the conversation itself.
//
// A name written from the opening message alone is wrong twice over: a thread
// that opens with "look at this" has no topic in it yet, and a thread named at
// turn 1 keeps that name through forty turns of drifting somewhere else. So the
// naming pass runs on a widening schedule (NAMING_GAPS) — once the first reply
// has landed, then more and more rarely — and every run after the first shows
// the model the name it already has and only what has been said since. That
// keeps names stable by default: the old name carries the thread's history
// forward, so a re-check reads as the whole thread without re-reading it.
//
// The one thing the schedule may never do is overwrite a name the user typed.
// `stillOurs` is the guard: a thread is ours to rename only while it still
// carries the exact name we last gave it (or pi's placeholder, or the first line
// of the opening message). Anything else the user chose, and the thread is
// theirs from then on.

/** Max length of an auto-derived title (the sidebar ellipsizes anyway). */
const MAX_AUTO_TITLE = 80;
/** Max length of a written subject — a subject line, not a sentence. */
export const MAX_SUBJECT = 60;
/** How much of any single message the subject writer is shown. */
const PROMPT_INPUT_CAP = 2_000;
/** The writer is a two-sentence task on a small model; don't wait on a wedged one. */
const SUBJECT_TIMEOUT_MS = 20_000;

/**
 * User turns between one naming and the next: the first once the opening reply
 * has landed, then at turns 3, 8, 20, 50, 125, and every 75 turns after that.
 * Widening on purpose — a name is most likely to be wrong early, and a thread
 * that has held the same topic for fifty turns is not about to surprise anyone.
 */
const NAMING_GAPS = [1, 2, 5, 12, 30, 75];
/**
 * Where a thread with no naming record joins the schedule. Every thread that
 * predates the schedule already carries a name written from its first message,
 * so it joins at step 1 — due for a re-check, not for a fresh naming off a
 * single exchange.
 */
const PRE_EXISTING_STEP = 1;
/** Below this much new conversation there is nothing to re-read; don't spend a call. */
const MIN_RECHECK_CHARS = 200;
/** Turns to wait before looking again at a thread whose new material was too thin. */
const THIN_RETRY_TURNS = 2;
/** How much of the conversation a naming run is shown. */
const EXCERPT_CAP = 2_500;

/** How many turns of this thread's schedule are left before it is named again. */
function gapFor(step: number): number {
  return NAMING_GAPS[Math.min(step, NAMING_GAPS.length - 1)];
}

/** Derive a chat title from the first user message: its first non-empty line, trimmed and capped. */
export function autoTitle(input: string): string {
  // The first line that still says something once its Markdown is gone — a
  // message that opens with a fence or a rule is named by what follows it.
  const line = input.split('\n').map(plainLine).find((l) => l.length > 0) ?? '';
  return line.length > MAX_AUTO_TITLE ? `${line.slice(0, MAX_AUTO_TITLE - 1).trimEnd()}…` : line;
}

/**
 * One message as the naming model sees it. Always the same rendering, whichever
 * excerpt it lands in — {@link wholeThreadExcerpt} recognises the opening inside
 * the tail by comparing these lines, so a message may not render two ways.
 */
function line(message: ChatMessage): string {
  const who = message.role === 'user' ? 'User' : 'Assistant';
  const text = message.content.trim();
  return `${who}: ${text.length > PROMPT_INPUT_CAP ? `${text.slice(0, PROMPT_INPUT_CAP - 1).trimEnd()}…` : text}`;
}

/** Does this message carry anything worth showing a naming model? */
function speaks(message: ChatMessage): boolean {
  return message.role !== 'system' && message.content.trim().length > 0;
}

/** The opening exchange: the first message and the reply it drew, if there is one yet. */
function openingExcerpt(messages: ChatMessage[]): string {
  const firstUser = messages.findIndex((m) => m.role === 'user' && speaks(m));
  if (firstUser < 0) return '';
  const reply = messages.slice(firstUser + 1).find((m) => m.role === 'assistant' && speaks(m));
  return [line(messages[firstUser]), reply ? line(reply) : ''].filter(Boolean).join('\n');
}

/**
 * The tail of the conversation: back through `userTurns` of the user's messages,
 * or as far as the character cap allows, whichever comes first. Newest material
 * is what a re-check is for, so the cap eats into the oldest end.
 */
function tailExcerpt(messages: ChatMessage[], userTurns: number, cap = EXCERPT_CAP): string {
  const lines: string[] = [];
  let budget = cap;
  let turns = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!speaks(message)) continue;
    if (message.role === 'user') {
      if (turns >= userTurns) break;
      turns += 1;
    }
    const rendered = line(message);
    if (rendered.length > budget) break;
    budget -= rendered.length + 1;
    lines.unshift(rendered);
  }
  return lines.join('\n');
}

/**
 * The whole thread at a glance: how it opened, then where it has got to. What
 * the "Write a subject" action is asked to name — an explicit rename is the one
 * time it is worth paying to re-read a thread from both ends. The idle-chat
 * filer (autofile.ts) reads a chat the same way.
 */
export function wholeThreadExcerpt(messages: ChatMessage[]): string {
  const opening = openingExcerpt(messages);
  const tail = tailExcerpt(messages, messages.length, Math.max(0, EXCERPT_CAP - opening.length - 2));
  // On a short thread the tail has already walked back to the opening; only a
  // long one needs its head pasted back on in front of the gap.
  return !opening || tail.includes(opening) ? tail || opening : [opening, '…', tail].join('\n');
}

/** The one-shot prompt behind a written subject. */
export function subjectPrompt(conversation: string): string {
  return [
    'Write a subject line for the conversation below, the way an email subject names a thread.',
    '',
    'Rules:',
    '- Two to six words. Never more than 60 characters.',
    '- Name the topic, not the request: "Q3 revenue breakdown", not "User asks about Q3 revenue".',
    '- Keep concrete nouns from the conversation — names, files, error codes — over generic ones.',
    '- Write it in the same language as the conversation.',
    '- No quotes, no trailing period, no "Subject:" prefix, no explanation.',
    '- Reply with the subject line alone.',
    '',
    'Conversation:',
    '"""',
    conversation.slice(0, EXCERPT_CAP),
    '"""'
  ].join('\n');
}

/** What a re-check answers with when the name it was given still fits. */
export const KEEP = 'KEEP';

/**
 * The prompt behind a re-check. Deliberately biased towards KEEP: the name is
 * already on screen and in the user's head, and a row that re-words itself from
 * "Deploy pipeline rollout" to "Deploy pipeline release" is pure noise.
 */
export function resubjectPrompt(currentName: string, conversation: string): string {
  return [
    `A conversation is named "${currentName}". Below is what has been said in it since that name was written.`,
    'Decide whether the name still describes the conversation as a whole.',
    '',
    'Rules:',
    `- Reply with the single word ${KEEP} if the name still fits, even loosely. Prefer ${KEEP}: a name that changes for no reason is worse than one that is slightly stale.`,
    '- Only write a new name if the conversation has clearly moved on to a different subject.',
    '- A new name describes the conversation as a whole, weighted towards what it has become — not just the latest message.',
    '- Two to six words. Never more than 60 characters.',
    '- Name the topic, not the request. Keep concrete nouns — names, files, error codes — over generic ones.',
    '- Write it in the same language as the conversation.',
    '- No quotes, no trailing period, no explanation.',
    `- Reply with ${KEEP} or the new name alone.`,
    '',
    'Since then:',
    '"""',
    conversation.slice(0, EXCERPT_CAP),
    '"""'
  ].join('\n');
}

/**
 * Reduce a model's reply to a usable subject line, or to '' if there isn't one.
 * Deliberately unforgiving: a bad subject would become the thread's NAME, and a
 * blank result just leaves the standing name alone, which is no worse than
 * where we started.
 */
export function sanitizeSubject(raw: string): string {
  let text = (raw ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  // Models like to answer a "write a subject" prompt in the shape of the question.
  text = text.replace(/^(subject|title)\s*[:\-–]\s*/i, '');
  // Strip matched wrapping quotes/backticks, possibly nested ("`…`").
  for (let i = 0; i < 3; i += 1) {
    const stripped = text.replace(/^["'`“”‘’*]+|["'`“”‘’*]+$/g, '').trim();
    if (stripped === text) break;
    text = stripped;
  }
  text = plainLine(text).replace(/[.,;:]+$/, '').trim();
  // A reply this long isn't a subject line — it's the model ignoring the brief.
  if (text.length > MAX_SUBJECT * 3) return '';
  if (text.length > MAX_SUBJECT) text = `${text.slice(0, MAX_SUBJECT - 1).trimEnd()}…`;
  return text;
}

/**
 * Writing systems a stray-script check knows. A letter outside all of these
 * (a rare script) is not judged at all.
 */
const SCRIPTS = [
  'Latin', 'Cyrillic', 'Greek', 'Armenian', 'Georgian', 'Hebrew', 'Arabic', 'Syriac', 'Thaana',
  'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam',
  'Sinhala', 'Thai', 'Lao', 'Tibetan', 'Myanmar', 'Khmer', 'Ethiopic', 'Hangul', 'Hiragana', 'Katakana',
  'Han', 'Mongolian'
].map((name) => ({ name, letter: new RegExp(`\\p{Script=${name}}`, 'u') }));

function scriptsOf(text: string): Set<string> {
  const found = new Set<string>();
  for (const ch of text.match(/\p{L}/gu) ?? []) {
    const script = SCRIPTS.find((s) => s.letter.test(ch));
    if (script) found.add(script.name);
  }
  return found;
}

/**
 * True when the subject has letters of a writing system that the source text
 * has none of. Small models sometimes glue a word from a random script onto a
 * good subject ("Zdroj grafu o sandbagginguтипақ", "Ružinovская"); such a
 * subject is a glitch, not a name.
 */
export function hasStrayScript(subject: string, source: string): boolean {
  const known = scriptsOf(source);
  for (const script of scriptsOf(subject)) if (!known.has(script)) return true;
  return false;
}

/**
 * Ask for a subject and sanitize it. A reply with a stray script gets one more
 * try, because the glitch is random and a second call is usually clean. If the
 * second reply is bad too, the result is '' and the standing name stays.
 */
export async function writeSubject(
  complete: SubjectDeps['complete'],
  prompt: string,
  opts: Parameters<SubjectDeps['complete']>[1],
  source: string
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const subject = sanitizeSubject(await complete(prompt, opts));
    if (!hasStrayScript(subject, source)) return subject;
    log('chats', 'subject had a stray script', { subject, attempt });
  }
  return '';
}

/** What the naming pass needs from the backend, injected so it stays testable. */
export interface SubjectDeps {
  complete(
    prompt: string,
    opts: { model?: string | null; effort?: string | null; timeoutMs?: number }
  ): Promise<string>;
  /** The thread's current name, or null if it can't be read. */
  currentTitle(threadId: string): Promise<string | null>;
  rename(threadId: string, name: string): Promise<void>;
  /** The thread's messages, oldest first. */
  readMessages(threadId: string): Promise<ChatMessage[]>;
}

/**
 * True while the thread still carries a name Stem gave it, so renaming it is
 * replacing our own guess rather than overwriting the user's choice. `stored` is
 * the subject we last wrote — the fingerprint that lets a re-check recognise its
 * own predecessor instead of mistaking it for a hand-typed name.
 */
function stillOurs(current: string | null, stored: string | null, firstMessage: string): boolean {
  if (current === null) return false;
  const name = current.trim();
  if (name === '' || name === 'New chat') return true;
  if (stored !== null && name === stored) return true;
  // Titles are listed stripped of Markdown, while names written before the
  // stripping are stored raw — so both sides are compared as plain text.
  const plain = plainLine(name);
  if (stored !== null && plain === plainLine(stored)) return true;
  if (plain === autoTitle(firstMessage)) return true;
  // The raw first line, which is what autoTitle used to write.
  const firstLine = firstMessage.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return plain === plainLine(firstLine.length > MAX_AUTO_TITLE ? `${firstLine.slice(0, MAX_AUTO_TITLE - 1).trimEnd()}…` : firstLine);
}

/** A re-check that answered "the name still fits", however it phrased it. */
function saysKeep(subject: string, currentName: string): boolean {
  return subject.toUpperCase() === KEEP || subject.toLowerCase() === currentName.trim().toLowerCase();
}

/**
 * Count this thread's settled turn against its naming schedule, and name it if
 * it has come due.
 *
 * Called once per turn, so the cheap path matters: everything before the due
 * check is arithmetic over a few bytes of store, and an ordinary turn costs no
 * thread read and no model call.
 */
export async function nameThreadIfDue(deps: SubjectDeps, threadId: string): Promise<string | null> {
  try {
    const chats = (await readSettings()).chats;
    // `off` doesn't even keep count: turning subjects back on later starts the
    // schedule from that point rather than firing on the next turn of every
    // thread the user chatted in while it was off.
    if (chats.subjects === 'off') return null;
    const state = await bumpNaming(threadId, PRE_EXISTING_STEP);
    if (state.since < gapFor(state.step)) return null;
    return await nameThread(deps, threadId, { settings: chats, state });
  } catch (e) {
    log('chats', 'naming check failed', { threadId, error: String(e) });
    return null;
  }
}

/**
 * Name one thread from its conversation.
 *
 * Runs on the warm `--no-session` completion worker, so it never touches the
 * user's live chat, and every failure path is silent: a thread that doesn't get
 * a subject simply keeps the name it already has.
 *
 * `force` is the "Write a subject" row action — an explicit request, so it runs
 * whatever the mode is, reads the whole thread rather than only what is new, and
 * may replace a name the user typed. Returns the subject if one was written,
 * else null.
 */
export async function nameThread(
  deps: SubjectDeps,
  threadId: string,
  opts?: { force?: boolean; settings?: ChatsSettings; state?: NamingState }
): Promise<string | null> {
  const force = opts?.force === true;
  try {
    const chats = opts?.settings ?? (await readSettings()).chats;
    if (chats.subjects === 'off' && !force) return null;
    const state = opts?.state ?? (await getNaming(threadId)) ?? { step: PRE_EXISTING_STEP, since: 0 };
    // Every path out of here leaves the schedule somewhere definite. A run that
    // bails without doing this would come due again on the very next turn, and
    // keep re-reading the thread for as long as it kept bailing.
    const advance = () => setNaming(threadId, { step: state.step + 1, since: 0 });
    /** Come back in a couple of turns rather than at the next full gap. */
    const soon = () => setNaming(threadId, { step: state.step, since: Math.max(0, gapFor(state.step) - THIN_RETRY_TURNS) });

    const messages = await deps.readMessages(threadId);
    const firstMessage = messages.find((m) => m.role === 'user')?.content ?? '';
    if (!firstMessage.trim()) {
      await soon();
      return null;
    }

    const stored = (await getSubjects())[threadId] ?? null;
    // Cheap bail-out before spending a model call on a thread we won't rename
    // and whose name the user has already chosen. The schedule still advances:
    // a thread the user has named is unlikely to become ours again, so the
    // widening gaps are what keep it from being re-read every turn forever.
    if (!force && !stillOurs(await deps.currentTitle(threadId), stored, firstMessage)) {
      await advance();
      return null;
    }

    // A re-check needs a name to check; a thread whose subject was never written
    // (the mode was off until now) re-checks the name it is actually wearing.
    const currentName = stored ?? autoTitle(firstMessage);
    const opening = state.step === 0;
    const recheck = !force && !opening;
    const excerpt = force
      ? wholeThreadExcerpt(messages)
      : opening
        ? openingExcerpt(messages)
        : tailExcerpt(messages, state.since);
    if (!excerpt.trim()) {
      await soon();
      return null;
    }
    if (recheck && excerpt.length < MIN_RECHECK_CHARS) {
      // Nothing has really been said since the last naming — "thanks", "yes",
      // "keep going". Hold the step where it is and look again in a couple of
      // turns rather than burning the slot on a model call with no material.
      await soon();
      return null;
    }

    // The check counts from the moment the call goes out, not from a reply: a
    // KEEP, an unusable answer and a wedged model must all leave the schedule
    // advanced, or a thread would try again on every turn. A forced run counts
    // too, so an explicit rename gets a full gap of quiet before a re-check.
    await advance();
    const subject = await writeSubject(
      deps.complete,
      recheck ? resubjectPrompt(currentName, excerpt) : subjectPrompt(excerpt),
      {
        ...(await backgroundRunOf('subject', () => ({ model: chats.subjectModel, effort: chats.subjectEffort }))),
        timeoutMs: SUBJECT_TIMEOUT_MS
      },
      // The model saw the excerpt and, on a re-check, the standing name.
      recheck ? `${currentName}\n${excerpt}` : excerpt
    );
    if (!subject) return null;
    if (recheck && saysKeep(subject, currentName)) return null;

    await setSubject(threadId, subject);

    if (chats.subjects === 'everywhere') {
      // Re-check: the completion took a couple of seconds, and the user may have
      // renamed the thread inside that window.
      if (force || stillOurs(await deps.currentTitle(threadId), stored, firstMessage)) {
        await deps.rename(threadId, subject);
      }
    }
    return subject;
  } catch (e) {
    log('chats', 'subject write failed', { threadId, error: String(e) });
    return null;
  }
}
