import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { recallDbPath } from '../workspace/paths';

// Stem Recall's storage layer. Owns recall.sqlite end-to-end so the memory
// system is decoupled from the chat backend (pi today, anything later).
//
// Two surfaces live here:
//  - `messages`     Level 2: every user+assistant message, mirrored into an FTS5
//                   index for episodic search (bm25-ranked, unicode61 tokenizer
//                   so Slovak/German/English all tokenize). Verified working on
//                   node:sqlite in Electron 42 / Node 24 (see scripts/sqlite-spike.mjs).
//  - `facts`        Level 1: distilled durable profile facts, always injected.
//
// node:sqlite is synchronous, so no async write-queue is needed (calls can't
// interleave the way the JSON stores in chats.ts can). Ops here are tiny.

export type MessageRole = 'user' | 'assistant';

export interface RecordMessageInput {
  threadId: string;
  turnId?: string | null;
  role: MessageRole;
  text: string;
  cwd?: string | null;
  /** Unix seconds. Defaults to now. */
  ts?: number;
}

export interface SearchHit {
  id: number;
  threadId: string;
  turnId: string | null;
  role: MessageRole;
  ts: number;
  text: string;
  snippet: string;
  /** bm25 score (lower = better match). */
  score: number;
}

export interface SearchOptions {
  limit?: number;
  /** Exclude hits from this thread (the current chat — its history is already in context). */
  excludeThreadId?: string | null;
}

export interface Fact {
  id: number;
  text: string;
  source: string;
  updatedAt: number;
}

let db: DatabaseSync | null = null;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function dedupKey(threadId: string, role: string, text: string): string {
  return createHash('sha256').update(`${threadId}|${role}|${text}`).digest('hex').slice(0, 32);
}

// Normalize a fact for dedup: lowercase, collapse whitespace, strip trailing
// punctuation. Two facts that normalize equal are treated as the same fact.
function normalizeFact(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:\s]+$/g, '')
    .trim();
}

function open(): DatabaseSync {
  if (db) return db;
  const handle = new DatabaseSync(recallDbPath());
  handle.exec('PRAGMA journal_mode = WAL;');
  handle.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id        INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id   TEXT,
      role      TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      cwd       TEXT,
      text      TEXT NOT NULL,
      dedup_key TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      content='messages',
      content_rowid='id',
      tokenize='unicode61'
    );

    -- Keep the FTS index in lockstep with the messages table.
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;

    CREATE TABLE IF NOT EXISTS facts (
      id         INTEGER PRIMARY KEY,
      text       TEXT NOT NULL,
      norm       TEXT UNIQUE,
      source     TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  db = handle;
  return handle;
}

/**
 * Persist one message. Idempotent: re-capturing the same (thread, role, text) is
 * a no-op via the dedup_key UNIQUE constraint, so overlapping captures never
 * create duplicates.
 */
export function recordMessage(input: RecordMessageInput): void {
  const text = input.text.trim();
  if (!text) return;
  const handle = open();
  handle
    .prepare(
      `INSERT OR IGNORE INTO messages (thread_id, turn_id, role, ts, cwd, text, dedup_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.threadId,
      input.turnId ?? null,
      input.role,
      input.ts ?? nowSeconds(),
      input.cwd ?? null,
      text,
      dedupKey(input.threadId, input.role, text)
    );
}

/**
 * Episodic search over all captured messages. `query` must already be a valid
 * FTS5 MATCH expression (use search.ts to build one safely from raw user text).
 */
export function search(query: string, options: SearchOptions = {}): SearchHit[] {
  if (!query.trim()) return [];
  const limit = options.limit ?? 5;
  const exclude = options.excludeThreadId ?? null;
  const handle = open();
  const rows = handle
    .prepare(
      `SELECT m.id AS id, m.thread_id AS threadId, m.turn_id AS turnId, m.role AS role,
              m.ts AS ts, m.text AS text,
              snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet,
              bm25(messages_fts) AS score
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ?
         AND (? IS NULL OR m.thread_id <> ?)
       ORDER BY score
       LIMIT ?`
    )
    .all(query, exclude, exclude, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    threadId: r.threadId as string,
    turnId: (r.turnId as string | null) ?? null,
    role: r.role as MessageRole,
    ts: r.ts as number,
    text: r.text as string,
    snippet: r.snippet as string,
    score: r.score as number
  }));
}

export interface StoredMessage {
  id: number;
  threadId: string;
  role: MessageRole;
  ts: number;
  text: string;
}

/**
 * Messages with id greater than `sinceId`, oldest first — the distillation pass
 * uses this to process only what's new since its last run (the id is a monotonic
 * autoincrement, so it doubles as a watermark).
 */
export function getMessagesForDistill(sinceId: number, limit = 200): StoredMessage[] {
  const handle = open();
  const rows = handle
    .prepare(
      `SELECT id, thread_id AS threadId, role, ts, text
       FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`
    )
    .all(sinceId, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    threadId: r.threadId as string,
    role: r.role as MessageRole,
    ts: r.ts as number,
    text: r.text as string
  }));
}

/** Insert or refresh a durable fact (Level 1). Correction-aware via the norm key. */
export function upsertFact(text: string, source = 'distilled'): void {
  const clean = text.trim();
  if (!clean) return;
  const handle = open();
  handle
    .prepare(
      `INSERT INTO facts (text, norm, source, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(norm) DO UPDATE SET text = excluded.text, source = excluded.source, updated_at = excluded.updated_at`
    )
    .run(clean, normalizeFact(clean), source, nowSeconds());
}

export function getFacts(limit = 100): Fact[] {
  const handle = open();
  const rows = handle
    .prepare(`SELECT id, text, source, updated_at AS updatedAt FROM facts ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    text: r.text as string,
    source: r.source as string,
    updatedAt: r.updatedAt as number
  }));
}

