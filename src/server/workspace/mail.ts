import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { InboxEntry, InboxState } from '../../shared/inbox';
import { toMs } from '../../shared/inbox';
import { cleanMailSubject, deriveMailSubject, NO_SUBJECT, resolveMailSubject } from '../../shared/mail-subject';
import type {
  GeneratedImageRef,
  MailApproval,
  MailApprovalStatus,
  MailAgent,
  MailConversation,
  MailItem,
  MailListResult,
  ScheduledRunReport
} from '../../shared/types';
import { coerceSystemVersion } from '../../shared/sys-version';
import { systemVersion } from '../sys-version';
import { degrade } from '../degrade';
import { mailStorePath } from './paths';

// The Stem-owned mail store: the Inbox's conversations and items, plus the
// per-conversation read/archive/snooze state. Same shape as the inbox store
// next door — serialized read-modify-write, atomic temp+rename, corrupt-file
// degradation — but unlike the chat Inbox nothing here derives from a thread
// mtime: a conversation's activity timestamps are stamped by appendMailItem,
// and `userUpdatedAt` moves only for items addressed to the user, so persona-
// internal traffic can never resurrect an archived conversation.

interface MailFile {
  version: 1;
  conversations: MailConversation[];
  items: MailItem[];
  /** Read/archive/snooze per conversation id — shared/inbox.ts semantics. */
  inbox: InboxState;
  /**
   * ms the one-time subject pass finished (server/mail/subject.ts): the sweep
   * that gave conversations predating written subjects a model-written name.
   * Present = done, never run again.
   */
  subjectPassAt?: number;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const APPROVAL_STATUSES: readonly MailApprovalStatus[] = ['pending', 'allowed', 'denied', 'superseded', 'cancelled'];

function coerceApproval(raw: unknown): MailApproval | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const a = raw as Record<string, unknown>;
  const resume = a.resume && typeof a.resume === 'object' ? (a.resume as Record<string, unknown>) : null;
  if (typeof a.id !== 'string' || typeof a.command !== 'string' || !resume) return undefined;
  if (typeof resume.personaId !== 'string' || typeof resume.threadId !== 'string' || typeof resume.from !== 'string') {
    return undefined;
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  return {
    id: a.id,
    kind: a.kind === 'harness' ? 'harness' : 'exec',
    command: a.command,
    ...(str(a.cwd) ? { cwd: str(a.cwd) } : {}),
    ...(str(a.deviceLabel) ? { deviceLabel: str(a.deviceLabel) } : {}),
    ...(str(a.reason) ? { reason: str(a.reason) } : {}),
    status: APPROVAL_STATUSES.includes(a.status as MailApprovalStatus) ? (a.status as MailApprovalStatus) : 'cancelled',
    resume: {
      personaId: resume.personaId,
      threadId: resume.threadId,
      from: resume.from,
      epoch: num(resume.epoch) ?? 0,
      sourceItemId: typeof resume.sourceItemId === 'string' ? resume.sourceItemId : '',
      ...(str(resume.deviceId) ? { deviceId: str(resume.deviceId) } : {}),
      ...(str(resume.taskId) ? { taskId: str(resume.taskId) } : {})
    }
  };
}

function coerceItem(raw: unknown): MailItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (typeof r.conversationId !== 'string' || !r.conversationId) return null;
  if (typeof r.from !== 'string' || !r.from) return null;
  const to = Array.isArray(r.to) ? r.to.filter((t): t is string => typeof t === 'string' && !!t) : [];
  if (!to.length) return null;
  const item: MailItem = {
    id: r.id,
    conversationId: r.conversationId,
    from: r.from,
    to,
    body: typeof r.body === 'string' ? r.body : '',
    at: num(r.at) ?? 0
  };
  if (typeof r.taskId === 'string' && r.taskId) item.taskId = r.taskId;
  if (typeof r.runThreadId === 'string' && r.runThreadId) item.runThreadId = r.runThreadId;
  if (typeof r.subject === 'string' && r.subject) item.subject = r.subject;
  if (typeof r.result === 'string' && r.result) item.result = r.result;
  if (r.stale === true) item.stale = true;
  if (Array.isArray(r.agentReplies)) {
    const replies = r.agentReplies.filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (replies.length) item.agentReplies = replies;
  }
  if (Array.isArray(r.images)) {
    const images = r.images.flatMap((raw): GeneratedImageRef[] => {
      const img = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
      if (!img || typeof img.id !== 'string' || typeof img.threadId !== 'string') return [];
      return [
        {
          id: img.id,
          threadId: img.threadId,
          mime: typeof img.mime === 'string' ? img.mime : 'image/png',
          ...(num(img.width) !== undefined ? { width: num(img.width) } : {}),
          ...(num(img.height) !== undefined ? { height: num(img.height) } : {}),
          ...(typeof img.prompt === 'string' ? { prompt: img.prompt } : {}),
          ...(typeof img.revisedPrompt === 'string' ? { revisedPrompt: img.revisedPrompt } : {})
        }
      ];
    });
    if (images.length) item.images = images;
  }
  const sys = coerceSystemVersion(r.sys);
  if (sys) item.sys = sys;
  const approval = coerceApproval(r.approval);
  if (approval) item.approval = approval;
  if (Array.isArray(r.attachments)) {
    const attachments = r.attachments.flatMap((a) => {
      if (!a || typeof a !== 'object') return [];
      const att = a as Record<string, unknown>;
      const kind = att.kind === 'image' ? ('image' as const) : att.kind === 'file' ? ('file' as const) : null;
      if (!kind) return [];
      return [
        {
          kind,
          ...(typeof att.name === 'string' ? { name: att.name } : {}),
          ...(typeof att.mime === 'string' ? { mime: att.mime } : {}),
          ...(typeof att.dataUrl === 'string' ? { dataUrl: att.dataUrl } : {})
        }
      ];
    });
    if (attachments.length) item.attachments = attachments;
  }
  return item;
}

