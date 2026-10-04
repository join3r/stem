import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { ChatPin, ChatPinInput, ChatPinKind, ChatPinPatch } from '../../shared/types';
import { chatPinsDbPath } from '../workspace/paths';

// The chat pinboards: what the user kept from each chat — a whole message, a
// passage of one, or a note of their own (docs/chat-pinboard-plan.md). Owns
// chat_pins.sqlite end-to-end, with the node:sqlite + WAL idioms of
// chatsearch/store.ts. Unlike that index this is the user's own data: nothing
// here can be rebuilt from the session files, so it travels with a state
// transfer (workspace/state-transfer.ts).
//
// A pin keeps a snapshot of its text rather than a pointer into the transcript.
// Retry, edit and delete-from-here rewrite the transcript under it; the pin still
// reads correctly and only loses its jump-to-source (the client decides that by
// looking for `anchor` among the chat's messages).
//
// node:sqlite is synchronous, so no write queue is needed. Ops here are tiny.

/** A note or a pinned passage is a few lines; a pinned message can be a long answer. */
export const MAX_PIN_TEXT = 20_000;
/** Labels are 2–4 words for the collapsed board; anything longer is not a label. */
export const MAX_PIN_LABEL = 60;
/** A board is something to glance at. Past this it has stopped being one. */
export const MAX_PINS_PER_CHAT = 100;

const KINDS: readonly ChatPinKind[] = ['message', 'passage', 'note'];

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  const handle = new DatabaseSync(chatPinsDbPath());
  handle.exec('PRAGMA journal_mode = WAL;');
  handle.exec(`
    CREATE TABLE IF NOT EXISTS pins (
      id           TEXT PRIMARY KEY,
      thread_id    TEXT NOT NULL,
      kind         TEXT NOT NULL,
      anchor       TEXT,
      role         TEXT,
      text         TEXT NOT NULL,
      label        TEXT,
      label_source TEXT,
      position     INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pins_thread ON pins(thread_id, position);
  `);
  db = handle;
  return handle;
}

function toPin(r: Record<string, unknown>): ChatPin {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    kind: r.kind as ChatPinKind,
    anchor: (r.anchor as string | null) ?? null,
    role: (r.role as ChatPin['role']) ?? null,
    text: r.text as string,
    label: (r.label as string | null) ?? null,
    labelSource: (r.label_source as ChatPin['labelSource']) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  };
}

/** Trim and bound pin text; empty is a refusal, not a blank pin. */
function cleanText(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('A pin needs text.');
  const text = raw.trim();
  if (!text) throw new Error('A pin needs text.');
  if (text.length > MAX_PIN_TEXT) throw new Error(`A pin can hold at most ${MAX_PIN_TEXT} characters.`);
  return text;
}

/** One line, bounded; empty means "no label". */
export function cleanLabel(raw: string): string | null {
  const label = raw.replace(/\s+/g, ' ').trim();
  if (!label) return null;
  return label.length > MAX_PIN_LABEL ? `${label.slice(0, MAX_PIN_LABEL - 1).trimEnd()}…` : label;
}

/**
 * Check an incoming pin against the domain rules the IPC guard's shallow object
 * check cannot see: a known kind, real text, and a source for anything that is
 * not the user's own note (a note has none).
 */
export function parsePinInput(raw: ChatPinInput): Required<ChatPinInput> {
  if (!raw || !KINDS.includes(raw.kind)) throw new Error('Unknown kind of pin.');
  const text = cleanText(raw.text);
  if (raw.kind === 'note') return { kind: 'note', text, anchor: null, role: null };
  if (typeof raw.anchor !== 'string' || !raw.anchor.trim()) throw new Error('A pinned message needs its turn.');
  if (raw.role !== 'user' && raw.role !== 'assistant') throw new Error('A pinned message needs its role.');
  return { kind: raw.kind, text, anchor: raw.anchor.trim(), role: raw.role };
}

/** The chat's pins in board order (oldest first within a tie, which only a reorder resolves). */
export function listPins(threadId: string): ChatPin[] {
  const rows = open()
    .prepare(`SELECT * FROM pins WHERE thread_id = ? ORDER BY position ASC, created_at ASC`)
    .all(threadId) as Array<Record<string, unknown>>;
  return rows.map(toPin);
}

export function getPin(threadId: string, pinId: string): ChatPin | null {
  const row = open().prepare(`SELECT * FROM pins WHERE thread_id = ? AND id = ?`).get(threadId, pinId) as
    | Record<string, unknown>
    | undefined;
  return row ? toPin(row) : null;
}

/**
 * Pin something to the end of the chat's board. The same message pinned twice is
 * one pin — the Pin button toggles, and a double click must not make two. An
 * older turn can rebuild as several assistant bubbles under one anchor, so a
 * message is told apart by its text too. A passage is distinct per text, so two
 * passages of one answer are two pins.
 */
