import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { InboxEntry, InboxState } from '../../shared/inbox';
import { toMs } from '../../shared/inbox';
import { cleanMailSubject, deriveMailSubject, NO_SUBJECT, resolveMailSubject } from '../../shared/mail-subject';
import {
  isExternalAddress,
  type GeneratedImageRef,
  type MailApproval,
  type MailApprovalStatus,
  type MailAgent,
  type MailConversation,
  type MailExternal,
  type MailCollab,
  type MailExternalThread,
  type MailItem,
  type MailListResult,
  type ScheduledRunReport,
  type SystemVersion
} from '../../shared/types';
import { coerceSystemVersion } from '../../shared/sys-version';
import { systemVersion } from '../sys-version';
import { degrade } from '../degrade';
import { mailStorePath } from './paths';
import { replaceFile } from '../replace-file';

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
    kind: a.kind === 'harness' ? 'harness' : a.kind === 'send' ? 'send' : 'exec',
    command: a.command,
    ...(str(a.to) ? { to: str(a.to) } : {}),
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
  // Cleaned on read like the conversation's subject: a per-mail subject is a
  // model-written line too (a run's headline), and rows print it as text.
  const subject = typeof r.subject === 'string' ? cleanMailSubject(r.subject) : '';
  if (subject) item.subject = subject;
  if (typeof r.result === 'string' && r.result) item.result = r.result;
  if (r.stale === true) item.stale = true;
  if (r.filed === true) item.filed = true;
  if (r.statusQuery === true) item.statusQuery = true;
  if (r.statusReply === true) item.statusReply = true;
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
  const external = coerceExternal(r.external);
  if (external) item.external = external;
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
          ...(typeof att.dataUrl === 'string' ? { dataUrl: att.dataUrl } : {}),
          ...(typeof att.fileId === 'string' && /^[0-9a-f]{32}$/.test(att.fileId) ? { fileId: att.fileId } : {}),
          ...(num(att.size) !== undefined ? { size: num(att.size) } : {})
        }
      ];
    });
    if (attachments.length) item.attachments = attachments;
  }
  return item;
}

const EXTERNAL_STATUSES = ['queued', 'sent', 'delivered', 'expired', 'failed', 'unreachable', 'key-changed', 'waiting', 'joined'] as const;

function coerceExternal(raw: unknown): MailExternal | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: MailExternal = {};
  if (typeof r.envelopeId === 'string' && r.envelopeId) out.envelopeId = r.envelopeId;
  if (r.held === true) out.held = true;
  if (r.keyChanged === true) out.keyChanged = true;
  if (r.unsupported === true) out.unsupported = true;
  if (EXTERNAL_STATUSES.includes(r.status as (typeof EXTERNAL_STATUSES)[number])) out.status = r.status as MailExternal['status'];
  if (typeof r.error === 'string' && r.error) out.error = r.error;
  return out;
}

function coerceCollab(raw: unknown): MailCollab | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.goal !== 'string' || typeof r.basedOn !== 'string') return undefined;
  const lines = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 8) : []);
  return {
    goal: r.goal,
    agreed: lines(r.agreed),
    open: lines(r.open),
    ...(typeof r.next === 'string' && r.next ? { next: r.next } : {}),
    basedOn: r.basedOn,
    updatedAt: num(r.updatedAt) ?? 0
  };
}

/** Store where a conversation with another person stands (interstem/collab.ts). */
export function setConversationCollab(id: string, collab: MailCollab): Promise<MailListResult> {
  return update((store) => {
    const conversation = store.conversations.find((c) => c.id === id);
    if (!conversation?.external) return false;
    conversation.collab = collab;
  });
}