/**
 * Every fact, uncapped — for the consolidation pass, which must reason over the
 * whole set to merge/correct/drop. `getFacts` keeps its 100-row cap for inject/UI.
 */
export function getAllFacts(): Fact[] {
  const handle = open();
  const rows = handle
    .prepare(`SELECT id, text, source, updated_at AS updatedAt FROM facts ORDER BY id ASC`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    text: r.text as string,
    source: r.source as string,
    updatedAt: r.updatedAt as number
  }));
}

export function deleteFact(id: number): void {
  open().prepare(`DELETE FROM facts WHERE id = ?`).run(id);
}

// ---- consolidation (Level 1 cleanup) ----

/** Merge several facts into one: the survivor's text becomes `text`, the rest are dropped. */
export interface MergeOp {
  ids: number[];
  text: string;
}
/** Rewrite a single fact's text in place (a correction). */
export interface CorrectOp {
  id: number;
  text: string;
}
export interface ConsolidationOps {
  merge: MergeOp[];
  correct: CorrectOp[];
  drop: number[];
}
export interface ConsolidationResult {
  merged: number;
  corrected: number;
  dropped: number;
}

/**
 * Apply a batch of consolidation operations in a single transaction. Default
 * posture is KEEP: only ids named in an op are touched; unknown ids are ignored.
 *
 * Order matters for the `norm` UNIQUE constraint: all deletes run first (merge
 * losers + explicit drops), so a survivor/correction can safely take text whose
 * norm previously belonged to a now-deleted row. Text writes that would still
 * collide with another surviving row (two survivors normalizing equal) are
 * skipped per-row rather than aborting the whole batch.
 */
export function applyConsolidation(ops: ConsolidationOps): ConsolidationResult {
  const handle = open();
  const existing = new Set(getAllFacts().map((f) => f.id));

  // Resolve text writes (merge survivors + corrections) and the ids each removes.
  const dropIds = new Set<number>(); // explicit drops
  const mergeLoserIds = new Set<number>(); // losers folded into a survivor
  const textWrites: Array<{ id: number; text: string; kind: 'merge' | 'correct' }> = [];

  for (const m of ops.merge) {
    const present = m.ids.filter((id) => existing.has(id));
    const text = m.text.trim();
    if (present.length === 0 || !text) continue;
    const survivor = Math.min(...present);
    for (const id of present) if (id !== survivor) mergeLoserIds.add(id);
    textWrites.push({ id: survivor, text, kind: 'merge' });
  }
  for (const c of ops.correct) {
    const text = c.text.trim();
    if (existing.has(c.id) && text) textWrites.push({ id: c.id, text, kind: 'correct' });
  }
  for (const id of ops.drop) if (existing.has(id)) dropIds.add(id);
  // A survivor/corrected row must never be deleted by an overlapping op.
  for (const w of textWrites) {
    dropIds.delete(w.id);
    mergeLoserIds.delete(w.id);
  }

  let merged = 0;
  let dropped = 0;
  let corrected = 0;
  handle.exec('BEGIN');
  try {
    // Deletes first so a survivor/correction can reclaim a deleted row's norm.
    const del = handle.prepare(`DELETE FROM facts WHERE id = ?`);
    for (const id of mergeLoserIds) merged += del.run(id).changes as number;
    for (const id of dropIds) dropped += del.run(id).changes as number;

    const upd = handle.prepare(`UPDATE facts SET text = ?, norm = ?, updated_at = ? WHERE id = ?`);
    for (const w of textWrites) {
      try {
        if ((upd.run(w.text, normalizeFact(w.text), nowSeconds(), w.id).changes as number) > 0) {
          if (w.kind === 'correct') corrected += 1;
        }
      } catch {
        // norm UNIQUE collision with another surviving row — leave this fact as-is.
      }
    }
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }

  return { merged, corrected, dropped };
}

export function getMeta(key: string): string | null {
  const handle = open();
  const row = handle.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  open()
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value);
}

/** Count of captured messages — used by tests/diagnostics. */
export function messageCount(): number {
  const row = open().prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number };
  return row.n;
}

/** Test hook: close the handle so a fresh path can be opened. */
export function closeForTest(): void {
  db?.close();
  db = null;
}
