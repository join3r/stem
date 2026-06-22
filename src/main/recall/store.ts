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

export function deleteFact(id: number): void {
  open().prepare(`DELETE FROM facts WHERE id = ?`).run(id);
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
