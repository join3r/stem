import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { recallDbPath } from '../workspace/paths';
import type { EmbeddingCacheStats, EpisodicStats, TurnTiming } from '../../shared/types';

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
// Whether the optional facts_trigram index was created successfully (see open()).
let factsTrigram = false;

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

    -- Lexical (BM25) index over facts: the no-embeddings relevance tier. Mirrors
    -- messages_fts so fact ranking is query-aware with zero model/network. Kept in
    -- lockstep with facts via triggers — and because facts mutate (corrections,
    -- consolidation), an UPDATE trigger is needed too, unlike append-mostly messages.
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      text,
      content='facts',
      content_rowid='id',
      tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO facts_fts(rowid, text) VALUES (new.id, new.text);
    END;

    -- Cached embedding per (fact, model) for relevance ranking at inject time.
    -- Keyed by model so swapping the embeddings model just recomputes; stale rows
    -- under an old model are never read. Vectors are invalidated (deleted) whenever
    -- a fact's text changes, so a cached vector always matches its current text.
    CREATE TABLE IF NOT EXISTS fact_vectors (
      fact_id    INTEGER NOT NULL,
      model      TEXT NOT NULL,
      dim        INTEGER NOT NULL,
      vec        BLOB NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (fact_id, model)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- Per-turn answer-time breakdown, surfaced on the assistant message. Keyed by
    -- the FINAL assistant entry id (pi's session entry id) so readThread can attach
    -- it to the rebuilt assistant bubble on reopen. Independent of recall capture.
    CREATE TABLE IF NOT EXISTS turn_timings (
      turn_entry_id TEXT PRIMARY KEY,
      thread_id     TEXT NOT NULL,
      total_ms      INTEGER,
      thinking_ms   INTEGER NOT NULL,
      tool_ms       INTEGER NOT NULL,
      answer_ms     INTEGER NOT NULL,
      ttft_ms       INTEGER,
      build_ms      INTEGER,
      recall_ms     INTEGER,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turn_timings_thread ON turn_timings(thread_id);

    -- The durable facts injected on a thread's most recent turn — surfaced in the
    -- Memory UI so you can see what the model actually "knew about you". Keyed by
    -- thread so reopening an old chat still shows its last injected set. fact_ids is
    -- a JSON array (injected order); tier records which selection path chose them.
    CREATE TABLE IF NOT EXISTS active_facts (
      thread_id  TEXT PRIMARY KEY,
      fact_ids   TEXT NOT NULL,
      tier       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Optional trigram index over facts: a substring/morphology recall booster for
  // the lexical tier (catches inflected SK/DE forms and partial words the unicode61
  // term index misses). Created separately and guarded because the trigram tokenizer
  // needs a recent SQLite/FTS5 build; if it's unavailable we silently run term-only.
  try {
    handle.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_trigram USING fts5(
        text,
        content='facts',
        content_rowid='id',
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS facts_trig_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_trigram(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_trig_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_trigram(facts_trigram, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_trig_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_trigram(facts_trigram, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO facts_trigram(rowid, text) VALUES (new.id, new.text);
      END;
    `);
    factsTrigram = true;
  } catch {
    factsTrigram = false;
  }

  // One-time backfill: rows that predate the fact indexes aren't in them yet
  // (triggers only fire on future mutations). Rebuild once, gated by a meta flag so
  // it never runs on a populated, already-indexed DB. The flag is read/written via
  // the local handle to avoid re-entering open() before `db` is assigned.
  const built = handle.prepare(`SELECT value FROM meta WHERE key = 'facts_index_built'`).get() as
    | { value: string }
    | undefined;
  if (built?.value !== '1') {
    try {
      handle.exec(`INSERT INTO facts_fts(facts_fts) VALUES('rebuild')`);
      if (factsTrigram) handle.exec(`INSERT INTO facts_trigram(facts_trigram) VALUES('rebuild')`);
    } catch {
      // A rebuild failure must never block startup; triggers still keep new facts synced.
    }
    handle
      .prepare(`INSERT INTO meta(key, value) VALUES('facts_index_built', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`)
      .run();
  }

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

export interface TurnTimingRecord {
  /** pi's final assistant entry id for the turn — the persistence key. */
  turnEntryId: string;
  threadId: string;
  totalMs: number | null;
  thinkingMs: number;
  toolMs: number;
  answerMs: number;
  ttftMs: number | null;
  buildMs: number | null;
  recallMs: number | null;
}

/** Persist (or replace) a turn's answer-time breakdown. Best-effort; keyed by entry id. */
export function upsertTurnTiming(rec: TurnTimingRecord): void {
  const handle = open();
  handle
    .prepare(
      `INSERT INTO turn_timings
         (turn_entry_id, thread_id, total_ms, thinking_ms, tool_ms, answer_ms, ttft_ms, build_ms, recall_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(turn_entry_id) DO UPDATE SET
         thread_id = excluded.thread_id,
         total_ms = excluded.total_ms,
         thinking_ms = excluded.thinking_ms,
         tool_ms = excluded.tool_ms,
         answer_ms = excluded.answer_ms,
         ttft_ms = excluded.ttft_ms,
         build_ms = excluded.build_ms,
         recall_ms = excluded.recall_ms`
    )
    .run(
      rec.turnEntryId,
      rec.threadId,
      rec.totalMs,
      rec.thinkingMs,
      rec.toolMs,
      rec.answerMs,
      rec.ttftMs,
      rec.buildMs,
      rec.recallMs,
      nowSeconds()
    );
}

/** Load a thread's persisted turn timings, keyed by final assistant entry id. */
export function getTurnTimingsByThread(threadId: string): Map<string, TurnTiming> {
  const handle = open();
  const rows = handle
    .prepare(
      `SELECT turn_entry_id AS entryId, total_ms AS totalMs, thinking_ms AS thinkingMs,
              tool_ms AS toolMs, answer_ms AS answerMs, ttft_ms AS ttftMs,
              build_ms AS buildMs, recall_ms AS recallMs
       FROM turn_timings WHERE thread_id = ?`
    )
    .all(threadId) as Array<{
    entryId: string;
    totalMs: number | null;
    thinkingMs: number;
    toolMs: number;
    answerMs: number;
    ttftMs: number | null;
    buildMs: number | null;
    recallMs: number | null;
  }>;
  const out = new Map<string, TurnTiming>();
  for (const r of rows) {
    out.set(r.entryId, {
      totalMs: r.totalMs,
      thinkingMs: r.thinkingMs,
      toolMs: r.toolMs,
      answerMs: r.answerMs,
      ttftMs: r.ttftMs,
      buildMs: r.buildMs,
      recallMs: r.recallMs
    });
  }
  return out;
}

/** Which selection path chose a turn's facts (see chooseFacts in inject.ts). */
export type FactTier = 'all' | 'embedding' | 'lexical' | 'recency';

/** Record the durable facts injected on `threadId`'s latest turn. Best-effort. */
export function setActiveFacts(threadId: string, factIds: number[], tier: FactTier): void {
  const handle = open();
  handle
    .prepare(
      `INSERT INTO active_facts (thread_id, fact_ids, tier, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         fact_ids = excluded.fact_ids,
         tier = excluded.tier,
         updated_at = excluded.updated_at`
    )
    .run(threadId, JSON.stringify(factIds), tier, nowSeconds());
}

/** Read a thread's last injected fact ids + tier, or null if none recorded. */
export function getActiveFactIds(threadId: string): { factIds: number[]; tier: FactTier } | null {
  const handle = open();
  const row = handle
    .prepare(`SELECT fact_ids AS factIds, tier FROM active_facts WHERE thread_id = ?`)
    .get(threadId) as { factIds: string; tier: string } | undefined;
  if (!row) return null;
  let factIds: number[] = [];
  try {
    const parsed = JSON.parse(row.factIds);
    if (Array.isArray(parsed)) factIds = parsed.filter((n): n is number => typeof n === 'number');
  } catch {
    // Corrupt JSON — treat as no recorded set rather than throwing.
  }
  return { factIds, tier: row.tier as FactTier };
}

/**
 * Resolve fact ids to their current rows, preserving the given order and silently
 * dropping ids whose fact has since been deleted or merged away by consolidation.
 */
export function getFactsByIds(ids: number[]): Fact[] {
  if (ids.length === 0) return [];
  const handle = open();
  const placeholders = ids.map(() => '?').join(',');
  const rows = handle
    .prepare(`SELECT id, text, source, updated_at AS updatedAt FROM facts WHERE id IN (${placeholders})`)
    .all(...ids) as Array<Record<string, unknown>>;
  const byId = new Map<number, Fact>();
  for (const r of rows) {
    byId.set(r.id as number, {
      id: r.id as number,
      text: r.text as string,
      source: r.source as string,
      updatedAt: r.updatedAt as number
    });
  }
  return ids.map((id) => byId.get(id)).filter((f): f is Fact => !!f);
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
  const norm = normalizeFact(clean);
  // A correction can change the text under an existing norm — drop any cached
  // vector so it's re-embedded against the new text on the next inject.
  handle.prepare(`DELETE FROM fact_vectors WHERE fact_id IN (SELECT id FROM facts WHERE norm = ?)`).run(norm);
  handle
    .prepare(
      `INSERT INTO facts (text, norm, source, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(norm) DO UPDATE SET text = excluded.text, source = excluded.source, updated_at = excluded.updated_at`
    )
    .run(clean, norm, source, nowSeconds());
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
  const handle = open();
  // No FK cascade (foreign_keys isn't globally enabled), so drop the vector by hand.
  handle.prepare(`DELETE FROM fact_vectors WHERE fact_id = ?`).run(id);
  handle.prepare(`DELETE FROM facts WHERE id = ?`).run(id);
}

// ---- lexical fact ranking (Level 1 no-embeddings fallback tier) ----

/** A fact plus its lexical match score (bm25; lower = better). */
export interface ScoredFact extends Fact {
  score: number;
}

/** True when the optional trigram fact index is available this session. */
export function factsTrigramAvailable(): boolean {
  open();
  return factsTrigram;
}

function mapScoredFact(r: Record<string, unknown>): ScoredFact {
  return {
    id: r.id as number,
    text: r.text as string,
    source: r.source as string,
    updatedAt: r.updatedAt as number,
    score: r.score as number
  };
}

/**
 * BM25 term ranking of facts for a prebuilt FTS5 MATCH expression. Returns up to
 * `limit`, best (most-negative bm25) first, with the raw score so callers can blend
 * in recency. Empty on no match or malformed query — search.ts builds the MATCH.
 */
export function factTermSearch(match: string, limit: number): ScoredFact[] {
  if (!match.trim() || limit <= 0) return [];
  const handle = open();
  try {
    const rows = handle
      .prepare(
        `SELECT f.id AS id, f.text AS text, f.source AS source, f.updated_at AS updatedAt,
                bm25(facts_fts) AS score
         FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
         WHERE facts_fts MATCH ?
         ORDER BY score
         LIMIT ?`
      )
      .all(match, limit) as Array<Record<string, unknown>>;
    return rows.map(mapScoredFact);
  } catch {
    return [];
  }
}

/**
 * Trigram substring match of facts (morphology/partial-word recall the term index
 * misses). Guarded: returns [] when the trigram index isn't available. Ordered by
 * recency since bm25 over trigram carries little ranking signal; score is left 0.
 */
export function factTrigramSearch(match: string, limit: number): ScoredFact[] {
  if (!factsTrigram || !match.trim() || limit <= 0) return [];
  const handle = open();
  try {
    const rows = handle
      .prepare(
        `SELECT f.id AS id, f.text AS text, f.source AS source, f.updated_at AS updatedAt,
                0 AS score
         FROM facts_trigram JOIN facts f ON f.id = facts_trigram.rowid
         WHERE facts_trigram MATCH ?
         ORDER BY f.updated_at DESC
         LIMIT ?`
      )
      .all(match, limit) as Array<Record<string, unknown>>;
    return rows.map(mapScoredFact);
  } catch {
    return [];
  }
}

// ---- embedding cache (Level 1 relevance ranking) ----

function bytesToFloat32(u8: Uint8Array): Float32Array {
  // The row buffer may be reused/unaligned — copy into a fresh, 0-aligned buffer.
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

/** Facts with no cached vector for `model` (need embedding before ranking). */
export function getFactsMissingVector(model: string): Fact[] {
  const rows = open()
    .prepare(
      `SELECT f.id, f.text, f.source, f.updated_at AS updatedAt
         FROM facts f
         LEFT JOIN fact_vectors v ON v.fact_id = f.id AND v.model = ?
        WHERE v.fact_id IS NULL
        ORDER BY f.id ASC`
    )
    .all(model) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    text: r.text as string,
    source: r.source as string,
    updatedAt: r.updatedAt as number
  }));
}

/** All cached vectors for `model`, keyed by fact id. */
export function getFactVectors(model: string): Map<number, Float32Array> {
  const rows = open()
    .prepare(`SELECT fact_id AS factId, vec FROM fact_vectors WHERE model = ?`)
    .all(model) as Array<{ factId: number; vec: Uint8Array }>;
  const out = new Map<number, Float32Array>();
  for (const r of rows) out.set(r.factId, bytesToFloat32(r.vec));
  return out;
}

/** Cache a fact's embedding for `model` (replaces any prior vector). */
export function upsertFactVector(factId: number, model: string, vec: Float32Array): void {
  const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  open()
    .prepare(
      `INSERT INTO fact_vectors (fact_id, model, dim, vec, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(fact_id, model) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, updated_at = excluded.updated_at`
    )
    .run(factId, model, vec.length, buf, nowSeconds());
}

/** Drop cached vectors for every model except `model` (hygiene after a model switch). */
export function pruneVectorsExceptModel(model: string): void {
  open().prepare(`DELETE FROM fact_vectors WHERE model <> ?`).run(model);
}

/** How many facts have a cached vector for `model` (plus total facts + vector dim). */
export function getEmbeddingCacheStats(model: string): EmbeddingCacheStats {
  const handle = open();
  const factCount = (handle.prepare(`SELECT COUNT(*) AS n FROM facts`).get() as { n: number }).n;
  const row = handle
    .prepare(`SELECT COUNT(*) AS n, MAX(dim) AS dim FROM fact_vectors WHERE model = ?`)
    .get(model) as { n: number; dim: number | null };
  return { factCount, embeddedCount: row.n, dim: row.n > 0 ? (row.dim ?? null) : null };
}

/**
 * Wipe the episodic store (Level 2): all messages + their FTS index, and the
 * distill watermark — message ids can be reused after a VACUUM, so a stale
 * watermark would make distillation skip freshly captured messages. VACUUM runs
 * after the delete (it can't run inside a transaction) to reclaim disk pages.
 *
 * Deleting from `messages` fires the messages_ad trigger per row, so the FTS
 * index is cleared in lockstep — no separate messages_fts delete needed.
 * Leaves facts and the recall_enabled toggle untouched.
 */
export function resetEpisodic(): void {
  const handle = open();
  handle.exec('BEGIN');
  try {
    handle.exec('DELETE FROM messages');
    handle.exec(`DELETE FROM meta WHERE key = 'distill_watermark'`);
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
  handle.exec('VACUUM');
}

/**
 * Wipe durable facts (Level 1) + the consolidation dirty-counter. Leaves the
 * episodic store and the recall_enabled toggle untouched.
 */
export function resetFacts(): void {
  const handle = open();
  handle.exec('BEGIN');
  try {
    handle.exec('DELETE FROM fact_vectors');
    handle.exec('DELETE FROM facts');
    handle.exec(`DELETE FROM meta WHERE key = 'consolidate_pending'`);
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
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
    const delVec = handle.prepare(`DELETE FROM fact_vectors WHERE fact_id = ?`);
    for (const id of mergeLoserIds) {
      delVec.run(id);
      merged += del.run(id).changes as number;
    }
    for (const id of dropIds) {
      delVec.run(id);
      dropped += del.run(id).changes as number;
    }
    // Survivors/corrections keep their row but get new text — invalidate their vectors.
    for (const w of textWrites) delVec.run(w.id);

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

/** On-disk footprint of recall.sqlite + its WAL sidecar (uncheckpointed writes). */
function dbSizeBytes(): number {
  const path = recallDbPath();
  let total = 0;
  for (const p of [path, `${path}-wal`]) {
    try {
      total += statSync(p).size;
    } catch {
      // sidecar (or db) not on disk yet — counts as 0.
    }
  }
  return total;
}

/**
 * Metadata for the Level-2 episodic store: how many messages are captured and how
 * much disk recall.sqlite occupies.
 */
export function getEpisodicStats(): EpisodicStats {
  return { messageCount: messageCount(), sizeBytes: dbSizeBytes() };
}

// ---- tunable limits (stored in meta so the backend can read them synchronously) ----

const EPISODIC_MAX_KEY = 'episodic_max_bytes';
const TIDY_THRESHOLD_KEY = 'consolidate_threshold';
/** 100 MB of chat text is effectively a safety ceiling, not a routine cap. */
export const DEFAULT_EPISODIC_MAX_BYTES = 100 * 1024 * 1024;
/** Run a tidy-up once this many new facts have accumulated (0 = manual only). */
export const DEFAULT_TIDY_THRESHOLD = 5;

/** Max on-disk size for the episodic store in bytes; 0 = unlimited. */
export function getEpisodicLimitBytes(): number {
  const raw = Number.parseInt(getMeta(EPISODIC_MAX_KEY) ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_EPISODIC_MAX_BYTES;
}
export function setEpisodicLimitBytes(bytes: number): void {
  setMeta(EPISODIC_MAX_KEY, String(Math.max(0, Math.floor(bytes))));
}

/** New-fact count that triggers an automatic tidy-up; 0 = manual only. */
export function getTidyThreshold(): number {
  const raw = Number.parseInt(getMeta(TIDY_THRESHOLD_KEY) ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TIDY_THRESHOLD;
}
export function setTidyThreshold(n: number): void {
  setMeta(TIDY_THRESHOLD_KEY, String(Math.max(0, Math.floor(n))));
}

// ---- fact-ranking tunables (inject-time relevance selection) ----

const FACT_THRESHOLD_KEY = 'recall_fact_threshold';
const FACT_COSINE_M_KEY = 'recall_cosine_m';
const FACT_RERANK_K_KEY = 'recall_rerank_k';
/** At or below this many facts, inject all of them (cheap, no embedding call). */
export const DEFAULT_FACT_THRESHOLD = 40;
/** Embedding-cosine shortlist size handed to the reranker. */
export const DEFAULT_FACT_COSINE_M = 20;
/** Facts actually injected after reranking (or cosine top-K when no reranker). */
export const DEFAULT_FACT_RERANK_K = 8;

function getMetaPositiveInt(key: string, fallback: number): number {
  const raw = Number.parseInt(getMeta(key) ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function getFactThreshold(): number {
  return getMetaPositiveInt(FACT_THRESHOLD_KEY, DEFAULT_FACT_THRESHOLD);
}
export function setFactThreshold(n: number): void {
  setMeta(FACT_THRESHOLD_KEY, String(Math.max(1, Math.floor(n))));
}
export function getFactCosineM(): number {
  return getMetaPositiveInt(FACT_COSINE_M_KEY, DEFAULT_FACT_COSINE_M);
}
export function getFactRerankK(): number {
  return getMetaPositiveInt(FACT_RERANK_K_KEY, DEFAULT_FACT_RERANK_K);
}

const CONSOLIDATE_CHUNK_KEY = 'consolidate_chunk_size';
/** Max facts per consolidation prompt; larger sets are clustered into chunks. */
export const DEFAULT_CONSOLIDATE_CHUNK = 50;

export function getConsolidateChunkSize(): number {
  // Floor of 2 so a "chunk" can always hold a mergeable pair.
  return Math.max(2, getMetaPositiveInt(CONSOLIDATE_CHUNK_KEY, DEFAULT_CONSOLIDATE_CHUNK));
}
export function setConsolidateChunkSize(n: number): void {
  setMeta(CONSOLIDATE_CHUNK_KEY, String(Math.max(2, Math.floor(n))));
}

/**
 * Trim the episodic store back under its size limit by deleting the oldest
 * messages, then VACUUM to actually reclaim the disk pages (SQLite keeps freed
 * pages otherwise, so the file — and the reported size — wouldn't shrink). Prunes
 * to ~85% of the limit so a steady trickle of new messages doesn't re-trigger a
 * VACUUM on every capture. Returns how many messages were removed.
 *
 * The messages_ad trigger keeps the FTS index in lockstep as rows are deleted.
 */
export function enforceEpisodicLimit(): number {
  const max = getEpisodicLimitBytes();
  if (max <= 0) return 0; // unlimited
  if (dbSizeBytes() <= max) return 0;

  const handle = open();
  const target = Math.floor(max * 0.85);
  let deleted = 0;
  // Bounded loop: the size estimate can under-shoot (fixed facts/meta overhead),
  // so re-measure after each VACUUM and prune again if still over.
  for (let i = 0; i < 8; i++) {
    const rows = messageCount();
    if (rows === 0) break;
    const size = dbSizeBytes();
    if (size <= target) break;
    const dropFraction = Math.min(0.9, 1 - target / size);
    const dropCount = Math.max(1, Math.ceil(rows * dropFraction));
    const cutoff = handle
      .prepare(`SELECT id FROM messages ORDER BY id ASC LIMIT 1 OFFSET ?`)
      .get(dropCount) as { id?: number } | undefined;
    if (cutoff?.id == null) {
      deleted += handle.prepare(`DELETE FROM messages`).run().changes as number;
    } else {
      deleted += handle.prepare(`DELETE FROM messages WHERE id < ?`).run(cutoff.id).changes as number;
    }
    handle.exec('VACUUM');
  }
  return deleted;
}

/** Test hook: close the handle so a fresh path can be opened. */
export function closeForTest(): void {
  db?.close();
  db = null;
}