function coerceExternalThread(raw: unknown): MailExternalThread | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.address !== 'string' || !isExternalAddress(r.address)) return undefined;
  if (typeof r.thread !== 'string' || !/^[0-9a-f]{32}$/.test(r.thread)) return undefined;
  if (typeof r.self !== 'string' || !isExternalAddress(r.self)) return undefined;
  return { address: r.address, thread: r.thread, self: r.self };
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
  const external = coerceExternalThread(r.external);
  // An inter-Stem conversation starts with no personas: the user handles it
  // until they bring one in to draft.
  if (!participants.length && !external) return null;
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
    ...(r.owner === 'memory-check' ? { owner: 'memory-check' as const } : {}),
    ...(external ? { external } : {}),
    ...(coerceCollab(r.collab) ? { collab: coerceCollab(r.collab)! } : {}),
    ...(r.outside && typeof r.outside === 'object' && isExternalAddress(String((r.outside as { address?: unknown }).address ?? ''))
      ? { outside: { address: String((r.outside as { address: string }).address) } }
      : {}),
    status,
    exchangeCount: num(r.exchangeCount) ?? 0,
    sendCounts,
    updatedAt: num(r.updatedAt) ?? 0,
    userUpdatedAt: num(r.userUpdatedAt) ?? 0,
    userSentAt: num(r.userSentAt) ?? 0,
    ...(num(r.userAnsweredAt) !== undefined ? { userAnsweredAt: num(r.userAnsweredAt) } : {}),
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
      ...(a.blind === true ? { blind: true as const } : {}),
      ...(typeof a.model === 'string' && a.model ? { model: a.model } : {})
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
  // Conversations stored before userSentAt existed, to backfill from their items.
  const legacy = new Set<string>();
  for (const entry of Array.isArray(raw.conversations) ? raw.conversations : []) {
    const conversation = coerceConversation(entry);
    if (conversation && !seen.has(conversation.id)) {
      seen.add(conversation.id);
      conversations.push(conversation);
      if (num((entry as Record<string, unknown>).userSentAt) === undefined) legacy.add(conversation.id);
    }
  }
  const items: MailItem[] = [];
  const byId = new Map(conversations.map((c) => [c.id, c] as const));
  for (const entry of Array.isArray(raw.items) ? raw.items : []) {
    const item = coerceItem(entry);
    if (item && seen.has(item.conversationId)) {
      items.push(item);
      // Backfill userSentAt for stores written before the field existed — the
      // items are the full history, so the derivation is exact. Only those: a
      // stored value is authoritative, because a user mail can land without
      // counting as a send (appendMailItem's deferUserSend).
      if (item.from === 'user' && legacy.has(item.conversationId) && !item.statusQuery) {
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
  await replaceFile(tmp, path);
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

/** How much of a mail body a summary keeps: enough for a two-line row preview. */
const SUMMARY_BODY_CHARS = 400;

/**
 * The list without the mail: every conversation and the inbox state, plus per
 * conversation only the mails a list row needs (the newest the user sent or
 * received, for the preview, and the user's newest send, for Sent's order),
 * bodies cut to a preview and the heavy fields dropped. A phone reads this on
 * every launch and every mail:changed; the whole store was 1.3 MB by October
 * and growing with every mail. A conversation's own mails come from
 * readMailConversation when it is opened.
 */
export function readMailSummary(): Promise<MailListResult> {
  return enqueue(async () => {
    const store = await readFileStore();
    const preview = new Map<string, MailItem>();
    const sent = new Map<string, MailItem>();
    for (const item of store.items) {
      if (item.from === 'user' || item.to.includes('user')) {
        const cur = preview.get(item.conversationId);
        if (!cur || item.at >= cur.at) preview.set(item.conversationId, item);
      }
      if (item.from === 'user') {
        const cur = sent.get(item.conversationId);
        if (!cur || item.at >= cur.at) sent.set(item.conversationId, item);
      }
    }
    const keep = new Set([...preview.values(), ...sent.values()]);
    const items = store.items
      .filter((item) => keep.has(item))
      .map((item): MailItem => ({
        id: item.id,
        conversationId: item.conversationId,
        from: item.from,
        to: item.to,
        body: item.body.length > SUMMARY_BODY_CHARS ? item.body.slice(0, SUMMARY_BODY_CHARS) : item.body,
        at: item.at,
        ...(item.subject !== undefined ? { subject: item.subject } : {})
      }));
    return { ...asResult(store), items };
  });
}

/** One conversation and all of its mails, whole: what opening it shows. */
export function readMailConversation(
  conversationId: string
): Promise<{ conversation: MailConversation | null; items: MailItem[]; sys: SystemVersion }> {
  return enqueue(async () => {
    const store = await readFileStore();
    return {
      conversation: store.conversations.find((c) => c.id === conversationId) ?? null,
      items: store.items.filter((item) => item.conversationId === conversationId),
      sys: systemVersion()
    };
  });
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
  opts: { private?: boolean; owner?: MailConversation['owner']; external?: MailExternalThread; outside?: { address: string } } = {}
): Promise<MailConversation> {
  const conversation: MailConversation = {
    id: randomUUID(),
    subject: resolveMailSubject(subject, bodyForSubject),
    participants,
    sessions: {},
    ...(opts.private ? { private: true as const } : {}),
    ...(opts.owner ? { owner: opts.owner } : {}),
    ...(opts.external ? { external: opts.external } : {}),
    ...(opts.outside ? { outside: opts.outside } : {}),
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
 * What one item spends of the exchange cap. Every persona recipient of a
 * persona's mail counts — counting only pure persona→persona items would let a
 * CC to the user launder the hop past the runaway guard — except an agent's
 * report to whoever started it: the brief or follow-up that asked for it
 * already paid, so a job of six agents costs six hops, not twelve.
 */
export function exchangeHops(
  conversation: Pick<MailConversation, 'agents'>,
  from: string,
  to: string[]
): number {
  if (from === 'user') return 0;
  const starter = conversation.agents?.find((a) => a.id === from)?.spawnedBy;
  // Mail to another Stem is the user's to send, never a hop between personas.
  return to.filter((t) => t !== 'user' && t !== starter && !isExternalAddress(t)).length;
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
 *
 * `deferUserSend` lands a user mail without counting it as a send yet: no
 * fresh exchange window, no new epoch for the stale check. The router uses it
 * for a mail that may turn out to be only a progress question (status-check),
 * and settles it with {@link settleUserSend} once it knows.
 */
export function appendMailItem(
  input: Omit<MailItem, 'id' | 'at'> & {
    at?: number;
    guard?: { exchangeCap: number; senderBudget?: number; budgetExempt?: boolean };
    staleIfUserSentAfter?: number;
    deferUserSend?: boolean;
  }
): Promise<MailListResult> {
  const { guard, staleIfUserSentAfter, deferUserSend, ...fields } = input;
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
    const hops = exchangeHops(conversation, item.from, item.to);
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
    if (item.from === 'user' && !deferUserSend) countUserSend(conversation, item.at);
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

/** A user send buys a fresh exchange window and becomes the stale check's epoch. */
function countUserSend(conversation: MailConversation, at: number): void {
  conversation.exchangeCount = 0;
  conversation.sendCounts = {};
  conversation.userSentAt = Math.max(conversation.userSentAt, at);
}

/**
 * Settle a user mail appended with `deferUserSend`: delivered to the personas
 * after all, it counts as the send it would have been; answered on the spot
 * as a progress question, it is marked so and never counts.
 */
export function settleUserSend(itemId: string, answeredAsStatus: boolean): Promise<MailListResult> {
  return update((store) => {
    const item = store.items.find((i) => i.id === itemId && i.from === 'user');
    if (!item) return;
    if (answeredAsStatus) item.statusQuery = true;
    else countUserSend(conversationOf(store, item.conversationId), item.at);
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
 * Replace a conversation's participant set (the reply box's To: field): the
 * first id drives. Sessions and send counts stay, so a persona dropped and
 * added back resumes its own thread. Duplicates collapse; an empty set is
 * refused (a conversation always has someone to answer the user).
 */
export function setParticipants(conversationId: string, personaIds: readonly string[]): Promise<MailListResult> {
  const next = [...new Set(personaIds)];
  if (!next.length) return Promise.reject(new Error('A conversation needs at least one persona.'));
  return update((store) => {
    conversationOf(store, conversationId).participants = next;
  });
}

/**
 * Hand a removed persona's seats to its successor (old -> new): each
 * conversation it was in gets the successor in its place, at the same position
 * so a driver stays the driver, and its session and send count are dropped so
 * the successor starts its own. Earlier mails keep their sender. Answers how
 * many conversations changed; no write when none did.
 */
export async function repointParticipants(successors: ReadonlyMap<string, string>): Promise<number> {
  let changed = 0;
  await update((store) => {
    for (const conversation of store.conversations) {
      if (!conversation.participants.some((p) => successors.has(p))) continue;
      const next: string[] = [];
      for (const p of conversation.participants) {
        const id = successors.get(p) ?? p;
        if (!next.includes(id)) next.push(id);
      }
      conversation.participants = next;
      for (const old of successors.keys()) {
        delete conversation.sessions[old];
        delete conversation.sendCounts[old];
      }
      changed++;
    }
    if (!changed) return false;
  });
  return changed;
}

/**
 * Record an agent started in a conversation (spawn_agent). The name and the
 * per-conversation limit are checked HERE, inside the serialized write: two
 * spawns racing in parallel turns both pass a check made on an earlier read,
 * and only this one sees the other's agent.
 */
export function addAgent(conversationId: string, agent: MailAgent, max: number): Promise<MailListResult> {
  return update((store) => {
    const conversation = conversationOf(store, conversationId);
    const agents = conversation.agents ?? [];
    if (agents.some((a) => a.name === agent.name)) {
      throw new Error(`An agent named ${agent.name} already exists in this conversation. Pick another name.`);
    }
    if (agents.length >= max) throw new Error(`This conversation already has ${max} agents, the most it may have.`);
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
 * Mark persona↔persona items filed (MailItem.filed): their deliveries were
 * dropped because the recipient had already answered for the wave. Unknown ids
 * are skipped — the conversation may have been deleted meanwhile.
 */
export function markMailItemsFiled(itemIds: string[]): Promise<MailListResult> {
  const ids = new Set(itemIds);
  return update((store) => {
    for (const item of store.items) if (ids.has(item.id)) item.filed = true;
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
    // Superseded/cancelled are Stem's housekeeping, not the user's answer.
    if (status === 'allowed' || status === 'denied') markAnswered(conversation);
    else conversation.updatedAt = Math.max(conversation.updatedAt, Date.now());
  });
  return settled;
}

// ---- inter-Stem mail ----

/** The conversation filed under a shared thread token with an external address. */
export async function findExternalConversation(thread: string, address: string, self: string): Promise<MailConversation | null> {
  const { conversations } = await readMail();
  return (
    conversations.find(
      (c) => c.external?.thread === thread && c.external.address === address && c.external.self === self
    ) ?? null
  );
}

/** Whether an inbound envelope is already stored (redelivery after a missed ack). */
export async function hasExternalEnvelope(envelopeId: string): Promise<boolean> {
  const { items } = await readMail();
  return items.some((i) => i.external?.envelopeId === envelopeId);
}

/**
 * Release a held inbound mail to the user's agents. Every held item in the
 * conversation up to and including this one is released together: the user
 * read them in order.
 */
export function releaseExternalItems(conversationId: string, upToItemId: string): Promise<MailListResult> {
  return update((store) => {
    const items = store.items.filter((i) => i.conversationId === conversationId);
    const idx = items.findIndex((i) => i.id === upToItemId);
    if (idx < 0) throw new Error('That mail no longer exists.');
    let changed = false;
    for (const item of items.slice(0, idx + 1)) {
      if (item.external?.held) {
        item.external = { ...item.external, held: false };
        delete item.external.held;
        changed = true;
      }
    }
    if (!changed) return false;
  });
}

/** Record an outbound send's progress on its item. */
export function setExternalStatus(itemId: string, patch: Partial<MailExternal>): Promise<MailListResult> {
  return update((store) => {
    const item = store.items.find((i) => i.id === itemId);
    if (!item) return false;
    const next: MailExternal = { ...item.external, ...patch };
    if (!patch.error && patch.status && patch.status !== 'failed' && patch.status !== 'unreachable') delete next.error;
    item.external = next;
  });
}

/**
 * Settle a persona's send draft, once. `body` is what the user actually
 * sent (they may have edited it). Returns the draft as it was while pending.
 */
export async function settleSendDraft(
  itemId: string,
  status: 'allowed' | 'denied',
  body?: string
): Promise<{ item: MailItem; approval: MailApproval } | null> {
  let settled: { item: MailItem; approval: MailApproval } | null = null;
  await update((store) => {
    const item = store.items.find((i) => i.id === itemId);
    if (item?.approval?.kind !== 'send' || item.approval.status !== 'pending') return false;
    settled = { item: { ...item }, approval: { ...item.approval } };
    item.approval = { ...item.approval, status, ...(body !== undefined ? { command: body } : {}) };
    markAnswered(conversationOf(store, item.conversationId));
  });
  return settled;
}

/** The user answered an approval item: the mail that asked is dealt with. */
function markAnswered(conversation: MailConversation): void {
  const now = Date.now();
  conversation.updatedAt = Math.max(conversation.updatedAt, now);
  conversation.userAnsweredAt = Math.max(conversation.userAnsweredAt ?? 0, now);
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
 * Mail threads no background learning pass may read: scheduled runs (one per
 * mail-sending firing; nobody watched them) and every thread of a private
 * conversation. Ordinary mail conversations are not in it.
 */
export async function threadsClosedToLearning(): Promise<Set<string>> {
  const { items, conversations } = await readMail();
  const ids = new Set<string>();
  for (const item of items) if (item.runThreadId) ids.add(item.runThreadId);
  // A private conversation's threads count as out of bounds too: its deliveries
  // capture nothing, so nothing should learn from them by another route.
  for (const c of conversations) if (c.private) for (const threadId of Object.values(c.sessions)) ids.add(threadId);
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
export async function taskMailHistory(
  taskId: string,
  limit: number,
  /**
   * The thread the task reports into, when it was scheduled from mail: earlier
   * tasks' reports there count too, so the next check in a chain of one-off
   * follow-ups knows what the previous checks already said.
   */
  conversationId?: string
): Promise<ScheduledRunReport[]> {
  const { conversations, items } = await readMail();
  const subjectOf = new Map(conversations.map((c) => [c.id, c.subject]));
  return items
    .filter(
      (i) =>
        i.from !== 'user' &&
        (i.taskId === taskId || (!!conversationId && !!i.taskId && i.conversationId === conversationId))
    )
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((i) => ({
      at: i.at,
      headline: i.subject ?? subjectOf.get(i.conversationId) ?? '',
      body: i.body,
      ...(i.result ? { reply: i.result } : {})
    }));
}

/**
 * The mail conversation a schedule_task call should report into: the one whose
 * persona session `threadId` is, the one a scheduled run in `threadId` already
 * mailed, or — for a run that has not mailed yet — wherever its task's earlier
 * firings went (`taskId`). Null for a plain chat.
 */
export async function mailConversationFor(threadId: string, taskId?: string): Promise<string | null> {
  const { conversations, items } = await readMail();
  const bySession = conversations.find((c) => Object.values(c.sessions).includes(threadId));
  if (bySession) return bySession.id;
  const byRun = items.find((i) => i.runThreadId === threadId) ?? (taskId ? items.find((i) => i.taskId === taskId) : undefined);
  return byRun && conversations.some((c) => c.id === byRun.conversationId) ? byRun.conversationId : null;
}

/**
 * The thread a picture was made in, when it reached `threadId` by mail: a
 * persona's mail carries the images its turn made (by id, the bytes stay in
 * the sender's session), so the recipient names an id its own thread never
 * held. Only mail the recipient's persona sent or was sent counts. Null when
 * no such mail carries `imageId`.
 */
export async function mailedImageThread(threadId: string, imageId: string): Promise<string | null> {
  const { conversations, items } = await readMail();
  for (const c of conversations) {
    const persona = Object.keys(c.sessions).find((p) => c.sessions[p] === threadId);
    if (!persona) continue;
    for (const item of items) {
      if (item.conversationId !== c.id) continue;
      if (item.from !== persona && !item.to.includes(persona)) continue;
      const hit = item.images?.find((img) => img.id === imageId);
      if (hit && hit.threadId !== threadId) return hit.threadId;
    }
  }
  return null;
}

/** Delete a conversation + its items + triage state. Returns the orphaned thread ids. */
export async function deleteConversation(id: string): Promise<{ result: MailListResult; threadIds: string[]; fileIds: string[] }> {
  let threadIds: string[] = [];
  let fileIds: string[] = [];
  liveWorking.delete(id);
  const result = await update((store) => {
    const conversation = store.conversations.find((c) => c.id === id);
    threadIds = conversation ? Object.values(conversation.sessions) : [];
    // A scheduled run's thread goes with the mail that kept it.
    for (const item of store.items) if (item.conversationId === id && item.runThreadId) threadIds.push(item.runThreadId);
    // Files in mail with another person (interstem/mail-files.ts) go too.
    fileIds = store.items.flatMap((i) => (i.conversationId === id ? (i.attachments ?? []).flatMap((a) => (a.fileId ? [a.fileId] : [])) : []));
    store.conversations = store.conversations.filter((c) => c.id !== id);
    store.items = store.items.filter((i) => i.conversationId !== id);
    delete store.inbox.entries[id];
  });
  return { result, threadIds, fileIds };
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
