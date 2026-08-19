import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { recallDbPath } from '../workspace/paths';
import { degrade } from '../degrade';
import {
  bytesToFloat32 as coreBytesToFloat32,
  hasMessageVectorsCore,
  semanticSearchMessagesCore,
  setCoreDegradeSink
} from './search-core';
import {
  DEFAULT_EPISODIC_MAX_BYTES,
  dbSizeBytesFor,
  enforceEpisodicLimitCore
} from './maintenance-core';
import type {
  ActivityItem,
  AutoConflictResolution,
  AutoResolvedConflict,
  ConflictResolution,
  EpisodicStats,
  FactCategory,
  FactDetails,
  FactEvidence,
  FactSelectionReason,
  FactSensitivity,
  FactStatus,
  MemoryConflict,
  SourceRef,
  TurnTiming
} from '../../shared/types';

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

// search-core.ts owns every FTS and cosine leg but can import nothing (it is
// bundled into the standalone MCP server), so it reports through a sink the host
// installs. This is that install for the main process, done at import because
// every main-process retrieval path — search.ts, inject.ts, folder-index — comes
// through here or alongside it, and a leg that fails before some later boot step
// would otherwise fail silently.
setCoreDegradeSink(degrade);

export type MessageRole = 'user' | 'assistant';


export interface RecordMessageInput {
  threadId: string;
  turnId?: string | null;
  role: MessageRole;
  text: string;
  cwd?: string | null;
  /** Unix seconds. Defaults to now. */
  ts?: number;
  /**
   * The turn this message belongs to used web tools (web_search/fetch_content/…),
   * so an assistant text may restate untrusted public-web content. Distillation
   * reads this to keep web-derived claims out of trusted fact provenance.
   */
  web?: boolean;
}


export interface SearchHit {
  id: number;
  threadId: string;
  turnId: string | null;
  role: MessageRole;
  ts: number;
  text: string;
  snippet: string;
  /**
   * bm25 score (lower = better) from FTS paths; on hybrid output this is the RRF
   * score instead (higher = better) — see searchMemoryHybrid.
   */
  score: number;
  /** Debug evidence on hybrid output: the FTS leg's bm25 score, when FTS saw it. */
  ftsScore?: number;
  /** Debug evidence on hybrid/semantic output: cosine similarity, when the semantic leg saw it. */
  cosine?: number;
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
  category: FactCategory;
  sensitivity: FactSensitivity;
  confidence: number;
  status: FactStatus;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  validFrom: number | null;
  validUntil: number | null;
  supersededBy: number | null;
  timesInjected: number;
  timesUsed: number;
  lastUsedAt: number | null;
  /** Last time this fact's injection was graded (used or not) — see usageRate. */
  lastGradedAt: number | null;
  selectionReason?: FactSelectionReason;
  /**
   * Set only on the representative of an OPEN conflict that getInjectableFacts
   * lets through: the fact is status='conflicted' but injected anyway, flagged
   * so the model treats it as uncertain.
   */
  disputed?: boolean;
}


export interface FactWriteOptions {
  source?: string;
  category?: FactCategory;
  sensitivity?: FactSensitivity;
  confidence?: number;
  status?: FactStatus;
  pinned?: boolean;
  validFrom?: number | null;
  validUntil?: number | null;
  evidence?: Omit<FactEvidence, 'id'>[];
  /**
   * May this write bring a superseded fact under the same norm back to life?
   * Defaults to true for source 'explicit' (the user's word), false otherwise —
   * distill passes true only for directUser claims. Without authority, a mere
   * restatement of retired text must not undo a supersede decision.
   */
  reviveSuperseded?: boolean;
}


/** An open conflict hydrated for the background adjudicator. */
export interface ConflictForAdjudication {
  id: number;
  reason: string;
  attempts: number;
  factA: FactDetails;
  factB: FactDetails;
}

/** What the adjudicator decided for one conflict (see applyAdjudication). */
export type AdjudicationDecision =
  | { kind: 'winner'; winnerId: number }
  | { kind: 'both' }
  | { kind: 'rewrite'; texts: string[] };

/** Which discovery path queued a relation check (see enqueueRelationChecks). */
export type RelationCheckOrigin = 'sweep' | 'coinject' | 'backfill';

/** A queued pair hydrated for the background classify pass. */
export interface PendingRelationCheck {
  id: number;
  origin: string;
  factA: FactDetails;
  factB: FactDetails;
}


/**
 * Newest evidence timestamp of a fact, or null when it has none. Evidence rows
 * are sorted ts ASC. Preferred over updated_at for truth-recency comparisons:
 * consolidation and re-upserts bump updated_at without any new evidence.
 */
export function newestEvidenceTs(details: Pick<FactDetails, 'evidence'>): number | null {
  const ev = details.evidence;
  return ev.length > 0 ? ev[ev.length - 1].timestamp : null;
}


const FACT_SELECT = `id, text, source, category, sensitivity, confidence, status, pinned,
  created_at AS createdAt, updated_at AS updatedAt, valid_from AS validFrom,
  valid_until AS validUntil, superseded_by AS supersededBy,
  times_injected AS timesInjected, times_used AS timesUsed, last_used_at AS lastUsedAt,
  last_graded_at AS lastGradedAt`;

const FACT_SELECT_F = `f.id, f.text, f.source, f.category, f.sensitivity, f.confidence, f.status, f.pinned,
  f.created_at AS createdAt, f.updated_at AS updatedAt, f.valid_from AS validFrom,
  f.valid_until AS validUntil, f.superseded_by AS supersededBy,
  f.times_injected AS timesInjected, f.times_used AS timesUsed, f.last_used_at AS lastUsedAt,
  f.last_graded_at AS lastGradedAt`;


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


/** A turn's persisted tool activity + web sources (see turn_activities). */
export interface TurnActivityPayload {
  activity: ActivityItem[];
  sources: SourceRef[];
}


/** Which selection path chose a turn's facts (see chooseFacts in inject.ts). */
export type FactTier = import('../../shared/types').FactTier;


export interface TurnInjectedFacts {
  threadId: string;
  turnId: string;
  factIds: number[];
}


/** One folder-doc excerpt injected on a turn (see turn_injected_docs). */
export interface InjectedDocRef {
  folderId: string;
  folderLabel: string;
  relPath: string;
  /** File mtime, Unix milliseconds. */
  mtime: number;
  excerpt: string;
}


export interface TurnInjectedDocs {
  threadId: string;
  turnId: string;
  docs: InjectedDocRef[];
}


export interface StoredMessage {
  id: number;
  threadId: string;
  turnId: string | null;
  role: MessageRole;
  ts: number;
  text: string;
  /** True when the message's turn used web tools — see RecordMessageInput.web. */
  web: boolean;
}


export const MAX_PINNED_FACTS = 5;

// ---- lexical fact ranking (Level 1 no-embeddings fallback tier) ----

/** A fact plus its lexical match score (bm25; lower = better). */
export interface ScoredFact extends Fact {
  score: number;
}


// ---- embedding cache (Level 1 relevance ranking) ----

// Shared with the recall MCP server via search-core.ts (it copies the possibly
// unaligned row buffer before viewing it as floats).
const bytesToFloat32 = coreBytesToFloat32;


// ---- message embedding cache (Level 2 semantic episodic search) ----

const LEGACY_MESSAGE_EMBED_WATERMARK_KEY = 'message_embed_watermark';

const MESSAGE_EMBED_WATERMARK_KEY = 'message_chunk_embed_watermark_v2';


export interface StoredMessageChunk {
  messageId: number;
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  text: string;
}


/** An episodic hit produced by cosine ranking; `score` carries the cosine too. */
export interface SemanticHit extends SearchHit {
  cosine: number;
}


// ---- thread summaries (Level 1.5: rolling episodic summaries) ----

export interface ThreadSummaryRow {
  id: number;
  threadId: string;
  text: string;
  firstTs: number;
  lastTs: number;
  messageCount: number;
  lastMessageId: number;
  updatedAt: number;
  /** Rolling revisions since the last rebuild-from-segments (or since creation). */
  revisionsSinceRebuild: number;
  /** True once segment coverage broke (a revision landed without its segment). */
  segmentsGap: boolean;
}


const SUMMARY_SELECT = `id, thread_id AS threadId, text, first_ts AS firstTs, last_ts AS lastTs,
  message_count AS messageCount, last_message_id AS lastMessageId, updated_at AS updatedAt,
  revisions_since_rebuild AS revisionsSinceRebuild, segments_gap AS segmentsGap`;


/** Hard cap on stored summary text — rolling revisions must not grow unbounded. */
export const MAX_SUMMARY_CHARS = 2000;


// ---- summary segments (anti-drift anchors for the rolling summaries) ----

export interface SummarySegmentRow {
  id: number;
  threadId: string;
  text: string;
  firstTs: number;
  lastTs: number;
  messageCount: number;
  lastMessageId: number;
  createdAt: number;
}


const SEGMENT_SELECT = `id, thread_id AS threadId, text, first_ts AS firstTs, last_ts AS lastTs,
  message_count AS messageCount, last_message_id AS lastMessageId, created_at AS createdAt`;


/**
 * Which open conflicts the autonomous adjudicator may act on: under the attempt
 * cap, both sides still present, and neither side explicit (the user's word is
 * only ever adjudicated by the user). ONE definition, shared by the selection
 * query and the gate's count — a count over a wider predicate would keep the
 * producer pass switched off waiting for conflicts the adjudicator never picks
 * up. Takes the attempt cap as its single bound parameter.
 */
const ADJUDICABLE_CONFLICT_WHERE = `status = 'open' AND adjudicate_attempts < ?
  AND EXISTS (SELECT 1 FROM facts a WHERE a.id = fact_a AND a.source <> 'explicit')
  AND EXISTS (SELECT 1 FROM facts b WHERE b.id = fact_b AND b.source <> 'explicit')`;


/** Hard cap on stored segment text (merged compaction segments may be longer). */
export const MAX_SEGMENT_CHARS = 700;

export const MAX_MERGED_SEGMENT_CHARS = 1400;


const FACTS_GENERATION_KEY = 'facts_generation';
const EPISODIC_GENERATION_KEY = 'episodic_generation';


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
  /** Chunks whose model call failed — those facts were never reviewed this pass. */
  failedChunks: number;
}


// ---- tunable limits (stored in meta so the backend can read them synchronously) ----

const EPISODIC_MAX_KEY = 'episodic_max_bytes';

const TIDY_THRESHOLD_KEY = 'consolidate_threshold';

// The default (and the limit's meta key) live in maintenance-core.ts so the scan
// worker enforces the same cap without importing this electron-bound module.
export { DEFAULT_EPISODIC_MAX_BYTES } from './maintenance-core';

/** Run a tidy-up once this many new facts have accumulated (0 = manual only). */
export const DEFAULT_TIDY_THRESHOLD = 5;

/**
 * Set once, by the v1→v2 schema migration, on a store that held facts distilled
 * before evidence/sensitivity/validity existed. Gates the provenance rebuild
 * offer (rebuild.ts) so only such a store is ever asked to upgrade.
 */
export const V1_FACTS_MIGRATED_KEY = 'recall_v1_facts_migrated';


// ---- fact-ranking tunables (inject-time relevance selection) ----

const FACT_THRESHOLD_KEY = 'recall_fact_threshold'; // v1, read once for migration only

const MAX_RELEVANT_FACTS_KEY = 'recall_max_relevant_facts';

const FACT_COSINE_M_KEY = 'recall_cosine_m';

const FACT_RERANK_K_KEY = 'recall_rerank_k';

/**
 * How many relevance-ranked facts a turn may receive, on top of any pinned ones.
 * Every injected fact must also clear its sensitivity's cosine gate, so a turn
 * often gets fewer. Tunable in Memory → Facts.
 */
export const DEFAULT_MAX_RELEVANT_FACTS = 8;

/** Embedding-cosine shortlist size handed to the reranker. */
export const DEFAULT_FACT_COSINE_M = 20;

/** Facts actually injected after reranking (or cosine top-K when no reranker). */
export const DEFAULT_FACT_RERANK_K = 8;


// ---- episodic semantic tunable ----

const SEMANTIC_MIN_COSINE_KEY = 'recall_semantic_min_cosine';

/**
 * Floor for semantic-only episodic hits. e5-family similarities squash into
 * roughly [0.7, 1.0], so 0.82 sits above unrelated-content noise while keeping
 * genuine cross-language matches (calibrated by scripts/recall-eval.mjs).
 */
export const DEFAULT_SEMANTIC_MIN_COSINE = 0.82;


const USAGE_WEIGHT_KEY = 'recall_usage_weight';

/**
 * Weight of the usage term blended into fact relevance ranking:
 * blended = cosine + W * (usageRate - 0.5), with a Laplace-smoothed usage rate
 * (times_used+1)/(times_injected+2) so never-injected facts sit exactly neutral.
 * Small versus the 0.72/0.82 sensitivity gates by design — usage reorders
 * candidates, it never admits or excludes them. 0 disables the blend.
 */
export const DEFAULT_USAGE_WEIGHT = 0.1;


const DUP_COSINE_KEY = 'recall_dup_cosine';

/**
 * Write-time duplicate-fact threshold (passage↔passage cosine). Calibrated by
 * scripts/recall-eval.mjs on 2026-07-04 with e5-small: same-language duplicates
 * score ≥ .949 while distinct-but-related facts reach .925 — 0.94 sits in that
 * gap. Cross-language duplicates (~.85) are deliberately NOT reachable: catching
 * them would over-trigger on same-language distinct pairs; regular consolidation
 * handles them. A hit never drops the fact — it only accelerates consolidation.
 */
export const DEFAULT_DUP_COSINE = 0.94;


const CONSOLIDATE_CHUNK_KEY = 'consolidate_chunk_size';

/** Max facts per consolidation prompt; larger sets are clustered into chunks. */
export const DEFAULT_CONSOLIDATE_CHUNK = 50;


/**
 * Stem Recall's storage layer as an injectable unit: one instance owns one
 * SQLite handle over the path returned by `dbPath` (re-read on every (re)open,
 * so tests can close + repoint). Methods are bound arrow properties: call
 * sites may destructure them off an instance and pass them around as
 * callbacks without losing `this`.
 */
export class RecallStore {
  private db: DatabaseSync | null = null;
  /** Whether this SQLite build supports the optional trigram FTS index. */
  private factsTrigram = false;

  constructor(private readonly dbPath: () => string) {}

  private nowSeconds = (): number => {
    return Math.floor(Date.now() / 1000);
  };


  private dedupKey = (threadId: string, turnId: string | null | undefined, role: string, text: string): string => {
    // turnId distinguishes a legitimate repeated utterance from duplicate capture
    // of the same turn. Older/no-turn import paths retain their idempotent behavior.
    return createHash('sha256').update(`${threadId}|${turnId ?? ''}|${role}|${text}`).digest('hex').slice(0, 32);
  };