/**
 * Conversation ids THIS process marked working. The set — not the file — is
 * the authority on "a delivery is in flight": ids enter on
 * setConversationStatus(id, 'working') and leave on any other status (or the
 * conversation's deletion), so a restart empties it naturally.
 */
const liveWorking = new Set<string>();

function coerceConversation(raw: unknown): MailConversation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return null;
  const participants = Array.isArray(r.participants)
    ? r.participants.filter((p): p is string => typeof p === 'string' && !!p)
    : [];
  if (!participants.length) return null;
  const sessions: Record<string, string> = {};
  if (r.sessions && typeof r.sessions === 'object') {
    for (const [personaId, threadId] of Object.entries(r.sessions as Record<string, unknown>)) {
      if (typeof threadId === 'string' && threadId) sessions[personaId] = threadId;
    }
  }
  // A 'working' status is in-memory truth about a delivery in flight: it
  // survives the file round-trip only while THIS process holds the flag (see
  // liveWorking). After a restart nothing is in flight, and a stale flag from
  // a previous process must not spin the row forever — and, just as important,
  // an unrelated write (marking a mail read) re-serializes every conversation,
  // so an unconditional flip here would silently erase a LIVE working status:
  // exactly the bug where a runaway thread showed idle while its turns ran.
  const rawStatus =
    r.status === 'working' || r.status === 'awaiting-user' || r.status === 'failed' || r.status === 'aborted'
      ? r.status
      : 'idle';
  const status = rawStatus === 'working' && !liveWorking.has(r.id) ? 'idle' : rawStatus;
  const sendCounts: Record<string, number> = {};
  if (r.sendCounts && typeof r.sendCounts === 'object') {
    for (const [personaId, count] of Object.entries(r.sendCounts as Record<string, unknown>)) {
      const n = num(count);
      if (n !== undefined && n > 0) sendCounts[personaId] = n;
    }
  }
  const agents = coerceAgents(r.agents);
  return {
    id: r.id,
    // Cleaned on READ, not only on write: subjects stored before the hygiene
    // existed (or written by an older server) heal the next time the store is
    // served, and persist healed on the next write. One that cleans to ''
    // gets re-derived from its items in coerce(), where the items are known.
    subject: cleanMailSubject(typeof r.subject === 'string' ? r.subject : ''),
    participants,
    sessions,
    ...(agents.length ? { agents } : {}),
    ...(r.private === true ? { private: true as const } : {}),
    status,
    exchangeCount: num(r.exchangeCount) ?? 0,
    sendCounts,
    updatedAt: num(r.updatedAt) ?? 0,
    userUpdatedAt: num(r.userUpdatedAt) ?? 0,
    userSentAt: num(r.userSentAt) ?? 0,
    createdAt: num(r.createdAt) ?? 0
  };
}