export function addPin(threadId: string, raw: ChatPinInput): ChatPin {
  const input = parsePinInput(raw);
  const handle = open();
  if (input.kind === 'message') {
    const existing = handle
      .prepare(`SELECT * FROM pins WHERE thread_id = ? AND kind = 'message' AND anchor = ? AND role = ? AND text = ?`)
      .get(threadId, input.anchor, input.role, input.text) as Record<string, unknown> | undefined;
    if (existing) return toPin(existing);
  }
  const { n, top } = handle
    .prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS top FROM pins WHERE thread_id = ?`)
    .get(threadId) as { n: number; top: number };
  if (n >= MAX_PINS_PER_CHAT) throw new Error(`A chat can hold at most ${MAX_PINS_PER_CHAT} pins.`);
  const now = Date.now();
  const pin: ChatPin = {
    id: randomUUID(),
    threadId,
    kind: input.kind,
    anchor: input.anchor,
    role: input.role,
    text: input.text,
    label: null,
    labelSource: null,
    createdAt: now,
    updatedAt: now
  };
  handle
    .prepare(
      `INSERT INTO pins (id, thread_id, kind, anchor, role, text, label, label_source, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
    )
    .run(pin.id, threadId, pin.kind, pin.anchor, pin.role, pin.text, top + 1, now, now);
  return pin;
}

/**
 * Change what the user may change. Only a note's text is editable — a pinned
 * message or passage is a quotation, and editing it would make the board claim
 * the chat said something it did not. A label the user writes is theirs for
 * good: background labelling never replaces it (setAutoLabel).
 */
export function updatePin(threadId: string, pinId: string, patch: ChatPinPatch): ChatPin {
  const pin = getPin(threadId, pinId);
  if (!pin) throw new Error('That pin is gone.');
  const next = { ...pin };
  if (patch.text !== undefined) {
    if (pin.kind !== 'note') throw new Error('Only a note can be edited; a pinned message is a quotation.');
    const text = cleanText(patch.text);
    if (text !== pin.text) {
      next.text = text;
      // A rewritten note may no longer fit the label the model gave it.
      if (pin.labelSource === 'auto') {
        next.label = null;
        next.labelSource = null;
      }
    }
  }
  if (patch.label !== undefined) {
    next.label = patch.label === null ? null : cleanLabel(String(patch.label));
    next.labelSource = next.label === null ? null : 'user';
  }
  next.updatedAt = Date.now();
  open()
    .prepare(`UPDATE pins SET text = ?, label = ?, label_source = ?, updated_at = ? WHERE thread_id = ? AND id = ?`)
    .run(next.text, next.label, next.labelSource, next.updatedAt, threadId, pinId);
  return next;
}

/**
 * The background labeller's write. Refused (false) when the user has labelled
 * the pin meanwhile, the pin is gone, or its text changed since the label was
 * asked for — a label written for the old text would be wrong for the new one.
 */
export function setAutoLabel(threadId: string, pinId: string, forText: string, rawLabel: string): boolean {
  const label = cleanLabel(rawLabel);
  if (!label) return false;
  const res = open()
    .prepare(
      `UPDATE pins SET label = ?, label_source = 'auto', updated_at = ?
       WHERE thread_id = ? AND id = ? AND text = ? AND (label_source IS NULL OR label_source = 'auto')`
    )
    .run(label, Date.now(), threadId, pinId, forText);
  return Number(res.changes) > 0;
}

export function removePin(threadId: string, pinId: string): void {
  open().prepare(`DELETE FROM pins WHERE thread_id = ? AND id = ?`).run(threadId, pinId);
}

/**
 * Put the chat's pins in the given order. It must name every pin of the chat
 * exactly once: a partial order from a client whose board is stale (a pin added
 * on another device a second ago) would otherwise drop that pin somewhere
 * arbitrary. Refused, the client refetches and the user drags again.
 */
export function reorderPins(threadId: string, pinIds: string[]): void {
  const current = listPins(threadId).map((p) => p.id);
  const wanted = new Set(pinIds);
  if (wanted.size !== pinIds.length || current.length !== pinIds.length || current.some((id) => !wanted.has(id))) {
    throw new Error('The board changed while you were reordering it. Try again.');
  }
  const handle = open();
  const set = handle.prepare(`UPDATE pins SET position = ? WHERE thread_id = ? AND id = ?`);
  handle.exec('BEGIN');
  try {
    pinIds.forEach((id, i) => set.run(i, threadId, id));
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

/** Forget a chat's board (on chat delete). */
export function dropThreadPins(threadId: string): void {
  open().prepare(`DELETE FROM pins WHERE thread_id = ?`).run(threadId);
}

/**
 * Give a fork its share of the board: every note, and every pin whose turn made
 * it into the fork (`anchors` — the fork's turn ids, both kinds). Order, labels
 * and timestamps come along; ids are new, so the two boards never share a row.
 */
export function copyPinsToFork(fromThreadId: string, toThreadId: string, anchors: ReadonlySet<string>): number {
  const pins = listPins(fromThreadId).filter((p) => p.kind === 'note' || (p.anchor !== null && anchors.has(p.anchor)));
  if (pins.length === 0) return 0;
  const handle = open();
  const ins = handle.prepare(
    `INSERT INTO pins (id, thread_id, kind, anchor, role, text, label, label_source, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  handle.exec('BEGIN');
  try {
    pins.forEach((p, i) =>
      ins.run(randomUUID(), toThreadId, p.kind, p.anchor, p.role, p.text, p.label, p.labelSource, i, p.createdAt, p.updatedAt)
    );
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
  return pins.length;
}

/** Test-only lifecycle seam. */
export function closeForTest(): void {
  db?.close();
  db = null;
}