  // Normalize a fact for dedup: lowercase, collapse whitespace, strip trailing
  // punctuation. Two facts that normalize equal are treated as the same fact.
  private normalizeFact = (text: string): string => {
    return text
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[.!?,;:\s]+$/g, '')
      .trim();
  };


  private mapFact = (r: Record<string, unknown>): Fact => {
    return {
      id: r.id as number,
      text: r.text as string,
      source: (r.source as string) || 'legacy',
      category: ((r.category as FactCategory) || 'other'),
      sensitivity: ((r.sensitivity as FactSensitivity) || 'standard'),
      confidence: typeof r.confidence === 'number' ? r.confidence : 0.8,
      status: ((r.status as FactStatus) || 'active'),
      pinned: Boolean(r.pinned),
      createdAt: (r.createdAt as number) || (r.updatedAt as number) || 0,
      updatedAt: (r.updatedAt as number) || 0,
      validFrom: (r.validFrom as number | null) ?? null,
      validUntil: (r.validUntil as number | null) ?? null,
      supersededBy: (r.supersededBy as number | null) ?? null,
      timesInjected: (r.timesInjected as number) || 0,
      timesUsed: (r.timesUsed as number) || 0,
      lastUsedAt: (r.lastUsedAt as number | null) ?? null,
      lastGradedAt: (r.lastGradedAt as number | null) ?? null
    };
  };


  private open = (): DatabaseSync => {
    if (this.db) return this.db;
    const handle = new DatabaseSync(this.dbPath());
    handle.exec('PRAGMA journal_mode = WAL;');
    // The scan worker (scan-worker.ts) VACUUMs on its own connection; a main-process
    // write landing in that exclusive window must wait, not throw SQLITE_BUSY. Sized
    // to outlast one VACUUM round of a ~100 MB store (the prune loop's budget is
    // 120 s total, ~8 rounds) — 5 s was shorter than a single round.
    handle.exec('PRAGMA busy_timeout = 60000;');
    handle.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id        INTEGER PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id   TEXT,
        role      TEXT NOT NULL,
        ts        INTEGER NOT NULL,
        cwd       TEXT,
        text      TEXT NOT NULL,
        dedup_key TEXT UNIQUE,
        web       INTEGER NOT NULL DEFAULT 0
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
        id            INTEGER PRIMARY KEY,
        text          TEXT NOT NULL,
        norm          TEXT UNIQUE,
        source        TEXT,
        category      TEXT NOT NULL DEFAULT 'other',
        sensitivity   TEXT NOT NULL DEFAULT 'standard',
        confidence    REAL NOT NULL DEFAULT 0.8,
        status        TEXT NOT NULL DEFAULT 'active',
        pinned        INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL DEFAULT 0,
        updated_at    INTEGER NOT NULL,
        valid_from    INTEGER,
        valid_until   INTEGER,
        superseded_by INTEGER,
        times_injected INTEGER NOT NULL DEFAULT 0,
        times_used     INTEGER NOT NULL DEFAULT 0,
        last_used_at   INTEGER,
        last_graded_at INTEGER
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

      -- Cached embedding per (message, model) for semantic episodic this.search. Same
      -- contract as fact_vectors: model-keyed, pruned on model switch. Messages are
      -- append-only so vectors never go stale from edits, but deletions (episodic
      -- pruning / reset) must clean this table by hand — no FK cascade.
      CREATE TABLE IF NOT EXISTS message_vectors (
        message_id INTEGER NOT NULL,
        model      TEXT NOT NULL,
        dim        INTEGER NOT NULL,
        vec        BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, model)
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

      -- Per-turn tool-call activity + web sources, surfaced as collapsible rows on
      -- the assistant message. Same keying discipline as turn_timings: the FINAL
      -- assistant entry id, so readThread can attach it on reopen. payload is a JSON
      -- { activity: ActivityItem[], sources: SourceRef[] } blob.
      CREATE TABLE IF NOT EXISTS turn_activities (
        turn_entry_id TEXT PRIMARY KEY,
        thread_id     TEXT NOT NULL,
        payload       TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turn_activities_thread ON turn_activities(thread_id);

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

      CREATE TABLE IF NOT EXISTS fact_evidence (
        id         INTEGER PRIMARY KEY,
        fact_id    INTEGER NOT NULL,
        message_id INTEGER,
        thread_id  TEXT,
        role       TEXT,
        ts         INTEGER NOT NULL,
        excerpt    TEXT NOT NULL,
        origin     TEXT NOT NULL,
        -- 'folder_doc' evidence: which indexed connected folder + file it cites.
        folder_id  TEXT,
        rel_path   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_fact_evidence_fact ON fact_evidence(fact_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_evidence_unique
        ON fact_evidence(fact_id, IFNULL(message_id, -1), origin, excerpt);

      CREATE TABLE IF NOT EXISTS fact_conflicts (
        id          INTEGER PRIMARY KEY,
        fact_a      INTEGER NOT NULL,
        fact_b      INTEGER NOT NULL,
        reason      TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',
        created_at  INTEGER NOT NULL,
        resolved_at INTEGER,
        resolution  TEXT,
        -- LLM adjudication tries so far; capped so a permanently-failing conflict
        -- can't burn a model call on every background cycle.
        adjudicate_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_conflict_pair
        ON fact_conflicts(MIN(fact_a, fact_b), MAX(fact_a, fact_b)) WHERE status = 'open';

      -- Memo + work queue for pairwise relation classification (the neighbour
      -- sweep, the co-injection guard, and the retroactive backfill). One row per
      -- unordered pair (fact_a < fact_b); verdict NULL = queued for the background
      -- classify pass, non-NULL = already judged, never re-spend a model call.
      CREATE TABLE IF NOT EXISTS fact_relation_checks (
        id         INTEGER PRIMARY KEY,
        fact_a     INTEGER NOT NULL,
        fact_b     INTEGER NOT NULL,
        verdict    TEXT,
        origin     TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        checked_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_relation_pair
        ON fact_relation_checks(fact_a, fact_b);
      -- The queue's read pattern: pending rows, oldest first. Without it that is a
      -- full scan plus a sort over a table that only grows.
      CREATE INDEX IF NOT EXISTS idx_fact_relation_pending
        ON fact_relation_checks(verdict, created_at);

      CREATE TABLE IF NOT EXISTS message_chunks (
        message_id  INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset   INTEGER NOT NULL,
        text         TEXT NOT NULL,
        PRIMARY KEY(message_id, chunk_index)
      );
      CREATE TABLE IF NOT EXISTS message_chunk_vectors (
        message_id  INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        model       TEXT NOT NULL,
        dim         INTEGER NOT NULL,
        vec         BLOB NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY(message_id, chunk_index, model)
      );

      -- The facts injected on EACH turn (append-style, unlike active_facts which
      -- keeps only a thread's latest set for the UI). The distill pass reads
      -- ungraded rows to ask the model which facts actually informed the reply,
      -- then flips graded so a row is counted exactly once.
      CREATE TABLE IF NOT EXISTS turn_injected_facts (
        thread_id  TEXT NOT NULL,
        turn_id    TEXT NOT NULL,
        fact_ids   TEXT NOT NULL,
        graded     INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, turn_id)
      );

      -- Folder-doc excerpts injected on EACH turn (learn-eligible folders only —
      -- memorize on, learnMode not 'off'). The distill pass folds unconsumed rows
      -- into its transcript as citable [doc:n] entries so conversation-used
      -- documents can back durable facts, then flips consumed with the segment.
      CREATE TABLE IF NOT EXISTS turn_injected_docs (
        thread_id  TEXT NOT NULL,
        turn_id    TEXT NOT NULL,
        doc_refs   TEXT NOT NULL,
        consumed   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, turn_id)
      );

      -- Level 1.5: one rolling English summary per thread, revised by the distill
      -- pass as new messages arrive. last_message_id is the summary's own watermark,
      -- independent of distill_cursor_v2 — a failed summary refresh retries without
      -- blocking fact extraction, and vice versa.
      CREATE TABLE IF NOT EXISTS summaries (
        id              INTEGER PRIMARY KEY,
        thread_id       TEXT NOT NULL UNIQUE,
        text            TEXT NOT NULL,
        first_ts        INTEGER NOT NULL,
        last_ts         INTEGER NOT NULL,
        message_count   INTEGER NOT NULL DEFAULT 0,
        last_message_id INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        -- Rolling revisions since the summary was last re-derived from its
        -- segments; drives the periodic anti-drift rebuild in summarize.ts.
        revisions_since_rebuild INTEGER NOT NULL DEFAULT 0,
        -- Sticky: set once any revision lands without its per-window segment.
        -- Segment coverage is then incomplete, so rebuilding from segments would
        -- silently drop that window — the rebuild disables itself instead.
        segments_gap    INTEGER NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
        text,
        content='summaries',
        content_rowid='id',
        tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON summaries BEGIN
        INSERT INTO summaries_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON summaries BEGIN
        INSERT INTO summaries_fts(summaries_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE ON summaries BEGIN
        INSERT INTO summaries_fts(summaries_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO summaries_fts(rowid, text) VALUES (new.id, new.text);
      END;

      -- Append-only per-window mini-summaries, each derived ONCE from raw
      -- messages. They anchor the periodic drift rebuild of the rolling thread
      -- summary (summarize.ts): the rolling text is re-derived from these instead
      -- of from itself, so every summary stays at most two compression hops from
      -- the raw transcript. Internal scaffolding only — not searched, not injected.
      CREATE TABLE IF NOT EXISTS summary_segments (
        id              INTEGER PRIMARY KEY,
        thread_id       TEXT NOT NULL,
        text            TEXT NOT NULL,
        first_ts        INTEGER NOT NULL,
        last_ts         INTEGER NOT NULL,
        message_count   INTEGER NOT NULL DEFAULT 0,
        last_message_id INTEGER NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_summary_segments_thread
        ON summary_segments(thread_id, first_ts, id);

      -- Cached embedding per (summary, model). Same contract as fact_vectors:
      -- model-keyed, invalidated whenever the summary text changes.
      CREATE TABLE IF NOT EXISTS summary_vectors (
        summary_id INTEGER NOT NULL,
        model      TEXT NOT NULL,
        dim        INTEGER NOT NULL,
        vec        BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (summary_id, model)
      );
    `);

    // Recall v2 is an additive migration. SQLite has no ADD COLUMN IF NOT EXISTS,
    // so inspect the old v1 table and add only what is missing. Existing rows stay
    // active and usable; provenance is rebuilt later only after user confirmation.
    const factColumns = new Set(
      (handle.prepare(`PRAGMA table_info(facts)`).all() as Array<{ name: string }>).map((r) => r.name)
    );
    const migratingV1Facts = !factColumns.has('confidence');
    // Defaults must match the CREATE TABLE above: an upgraded store and a fresh one
    // have to gate identically, or the same fact recalls differently on two machines.
    const additions: Array<[string, string]> = [
      ['category', `TEXT NOT NULL DEFAULT 'other'`],
      ['sensitivity', `TEXT NOT NULL DEFAULT 'standard'`],
      ['confidence', `REAL NOT NULL DEFAULT 0.8`],
      ['status', `TEXT NOT NULL DEFAULT 'active'`],
      ['pinned', `INTEGER NOT NULL DEFAULT 0`],
      ['created_at', `INTEGER NOT NULL DEFAULT 0`],
      ['valid_from', 'INTEGER'],
      ['valid_until', 'INTEGER'],
      ['superseded_by', 'INTEGER'],
      ['times_injected', 'INTEGER NOT NULL DEFAULT 0'],
      ['times_used', 'INTEGER NOT NULL DEFAULT 0'],
      ['last_used_at', 'INTEGER'],
      ['last_graded_at', 'INTEGER']
    ];
    for (const [name, ddl] of additions) {
      if (!factColumns.has(name)) handle.exec(`ALTER TABLE facts ADD COLUMN ${name} ${ddl}`);
    }
    // Same additive pattern for the summaries table (segment-rebuild bookkeeping,
    // added after the table shipped). Defaults must match the CREATE TABLE above.
    const summaryColumns = new Set(
      (handle.prepare(`PRAGMA table_info(summaries)`).all() as Array<{ name: string }>).map((r) => r.name)
    );
    const summaryAdditions: Array<[string, string]> = [
      ['revisions_since_rebuild', 'INTEGER NOT NULL DEFAULT 0'],
      ['segments_gap', 'INTEGER NOT NULL DEFAULT 0']
    ];
    for (const [name, ddl] of summaryAdditions) {
      if (!summaryColumns.has(name)) handle.exec(`ALTER TABLE summaries ADD COLUMN ${name} ${ddl}`);
    }
    // Folder-doc evidence columns, added after fact_evidence shipped.
    const evidenceColumns = new Set(
      (handle.prepare(`PRAGMA table_info(fact_evidence)`).all() as Array<{ name: string }>).map((r) => r.name)
    );
    for (const name of ['folder_id', 'rel_path']) {
      if (!evidenceColumns.has(name)) handle.exec(`ALTER TABLE fact_evidence ADD COLUMN ${name} TEXT`);
    }
    // Web-taint flag on messages, added after the table shipped. Default must
    // match the CREATE TABLE above.
    const messageColumns = new Set(
      (handle.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>).map((r) => r.name)
    );
    if (!messageColumns.has('web')) {
      handle.exec(`ALTER TABLE messages ADD COLUMN web INTEGER NOT NULL DEFAULT 0`);
    }
    // Existing v1 rows predate the external-content FTS table. Populate it before
    // the metadata backfill below fires the UPDATE trigger; deleting an absent FTS
    // row from that trigger can otherwise report a malformed index.
    if (migratingV1Facts) {
      try {
        handle.exec(`INSERT INTO facts_fts(facts_fts) VALUES('rebuild')`);
      } catch {
        // quiet: the guarded rebuild a few lines down retries this, and schema
        // migration itself stays usable either way.
      }
      handle.prepare(`UPDATE facts SET source = 'legacy' WHERE source IS NULL OR source = 'distilled'`).run();
      // Mark that this store once held provenance-less v1 memories — the ONLY
      // reason to offer the memory rebuild (see rebuild.ts). A fresh install
      // captures evidence from its first message, so it must never be asked to
      // "upgrade" a memory it has always had. Sticky: the offer survives the
      // user deleting every legacy fact before deciding.
      handle
        .prepare(`INSERT INTO meta(key, value) VALUES('${V1_FACTS_MIGRATED_KEY}', '1') ON CONFLICT(key) DO NOTHING`)
        .run();
    }
    handle.prepare(`UPDATE facts SET created_at = updated_at WHERE created_at = 0`).run();
    // Repair a class-refactor find/replace that turned the conflict-status literal
    // 'open' into 'this.open' in shipped builds (v0.1.0). Rows written by those
    // builds carry the wrong status, and DBs they created hold the pair-dedup
    // partial index keyed on it. Normalize the index first, then the rows;
    // duplicate pairs that slipped in while dedup was dead collapse to their
    // oldest row before the UPDATE so it can't trip the unique index.
    const conflictIdx = handle.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_fact_conflict_pair'`
    ).get() as { sql: string | null } | undefined;
    if (conflictIdx?.sql?.includes('this.open')) handle.exec(`DROP INDEX idx_fact_conflict_pair`);
    handle.exec(`
      DELETE FROM fact_conflicts WHERE status IN ('open', 'this.open') AND id NOT IN (
        SELECT MIN(id) FROM fact_conflicts WHERE status IN ('open', 'this.open')
        GROUP BY MIN(fact_a, fact_b), MAX(fact_a, fact_b)
      );
      UPDATE fact_conflicts SET status = 'open' WHERE status = 'this.open';
    `);
    handle.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_conflict_pair
        ON fact_conflicts(MIN(fact_a, fact_b), MAX(fact_a, fact_b)) WHERE status = 'open';
    `);
    // Adjudication bookkeeping, added after fact_conflicts shipped.
    const conflictColumns = new Set(
      (handle.prepare(`PRAGMA table_info(fact_conflicts)`).all() as Array<{ name: string }>).map((r) => r.name)
    );
    if (!conflictColumns.has('adjudicate_attempts')) {
      handle.exec(`ALTER TABLE fact_conflicts ADD COLUMN adjudicate_attempts INTEGER NOT NULL DEFAULT 0`);
    }
    handle.prepare(
      `INSERT INTO meta(key, value) VALUES('recall_schema_version', '3')
       ON CONFLICT(key) DO UPDATE SET value = '3'`
    ).run();

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
      this.factsTrigram = true;
    } catch (e) {
      this.factsTrigram = false;
      // Once per open, and the loss is invisible from the outside: fact search
      // keeps working, it just stops finding the inflected SK/DE forms the
      // trigram leg exists for.
      degrade('recall.store', 'built no fact trigram index — lexical fact search stays term-only', e);
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
        // Inside the try, like the trigram backfill below: written outside it, a
        // rebuild that threw still marked the index built, and every fact that
        // predates the index stayed unsearchable for the life of the store with
        // nothing left to retry it.
        handle
          .prepare(`INSERT INTO meta(key, value) VALUES('facts_index_built', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`)
          .run();
      } catch (e) {
        // A rebuild failure must never block startup; triggers still keep new
        // facts synced, and the unset flag means the next open tries again.
        degrade('recall.store', 'left the facts already in the store out of the FTS index', e);
      }
    }
    // The trigram index gets its OWN build flag: trigram availability is decided
    // per-session (the guarded CREATE above), so a store first opened on a SQLite
    // without trigram support must backfill when a later session gains it —
    // under the shared flag it kept a silently partial index forever.
    if (this.factsTrigram) {
      const trigramBuilt = handle.prepare(`SELECT value FROM meta WHERE key = 'facts_trigram_built'`).get() as
        | { value: string }
        | undefined;
      if (trigramBuilt?.value !== '1') {
        try {
          handle.exec(`INSERT INTO facts_trigram(facts_trigram) VALUES('rebuild')`);
          handle
            .prepare(`INSERT INTO meta(key, value) VALUES('facts_trigram_built', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`)
            .run();
        } catch {
          // quiet: the flag stays unset, so the next open runs the backfill
          // again — this heals itself without anyone reading a log.
        }
      }
    }

    this.db = handle;
    return handle;
  };


  /**
   * Persist one message. Idempotent per turn: re-capturing the same
   * (thread, turn, role, text) is a no-op, while the user legitimately repeating
   * the same text in a later turn creates a distinct episodic message.
   *
   * A turn's assistant reply can be captured several times as it grows — one turn
   * can hold several assistant messages (see pi/normalize.ts), and each completed
   * one carries the reply SO FAR. Later captures therefore supersede the earlier,
   * shorter version of the same turn rather than piling up nested near-duplicates.
   */
  recordMessage = (input: RecordMessageInput): void => {
    const text = input.text.trim();
    if (!text) return;
    const handle = this.open();
    // Supersede + insert must be atomic: a failed insert after the deletes would
    // silently lose the turn's whole reply (capture swallows errors by design).
    // IMMEDIATE, not deferred: the supersede SELECT below would otherwise open a
    // read snapshot that the first DELETE has to upgrade, and in WAL an upgrade
    // whose snapshot another connection has already outrun fails with
    // SQLITE_BUSY_SNAPSHOT *without* consulting the busy handler. Taking the
    // write lock up front puts the wait back under busy_timeout.
    handle.exec('BEGIN IMMEDIATE');
    try {
      if (input.turnId) {
        const superseded = handle
          .prepare(
            // A literal prefix test — LIKE would read `%`/`_` inside a stored reply as
            // wildcards, and a false positive here deletes someone's message.
            `SELECT id FROM messages
              WHERE thread_id = ? AND turn_id = ? AND role = ?
                AND text <> ? AND substr(?, 1, length(text)) = text`
          )
          .all(input.threadId, input.turnId, input.role, text, text) as { id: number }[];
        for (const row of superseded) {
          // No FK cascade — drop the cached vectors in the same pass (episodic
          // embedding runs at turn end, so normally there are none yet).
          handle.prepare(`DELETE FROM message_vectors WHERE message_id = ?`).run(row.id);
          handle.prepare(`DELETE FROM message_chunk_vectors WHERE message_id = ?`).run(row.id);
          handle.prepare(`DELETE FROM message_chunks WHERE message_id = ?`).run(row.id);
          handle.prepare(`DELETE FROM messages WHERE id = ?`).run(row.id);
        }
      }
      handle
        .prepare(
          `INSERT OR IGNORE INTO messages (thread_id, turn_id, role, ts, cwd, text, dedup_key, web)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.threadId,
          input.turnId ?? null,
          input.role,
          input.ts ?? this.nowSeconds(),
          input.cwd ?? null,
          text,
          this.dedupKey(input.threadId, input.turnId, input.role, text),
          input.web ? 1 : 0
        );
      handle.exec('COMMIT');
    } catch (err) {
      handle.exec('ROLLBACK');
      throw err;
    }
  };


  /** Persist (or replace) a turn's answer-time breakdown. Best-effort; keyed by entry id. */
  upsertTurnTiming = (rec: TurnTimingRecord): void => {
    const handle = this.open();
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
        this.nowSeconds()
      );
  };


  /** Load a thread's persisted turn timings, keyed by final assistant entry id. */
  getTurnTimingsByThread = (threadId: string): Map<string, TurnTiming> => {
    const handle = this.open();
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
  };


  /** Persist (or replace) a turn's tool activity + sources. Best-effort; keyed by entry id. */
  upsertTurnActivity = (rec: {
    turnEntryId: string;
    threadId: string;
    payload: TurnActivityPayload;
  }): void => {
    const handle = this.open();
    handle
      .prepare(
        `INSERT INTO turn_activities (turn_entry_id, thread_id, payload, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(turn_entry_id) DO UPDATE SET
           thread_id = excluded.thread_id,
           payload = excluded.payload`
      )
      .run(rec.turnEntryId, rec.threadId, JSON.stringify(rec.payload), this.nowSeconds());
  };


  /** Load a thread's persisted turn activities, keyed by final assistant entry id. */
  getTurnActivitiesByThread = (threadId: string): Map<string, TurnActivityPayload> => {
    const handle = this.open();
    const rows = handle
      .prepare(`SELECT turn_entry_id AS entryId, payload FROM turn_activities WHERE thread_id = ?`)
      .all(threadId) as Array<{ entryId: string; payload: string }>;
    const out = new Map<string, TurnActivityPayload>();
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.payload) as TurnActivityPayload;
        out.set(r.entryId, {
          activity: Array.isArray(parsed.activity) ? parsed.activity : [],
          sources: Array.isArray(parsed.sources) ? parsed.sources : []
        });
      } catch (e) {
        // The message renders as if the turn had done nothing — no sources, no
        // activity — which is exactly what a turn that did nothing looks like.
        degrade('recall.store', 'dropped one turn\'s stored activity and sources', e);
      }
    }
    return out;
  };


  /**
   * Record the durable facts injected on `threadId`'s latest turn. Best-effort.
   *
   * `disputed` is written for every entry, never omitted when false: the audit UI
   * distinguishes "recorded as not disputed" from "recorded before the flag
   * existed", and an omitted key would collapse the two (see getActiveFactIds).
   */
  setActiveFacts = (
    threadId: string,
    facts: Array<number | { id: number; reason?: FactSelectionReason; disputed?: boolean }>,
    tier: FactTier
  ): void => {
    const handle = this.open();
    handle
      .prepare(
        `INSERT INTO active_facts (thread_id, fact_ids, tier, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           fact_ids = excluded.fact_ids,
           tier = excluded.tier,
           updated_at = excluded.updated_at`
      )
      .run(
        threadId,
        JSON.stringify(
          facts.map((f) => (typeof f === 'number' ? f : { id: f.id, reason: f.reason, disputed: !!f.disputed }))
        ),
        tier,
        this.nowSeconds()
      );
  };


  /**
   * Read a thread's last injected fact ids + tier, or null if none recorded.
   *
   * `disputed[id]` is the flag as it was AT INJECTION TIME, which is the only
   * honest answer for an audit surface — a fact's current status says nothing
   * about whether the model was told it was contested on that turn. `undefined`
   * means the row predates the flag (a bare id, or an object without the key);
   * callers decide what to show for those, since the value is genuinely unknown.
   */
  getActiveFactIds = (threadId: string): {
    factIds: number[];
    reasons: Record<number, FactSelectionReason | undefined>;
    disputed: Record<number, boolean | undefined>;
    tier: FactTier;
  } | null => {
    const handle = this.open();
    const row = handle
      .prepare(`SELECT fact_ids AS factIds, tier FROM active_facts WHERE thread_id = ?`)
      .get(threadId) as { factIds: string; tier: string } | undefined;
    if (!row) return null;
    let factIds: number[] = [];
    const reasons: Record<number, FactSelectionReason | undefined> = {};
    const disputed: Record<number, boolean | undefined> = {};
    try {
      const parsed = JSON.parse(row.factIds);
      if (Array.isArray(parsed)) {
        for (const value of parsed) {
          if (typeof value === 'number') factIds.push(value);
          else if (value && typeof value === 'object' && typeof value.id === 'number') {
            factIds.push(value.id);
            reasons[value.id] = value.reason;
            if (typeof value.disputed === 'boolean') disputed[value.id] = value.disputed;
          }
        }
      }
    } catch (e) {
      // Reads back as "this thread had no facts injected", which is a real
      // state a thread can be in — so the row's existence is the only clue left.
      degrade('recall.store', 'read a thread\'s injected fact set as empty', e);
    }
    return { factIds, reasons, disputed, tier: row.tier as FactTier };
  };


  // ---- per-turn injected-facts log (usage grading source) ----

  /**
   * Append the fact ids injected on one turn. Unlike setActiveFacts (latest set
   * per thread, for the UI) this keeps every turn until graded, so a distill batch
   * spanning several turns can grade each reply against what it actually saw.
   * Best-effort: prunes rows older than 30 days so an abandoned thread's ungraded
   * rows don't accumulate forever.
   */
  recordTurnInjectedFacts = (threadId: string, turnId: string, factIds: number[]): void => {
    if (!turnId || factIds.length === 0) return;
    const handle = this.open();
    const now = this.nowSeconds();
    handle
      .prepare(
        `INSERT INTO turn_injected_facts (thread_id, turn_id, fact_ids, graded, created_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(thread_id, turn_id) DO UPDATE SET fact_ids = excluded.fact_ids`
      )
      .run(threadId, turnId, JSON.stringify(factIds), now);
    handle.prepare(`DELETE FROM turn_injected_facts WHERE created_at < ?`).run(now - 30 * 24 * 3600);
  };


  /** Ungraded injected-fact rows for the given turn ids (a distill batch's turns). */
  getUngradedTurnFacts = (turnIds: string[]): TurnInjectedFacts[] => {
    if (turnIds.length === 0) return [];
    const placeholders = turnIds.map(() => '?').join(',');
    const rows = this.open()
      .prepare(
        `SELECT thread_id AS threadId, turn_id AS turnId, fact_ids AS factIds
         FROM turn_injected_facts WHERE graded = 0 AND turn_id IN (${placeholders})`
      )
      .all(...turnIds) as Array<{ threadId: string; turnId: string; factIds: string }>;
    return rows.flatMap((r) => {
      try {
        const ids = JSON.parse(r.factIds);
        return Array.isArray(ids)
          ? [{ threadId: r.threadId, turnId: r.turnId, factIds: ids.filter((v): v is number => typeof v === 'number') }]
          : [];
      } catch (e) {
        // The turn drops out of the batch and its row stays ungraded forever —
        // every later distill re-reads it and drops it again.
        degrade('recall.store', 'left one turn out of the fact-grading batch', e);
        return [];
      }
    });
  };


  markTurnFactsGraded = (threadId: string, turnId: string): void => {
    this.open().prepare(`UPDATE turn_injected_facts SET graded = 1 WHERE thread_id = ? AND turn_id = ?`)
      .run(threadId, turnId);
  };


  // ---- per-turn injected-docs log (folder learn-on-use source) ----

  /** Append the folder-doc excerpts injected on one turn (same contract as facts). */
  recordTurnInjectedDocs = (threadId: string, turnId: string, docs: InjectedDocRef[]): void => {
    if (!turnId || docs.length === 0) return;
    const handle = this.open();
    const now = this.nowSeconds();
    handle
      .prepare(
        `INSERT INTO turn_injected_docs (thread_id, turn_id, doc_refs, consumed, created_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(thread_id, turn_id) DO UPDATE SET doc_refs = excluded.doc_refs`
      )
      .run(threadId, turnId, JSON.stringify(docs), now);
    handle.prepare(`DELETE FROM turn_injected_docs WHERE created_at < ?`).run(now - 30 * 24 * 3600);
  };


  /** Unconsumed injected-doc rows for the given turn ids (a distill batch's turns). */
  getUnconsumedTurnDocs = (turnIds: string[]): TurnInjectedDocs[] => {
    if (turnIds.length === 0) return [];
    const placeholders = turnIds.map(() => '?').join(',');
    const rows = this.open()
      .prepare(
        `SELECT thread_id AS threadId, turn_id AS turnId, doc_refs AS docRefs
         FROM turn_injected_docs WHERE consumed = 0 AND turn_id IN (${placeholders})`
      )
      .all(...turnIds) as Array<{ threadId: string; turnId: string; docRefs: string }>;
    return rows.flatMap((r) => {
      try {
        const docs = JSON.parse(r.docRefs);
        return Array.isArray(docs)
          ? [{
              threadId: r.threadId,
              turnId: r.turnId,
              docs: docs.filter(
                (d): d is InjectedDocRef =>
                  !!d && typeof d === 'object' &&
                  typeof (d as InjectedDocRef).folderId === 'string' &&
                  typeof (d as InjectedDocRef).relPath === 'string' &&
                  typeof (d as InjectedDocRef).excerpt === 'string'
              )
            }]
          : [];
      } catch (e) {
        // Same shape as the ungraded facts above: the row stays unconsumed and
        // no later pass can get past it either.
        degrade('recall.store', 'left one turn out of the injected-doc batch', e);
        return [];
      }
    });
  };


  markTurnDocsConsumed = (threadId: string, turnId: string): void => {
    this.open().prepare(`UPDATE turn_injected_docs SET consumed = 1 WHERE thread_id = ? AND turn_id = ?`)
      .run(threadId, turnId);
  };


  // ---- folder-learned facts (source 'folder:<id>') ----

  /** Active facts attributed to one folder source tag. */
  countFactsBySource = (source: string): number => {
    return (this.open()
      .prepare(`SELECT COUNT(*) AS n FROM facts WHERE source = ? AND status = 'active'`)
      .get(source) as { n: number }).n;
  };

  /**
   * Forget a disconnected folder's learned facts. Pinned facts always survive
   * (an explicit user override), as do explicit-converted ones (their source is
   * no longer the folder tag). Each goes through deleteFact so vectors,
   * evidence, conflicts and superseded_by pointers are cleaned consistently.
   * Returns the number of facts deleted.
   */
  forgetFactsBySource = (source: string): number => {
    const ids = (this.open()
      .prepare(`SELECT id FROM facts WHERE source = ? AND pinned = 0`)
      .all(source) as Array<{ id: number }>).map((r) => r.id);
    for (const id of ids) this.deleteFact(id);
    return ids.length;
  };


  /**
   * Apply one graded turn: every injected fact gains an injection count; the used
   * subset also gains a use count + last-used stamp. Deliberately does NOT touch
   * confidence — usage only reorders ranking, never crosses the injection gate.
   */
  recordFactUsage = (injectedIds: number[], usedIds: number[], ts = this.nowSeconds()): void => {
    if (injectedIds.length === 0) return;
    const handle = this.open();
    const used = new Set(usedIds);
    const bump = handle.prepare(
      `UPDATE facts SET times_injected = times_injected + 1,
              times_used = times_used + ?,
              last_used_at = CASE WHEN ? = 1 THEN ? ELSE last_used_at END,
              last_graded_at = ?
       WHERE id = ?`
    );
    // One turn's grades land atomically — a crash mid-loop must not leave half
    // the turn's injection counts applied.
    handle.exec('BEGIN');
    try {
      for (const id of injectedIds) {
        const wasUsed = used.has(id) ? 1 : 0;
        bump.run(wasUsed, wasUsed, ts, ts, id);
      }
      handle.exec('COMMIT');
    } catch (err) {
      handle.exec('ROLLBACK');
      throw err;
    }
  };


  /**
   * Resolve fact ids to their current rows, preserving the given order and silently
   * dropping ids whose fact has since been deleted or merged away by consolidation.
   */
  getFactsByIds = (ids: number[]): Fact[] => {
    if (ids.length === 0) return [];
    const handle = this.open();
    const placeholders = ids.map(() => '?').join(',');
    const rows = handle
      .prepare(`SELECT ${FACT_SELECT} FROM facts WHERE id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown>>;
    const byId = new Map<number, Fact>();
    for (const r of rows) byId.set(r.id as number, this.mapFact(r));
    return ids.map((id) => byId.get(id)).filter((f): f is Fact => !!f);
  };


  /**
   * Episodic search over all captured messages. `query` must already be a valid
   * FTS5 MATCH expression (use search.ts to build one safely from raw user text).
   */
  search = (query: string, options: SearchOptions = {}): SearchHit[] => {
    if (!query.trim()) return [];
    const limit = options.limit ?? 5;
    const exclude = options.excludeThreadId ?? null;
    const handle = this.open();
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
  };


  private mapStoredMessage = (r: Record<string, unknown>): StoredMessage => {
    return {
      id: r.id as number,
      threadId: r.threadId as string,
      turnId: (r.turnId as string | null) ?? null,
      role: r.role as MessageRole,
      ts: r.ts as number,
      text: r.text as string,
      web: (r.web as number | null) === 1
    };
  };


  /**
   * Messages with id greater than `sinceId`, oldest first — the distillation pass
   * uses this to process only what's new since its last run (the id is a monotonic
   * autoincrement, so it doubles as a watermark).
   */
  getMessagesForDistill = (sinceId: number, limit = 200): StoredMessage[] => {
    const handle = this.open();
    const rows = handle
      .prepare(
        `SELECT id, thread_id AS threadId, turn_id AS turnId, role, ts, text, web
         FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`
      )
      .all(sinceId, limit) as Array<Record<string, unknown>>;
    return rows.map(this.mapStoredMessage);
  };


  /** Cursor-v2 read: `fromId` is inclusive because a long message may resume mid-text. */
  getMessagesForDistillFrom = (fromId: number, limit = 200): StoredMessage[] => {
    const rows = this.open()
      .prepare(
        `SELECT id, thread_id AS threadId, turn_id AS turnId, role, ts, text, web
         FROM messages WHERE id >= ? ORDER BY id ASC LIMIT ?`
      )
      .all(fromId, limit) as Array<Record<string, unknown>>;
    return rows.map(this.mapStoredMessage);
  };


  /**
   * One thread's messages with id greater than `afterId`, oldest first — the
   * rolling-summary refresh walks these against the summary's own watermark.
   */
  getThreadMessagesAfter = (threadId: string, afterId: number, limit = 200): StoredMessage[] => {
    const rows = this.open()
      .prepare(
        `SELECT id, thread_id AS threadId, turn_id AS turnId, role, ts, text, web
         FROM messages WHERE thread_id = ? AND id > ? ORDER BY id ASC LIMIT ?`
      )
      .all(threadId, afterId, limit) as Array<Record<string, unknown>>;
    return rows.map(this.mapStoredMessage);
  };


  getMessageById = (id: number): StoredMessage | null => {
    const r = this.open().prepare(
      `SELECT id, thread_id AS threadId, turn_id AS turnId, role, ts, text, web FROM messages WHERE id = ?`
    ).get(id) as Record<string, unknown> | undefined;
    return r ? this.mapStoredMessage(r) : null;
  };


  /**
   * Insert or refresh a durable fact (Level 1). Correction-aware via the norm key.
   * Returns the fact's row id (insert or conflict-update alike; null on empty text)
   * so callers holding a fresh embedding can cache it without a lookup.
   */
  upsertFact = (
    text: string,
    sourceOrOptions: string | FactWriteOptions = 'distilled',
    extra: FactWriteOptions = {}
  ): number | null => {
    const clean = text.trim();
    if (!clean) return null;
    const handle = this.open();
    const norm = this.normalizeFact(clean);
    const opts: FactWriteOptions = typeof sourceOrOptions === 'string'
      ? { ...extra, source: sourceOrOptions }
      : sourceOrOptions;
    const source = opts.source ?? 'distilled';
    const now = this.nowSeconds();
    const confidence = Math.min(1, Math.max(0, opts.confidence ?? (source === 'explicit' ? 1 : 0.9)));
    const revive = opts.reviveSuperseded ?? source === 'explicit';
    // Snapshot the prior row so a superseded→active flip below is detectable.
    const prior = handle.prepare(`SELECT id, status FROM facts WHERE norm = ?`).get(norm) as
      | { id: number; status: string }
      | undefined;
    // A correction can change the text under an existing norm — drop any cached
    // vector so it's re-embedded against the new text on the next inject.
    handle.prepare(`DELETE FROM fact_vectors WHERE fact_id IN (SELECT id FROM facts WHERE norm = ?)`).run(norm);
    const row = handle
      .prepare(
        `INSERT INTO facts
           (text, norm, source, category, sensitivity, confidence, status, pinned,
            created_at, updated_at, valid_from, valid_until, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(norm) DO UPDATE SET
           text = excluded.text,
           source = CASE WHEN facts.source = 'explicit' AND excluded.source <> 'explicit'
                         THEN facts.source ELSE excluded.source END,
           category = CASE WHEN excluded.category = 'other' THEN facts.category ELSE excluded.category END,
           -- Sensitivity only ratchets up: once a claim is classified sensitive, a later
           -- reworded write must not quietly loosen its stricter relevance gate. Safe
           -- because nothing seeds 'sensitive' by default — only a classifier decision does.
           sensitivity = CASE WHEN facts.sensitivity = 'sensitive' THEN facts.sensitivity ELSE excluded.sensitivity END,
           confidence = MAX(facts.confidence, excluded.confidence),
           -- Reactivation needs authority (see FactWriteOptions.reviveSuperseded):
           -- an unauthorized restatement refreshes the row but leaves it retired.
           status = CASE WHEN facts.status = 'superseded' AND ? = 1 THEN excluded.status ELSE facts.status END,
           pinned = MAX(facts.pinned, excluded.pinned),
           updated_at = excluded.updated_at,
           valid_from = COALESCE(excluded.valid_from, facts.valid_from),
           valid_until = COALESCE(excluded.valid_until, facts.valid_until)
         RETURNING id`
      )
      .get(
        clean,
        norm,
        source,
        opts.category ?? 'other',
        opts.sensitivity ?? 'standard',
        confidence,
        opts.status ?? 'active',
        opts.pinned ? 1 : 0,
        now,
        now,
        opts.validFrom ?? null,
        opts.validUntil ?? null,
        revive ? 1 : 0
      ) as { id: number } | undefined;
    const id = row?.id ?? null;
    if (id != null && revive && prior?.status === 'superseded' && prior.id === id && (opts.status ?? 'active') === 'active') {
      // A revival is almost always a revival from EXPIRY (supersedeFact mangles the
      // norm key, so a restatement can't land on a row retired any other way). The
      // DO UPDATE above keeps the old valid_until, which sweepExpiredFacts would
      // re-apply within the minute — clear it, exactly as restoreSupersededFact
      // does, unless this write carried a fresh expiry of its own.
      handle.prepare(`UPDATE facts SET valid_until = ? WHERE id = ?`).run(opts.validUntil ?? null, id);
      // Legitimate resurrection: wipe the pair memos so the neighbour sweep
      // re-judges the revived fact — above all against whatever superseded it.
      // Pairs that went through fact_conflicts stay owned by the conflict
      // machinery (isRelationChecked still sees them there).
      handle.prepare(`DELETE FROM fact_relation_checks WHERE fact_a = ? OR fact_b = ?`).run(id, id);
    }
    if (id != null && opts.evidence?.length) this.addFactEvidence(id, opts.evidence);
    return id;
  };


  getFacts = (limit = 100): Fact[] => {
    this.sweepExpiredFacts();
    const handle = this.open();
    const rows = handle
      .prepare(`SELECT ${FACT_SELECT} FROM facts WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(this.mapFact);
  };


  /**
   * Facts first written at/after `ts` (Unix seconds), optionally filtered by a
   * source LIKE pattern ('distilled', 'folder:%'). Re-upserts of an existing
   * fact bump updated_at, not created_at, so this returns only genuinely new
   * rows — the background passes use it to NAME what they just learned in the
   * activity feed instead of reporting a bare count.
   */
  getFactsCreatedSince = (ts: number, sourceLike?: string): Fact[] => {
    const handle = this.open();
    const rows = (sourceLike
      ? handle
          .prepare(`SELECT ${FACT_SELECT} FROM facts WHERE created_at >= ? AND source LIKE ? ORDER BY id ASC`)
          .all(ts, sourceLike)
      : handle
          .prepare(`SELECT ${FACT_SELECT} FROM facts WHERE created_at >= ? ORDER BY id ASC`)
          .all(ts)) as Array<Record<string, unknown>>;
    return rows.map(this.mapFact);
  };


  /**
   * Every fact, uncapped — for the consolidation pass, which must reason over the
   * whole set to merge/correct/drop. `getFacts` keeps its 100-row cap for inject/UI.
   */
  getAllFacts = (): Fact[] => {
    this.sweepExpiredFacts();
    const handle = this.open();
    const rows = handle
      .prepare(`SELECT ${FACT_SELECT} FROM facts ORDER BY id ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(this.mapFact);
  };


  getInjectableFacts = (): Fact[] => {
    this.sweepExpiredFacts();
    const rows = this.open()
      .prepare(
        // A pin is an explicit user override — it outranks the confidence floor that
        // otherwise holds back unconfirmed assistant-derived claims.
        `SELECT ${FACT_SELECT} FROM facts
         WHERE status = 'active' AND (valid_until IS NULL OR valid_until >= ?)
           AND (pinned = 1 OR confidence >= 0.7 OR source IN ('explicit', 'legacy'))
         ORDER BY id ASC`
      )
      .all(this.nowSeconds()) as Array<Record<string, unknown>>;
    const base = rows.map(this.mapFact);
    const disputed = this.getDisputedRepresentatives();
    return disputed.length === 0 ? base : [...base, ...disputed].sort((a, b) => a.id - b.id);
  };


  /**
   * One injectable representative per OPEN conflict, flagged `disputed`, so a
   * disagreement degrades to "mostly right" instead of amnesia about both sides.
   * An explicit side wins the pick (the user's word holds while disputed);
   * otherwise the side with the newest evidence (updated_at is unreliable for
   * truth-recency — consolidation bumps it without new evidence). The pick must
   * clear the same gates as an active fact; the pinned lane can't apply because
   * createFactConflict unpins, so a doc-vs-doc pair (both 0.55) yields none.
   */
  private getDisputedRepresentatives = (): Fact[] => {
    const handle = this.open();
    const pairs = handle.prepare(
      `SELECT fact_a AS factA, fact_b AS factB FROM fact_conflicts WHERE status = 'open'`
    ).all() as Array<{ factA: number; factB: number }>;
    if (pairs.length === 0) return [];
    // This runs on the pre-turn hot path (via getInjectableFacts): hydrate every
    // involved fact in ONE query and take evidence recency from the batch
    // helper, instead of the old 4 queries per open conflict.
    const ids = [...new Set(pairs.flatMap((p) => [p.factA, p.factB]))];
    const rows = handle
      .prepare(`SELECT ${FACT_SELECT} FROM facts WHERE id IN (${ids.map(() => '?').join(', ')})`)
      .all(...ids) as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((r) => {
      const fact = this.mapFact(r);
      return [fact.id, fact] as const;
    }));
    const evidenceTs = this.getNewestEvidenceTsByFact();
    const now = this.nowSeconds();
    const picked = new Map<number, Fact>();
    for (const pair of pairs) {
      const sides = [byId.get(pair.factA), byId.get(pair.factB)]
        .filter((f): f is Fact => f?.status === 'conflicted');
      if (sides.length === 0) continue;
      const rep = sides.find((f) => f.source === 'explicit')
        ?? sides.reduce((best, f) => {
          const bestTs = evidenceTs.get(best.id) ?? best.updatedAt;
          const ts = evidenceTs.get(f.id) ?? f.updatedAt;
          return ts > bestTs || (ts === bestTs && f.id > best.id) ? f : best;
        });
      if (rep.validUntil != null && rep.validUntil < now) continue;
      if (!(rep.confidence >= 0.7 || rep.source === 'explicit' || rep.source === 'legacy')) continue;
      if (!picked.has(rep.id)) picked.set(rep.id, { ...rep, disputed: true });
    }
    return [...picked.values()];
  };


  /** Wall clock of the last getter-triggered expiry sweep. */
  private lastExpirySweep = 0;

  /**
   * Getter-side expiry, throttled to once a minute: valid_until has end-of-day
   * granularity, so fact reads shouldn't each issue an UPDATE just to retire
   * day-old expiries a few seconds sooner. getInjectableFacts additionally
   * filters valid_until in SQL, so an expired fact never injects regardless of
   * the sweep. Direct expireFacts() calls are never throttled.
   */
  private sweepExpiredFacts = (): void => {
    const now = this.nowSeconds();
    if (now - this.lastExpirySweep < 60) return;
    this.lastExpirySweep = now;
    this.expireFacts(now);
  };


  expireFacts = (now = this.nowSeconds()): number => {
    return this.open()
      .prepare(
        `UPDATE facts SET status = 'superseded', pinned = 0, updated_at = ?
         WHERE status = 'active' AND valid_until IS NOT NULL AND valid_until < ?`
      )
      .run(now, now).changes as number;
  };


  addFactEvidence = (factId: number, evidence: Omit<FactEvidence, 'id'>[]): void => {
    if (evidence.length === 0) return;
    const stmt = this.open().prepare(
      `INSERT OR IGNORE INTO fact_evidence
         (fact_id, message_id, thread_id, role, ts, excerpt, origin, folder_id, rel_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const e of evidence) {
      stmt.run(
        factId, e.messageId, e.threadId, e.role, e.timestamp, e.excerpt.slice(0, 1000), e.origin,
        e.folderId ?? null, e.relPath ?? null
      );
    }
  };


  getFactEvidence = (factId: number): FactEvidence[] => {
    const rows = this.open()
      .prepare(
        `SELECT id, message_id AS messageId, thread_id AS threadId, role, ts AS timestamp, excerpt, origin,
                folder_id AS folderId, rel_path AS relPath
         FROM fact_evidence WHERE fact_id = ? ORDER BY ts ASC, id ASC`
      )
      .all(factId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      messageId: (r.messageId as number | null) ?? null,
      threadId: (r.threadId as string | null) ?? null,
      role: (r.role as FactEvidence['role']) ?? null,
      timestamp: r.timestamp as number,
      excerpt: r.excerpt as string,
      origin: r.origin as FactEvidence['origin'],
      folderId: (r.folderId as string | null) ?? null,
      relPath: (r.relPath as string | null) ?? null
    }));
  };


  /** Evidence-row counts for every fact that has any, keyed by fact id. */
  getFactEvidenceCounts = (): Map<number, number> => {
    const rows = this.open()
      .prepare(`SELECT fact_id AS factId, COUNT(*) AS n FROM fact_evidence GROUP BY fact_id`)
      .all() as Array<{ factId: number; n: number }>;
    return new Map(rows.map((r) => [r.factId, r.n]));
  };


  private toFactDetails = (fact: Fact): FactDetails => {
    return { ...fact, evidence: this.getFactEvidence(fact.id) };
  };


  getFactDetails = (id: number): FactDetails | null => {
    const row = this.open().prepare(`SELECT ${FACT_SELECT} FROM facts WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toFactDetails(this.mapFact(row)) : null;
  };


  setFactPinned = (id: number, pinned: boolean): boolean => {
    const handle = this.open();
    if (pinned) {
      const count = (handle.prepare(`SELECT COUNT(*) AS n FROM facts WHERE pinned = 1 AND status = 'active'`).get() as { n: number }).n;
      if (count >= MAX_PINNED_FACTS) return false;
    }
    return (handle.prepare(`UPDATE facts SET pinned = ?, updated_at = ? WHERE id = ? AND status = 'active'`)
      .run(pinned ? 1 : 0, this.nowSeconds(), id).changes as number) > 0;
  };


  /**
   * Rewrite an active fact's text in place (note normalization). Returns the id of
   * the surviving fact: `id` itself, the fact it merged into when the new text
   * normalizes onto an existing claim, or null when nothing was written (missing
   * or inactive fact, empty text).
   */
  updateFactText = (id: number, newText: string): number | null => {
    const clean = newText.trim();
    if (!clean) return null;
    const handle = this.open();
    const row = handle.prepare(`SELECT text, norm, status FROM facts WHERE id = ?`).get(id) as
      | { text: string; norm: string; status: string }
      | undefined;
    if (!row || row.status !== 'active') return null;
    const norm = this.normalizeFact(clean);
    if (row.text === clean && row.norm === norm) return id;
    const existing = handle
      .prepare(`SELECT id FROM facts WHERE norm = ? AND id <> ?`)
      .get(norm, id) as { id: number } | undefined;
    if (existing) {
      // The rewrite lands on a claim we already hold: the user just re-asserted it,
      // so ratchet the survivor to explicit, keep this note's provenance on it, and
      // retire the duplicate instead of violating UNIQUE(norm).
      this.confirmFact(existing.id);
      handle.prepare(`UPDATE OR IGNORE fact_evidence SET fact_id = ? WHERE fact_id = ?`).run(existing.id, id);
      this.supersedeFact(id, existing.id);
      return existing.id;
    }
    // Same invalidation as upsertFact: the text changed, so any cached vector must
    // be re-embedded on the next inject. FTS/trigram follow via the update triggers.
    handle.prepare(`DELETE FROM fact_vectors WHERE fact_id = ?`).run(id);
    handle.prepare(`UPDATE facts SET text = ?, norm = ?, updated_at = ? WHERE id = ?`).run(clean, norm, this.nowSeconds(), id);
    return id;
  };


  confirmFact = (id: number): boolean => {
    return (this.open().prepare(
      `UPDATE facts SET source = 'explicit', confidence = 1, status = 'active', updated_at = ? WHERE id = ?`
    ).run(this.nowSeconds(), id).changes as number) > 0;
  };


  supersedeFact = (id: number, supersededBy: number | null = null): boolean => {
    const handle = this.open();
    const changed = (handle.prepare(
      `UPDATE facts SET status = 'superseded', pinned = 0, superseded_by = ?,
              norm = CASE WHEN norm LIKE '__superseded__%' THEN norm ELSE '__superseded__' || id || ':' || norm END,
              updated_at = ? WHERE id = ?`
    ).run(supersededBy, this.nowSeconds(), id).changes as number) > 0;
    if (changed) {
      handle.prepare(
        `UPDATE fact_conflicts SET status = 'resolved', resolved_at = ?, resolution = 'superseded'
         WHERE status = 'open' AND (fact_a = ? OR fact_b = ?)`
      ).run(this.nowSeconds(), id, id);
    }
    return changed;
  };


  restoreSupersededFact = (id: number): boolean => {
    const handle = this.open();
    const row = handle.prepare(`SELECT text FROM facts WHERE id = ? AND status = 'superseded'`).get(id) as
      | { text: string }
      | undefined;
    if (!row) return false;
    try {
      return (handle.prepare(
        `UPDATE facts SET status = 'active', norm = ?, superseded_by = NULL,
                valid_until = NULL, updated_at = ? WHERE id = ?`
      ).run(this.normalizeFact(row.text), this.nowSeconds(), id).changes as number) > 0;
    } catch {
      // quiet: an active fact already owns the same normalized claim. The false
      // this returns is the answer the caller asked for, not a swallowed one.
      return false;
    }
  };


  createFactConflict = (factA: number, factB: number, reason: string): number | null => {
    if (factA === factB) return null;
    const handle = this.open();
    handle.prepare(`UPDATE facts SET status = 'conflicted', pinned = 0 WHERE id IN (?, ?)`).run(factA, factB);
    const row = handle.prepare(
      `INSERT OR IGNORE INTO fact_conflicts(fact_a, fact_b, reason, status, created_at)
       VALUES (?, ?, ?, 'open', ?) RETURNING id`
    ).get(factA, factB, reason.slice(0, 500), this.nowSeconds()) as { id: number } | undefined;
    return row?.id ?? null;
  };


  /**
   * Every fact row, cheaply — sizes the lexical tier's bm25 noise gate. Counts
   * ALL statuses on purpose: the gate asks whether bm25 magnitudes are meaningful
   * yet, and IDF/avgdl come from facts_fts, which the triggers keep populated for
   * superseded rows too (retiring a fact flips its status, it doesn't delete it).
   */
  countFacts = (): number => {
    return (this.open().prepare(`SELECT COUNT(*) AS n FROM facts`).get() as { n: number }).n;
  };


  /** Open conflicts, cheaply — including the ones only the user can settle. */
  countOpenConflicts = (): number => {
    return (this.open().prepare(
      `SELECT COUNT(*) AS n FROM fact_conflicts WHERE status = 'open'`
    ).get() as { n: number }).n;
  };


  /**
   * Open conflicts the autonomous adjudicator can still act on — the gate for the
   * relation-check producer pass. Explicit-side and attempt-exhausted conflicts
   * are excluded because nothing but the user will ever clear them, and a backlog
   * of those would switch the producer off for good.
   */
  countAdjudicableConflicts = (maxAttempts: number): number => {
    return (this.open().prepare(
      `SELECT COUNT(*) AS n FROM fact_conflicts WHERE ${ADJUDICABLE_CONFLICT_WHERE}`
    ).get(maxAttempts) as { n: number }).n;
  };


  getMemoryConflicts = (): MemoryConflict[] => {
    const rows = this.open().prepare(
      `SELECT id, fact_a AS factA, fact_b AS factB, reason, created_at AS createdAt
       FROM fact_conflicts WHERE status = 'open' ORDER BY created_at DESC`
    ).all() as Array<{ id: number; factA: number; factB: number; reason: string; createdAt: number }>;
    return rows.flatMap((r) => {
      const factA = this.getFactDetails(r.factA);
      const factB = this.getFactDetails(r.factB);
      return factA && factB ? [{ ...r, factA, factB }] : [];
    });
  };


  resolveMemoryConflict = (id: number, resolution: ConflictResolution): boolean => {
    const handle = this.open();
    const row = handle.prepare(
      `SELECT fact_a AS factA, fact_b AS factB FROM fact_conflicts WHERE id = ? AND status = 'open'`
    ).get(id) as { factA: number; factB: number } | undefined;
    if (!row) return false;
    const a = this.getFactDetails(row.factA);
    const b = this.getFactDetails(row.factB);
    if (!a || !b) return false;
    let loserId: number | null = null;
    if (resolution !== 'keep_both') {
      const newer = a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.id > b.id) ? a : b;
      const older = newer.id === a.id ? b : a;
      const keep = resolution === 'keep_newer' ? newer : older;
      const lose = keep.id === a.id ? b : a;
      loserId = lose.id;
      this.supersedeFact(lose.id, keep.id);
    }
    handle.prepare(
      `UPDATE fact_conflicts SET status = 'resolved', resolved_at = ?, resolution = ? WHERE id = ?`
    ).run(this.nowSeconds(), resolution, id);
    for (const factId of [a.id, b.id]) {
      if (factId !== loserId) this.settleConflictSide(factId);
    }
    return true;
  };


  /** Reactivate a conflict side unless it's still in another open conflict (or superseded). */
  private settleConflictSide = (factId: number): void => {
    const handle = this.open();
    const stillConflicted = (handle.prepare(
      `SELECT EXISTS(SELECT 1 FROM fact_conflicts WHERE status = 'open' AND (fact_a = ? OR fact_b = ?)) AS n`
    ).get(factId, factId) as { n: number }).n === 1;
    handle.prepare(`UPDATE facts SET status = ? WHERE id = ? AND status <> 'superseded'`)
      .run(stillConflicted ? 'conflicted' : 'active', factId);
  };


  /**
   * Open conflicts eligible for autonomous adjudication (ADJUDICABLE_CONFLICT_WHERE),
   * hydrated with both sides. Oldest first.
   */
  getConflictsForAdjudication = (limit: number, maxAttempts: number): ConflictForAdjudication[] => {
    const rows = this.open().prepare(
      `SELECT id, fact_a AS factA, fact_b AS factB, reason, adjudicate_attempts AS attempts
       FROM fact_conflicts WHERE ${ADJUDICABLE_CONFLICT_WHERE}
       ORDER BY created_at ASC, id ASC LIMIT ?`
    ).all(maxAttempts, limit) as Array<{ id: number; factA: number; factB: number; reason: string; attempts: number }>;
    return rows.flatMap((r) => {
      const factA = this.getFactDetails(r.factA);
      const factB = this.getFactDetails(r.factB);
      // Both sides are guaranteed present by the predicate; this is hydration, not
      // a second copy of it — re-stating the eligibility rules here is what let the
      // gate's count drift away from this query in the first place.
      if (!factA || !factB) return [];
      return [{ id: r.id, reason: r.reason, attempts: r.attempts, factA, factB }];
    });
  };


  bumpAdjudicationAttempts = (conflictId: number): void => {
    this.open().prepare(
      `UPDATE fact_conflicts SET adjudicate_attempts = adjudicate_attempts + 1 WHERE id = ?`
    ).run(conflictId);
  };

  /**
   * Give back an attempt counted for a call that never reached a verdict. The
   * bump happens before the model call so a crash mid-call still costs one — a
   * caught error is the other case, and burning the budget on a model that is
   * merely down is what drops a conflict to manual-only for good.
   */
  refundAdjudicationAttempt = (conflictId: number): void => {
    this.open().prepare(
      `UPDATE fact_conflicts SET adjudicate_attempts = MAX(0, adjudicate_attempts - 1) WHERE id = ?`
    ).run(conflictId);
  };


  /**
   * Queue unordered fact pairs for relation classification. INSERT OR IGNORE on
   * the normalized (min, max) pair makes re-enqueueing free, so every discovery
   * path (write-time sweep overflow, co-injection, backfill) can fire blind.
   * Pairs that ever reached fact_conflicts are skipped — the conflict machinery
   * already owns their resolution, whatever its outcome was.
   */
  enqueueRelationChecks = (pairs: Array<[number, number]>, origin: RelationCheckOrigin): number => {
    const handle = this.open();
    const insert = handle.prepare(
      `INSERT OR IGNORE INTO fact_relation_checks (fact_a, fact_b, verdict, origin, created_at)
       SELECT ?, ?, NULL, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM fact_conflicts
         WHERE MIN(fact_a, fact_b) = ? AND MAX(fact_a, fact_b) = ?
       )`
    );
    let queued = 0;
    for (const [x, y] of pairs) {
      if (x === y) continue;
      const a = Math.min(x, y);
      const b = Math.max(x, y);
      queued += insert.run(a, b, origin, this.nowSeconds(), a, b).changes as number;
    }
    return queued;
  };


  /** Has this unordered pair already been classified (or conflicted)? */
  isRelationChecked = (x: number, y: number): boolean => {
    const a = Math.min(x, y);
    const b = Math.max(x, y);
    const row = this.open().prepare(
      `SELECT EXISTS(
         SELECT 1 FROM fact_relation_checks WHERE fact_a = ? AND fact_b = ? AND verdict IS NOT NULL
       ) OR EXISTS(
         SELECT 1 FROM fact_conflicts WHERE MIN(fact_a, fact_b) = ? AND MAX(fact_a, fact_b) = ?
       ) AS n`
    ).get(a, b, a, b) as { n: number };
    return row.n === 1;
  };


  /**
   * Pending relation checks hydrated for the background classify pass, oldest
   * first. Rows whose sides are no longer both active are settled as 'stale' on
   * the way out — the pair's disagreement (if any) was resolved by other means.
   */
  getPendingRelationChecks = (limit: number): PendingRelationCheck[] => {
    const handle = this.open();
    const out: PendingRelationCheck[] = [];
    // Over-fetch so a run that settles stale rows still fills the limit.
    //
    // A pair with a side in another open conflict is not judgeable yet, and it is
    // excluded HERE rather than skipped after the fetch: a conflict that only the
    // user can settle keeps its pairs pending forever, and since they are also the
    // oldest rows they used to fill the whole window on every pass — past ~limit*4
    // of them the queue returned zero work indefinitely while ready pairs waited
    // behind them. Filtering in SQL keeps them queued (they come back the moment
    // the conflict settles, unlike terminal 'stale') without letting them occupy
    // the window.
    const rows = handle.prepare(
      `SELECT id, fact_a AS factA, fact_b AS factB, origin
       FROM fact_relation_checks r
       WHERE r.verdict IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM facts f WHERE f.id IN (r.fact_a, r.fact_b) AND f.status = 'conflicted'
         )
       ORDER BY r.created_at ASC, r.id ASC LIMIT ?`
    ).all(limit * 4) as Array<{ id: number; factA: number; factB: number; origin: string }>;
    for (const r of rows) {
      if (out.length >= limit) break;
      const factA = this.getFactDetails(r.factA);
      const factB = this.getFactDetails(r.factB);
      if (factA?.status === 'active' && factB?.status === 'active') {
        out.push({ id: r.id, origin: r.origin, factA, factB });
      } else if (!factA || factA.status === 'superseded' || !factB || factB.status === 'superseded') {
        this.recordRelationVerdict(r.id, 'stale');
      }
    }
    return out;
  };


  recordRelationVerdict = (id: number, verdict: string): void => {
    this.open().prepare(
      `UPDATE fact_relation_checks SET verdict = ?, checked_at = ? WHERE id = ?`
    ).run(verdict.slice(0, 40), this.nowSeconds(), id);
  };


  /**
   * Memoize a verdict for an unordered pair judged outside the queue (the
   * write-time sweep classifies inline). Upserts so a pending row left by an
   * earlier discovery path is settled rather than duplicated.
   */
  recordRelationResult = (x: number, y: number, verdict: string, origin: RelationCheckOrigin): void => {
    if (x === y) return;
    const a = Math.min(x, y);
    const b = Math.max(x, y);
    const now = this.nowSeconds();
    this.open().prepare(
      `INSERT INTO fact_relation_checks (fact_a, fact_b, verdict, origin, created_at, checked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(fact_a, fact_b) DO UPDATE SET verdict = excluded.verdict, checked_at = excluded.checked_at`
    ).run(a, b, verdict.slice(0, 40), origin, now, now);
  };


  /** Pending-queue depth, for the background pass's activity row. */
  pendingRelationCheckCount = (): number => {
    return (this.open().prepare(
      `SELECT COUNT(*) AS n FROM fact_relation_checks WHERE verdict IS NULL`
    ).get() as { n: number }).n;
  };


  /**
   * Newest evidence timestamp per fact in one query — the batch analog of
   * newestEvidenceTs for consumers that render many facts (the consolidation
   * prompt, the neighbour sweep) and must not load full evidence for each.
   */
  getNewestEvidenceTsByFact = (): Map<number, number> => {
    const rows = this.open().prepare(
      `SELECT fact_id AS factId, MAX(ts) AS ts FROM fact_evidence GROUP BY fact_id`
    ).all() as Array<{ factId: number; ts: number }>;
    return new Map(rows.map((r) => [r.factId, r.ts]));
  };


  /**
   * Apply one adjudicator decision transactionally. `expected` pins the exact pair
   * the model judged — the conflict must still be open on those ids with those
   * texts, or nothing is applied (facts can be superseded, rewritten, or reset
   * while the model call was in flight).
   */
  applyAdjudication = (
    conflictId: number,
    decision: AdjudicationDecision,
    expected: { aId: number; aText: string; bId: number; bText: string },
    /** Optional out-param: filled with a rewrite's replacement fact ids so the caller can queue them for the neighbour sweep. */
    sink?: { newFactIds?: number[] }
  ): boolean => {
    const handle = this.open();
    // IMMEDIATE for the same reason as recordMessage: this reads the conflict and
    // both sides before writing, and a deferred snapshot upgrade bypasses the busy
    // handler entirely (SQLITE_BUSY_SNAPSHOT) whenever a background pass committed
    // in between.
    handle.exec('BEGIN IMMEDIATE');
    try {
      const row = handle.prepare(
        `SELECT fact_a AS factA, fact_b AS factB FROM fact_conflicts WHERE id = ? AND status = 'open'`
      ).get(conflictId) as { factA: number; factB: number } | undefined;
      const a = this.getFactDetails(expected.aId);
      const b = this.getFactDetails(expected.bId);
      const intact = row && row.factA === expected.aId && row.factB === expected.bId
        && a && a.text === expected.aText && a.status !== 'superseded'
        && b && b.text === expected.bText && b.status !== 'superseded';
      if (!intact) {
        handle.exec('ROLLBACK');
        return false;
      }
      let resolution: AutoConflictResolution;
      const settleIds: number[] = [];
      if (decision.kind === 'winner') {
        if (decision.winnerId !== expected.aId && decision.winnerId !== expected.bId) {
          handle.exec('ROLLBACK');
          return false;
        }
        const loserId = decision.winnerId === expected.aId ? expected.bId : expected.aId;
        // supersedeFact resolves every open conflict on the loser (this one
        // included, as 'superseded'); the resolution UPDATE below re-stamps it.
        this.supersedeFact(loserId, decision.winnerId);
        settleIds.push(decision.winnerId);
        resolution = 'auto_supersede';
      } else if (decision.kind === 'both') {
        settleIds.push(expected.aId, expected.bId);
        resolution = 'auto_keep_both';
      } else {
        // Rewrite: replace the pair with 1..N atomic facts carrying the union of
        // both sides' provenance. Source/confidence/sensitivity inherit from the
        // sides so the replacements pass the same injection gates the originals
        // would have.
        const donor = (newestEvidenceTs(b) ?? b.updatedAt) >= (newestEvidenceTs(a) ?? a.updatedAt) ? b : a;
        const evidence = [...a.evidence, ...b.evidence].map(({ id: _id, ...rest }) => rest);
        const newIds: number[] = [];
        for (const text of decision.texts) {
          const nid = this.upsertFact(text, {
            source: donor.source,
            category: donor.category,
            sensitivity: a.sensitivity === 'sensitive' || b.sensitivity === 'sensitive' ? 'sensitive' : 'standard',
            confidence: Math.max(a.confidence, b.confidence),
            evidence
          });
          if (nid != null && !newIds.includes(nid)) newIds.push(nid);
        }
        // A rewrite text can normalize onto one of the originals ("keep this half
        // verbatim") — that side survives as its own replacement, so only the
        // originals that did NOT come back are superseded.
        const survivors = newIds.filter((nid) => nid !== expected.aId && nid !== expected.bId);
        if (newIds.length === 0) {
          handle.exec('ROLLBACK');
          return false;
        }
        const successor = survivors[0] ?? newIds[0];
        for (const originalId of [expected.aId, expected.bId]) {
          if (newIds.includes(originalId)) settleIds.push(originalId);
          else this.supersedeFact(originalId, successor);
        }
        settleIds.push(...survivors);
        if (sink) sink.newFactIds = [...survivors];
        resolution = 'auto_rewrite';
      }
      handle.prepare(
        `UPDATE fact_conflicts SET status = 'resolved', resolved_at = ?, resolution = ? WHERE id = ?`
      ).run(this.nowSeconds(), resolution, conflictId);
      for (const factId of new Set(settleIds)) this.settleConflictSide(factId);
      handle.exec('COMMIT');
      return true;
    } catch (err) {
      handle.exec('ROLLBACK');
      throw err;
    }
  };


  /** Conflicts the background adjudicator resolved, newest first, for the audit list. */
  getAutoResolvedConflicts = (limit = 20): AutoResolvedConflict[] => {
    const rows = this.open().prepare(
      `SELECT id, fact_a AS factA, fact_b AS factB, reason, resolution, resolved_at AS resolvedAt
       FROM fact_conflicts
       WHERE status = 'resolved' AND resolution IN ('auto_supersede', 'auto_keep_both', 'auto_rewrite')
       ORDER BY resolved_at DESC, id DESC LIMIT ?`
    ).all(limit) as Array<{ id: number; factA: number; factB: number; reason: string; resolution: AutoConflictResolution; resolvedAt: number }>;
    return rows.flatMap((r) => {
      const factA = this.getFactDetails(r.factA);
      const factB = this.getFactDetails(r.factB);
      return factA && factB ? [{ id: r.id, factA, factB, reason: r.reason, resolution: r.resolution, resolvedAt: r.resolvedAt }] : [];
    });
  };


  deleteFact = (id: number): void => {
    const handle = this.open();
    // No FK cascade (foreign_keys isn't globally enabled), so drop the vector by hand.
    handle.prepare(`DELETE FROM fact_vectors WHERE fact_id = ?`).run(id);
    handle.prepare(`DELETE FROM fact_evidence WHERE fact_id = ?`).run(id);
    handle.prepare(`DELETE FROM fact_conflicts WHERE fact_a = ? OR fact_b = ?`).run(id, id);
    handle.prepare(`DELETE FROM fact_relation_checks WHERE fact_a = ? OR fact_b = ?`).run(id, id);
    handle.prepare(`UPDATE facts SET superseded_by = NULL WHERE superseded_by = ?`).run(id);
    handle.prepare(`DELETE FROM facts WHERE id = ?`).run(id);
  };


  /** True when the optional trigram fact index is available this session. */
  factsTrigramAvailable = (): boolean => {
    this.open();
    return this.factsTrigram;
  };


  private mapScoredFact = (r: Record<string, unknown>): ScoredFact => {
    return { ...this.mapFact(r), score: r.score as number };
  };


  /**
   * BM25 term ranking of facts for a prebuilt FTS5 MATCH expression. Returns up to
   * `limit`, best (most-negative bm25) first, with the raw score so callers can blend
   * in recency. Empty on no match or malformed query — search.ts builds the MATCH.
   * Conflicted rows are included so a disputed representative stays rankable; the
   * injection path intersects with getInjectableFacts, which admits only those.
   */
  factTermSearch = (match: string, limit: number): ScoredFact[] => {
    if (!match.trim() || limit <= 0) return [];
    const handle = this.open();
    try {
      const rows = handle
        .prepare(
          `SELECT ${FACT_SELECT_F},
                  bm25(facts_fts) AS score
           FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
           WHERE facts_fts MATCH ? AND f.status IN ('active', 'conflicted')
           ORDER BY score
           LIMIT ?`
        )
        .all(match, limit) as Array<Record<string, unknown>>;
      return rows.map(this.mapScoredFact);
    } catch (e) {
      degrade('recall.facts', 'returned no fact hits from the term index', e);
      return [];
    }
  };


  /**
   * Trigram substring match of facts (morphology/partial-word recall the term index
   * misses). Guarded: returns [] when the trigram index isn't available. Ordered by
   * recency since bm25 over trigram carries little ranking signal; score is left 0.
   */
  factTrigramSearch = (match: string, limit: number): ScoredFact[] => {
    if (!this.factsTrigram || !match.trim() || limit <= 0) return [];
    const handle = this.open();
    try {
      const rows = handle
        .prepare(
          `SELECT ${FACT_SELECT_F},
                  0 AS score
           FROM facts_trigram JOIN facts f ON f.id = facts_trigram.rowid
           WHERE facts_trigram MATCH ? AND f.status IN ('active', 'conflicted')
           ORDER BY f.updated_at DESC
           LIMIT ?`
        )
        .all(match, limit) as Array<Record<string, unknown>>;
      return rows.map(this.mapScoredFact);
    } catch (e) {
      degrade('recall.facts', 'returned no fact hits from the trigram index', e);
      return [];
    }
  };


  /**
   * The live handle, for hand-off to the shared retrieval core (search-core.ts),
   * which is handle-parameterized so the recall MCP server can run the same code
   * on its own read-only connection. Not for ad-hoc SQL elsewhere — everything
   * else goes through this module's functions.
   */
  dbHandle = (): DatabaseSync => {
    return this.open();
  };


  /** Facts with no cached vector for `model` (need embedding before ranking). */
  getFactsMissingVector = (model: string): Fact[] => {
    const rows = this.open()
      .prepare(
        `SELECT ${FACT_SELECT_F}
           FROM facts f
           LEFT JOIN fact_vectors v ON v.fact_id = f.id AND v.model = ?
          WHERE v.fact_id IS NULL AND f.status IN ('active', 'conflicted')
          ORDER BY f.id ASC`
      )
      .all(model) as Array<Record<string, unknown>>;
    return rows.map(this.mapFact);
  };


  /** All cached vectors for `model`, keyed by fact id. */
  getFactVectors = (model: string): Map<number, Float32Array> => {
    const rows = this.open()
      .prepare(`SELECT fact_id AS factId, vec FROM fact_vectors WHERE model = ?`)
      .all(model) as Array<{ factId: number; vec: Uint8Array }>;
    const out = new Map<number, Float32Array>();
    for (const r of rows) out.set(r.factId, bytesToFloat32(r.vec));
    return out;
  };


  /** Cache a fact's embedding for `model` (replaces any prior vector). */
  upsertFactVector = (factId: number, model: string, vec: Float32Array): void => {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.open()
      .prepare(
        `INSERT INTO fact_vectors (fact_id, model, dim, vec, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fact_id, model) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, updated_at = excluded.updated_at`
      )
      .run(factId, model, vec.length, buf, this.nowSeconds());
  };


  /**
   * Cache an embedding only if the fact snapshot it was calculated from is still
   * the same active row in the same reset generation. Embedding calls are async,
   * while fact ids are reusable after reset; checking both epoch and text at this
   * final synchronous write boundary prevents a stale vector attaching to a new
   * fact that inherited the old integer id.
   */
  upsertFactVectorForSnapshot = (
    factId: number,
    expectedText: string,
    expectedGeneration: number,
    model: string,
    vec: Float32Array
  ): boolean => {
    if (this.getFactsGeneration() !== expectedGeneration) return false;
    const current = this.open()
      .prepare(`SELECT text FROM facts WHERE id = ? AND status = 'active'`)
      .get(factId) as { text: string } | undefined;
    if (!current || current.text !== expectedText) return false;
    this.upsertFactVector(factId, model, vec);
    return true;
  };


  /** Drop cached vectors for every model except `model` (hygiene after a model switch). */
  pruneVectorsExceptModel = (model: string): void => {
    this.open().prepare(`DELETE FROM fact_vectors WHERE model <> ?`).run(model);
  };



  /**
   * Messages with id greater than `afterId`, oldest first — the episodic embed
   * pass walks these in batches, watermark-style (mirrors getMessagesForDistill).
   */
  /** How many messages sit past the embed watermark — the honest total for progress. */
  countMessagesForEmbedding = (afterId: number): number => {
    const row = this.open().prepare(`SELECT COUNT(*) AS n FROM messages WHERE id > ?`).get(afterId) as {
      n: number;
    };
    return row.n;
  };


  getMessagesForEmbedding = (afterId: number, limit = 200): StoredMessage[] => {
    const rows = this.open()
      .prepare(
        `SELECT id, thread_id AS threadId, turn_id AS turnId, role, ts, text, web
         FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`
      )
      .all(afterId, limit) as Array<Record<string, unknown>>;
    return rows.map(this.mapStoredMessage);
  };


  /** Cache a message's embedding for `model` (replaces any prior vector). */
  upsertMessageVector = (messageId: number, model: string, vec: Float32Array): void => {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.open()
      .prepare(
        `INSERT INTO message_vectors (message_id, model, dim, vec, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(message_id, model) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, updated_at = excluded.updated_at`
      )
      .run(messageId, model, vec.length, buf, this.nowSeconds());
  };


  replaceMessageChunks = (
    messageId: number,
    chunks: Array<Omit<StoredMessageChunk, 'messageId'>>
  ): void => {
    const handle = this.open();
    handle.prepare(`DELETE FROM message_chunks WHERE message_id = ?`).run(messageId);
    handle.prepare(`DELETE FROM message_chunk_vectors WHERE message_id = ?`).run(messageId);
    const stmt = handle.prepare(
      `INSERT INTO message_chunks(message_id, chunk_index, start_offset, end_offset, text)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const c of chunks) stmt.run(messageId, c.chunkIndex, c.startOffset, c.endOffset, c.text);
  };


  getMessageChunks = (messageId: number): StoredMessageChunk[] => {
    const rows = this.open().prepare(
      `SELECT message_id AS messageId, chunk_index AS chunkIndex, start_offset AS startOffset,
              end_offset AS endOffset, text
       FROM message_chunks WHERE message_id = ? ORDER BY chunk_index`
    ).all(messageId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      messageId: r.messageId as number,
      chunkIndex: r.chunkIndex as number,
      startOffset: r.startOffset as number,
      endOffset: r.endOffset as number,
      text: r.text as string
    }));
  };


  upsertMessageChunkVector = (
    messageId: number,
    chunkIndex: number,
    model: string,
    vec: Float32Array
  ): void => {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.open().prepare(
      `INSERT INTO message_chunk_vectors(message_id, chunk_index, model, dim, vec, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id, chunk_index, model) DO UPDATE SET
         dim = excluded.dim, vec = excluded.vec, updated_at = excluded.updated_at`
    ).run(messageId, chunkIndex, model, vec.length, buf, this.nowSeconds());
  };


  /** Drop cached message vectors for every model except `model` (after a model switch). */
  pruneMessageVectorsExceptModel = (model: string): void => {
    const handle = this.open();
    handle.prepare(`DELETE FROM message_vectors WHERE model <> ?`).run(model);
    handle.prepare(`DELETE FROM message_chunk_vectors WHERE model <> ?`).run(model);
  };


  /**
   * Last message id the episodic embed pass has processed for `model` (embedded OR
   * deliberately skipped). A watermark recorded under a different model — the
   * embeddings model changed — reads as 0, restarting the backfill.
   */
  getMessageEmbedWatermark = (model: string): number => {
    const raw = this.getMeta(MESSAGE_EMBED_WATERMARK_KEY);
    if (!raw) return 0;
    try {
      const parsed = JSON.parse(raw) as { model?: string; id?: number };
      return parsed.model === model && typeof parsed.id === 'number' ? parsed.id : 0;
    } catch {
      // quiet: a watermark that won't parse is one we must not trust, and 0
      // restarts the backfill — the same recovery a model switch already takes.
      return 0;
    }
  };


  setMessageEmbedWatermark = (model: string, id: number): void => {
    this.setMeta(MESSAGE_EMBED_WATERMARK_KEY, JSON.stringify({ model, id }));
    // Keep the v1 cursor current while the old lead-vector table remains as a
    // downgrade/fallback path. A pre-v2 cursor is never read as chunk progress.
    this.setMeta(LEGACY_MESSAGE_EMBED_WATERMARK_KEY, JSON.stringify({ model, id }));
  };


  /**
   * Brute-force cosine top-N over the cached message vectors for `model`. Streams
   * rows instead of materializing a full id→vector map — unlike facts, the message
   * set can reach tens of thousands of rows, and a per-turn multi-MB allocation is
   * the thing to avoid; the arithmetic itself is cheap. Rows with a dim mismatch
   * (stale model collision) are skipped.
   */
  semanticSearchMessages = (
    qVec: Float32Array,
    model: string,
    opts: { limit: number; minCosine: number; excludeThreadId?: string | null }
  ): SemanticHit[] => {
    return semanticSearchMessagesCore(this.open(), qVec, model, {
      ...opts,
      snippetChars: 400
    }).map((h) => ({ ...h, role: h.role as MessageRole, cosine: h.cosine ?? h.score }));
  };


  private mapSummary = (r: Record<string, unknown>): ThreadSummaryRow => {
    return {
      id: r.id as number,
      threadId: r.threadId as string,
      text: r.text as string,
      firstTs: r.firstTs as number,
      lastTs: r.lastTs as number,
      messageCount: r.messageCount as number,
      lastMessageId: r.lastMessageId as number,
      updatedAt: r.updatedAt as number,
      revisionsSinceRebuild: (r.revisionsSinceRebuild as number) || 0,
      segmentsGap: !!(r.segmentsGap as number)
    };
  };


  /**
   * Insert or revise a thread's rolling summary and advance its watermark. The
   * cached vector is invalidated on every write since the text always changes.
   * Returns the summary row id, or null on empty text.
   */
  upsertSummary = (input: {
    threadId: string;
    text: string;
    firstTs: number;
    lastTs: number;
    newMessageCount: number;
    lastMessageId: number;
    /** True when the text was re-derived from segments — resets the drift counter. */
    rebuilt?: boolean;
    /** False when this revision has no per-window segment → coverage gap (sticky). */
    segmentStored?: boolean;
  }): number | null => {
    const text = input.text.trim().slice(0, MAX_SUMMARY_CHARS);
    if (!text) return null;
    const handle = this.open();
    handle.prepare(
      `DELETE FROM summary_vectors WHERE summary_id IN (SELECT id FROM summaries WHERE thread_id = ?)`
    ).run(input.threadId);
    const rebuilt = input.rebuilt === true;
    const gap = !rebuilt && input.segmentStored === false ? 1 : 0;
    const row = handle
      .prepare(
        `INSERT INTO summaries (thread_id, text, first_ts, last_ts, message_count, last_message_id, updated_at,
                                revisions_since_rebuild, segments_gap)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           text = excluded.text,
           first_ts = MIN(summaries.first_ts, excluded.first_ts),
           last_ts = MAX(summaries.last_ts, excluded.last_ts),
           message_count = summaries.message_count + excluded.message_count,
           last_message_id = MAX(summaries.last_message_id, excluded.last_message_id),
           updated_at = excluded.updated_at,
           revisions_since_rebuild = CASE WHEN ? THEN 0 ELSE summaries.revisions_since_rebuild + 1 END,
           segments_gap = MAX(summaries.segments_gap, excluded.segments_gap)
         RETURNING id`
      )
      .get(
        input.threadId,
        text,
        input.firstTs,
        input.lastTs,
        input.newMessageCount,
        input.lastMessageId,
        this.nowSeconds(),
        rebuilt ? 0 : 1,
        gap,
        rebuilt ? 1 : 0
      ) as { id: number } | undefined;
    return row?.id ?? null;
  };


  /** Reset the drift counter without touching the text (rebuild skipped as moot). */
  markSummaryRebuilt = (threadId: string): void => {
    this.open().prepare(`UPDATE summaries SET revisions_since_rebuild = 0 WHERE thread_id = ?`).run(threadId);
  };


  getSummaryByThread = (threadId: string): ThreadSummaryRow | null => {
    const row = this.open().prepare(`SELECT ${SUMMARY_SELECT} FROM summaries WHERE thread_id = ?`)
      .get(threadId) as Record<string, unknown> | undefined;
    return row ? this.mapSummary(row) : null;
  };


  listThreadSummaries = (): ThreadSummaryRow[] => {
    const rows = this.open().prepare(`SELECT ${SUMMARY_SELECT} FROM summaries ORDER BY last_ts DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(this.mapSummary);
  };


  deleteThreadSummary = (id: number): void => {
    const handle = this.open();
    // Segments die with the summary: the watermark dies with the row, so the
    // thread resummarizes from scratch — a stale seed would pollute the rebuild.
    const row = handle.prepare(`SELECT thread_id AS threadId FROM summaries WHERE id = ?`).get(id) as
      | { threadId: string }
      | undefined;
    if (row) handle.prepare(`DELETE FROM summary_segments WHERE thread_id = ?`).run(row.threadId);
    handle.prepare(`DELETE FROM summary_vectors WHERE summary_id = ?`).run(id);
    handle.prepare(`DELETE FROM summaries WHERE id = ?`).run(id);
  };


  addSummarySegment = (input: {
    threadId: string;
    text: string;
    firstTs: number;
    lastTs: number;
    messageCount: number;
    lastMessageId: number;
    maxChars?: number;
  }): number | null => {
    const text = input.text.trim().slice(0, input.maxChars ?? MAX_SEGMENT_CHARS);
    if (!text) return null;
    const row = this.open()
      .prepare(
        `INSERT INTO summary_segments (thread_id, text, first_ts, last_ts, message_count, last_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(input.threadId, text, input.firstTs, input.lastTs, input.messageCount, input.lastMessageId, this.nowSeconds()) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  };


  /** A thread's segments in chronological order (merged rows keep their range's first_ts). */
  getSummarySegments = (threadId: string): SummarySegmentRow[] => {
    const rows = this.open()
      .prepare(`SELECT ${SEGMENT_SELECT} FROM summary_segments WHERE thread_id = ? ORDER BY first_ts ASC, id ASC`)
      .all(threadId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      threadId: r.threadId as string,
      text: r.text as string,
      firstTs: r.firstTs as number,
      lastTs: r.lastTs as number,
      messageCount: r.messageCount as number,
      lastMessageId: r.lastMessageId as number,
      createdAt: r.createdAt as number
    }));
  };


  /**
   * Compaction: atomically replace a set of (oldest) segments with one merged
   * segment carrying their combined range. Used when a long thread's segments
   * outgrow the rebuild input budget.
   */
  replaceSummarySegments = (
    threadId: string,
    ids: number[],
    merged: { text: string; firstTs: number; lastTs: number; messageCount: number; lastMessageId: number }
  ): number | null => {
    if (ids.length === 0) return null;
    const handle = this.open();
    handle.exec('BEGIN');
    try {
      const del = handle.prepare(`DELETE FROM summary_segments WHERE thread_id = ? AND id = ?`);
      for (const id of ids) del.run(threadId, id);
      const inserted = this.addSummarySegment({ threadId, ...merged, maxChars: MAX_MERGED_SEGMENT_CHARS });
      handle.exec('COMMIT');
      return inserted;
    } catch (err) {
      handle.exec('ROLLBACK');
      throw err;
    }
  };


  /**
   * Threads that have captured messages beyond their summary's watermark (or no
   * summary at all). Newest activity first for the post-turn refresh (the chat
   * the user just used); oldest first for the dormant backfill's work queue.
   */
  getThreadsNeedingSummary = (
    limit: number,
    order: 'newest' | 'oldest' = 'newest',
    minimum: { messages: number; chars: number } = { messages: 0, chars: 0 }
  ): Array<{ threadId: string; behindBy: number }> => {
    if (limit <= 0) return [];
    const rows = this.open()
      .prepare(
        `SELECT m.thread_id AS threadId, COUNT(*) AS behindBy
         FROM messages m
         LEFT JOIN summaries s ON s.thread_id = m.thread_id
         WHERE m.id > COALESCE(s.last_message_id, 0)
         GROUP BY m.thread_id
         HAVING
           (s.thread_id IS NULL AND SUM(LENGTH(m.text)) >= ?)
           OR
           (s.thread_id IS NOT NULL AND (COUNT(*) >= ? OR SUM(LENGTH(m.text)) >= ?))
         ORDER BY MAX(m.ts) ${order === 'newest' ? 'DESC' : 'ASC'}
         LIMIT ?`
      )
      .all(minimum.chars, minimum.messages, minimum.chars, limit) as Array<{ threadId: string; behindBy: number }>;
    return rows;
  };


  /** Summaries with no cached vector for `model` (need embedding before search). */
  getSummariesMissingVector = (model: string): ThreadSummaryRow[] => {
    const rows = this.open()
      .prepare(
        `SELECT s.id, s.thread_id AS threadId, s.text, s.first_ts AS firstTs, s.last_ts AS lastTs,
                s.message_count AS messageCount, s.last_message_id AS lastMessageId, s.updated_at AS updatedAt,
                s.revisions_since_rebuild AS revisionsSinceRebuild, s.segments_gap AS segmentsGap
         FROM summaries s
         LEFT JOIN summary_vectors v ON v.summary_id = s.id AND v.model = ?
         WHERE v.summary_id IS NULL
         ORDER BY s.id ASC`
      )
      .all(model) as Array<Record<string, unknown>>;
    return rows.map(this.mapSummary);
  };


  /** Cache a summary's embedding for `model` (replaces any prior vector). */
  upsertSummaryVector = (summaryId: number, model: string, vec: Float32Array): void => {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.open()
      .prepare(
        `INSERT INTO summary_vectors (summary_id, model, dim, vec, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(summary_id, model) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, updated_at = excluded.updated_at`
      )
      .run(summaryId, model, vec.length, buf, this.nowSeconds());
  };


  /** Drop cached summary vectors for every model except `model` (after a model switch). */
  pruneSummaryVectorsExceptModel = (model: string): void => {
    this.open().prepare(`DELETE FROM summary_vectors WHERE model <> ?`).run(model);
  };


  /**
   * True when ANY message vector is cached (any model). The hybrid search uses
   * this as a pre-embed gate: with an empty table there is nothing to scan, so
   * the query embed would be pure waste (e.g. embeddings just turned on, backfill
   * not yet run — or a fact-only turn on a fresh DB).
   */
  hasMessageVectors = (): boolean => {
    return hasMessageVectorsCore(this.open());
  };


  /** How many messages have a cached vector for `model`, vs total messages. */
  getEpisodicVectorStats = (model: string): { messageCount: number; embeddedCount: number } => {
    const handle = this.open();
    const embedded = handle
      .prepare(
        `SELECT COUNT(DISTINCT message_id) AS n FROM (
           SELECT message_id FROM message_chunk_vectors WHERE model = ?
           UNION SELECT message_id FROM message_vectors WHERE model = ?
         )`
      )
      .get(model, model) as { n: number };
    return { messageCount: this.messageCount(), embeddedCount: embedded.n };
  };


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
  resetEpisodic = (options: { skipVacuum?: boolean } = {}): void => {
    const handle = this.open();
    const nextGeneration = this.getEpisodicGeneration() + 1;
    handle.exec('BEGIN');
    try {
      // Cancellation barrier for in-flight summarize/distill/rebuild passes —
      // the same role FACTS_GENERATION_KEY plays for resetFacts.
      handle.prepare(
        `INSERT INTO meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(EPISODIC_GENERATION_KEY, String(nextGeneration));
      handle.exec('DELETE FROM messages');
      handle.exec('DELETE FROM message_vectors');
      handle.exec('DELETE FROM message_chunk_vectors');
      handle.exec('DELETE FROM message_chunks');
      // Summaries are derived from messages, and their last_message_id watermarks
      // would be corrupted by message-id reuse after the VACUUM below. The
      // per-turn injected-facts log references turn ids of deleted messages.
      handle.exec('DELETE FROM summaries');
      handle.exec('DELETE FROM summary_segments');
      handle.exec('DELETE FROM summary_vectors');
      handle.exec('DELETE FROM turn_injected_facts');
      handle.exec(`DELETE FROM meta WHERE key = 'distill_watermark'`);
      handle.exec(`DELETE FROM meta WHERE key = 'distill_cursor_v2'`);
      handle.exec(`DELETE FROM meta WHERE key = 'skill_distill_watermark'`);
      handle.exec(`DELETE FROM meta WHERE key = 'skill_distill_cursor_v2'`);
      handle.exec(`DELETE FROM meta WHERE key = 'memory_rebuild_v2'`);
      // Same rowid-reuse hazard as the distill watermark: after VACUUM, new
      // messages can reclaim old ids and would be skipped by a stale embed watermark.
      handle.exec(`DELETE FROM meta WHERE key = '${MESSAGE_EMBED_WATERMARK_KEY}'`);
      handle.exec(`DELETE FROM meta WHERE key = '${LEGACY_MESSAGE_EMBED_WATERMARK_KEY}'`);
      handle.exec('COMMIT');
    } catch (err) {
      handle.exec('ROLLBACK');
      throw err;
    }
    // Callers that can VACUUM off-thread (workspace/memory.ts via scan.ts) skip
    // the inline one; everyone else keeps the synchronous reclaim.
    if (!options.skipVacuum) handle.exec('VACUUM');
  };


  /** Monotonic epoch used to invalidate asynchronous fact writers after a reset. */
  getFactsGeneration = (): number => {
    return Number.parseInt(this.getMeta(FACTS_GENERATION_KEY) ?? '0', 10) || 0;
  };


  /**
   * Monotonic epoch for the episodic side, bumped by resetEpisodic. Summarize,
   * distill and rebuild snapshot it before their model calls and drop every
   * write when it moved: without this barrier an in-flight pass would resurrect
   * erased content and — after the VACUUM reuses message rowids — persist a
   * cursor that makes distillation skip freshly captured messages.
   */
  getEpisodicGeneration = (): number => {
    return Number.parseInt(this.getMeta(EPISODIC_GENERATION_KEY) ?? '0', 10) || 0;
  };


  /**
   * Wipe durable facts (Level 1) + the consolidation dirty-counter. Leaves the
   * episodic store and the recall_enabled toggle untouched.
   */
  resetFacts = (): void => {
    const handle = this.open();
    const nextGeneration = this.getFactsGeneration() + 1;
    handle.exec('BEGIN');
    try {
      handle.prepare(
        `INSERT INTO meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(FACTS_GENERATION_KEY, String(nextGeneration));
      handle.exec('DELETE FROM fact_vectors');
      handle.exec('DELETE FROM fact_evidence');
      handle.exec('DELETE FROM fact_conflicts');
      handle.exec('DELETE FROM fact_relation_checks');
      handle.exec('DELETE FROM facts');
      // Fact ids in the per-turn injected log are now dangling — drop it too.
      handle.exec('DELETE FROM turn_injected_facts');
      handle.exec(`DELETE FROM meta WHERE key = 'consolidate_pending'`);
      // The relation-sweep backfill's coverage claim is about the rows that no
      // longer exist — a rebuilt store must be re-enumerated from the start.
      handle.exec(`DELETE FROM meta WHERE key IN ('relation_sweep_cursor', 'relation_sweep_done')`);
      // Clearing facts is also a cancellation barrier for an active rebuild.
      // Removing its progress returns it to the explicit-consent "available" state.
      // The v1 flag deliberately survives: it describes the store's TRANSCRIPTS
      // (recorded before v2 ever attached evidence), which this reset doesn't touch.
      handle.exec(`DELETE FROM meta WHERE key = 'memory_rebuild_v2'`);
      handle.exec('COMMIT');
    } catch (err) {
      handle.exec('ROLLBACK');
      throw err;
    }
  };


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
  applyConsolidation = (ops: ConsolidationOps): ConsolidationResult => {
    const handle = this.open();
    const existing = new Set(this.getAllFacts().filter((f) => f.status === 'active').map((f) => f.id));

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
      // Supersede first so a survivor/correction can reclaim a loser's normalized
      // key without erasing its text/evidence/history.
      const retire = handle.prepare(
        `UPDATE facts SET status = 'superseded', pinned = 0, superseded_by = ?,
                norm = '__superseded__' || id || ':' || norm, updated_at = ?
         WHERE id = ? AND status = 'active'`
      );
      const delVec = handle.prepare(`DELETE FROM fact_vectors WHERE fact_id = ?`);
      const mergeSurvivor = new Map<number, number>();
      for (const m of ops.merge) {
        const present = m.ids.filter((id) => existing.has(id));
        if (present.length < 2) continue;
        const survivor = Math.min(...present);
        for (const id of present) if (id !== survivor) mergeSurvivor.set(id, survivor);
      }
      // The survivor absorbs each loser's evidence rows (copy, not move — the
      // loser keeps its own provenance for the audit/restore path). Without this
      // the min-id survivor keeps only its own, older evidence, and every merge
      // silently destroys the absorbed assertion's truth-recency — which then
      // poisons any "later evidence wins" comparison downstream.
      const copyEvidence = handle.prepare(
        `INSERT OR IGNORE INTO fact_evidence
           (fact_id, message_id, thread_id, role, ts, excerpt, origin, folder_id, rel_path)
         SELECT ?, message_id, thread_id, role, ts, excerpt, origin, folder_id, rel_path
         FROM fact_evidence WHERE fact_id = ?`
      );
      for (const id of mergeLoserIds) {
        const survivor = mergeSurvivor.get(id);
        if (survivor != null) copyEvidence.run(survivor, id);
        merged += retire.run(survivor ?? null, this.nowSeconds(), id).changes as number;
      }
      for (const id of dropIds) {
        dropped += retire.run(null, this.nowSeconds(), id).changes as number;
      }
      // Survivors/corrections keep their row but get new text — invalidate their vectors.
      for (const w of textWrites) delVec.run(w.id);

      const upd = handle.prepare(`UPDATE facts SET text = ?, norm = ?, updated_at = ? WHERE id = ?`);
      for (const w of textWrites) {
        try {
          if ((upd.run(w.text, this.normalizeFact(w.text), this.nowSeconds(), w.id).changes as number) > 0) {
            if (w.kind === 'correct') corrected += 1;
          }
        } catch {
          // quiet: norm UNIQUE collision with another surviving row — the claim
          // survives on that row, and the unincremented count says one fewer
          // was corrected.
        }
      }
      handle.exec('COMMIT');
    } catch (err) {
      handle.exec('ROLLBACK');
      throw err;
    }

    return { merged, corrected, dropped, failedChunks: 0 };
  };


  getMeta = (key: string): string | null => {
    const handle = this.open();
    const row = handle.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  };


  setMeta = (key: string, value: string): void => {
    this.open()
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  };


  /** Count of captured messages — used by tests/diagnostics. */
  messageCount = (): number => {
    const row = this.open().prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number };
    return row.n;
  };


  /** On-disk footprint of recall.sqlite + its WAL sidecar (uncheckpointed writes). */
  private dbSizeBytes = (): number => {
    return dbSizeBytesFor(this.dbPath());
  };


  /**
   * Metadata for the Level-2 episodic store: how many messages are captured and how
   * much disk recall.sqlite occupies.
   */
  getEpisodicStats = (): EpisodicStats => {
    return { messageCount: this.messageCount(), sizeBytes: this.dbSizeBytes() };
  };


  /** Max on-disk size for the episodic store in bytes; 0 = unlimited. */
  getEpisodicLimitBytes = (): number => {
    const raw = Number.parseInt(this.getMeta(EPISODIC_MAX_KEY) ?? '', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_EPISODIC_MAX_BYTES;
  };

  setEpisodicLimitBytes = (bytes: number): void => {
    this.setMeta(EPISODIC_MAX_KEY, String(Math.max(0, Math.floor(bytes))));
  };


  /** New-fact count that triggers an automatic tidy-up; 0 = manual only. */
  getTidyThreshold = (): number => {
    const raw = Number.parseInt(this.getMeta(TIDY_THRESHOLD_KEY) ?? '', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TIDY_THRESHOLD;
  };

  setTidyThreshold = (n: number): void => {
    this.setMeta(TIDY_THRESHOLD_KEY, String(Math.max(0, Math.floor(n))));
  };


  private getMetaPositiveInt = (key: string, fallback: number): number => {
    const raw = Number.parseInt(this.getMeta(key) ?? '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };


  getMaxRelevantFacts = (): number => {
    const current = this.getMeta(MAX_RELEVANT_FACTS_KEY);
    if (current != null) return this.getMetaPositiveInt(MAX_RELEVANT_FACTS_KEY, DEFAULT_MAX_RELEVANT_FACTS);
    // Do not reinterpret the v1 inject-all threshold as a v2 result count. Record
    // the new safe default once so future reads are stable.
    if (this.getMeta(FACT_THRESHOLD_KEY) != null) this.setMeta(MAX_RELEVANT_FACTS_KEY, String(DEFAULT_MAX_RELEVANT_FACTS));
    return DEFAULT_MAX_RELEVANT_FACTS;
  };

  setMaxRelevantFacts = (n: number): void => {
    this.setMeta(MAX_RELEVANT_FACTS_KEY, String(Math.max(1, Math.min(32, Math.floor(n)))));
  };

  getFactCosineM = (): number => {
    return this.getMetaPositiveInt(FACT_COSINE_M_KEY, DEFAULT_FACT_COSINE_M);
  };

  getFactRerankK = (): number => {
    return this.getMetaPositiveInt(FACT_RERANK_K_KEY, DEFAULT_FACT_RERANK_K);
  };


  getSemanticMinCosine = (): number => {
    const raw = Number.parseFloat(this.getMeta(SEMANTIC_MIN_COSINE_KEY) ?? '');
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_SEMANTIC_MIN_COSINE;
  };

  setSemanticMinCosine = (v: number): void => {
    this.setMeta(SEMANTIC_MIN_COSINE_KEY, String(Math.min(1, Math.max(0, v))));
  };


  getUsageWeight = (): number => {
    const raw = Number.parseFloat(this.getMeta(USAGE_WEIGHT_KEY) ?? '');
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_USAGE_WEIGHT;
  };

  setUsageWeight = (v: number): void => {
    this.setMeta(USAGE_WEIGHT_KEY, String(Math.min(1, Math.max(0, v))));
  };


  getDupCosine = (): number => {
    const raw = Number.parseFloat(this.getMeta(DUP_COSINE_KEY) ?? '');
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_DUP_COSINE;
  };

  setDupCosine = (v: number): void => {
    this.setMeta(DUP_COSINE_KEY, String(Math.min(1, Math.max(0, v))));
  };


  getConsolidateChunkSize = (): number => {
    // Floor of 2 so a "chunk" can always hold a mergeable pair.
    return Math.max(2, this.getMetaPositiveInt(CONSOLIDATE_CHUNK_KEY, DEFAULT_CONSOLIDATE_CHUNK));
  };

  setConsolidateChunkSize = (n: number): void => {
    this.setMeta(CONSOLIDATE_CHUNK_KEY, String(Math.max(2, Math.floor(n))));
  };


  /**
   * Trim the episodic store back under its size limit (prune oldest + VACUUM).
   * Synchronous in-process pass — the capture path normally routes this through
   * the scan worker instead (see scan.ts); the mechanics live in maintenance-core
   * so both run the same code.
   */
  enforceEpisodicLimit = (): number => {
    return enforceEpisodicLimitCore(this.open(), this.dbPath());
  };


  /** Close the handle; the next call re-opens over the current dbPath(). */
  close = (): void => {
    this.db?.close();
    this.db = null;
  };
}

/** The app-wide store over recall.sqlite (see workspace/paths). */
export const recallStore = new RecallStore(() => recallDbPath());

/** Test hook: close the default handle so a fresh path can be opened. */
export function closeForTest(): void {
  recallStore.close();
}