function coerceAgents(raw: unknown): MailAgent[] {
  if (!Array.isArray(raw)) return [];
  const agents: MailAgent[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as Record<string, unknown>;
    if (typeof a.id !== 'string' || typeof a.role !== 'string' || typeof a.name !== 'string') continue;
    if (typeof a.spawnedBy !== 'string' || !a.id || agents.some((x) => x.id === a.id)) continue;
    agents.push({
      id: a.id,
      role: a.role,
      name: a.name,
      spawnedBy: a.spawnedBy,
      ...(a.blind === true ? { blind: true as const } : {})
    });
  }
  return agents;
}

function coerceEntry(raw: unknown): InboxEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const entry: InboxEntry = {};
  const readAt = num(r.readAt);
  if (readAt !== undefined) entry.readAt = readAt;
  const archivedAt = num(r.archivedAt);
  if (archivedAt !== undefined) entry.archivedAt = archivedAt;
  const snoozedAt = num(r.snoozedAt);
  if (snoozedAt !== undefined) entry.snoozedAt = snoozedAt;
  const snoozedUntil = num(r.snoozedUntil);
  if (snoozedUntil !== undefined) entry.snoozedUntil = snoozedUntil;
  if (r.forcedUnread === true) entry.forcedUnread = true;
  return Object.keys(entry).length ? entry : null;
}

function coerce(parsed: unknown): MailFile {
  const raw = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const conversations: MailConversation[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw.conversations) ? raw.conversations : []) {
    const conversation = coerceConversation(entry);
    if (conversation && !seen.has(conversation.id)) {
      seen.add(conversation.id);
      conversations.push(conversation);
    }
  }
  const items: MailItem[] = [];
  const byId = new Map(conversations.map((c) => [c.id, c] as const));
  for (const entry of Array.isArray(raw.items) ? raw.items : []) {
    const item = coerceItem(entry);
    if (item && seen.has(item.conversationId)) {
      items.push(item);
      // Backfill userSentAt for stores written before the field existed — the
      // items are the full history, so the derivation is exact.
      if (item.from === 'user') {
        const c = byId.get(item.conversationId);
        if (c && item.at > c.userSentAt) c.userSentAt = item.at;
      }
    }
  }
  // A conversation whose stored subject was blank or pure markup gets one
  // derived from its first mail — the user's if there is one, else whatever
  // opened the thread — so a leaked-markup subject heals into a real name
  // rather than a shrug. A stored literal NO_SUBJECT is left alone: it was
  // written deliberately, for a mail whose body offered nothing either.
  for (const conversation of conversations) {
    if (conversation.subject) continue;
    // Oldest first, user mail before persona traffic — and skipping mails
    // whose body derives to nothing (attachments-only), so one early photo
    // does not doom the conversation to the shrug.
    const ofConversation = items.filter((i) => i.conversationId === conversation.id);
    const derived = [...ofConversation.filter((i) => i.from === 'user'), ...ofConversation]
      .map((i) => deriveMailSubject(i.body))
      .find(Boolean);
    conversation.subject = derived || NO_SUBJECT;
  }
  const inboxRaw = (raw.inbox && typeof raw.inbox === 'object' ? raw.inbox : {}) as Record<string, unknown>;
  const entries: Record<string, InboxEntry> = {};
  if (inboxRaw.entries && typeof inboxRaw.entries === 'object') {
    for (const [id, value] of Object.entries(inboxRaw.entries as Record<string, unknown>)) {
      const entry = coerceEntry(value);
      if (entry && seen.has(id)) entries[id] = entry;
    }
  }
  const subjectPassAt = num(raw.subjectPassAt);
  return {
    version: 1,
    conversations,
    items,
    // Mail starts empty on every install, so unlike the chat Inbox there is no
    // wall-of-unread problem to baseline away — 0 keeps every real mail bold.
    inbox: { baseline: num(inboxRaw.baseline) ?? 0, entries },
    ...(subjectPassAt !== undefined ? { subjectPassAt } : {})
  };
}

