import type { TurnAttachment } from '../../shared/types';
import type { StorageLike } from '../chats/return-chat';

// Unsent mail: one reply draft per conversation, and the one New mail draft.
//
// Kept outside React because the views that own them come and go — opening
// another conversation swaps the reply box, closing New mail unmounts the form
// — and a draft must never follow the user into a different conversation or
// vanish with a closed pane. Persisted to localStorage, unlike the chat
// composer's window-lifetime drafts: a mail is a longer piece of writing, and
// the Inbox shows the New mail draft as a row to come back to. Pasted bytes
// (base64 attachments) stay in memory only; storage is small.

export interface ReplyDraft {
  text: string;
  attachments: TurnAttachment[];
}

export interface ComposeDraft {
  /** Persona ids in selection order — the first one leads. */
  to: string[];
  subject: string;
  body: string;
  private: boolean;
  attachments: TurnAttachment[];
}

export const MAIL_DRAFTS_KEY = 'stem.mail.drafts';

const EMPTY_REPLY: ReplyDraft = { text: '', attachments: [] };
export const EMPTY_COMPOSE: ComposeDraft = { to: ['normal'], subject: '', body: '', private: false, attachments: [] };

interface Drafts {
  replies: Record<string, ReplyDraft>;
  compose: ComposeDraft | null;
  /** Who the last sent New mail (or forward) went to; a fresh New mail starts there. */
  lastTo: string[] | null;
}

let drafts: Drafts | null = null;
let storage: StorageLike | null = null;
const listeners = new Set<() => void>();

function store(): StorageLike | null {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function load(): Drafts {
  if (drafts) return drafts;
  drafts = { replies: {}, compose: null, lastTo: null };
  try {
    const raw = store()?.getItem(MAIL_DRAFTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Drafts>;
      if (parsed.replies && typeof parsed.replies === 'object') drafts.replies = parsed.replies;
      if (parsed.compose && typeof parsed.compose === 'object') drafts.compose = { ...EMPTY_COMPOSE, ...parsed.compose };
      if (Array.isArray(parsed.lastTo) && parsed.lastTo.every((id) => typeof id === 'string')) drafts.lastTo = parsed.lastTo;
    }
  } catch {
    // A corrupt or unreadable store costs the saved drafts, never the pane.
  }
  return drafts;
}

/** Only path attachments survive a restart; pasted bytes would overflow storage. */
const durable = (atts: TurnAttachment[]) => atts.filter((a) => a.path && !a.dataBase64);

function persist(): void {
  const d = load();
  const replies: Record<string, ReplyDraft> = {};
  for (const [id, r] of Object.entries(d.replies)) replies[id] = { text: r.text, attachments: durable(r.attachments) };
  const compose = d.compose && { ...d.compose, attachments: durable(d.compose.attachments) };
  try {
    store()?.setItem(MAIL_DRAFTS_KEY, JSON.stringify({ replies, compose, lastTo: d.lastTo }));
  } catch {
    // Best-effort: the in-memory copy still serves this window.
  }
}

function changed(): void {
  persist();
  for (const l of listeners) l();
}

export function subscribeMailDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readReplyDraft(conversationId: string): ReplyDraft {
  return load().replies[conversationId] ?? EMPTY_REPLY;
}

export function writeReplyDraft(conversationId: string, draft: ReplyDraft): void {
  const d = load();
  const empty = !draft.text.trim() && draft.attachments.length === 0;
  if (empty && !d.replies[conversationId]) return;
  const replies = { ...d.replies };
  if (empty) delete replies[conversationId];
  else replies[conversationId] = draft;
  drafts = { ...d, replies };
  changed();
}

/** The New mail draft, or null when there is nothing worth keeping. Stable between writes. */
export function readComposeDraft(): ComposeDraft | null {
  return load().compose;
}

export function writeComposeDraft(draft: ComposeDraft | null): void {
  const d = load();
  // To and Private alone are settings, not writing: they don't make a draft.
  const empty = !draft || (!draft.body.trim() && !draft.subject.trim() && draft.attachments.length === 0);
  if (empty && !d.compose) return;
  drafts = { ...d, compose: empty ? null : draft };
  changed();
}

/**
 * A blank New mail, addressed to whoever the last one went to. `known` is the
 * persona ids that still exist: a deleted persona drops out, and if nobody is
 * left the mail falls back to the default persona.
 */
export function freshCompose(known?: Set<string>): ComposeDraft {
  const last = (load().lastTo ?? []).filter((id) => !known || known.has(id));
  return last.length ? { ...EMPTY_COMPOSE, to: last } : EMPTY_COMPOSE;
}

/** Remember who a sent New mail went to, for the next one. */
export function rememberRecipients(to: string[]): void {
  if (!to.length) return;
  const d = load();
  if (d.lastTo && d.lastTo.length === to.length && d.lastTo.every((id, i) => id === to[i])) return;
  drafts = { ...d, lastTo: [...to] };
  changed();
}

/** Drop the reply drafts of conversations that no longer exist. */
export function pruneReplyDrafts(liveIds: Set<string>): void {
  const d = load();
  const stale = Object.keys(d.replies).filter((id) => !liveIds.has(id));
  if (!stale.length) return;
  const replies = { ...d.replies };
  for (const id of stale) delete replies[id];
  drafts = { ...d, replies };
  changed();
}

/** Test hook: start over against the given storage. */
export function resetMailDrafts(next: StorageLike | null = null): void {
  drafts = null;
  storage = next;
  listeners.clear();
}
