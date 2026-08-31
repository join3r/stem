import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { InboxEntry, InboxState } from '../../shared/inbox';
import { toMs } from '../../shared/inbox';
import type { MailConversation, MailItem, MailListResult } from '../../shared/types';
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
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
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
  return item;
}

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
  const status = r.status === 'working' || r.status === 'awaiting-user' ? r.status : 'idle';
  const sendCounts: Record<string, number> = {};
  if (r.sendCounts && typeof r.sendCounts === 'object') {
    for (const [personaId, count] of Object.entries(r.sendCounts as Record<string, unknown>)) {
      const n = num(count);
      if (n !== undefined && n > 0) sendCounts[personaId] = n;
    }
  }
  return {
    id: r.id,
    subject: typeof r.subject === 'string' ? r.subject : '',
    participants,
    sessions,
    // A 'working' status is in-memory truth about a delivery in flight; after a
    // restart nothing is in flight, so it must not survive the file round-trip
    // (the row would spin forever).
    status: status === 'working' ? 'idle' : status,
    exchangeCount: num(r.exchangeCount) ?? 0,
    sendCounts,
    updatedAt: num(r.updatedAt) ?? 0,
    userUpdatedAt: num(r.userUpdatedAt) ?? 0,
    createdAt: num(r.createdAt) ?? 0
  };
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
  for (const entry of Array.isArray(raw.items) ? raw.items : []) {
    const item = coerceItem(entry);
    if (item && seen.has(item.conversationId)) items.push(item);
  }
  const inboxRaw = (raw.inbox && typeof raw.inbox === 'object' ? raw.inbox : {}) as Record<string, unknown>;
  const entries: Record<string, InboxEntry> = {};
  if (inboxRaw.entries && typeof inboxRaw.entries === 'object') {
    for (const [id, value] of Object.entries(inboxRaw.entries as Record<string, unknown>)) {
      const entry = coerceEntry(value);
      if (entry && seen.has(id)) entries[id] = entry;
    }
  }
  return {
    version: 1,
    conversations,
    items,
    // Mail starts empty on every install, so unlike the chat Inbox there is no
    // wall-of-unread problem to baseline away — 0 keeps every real mail bold.
    inbox: { baseline: num(inboxRaw.baseline) ?? 0, entries }
  };
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
  return { conversations: store.conversations, items: store.items, inbox: store.inbox };
}

export function readMail(): Promise<MailListResult> {
  return enqueue(async () => asResult(await readFileStore()));
}

/** Read, mutate, persist atomically. All public mutators funnel through here. */
function update(mutate: (store: MailFile) => void): Promise<MailListResult> {
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
    mutate(store);
    await writeFileAtomic(store);
    return asResult(store);
  });
}

function conversationOf(store: MailFile, id: string): MailConversation {
  const conversation = store.conversations.find((c) => c.id === id);
  if (!conversation) throw new Error('That mail conversation no longer exists.');
  return conversation;
}

/** Create a conversation (no items yet). `participants[0]` is the driver. */
export function createConversation(subject: string, participants: string[]): Promise<MailConversation> {
  const conversation: MailConversation = {
    id: randomUUID(),
    subject: subject.trim() || '(no subject)',
    participants,
    sessions: {},
    status: 'idle',
    exchangeCount: 0,
    sendCounts: {},
    updatedAt: Date.now(),
    userUpdatedAt: 0,
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
 */
export function appendMailItem(
  input: Omit<MailItem, 'id' | 'at'> & {
    at?: number;
    guard?: { exchangeCap: number; senderBudget?: number; budgetExempt?: boolean };
  }
): Promise<MailListResult> {
  const { guard, ...fields } = input;
  return update((store) => {
    const conversation = conversationOf(store, fields.conversationId);
    const item: MailItem = { ...fields, id: randomUUID(), at: fields.at ?? Date.now() };
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
    conversation.updatedAt = item.at;
    if (item.from === 'user') {
      conversation.exchangeCount = 0;
      conversation.sendCounts = {};
    }
    if (item.to.includes('user')) conversation.userUpdatedAt = item.at;
    if (hops > 0) {
      conversation.exchangeCount += hops;
      if (!guard?.budgetExempt) {
        conversation.sendCounts[item.from] = (conversation.sendCounts[item.from] ?? 0) + hops;
      }
    }
  });
}

/** Grow a conversation's participant set (the add_persona tool). Idempotent. */
export function addParticipant(conversationId: string, personaId: string): Promise<MailListResult> {
  return update((store) => {
    const conversation = conversationOf(store, conversationId);
    if (!conversation.participants.includes(personaId)) conversation.participants.push(personaId);
  });
}

export function setConversationStatus(
  id: string,
  status: MailConversation['status']
): Promise<MailListResult> {
  return update((store) => {
    conversationOf(store, id).status = status;
  });
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

/** Every hidden persona thread id — the chat list filters these out. */
export async function mailSessionThreadIds(): Promise<Set<string>> {
  const { conversations } = await readMail();
  const ids = new Set<string>();
  for (const c of conversations) for (const threadId of Object.values(c.sessions)) ids.add(threadId);
  return ids;
}

/** Delete a conversation + its items + triage state. Returns the orphaned thread ids. */
export async function deleteConversation(id: string): Promise<{ result: MailListResult; threadIds: string[] }> {
  let threadIds: string[] = [];
  const result = await update((store) => {
    const conversation = store.conversations.find((c) => c.id === id);
    threadIds = conversation ? Object.values(conversation.sessions) : [];
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