// Observers run only after durable writes. Triage changes need the same push
// as router deliveries so every paired client sees the same Inbox.
const changeListeners = new Set<() => void>();
const receivedListeners = new Set<(item: MailItem) => void>();
export function onMailChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}
export function onMailReceived(listener: (item: MailItem) => void): () => void {
  receivedListeners.add(listener);
  return () => { receivedListeners.delete(listener); };
}
function announce<T>(listeners: Set<(value: T) => void>, value: T): void {
  for (const listener of listeners) {
    try { listener(value); } catch (error) { degrade('mail', 'a mail observer failed after the write', error); }
  }
}

// Serialize writes through a promise chain so concurrent IPC calls and the
// router's delivery bookkeeping can't interleave a read-modify-write.
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeFileAtomic(store: MailFile): Promise<void> {
  const path = mailStorePath();
  // quiet: the write below is the one that has to land, and it rejects to the
  // mutator that called this if the directory really is not there.
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  // rename is atomic on the same volume — readers never see a half-written file.
  await rename(tmp, path);
}

async function readFileStore(): Promise<MailFile> {
  try {
    return coerce(JSON.parse(await readFile(mailStorePath(), 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      // Corrupt/unreadable: degrade to an empty Inbox rather than throwing —
      // and leave the file alone (see update below) so it stays fixable.
      degrade('mail', 'served an empty mail store', err);
    }
    return coerce({});
  }
}

function asResult(store: MailFile): MailListResult {
  // `sys` is the serving process's version, so a client can tell which items
  // the personas AS THEY ARE NOW produced (shared/sys-version.ts sameSystem).
  return { conversations: store.conversations, items: store.items, inbox: store.inbox, sys: systemVersion() };
}

export function readMail(): Promise<MailListResult> {
  return enqueue(async () => asResult(await readFileStore()));
}

/**
 * Read, mutate, persist atomically. All public mutators funnel through here.
 * A mutator returning `false` changed nothing: no write, no change event.
 */
function update(mutate: (store: MailFile) => void | false): Promise<MailListResult> {
  return enqueue(async () => {
    let store: MailFile;
    try {
      store = coerce(JSON.parse(await readFile(mailStorePath(), 'utf8')));
    } catch (err) {
      // Refuse to write over a file that exists but can't be read — one failed
      // action beats silently replacing every conversation. (ENOENT is the
      // first write on a fresh install, where an empty store is the truth.)
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        degrade('mail', 'refused to write mail over a file it could not read', err);
        throw err;
      }
      store = coerce({});
    }
    if (mutate(store) === false) return asResult(store);
    await writeFileAtomic(store);
    announce(changeListeners, undefined);
    return asResult(store);
  });
}

function conversationOf(store: MailFile, id: string): MailConversation {
  const conversation = store.conversations.find((c) => c.id === id);
  if (!conversation) throw new Error('That mail conversation no longer exists.');
  return conversation;
}

/**
 * Create a conversation (no items yet). `participants[0]` is the driver.
 * `bodyForSubject` is the first mail's body, the fallback a blank (or
 * markup-only) subject is derived from — see shared/mail-subject.
 */
export function createConversation(
  subject: string,
  participants: string[],
  bodyForSubject = '',
  opts: { private?: boolean } = {}
): Promise<MailConversation> {
  const conversation: MailConversation = {
    id: randomUUID(),
    subject: resolveMailSubject(subject, bodyForSubject),
    participants,
    sessions: {},
    ...(opts.private ? { private: true as const } : {}),
    status: 'idle',
    exchangeCount: 0,
    sendCounts: {},
    updatedAt: Date.now(),
    userUpdatedAt: 0,
    userSentAt: 0,
    createdAt: Date.now()
  };
  return update((store) => {
    store.conversations.push(conversation);
  }).then(() => conversation);
}

/**
 * A cap refused an append. Typed so the router can answer the racing sender
 * with the same friendly copy its pre-check would have used — with deliveries
 * running in parallel, two sends can both pass the router's read-then-refuse
 * check, and only this in-store check is authoritative.
 */
export class CapError extends Error {
  constructor(readonly kind: 'exchange' | 'budget') {
    super(kind === 'exchange' ? 'The exchange cap is used up.' : 'The send budget is used up.');
    this.name = 'CapError';
  }
}

/**
 * Append one item, stamping the conversation's activity clocks: `updatedAt`
 * always, `userUpdatedAt` only when the item addresses the user (that is the
 * unread/placement input), `exchangeCount`/`sendCounts` only for
 * persona→persona mail — and a mail FROM the user resets both: each user send
 * buys the personas a fresh window of exchanges (the caps guard one runaway
 * wave, not the conversation's lifetime).
 *
 * `guard` makes the caps part of the same atomic read-modify-write: the append
 * throws CapError instead of landing when the wave's global cap (or the
 * sender's own budget) would overflow. `budgetExempt` marks an implicit reply
 * to the turn's initiator — exempt from the sender's budget (a capped persona
 * can always finish its assignment) but still spending the global cap.
 *
 * `staleIfUserSentAfter` is the userSentAt of the user mail this reply answers:
 * checked here, inside the atomic write, so a user reply racing the append
 * cannot slip between a read and the stamp. A persona→user item landing after
 * a NEWER user send is marked stale — it answers an earlier message.
 */
export function appendMailItem(
  input: Omit<MailItem, 'id' | 'at'> & {
    at?: number;
    guard?: { exchangeCap: number; senderBudget?: number; budgetExempt?: boolean };
    staleIfUserSentAfter?: number;
  }
): Promise<MailListResult> {
  const { guard, staleIfUserSentAfter, ...fields } = input;
  let appended: MailItem | undefined;
  return update((store) => {
    const conversation = conversationOf(store, fields.conversationId);
    // Every item carries the system version in force when it landed. For a
    // persona's reply that is the code that wrote it; for the user's mail it is
    // the code that will answer it. Callers never pass one — the stamp is the
    // store's, so an old item can only ever be missing it, never mis-stamped.
    const item: MailItem = { ...fields, id: randomUUID(), at: fields.at ?? Date.now(), sys: systemVersion() };
    if (
      staleIfUserSentAfter !== undefined &&
      item.from !== 'user' &&
      item.to.includes('user') &&
      conversation.userSentAt > staleIfUserSentAfter
    ) {
      item.stale = true;
    }
    // Every persona recipient of a persona's mail spends cap budget — counting
    // only pure persona→persona items would let a CC to the user launder the
    // hop past the runaway guard.
    const hops = item.from === 'user' ? 0 : item.to.filter((t) => t !== 'user').length;
    if (guard && hops > 0) {
      if (conversation.exchangeCount + hops > guard.exchangeCap) throw new CapError('exchange');
      if (guard.senderBudget !== undefined && !guard.budgetExempt) {
        const spent = conversation.sendCounts[item.from] ?? 0;
        if (spent + hops > guard.senderBudget) throw new CapError('budget');
      }
    }
    store.items.push(item);
    appended = item;
    conversation.updatedAt = item.at;
    if (item.from === 'user') {
      conversation.exchangeCount = 0;
      conversation.sendCounts = {};
      conversation.userSentAt = item.at;
    }
    if (item.to.includes('user')) conversation.userUpdatedAt = item.at;
    if (hops > 0) {
      conversation.exchangeCount += hops;
      if (!guard?.budgetExempt) {
        conversation.sendCounts[item.from] = (conversation.sendCounts[item.from] ?? 0) + hops;
      }
    }
  }).then((result) => {
    if (appended && appended.from !== 'user' && appended.to.includes('user')) announce(receivedListeners, appended);
    return result;
  });
}

/** Grow a conversation's participant set (the user's add control). Idempotent. */
export function addParticipant(conversationId: string, personaId: string): Promise<MailListResult> {
  return update((store) => {
    const conversation = conversationOf(store, conversationId);
    if (!conversation.participants.includes(personaId)) conversation.participants.push(personaId);
  });
}

/**
 * Record an agent started in a conversation (spawn_agent). Refuses a second
 * agent under the same id — the caller checks first and says why; this is the
 * race backstop.
 */
export function addAgent(conversationId: string, agent: MailAgent): Promise<MailListResult> {
  return update((store) => {
    const conversation = conversationOf(store, conversationId);
    const agents = conversation.agents ?? [];
    if (agents.some((a) => a.id === agent.id)) throw new Error(`An agent named "${agent.name}" already exists here.`);
    conversation.agents = [...agents, agent];
  });
}

export function setConversationStatus(
  id: string,
  status: MailConversation['status']
): Promise<MailListResult> {
  // The flag flips INSIDE the serialized write, never ahead of it: flipped at
  // call time, a read already queued before this write coerced the still-stored
  // 'working' to idle — a conversation with its failure mail on file and an
  // idle row, for one poll. Together, the file and the flag change as one.
  return update((store) => {
    conversationOf(store, id).status = status;
    if (status === 'working') liveWorking.add(id);
    else liveWorking.delete(id);
  });
}

/** Retitle a conversation — a scheduled task's latest firing names its thread. */
export function setConversationSubject(id: string, subject: string): Promise<MailListResult> {
  return update((store) => {
    conversationOf(store, id).subject = subject;
  });
}

/**
 * Swap a subject Stem made up for a written one — but only while the stored
 * subject is still `expected`, checked inside the atomic write: a model call
 * takes seconds, and a subject changed meanwhile (a task headline, a future
 * rename) is not ours to overwrite. True when the swap landed.
 */
export async function replaceMailSubject(id: string, expected: string, subject: string): Promise<boolean> {
  let replaced = false;
  await update((store) => {
    const conversation = store.conversations.find((c) => c.id === id);
    if (!conversation || conversation.subject !== expected || conversation.subject === subject) return false;
    conversation.subject = subject;
    replaced = true;
  });
  return replaced;
}

/** Whether the one-time subject pass has already run on this store. */
export function mailSubjectPassDone(): Promise<boolean> {
  return enqueue(async () => (await readFileStore()).subjectPassAt !== undefined);
}

/** Record the one-time subject pass as run, so no later boot repeats it. */
export async function markMailSubjectPassDone(): Promise<void> {
  await update((store) => {
    if (store.subjectPassAt !== undefined) return false;
    store.subjectPassAt = Date.now();
  });
}

/**
 * Attach a scheduled run's final reply to the notification it sent mid-run.
 * The reply lands after the mail did, so the conversation's activity clocks
 * move with it: a user who read the one-line notice before the report arrived
 * sees the conversation unread again, which is what happened. No `received`
 * announcement — the notify already pushed, and this is the same mail.
 */
export function setMailItemResult(itemId: string, result: string, images?: GeneratedImageRef[]): Promise<MailListResult> {
  return update((store) => {
    const item = store.items.find((i) => i.id === itemId);
    if (!item) throw new Error('That mail no longer exists.');
    if (result) item.result = result;
    // Pictures the run made after its notify ride with the result.
    if (images?.length) {
      const have = new Set((item.images ?? []).map((i) => i.id));
      item.images = [...(item.images ?? []), ...images.filter((i) => !have.has(i.id))];
    }
    const conversation = conversationOf(store, item.conversationId);
    const at = Date.now();
    conversation.updatedAt = Math.max(conversation.updatedAt, at);
    if (item.to.includes('user')) conversation.userUpdatedAt = Math.max(conversation.userUpdatedAt, at);
  });
}

/**
 * Settle a parked run's approval item, once: only a pending one changes, so a
 * second answer (two clients, a double tap) finds it settled and is refused.
 * Returns the approval as it was while pending, or null when it was not.
 */
export async function settleMailApproval(itemId: string, status: Exclude<MailApprovalStatus, 'pending'>): Promise<MailApproval | null> {
  let settled: MailApproval | null = null;
  await update((store) => {
    const item = store.items.find((i) => i.id === itemId);
    if (!item?.approval || item.approval.status !== 'pending') return;
    settled = { ...item.approval };
    item.approval = { ...item.approval, status };
    const conversation = conversationOf(store, item.conversationId);
    conversation.updatedAt = Math.max(conversation.updatedAt, Date.now());
  });
  return settled;
}

/** Record the hidden pi thread a persona's deliveries run in. */
export function setConversationSession(
  id: string,
  personaId: string,
  threadId: string
): Promise<MailListResult> {
  return update((store) => {
    conversationOf(store, id).sessions[personaId] = threadId;
  });
}

/**
 * Every thread mail owns: persona sessions behind conversations, and the
 * threads scheduled runs left behind on their mail items. The chat list
 * filters these out — the Inbox is where they show.
 */
export async function mailSessionThreadIds(): Promise<Set<string>> {
  const { conversations, items } = await readMail();
  const ids = new Set<string>();
  for (const c of conversations) for (const threadId of Object.values(c.sessions)) ids.add(threadId);
  for (const item of items) if (item.runThreadId) ids.add(item.runThreadId);
  return ids;
}

/**
 * The threads a scheduled task's runs left behind (one per mail-sending
 * firing), for deletion when the TASK goes. The mail stays, and so does its
 * Work record — only the transcript nobody can reach any more is dropped. The
 * ids come off the items too, so a second call answers nothing.
 */
export async function taskRunThreadIds(taskId: string): Promise<string[]> {
  const ids: string[] = [];
  await update((store) => {
    for (const item of store.items) {
      if (item.taskId !== taskId || !item.runThreadId) continue;
      ids.push(item.runThreadId);
      delete item.runThreadId;
    }
  });
  return ids;
}

/**
 * What a scheduled task's earlier runs mailed the user, newest first, at most
 * `limit` of them: each firing's headline, notify line and attached reply. The
 * next run reads this instead of a thread history it no longer has, so a watch
 * task reports each finding once. The user's own mails in the conversation are
 * not the task's reports and stay out.
 */
export async function taskMailHistory(taskId: string, limit: number): Promise<ScheduledRunReport[]> {
  const { conversations, items } = await readMail();
  const subjectOf = new Map(conversations.map((c) => [c.id, c.subject]));
  return items
    .filter((i) => i.taskId === taskId && i.from !== 'user')
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((i) => ({
      at: i.at,
      headline: i.subject ?? subjectOf.get(i.conversationId) ?? '',
      body: i.body,
      ...(i.result ? { reply: i.result } : {})
    }));
}

/** Delete a conversation + its items + triage state. Returns the orphaned thread ids. */
export async function deleteConversation(id: string): Promise<{ result: MailListResult; threadIds: string[] }> {
  let threadIds: string[] = [];
  liveWorking.delete(id);
  const result = await update((store) => {
    const conversation = store.conversations.find((c) => c.id === id);
    threadIds = conversation ? Object.values(conversation.sessions) : [];
    // A scheduled run's thread goes with the mail that kept it.
    for (const item of store.items) if (item.conversationId === id && item.runThreadId) threadIds.push(item.runThreadId);
    store.conversations = store.conversations.filter((c) => c.id !== id);
    store.items = store.items.filter((i) => i.conversationId !== id);
    delete store.inbox.entries[id];
  });
  return { result, threadIds };
}

// ---- triage (read / archive / snooze), keyed by conversation id ----
// Mirrors workspace/inbox.ts exactly; the renderer's optimistic patches
// (shared/inbox.ts withRead/withArchived/withSnooze) apply unchanged.

function entryOf(store: MailFile, id: string): InboxEntry {
  const existing = store.inbox.entries[id];
  if (existing) return existing;
  const fresh: InboxEntry = {};
  store.inbox.entries[id] = fresh;
  return fresh;
}

function prune(store: MailFile, id: string): void {
  const entry = store.inbox.entries[id];
  if (entry && Object.keys(entry).length === 0) delete store.inbox.entries[id];
}

export function setMailArchived(ids: string[], archived: boolean): Promise<MailListResult> {
  const now = Date.now();
  return update((store) => {
    for (const id of ids) {
      const entry = entryOf(store, id);
      if (archived) {
        entry.archivedAt = now;
        delete entry.snoozedAt;
        delete entry.snoozedUntil;
      } else {
        delete entry.archivedAt;
      }
      prune(store, id);
    }
  });
}

export function setMailSnooze(ids: string[], until: number | null): Promise<MailListResult> {
  const now = Date.now();
  return update((store) => {
    for (const id of ids) {
      const entry = entryOf(store, id);
      if (until != null && until > now) {
        entry.snoozedAt = now;
        entry.snoozedUntil = until;
        delete entry.archivedAt;
      } else {
        delete entry.snoozedAt;
        delete entry.snoozedUntil;
      }
      prune(store, id);
    }
  });
}

export function setMailRead(ids: string[], read: boolean): Promise<MailListResult> {
  const now = Date.now();
  return update((store) => {
    for (const id of ids) {
      const entry = entryOf(store, id);
      if (read) {
        const conversation = store.conversations.find((c) => c.id === id);
        // Cover the conversation's own stamp when it sits in the future
        // relative to `now` — the chat Inbox's clock-skew guard, per row.
        entry.readAt = Math.max(now, toMs(conversation?.userUpdatedAt ?? 0));
        delete entry.forcedUnread;
      } else {
        entry.forcedUnread = true;
      }
      prune(store, id);
    }
  });
}
