import type { DatabaseSync } from 'node:sqlite';

// The shared retrieval core: tokenization, FTS match building, cosine scans and
// reciprocal-rank fusion over recall.sqlite — parameterized by a DatabaseSync
// handle so the SAME code serves two processes:
//   - the main process (store.ts / search.ts / inject.ts), read-write handle
//   - the standalone recall MCP server (mcp-server-main.ts), read-only handle
//
// This file must stay electron-free and store-free (no imports beyond
// node:sqlite types): it is bundled into dist/main/recall-mcp-server.js and run
// under ELECTRON_RUN_AS_NODE. Any state it needs (tunables) is read from the
// meta table through the handle it is given.
//
// It replaces the hand-copied duplicate search logic that previously lived in
// mcp-server.mjs — behavior changes here reach both processes by construction.

/**
 * Where a leg says it failed and returned nothing anyway.
 *
 * Every FTS and cosine leg below answers a malformed MATCH, a schema drift or a
 * corrupt vector blob with `[]` — which is also what a healthy store answers for
 * a question nothing matches. Those two events are only ever told apart if the
 * leg says something, and this file cannot reach the app's logger: it is bundled
 * into the standalone MCP server and shared with the scan worker, which is why
 * the header forbids imports past node:sqlite. So each host installs its own
 * channel, and the default is the silence this file used to have everywhere.
 */
export type CoreDegradeSink = (scope: string, what: string, error: unknown) => void;

let sink: CoreDegradeSink | null = null;

/** Install the host's channel: degrade() in main, stderr in the MCP server. */
export function setCoreDegradeSink(next: CoreDegradeSink | null): void {
  sink = next;
}

function report(scope: string, what: string, error: unknown): void {
  try {
    sink?.(scope, what, error);
  } catch {
    // quiet: the caller is already inside its own failure path. A sink that
    // throws must not turn a leg that returned [] into a leg that throws.
  }
}

export type CoreRole = 'user' | 'assistant';

/** One ranked hit; `score` is bm25 on FTS output, cosine on semantic, RRF on hybrid. */
export interface CoreSearchHit {
  id: number;
  threadId: string;
  turnId: string | null;
  role: CoreRole;
  ts: number;
  text: string;
  snippet: string;
  score: number;
  /** Debug evidence on hybrid output: the FTS leg's bm25 score, when FTS saw it. */
  ftsScore?: number;
  /** Debug evidence on hybrid/semantic output: cosine similarity, when the semantic leg saw it. */
  cosine?: number;
}

/** A ranked fact hit (id + text only — the core doesn't know the Fact shape). */
export interface CoreFactHit {
  id: number;
  text: string;
  score: number;
}

/** A ranked thread-summary hit. */
export interface CoreSummaryHit {
  id: number;
  threadId: string;
  text: string;
  firstTs: number;
  lastTs: number;
  score: number;
  ftsScore?: number;
  cosine?: number;
}

/** A ranked hit from one indexed connected folder's document index. */
export interface CoreDocHit {
  id: number;
  /** Folder-relative path of the file. */
  relPath: string;
  title: string;
  /** File mtime, Unix milliseconds. */
  mtime: number;
  text: string;
  snippet: string;
  score: number;
  ftsScore?: number;
  cosine?: number;
}

/** A query embedding plus the model that keys the vector caches. */
export interface QueryEmbedding {
  vec: Float32Array;
  model: string;
}

/**
 * Lazy query-embed thunk (memoized by the caller so all legs of a turn share
 * one embed). Absent/null result/throw → FTS-only.
 */
export type EmbedQueryFn = () => Promise<QueryEmbedding | null>;

// Very common words carry no signal and only dilute bm25 ranking. Kept small and
// multilingual-ish (EN/SK/DE) since the user mixes languages.
export const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'are', 'was', 'were', 'be', 'for',
  'with', 'that', 'this', 'it', 'i', 'you', 'we', 'my', 'me', 'do', 'does', 'did', 'what', 'who',
  'when', 'where', 'why', 'how', 'about',
  'a', 'aby', 'ako', 'ale', 'som', 'si', 'sa', 'na', 'je', 'to', 'co', 'čo', 'ktorý', 'kde',
  'der', 'die', 'das', 'und', 'ich', 'ist', 'für', 'mit', 'was', 'wie'
]);

/** Lowercase word/number tokens of at least `minLen` chars, stopwords removed, deduped. */
export function lexTokens(raw: string, minLen: number): string[] {
  const tokens = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length >= minLen && !STOPWORDS.has(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** OR together quoted FTS5 string terms (escaping embedded quotes). Null when empty. */
function quotedOr(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression. Each word becomes a
 * quoted term (so punctuation/operators can never break MATCH syntax) and the
 * terms are OR-ed, which is the right recall-oriented default. Returns null when
 * there's nothing searchable.
 */
export function buildMatchQuery(raw: string): string | null {
  return quotedOr(lexTokens(raw, 2));
}

/**
 * MATCH expression for the trigram index. Trigram tokens must be ≥ 3 chars; each
 * quoted term becomes a substring search, OR-ed. Null when nothing qualifies.
 */
export function buildTrigramQuery(raw: string): string | null {
  return quotedOr(lexTokens(raw, 3));
}

export const RRF_K = 60;
export const FTS_CANDIDATES = 12;
export const SEMANTIC_CANDIDATES = 12;
/**
 * bm25 noise gate for the FTS leg (scores are negative; more-negative = better).
 * Applied per-leg BEFORE fusion, because RRF scores aren't bm25: each leg filters
 * its own noise so a garbage leg can never mint a hit.
 */
export const FTS_SCORE_CEILING = -0.1;

/**
 * Floor for semantic-only hits. e5-family similarities squash into roughly
 * [0.7, 1.0], so 0.82 sits above unrelated-content noise while keeping genuine
 * cross-language matches (calibrated by scripts/recall-eval.mjs).
 */
export const DEFAULT_SEMANTIC_MIN_COSINE = 0.82;

/**
 * Floor for semantic summary hits — deliberately LOWER than the message floor:
 * summaries are long multi-topic passages, which compresses e5 query↔passage
 * cosines (measured 2026-07-10 with e5-small on the golden fixture: true sk→en
 * matches land at 0.79–0.81, under the 0.82 message gate, while ranking stays
 * perfect). The gate only strains noise; RRF does the ranking above it.
 */
export const DEFAULT_SUMMARY_MIN_COSINE = 0.78;

function readMinCosine(db: DatabaseSync, key: string, fallback: number): number {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value?: string }
      | undefined;
    const v = Number.parseFloat(row?.value ?? '');
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
  } catch {
    // quiet: the tunable is optional. A DB whose meta table predates the key —
    // or the whole table — has nothing to say about it, and the shipped default
    // is the answer, not a consolation prize.
    return fallback;
  }
}

/** The tunable message min-cosine from the meta table, or the default when unset/unreadable. */
export function readSemanticMinCosine(db: DatabaseSync): number {
  return readMinCosine(db, 'recall_semantic_min_cosine', DEFAULT_SEMANTIC_MIN_COSINE);
}

/** The tunable summary min-cosine (own key — see DEFAULT_SUMMARY_MIN_COSINE). */
export function readSummaryMinCosine(db: DatabaseSync): number {
  return readMinCosine(db, 'recall_summary_min_cosine', DEFAULT_SUMMARY_MIN_COSINE);
}

/**
 * Floor for semantic folder-document hits. Docs are long multi-topic passages
 * like summaries (embedded from title + lead), so they share the lower floor.
 */
export const DEFAULT_DOC_MIN_COSINE = 0.78;

/** The tunable folder-doc min-cosine (read from the folder index's own meta table). */
export function readDocMinCosine(db: DatabaseSync): number {
  return readMinCosine(db, 'folder_docs_min_cosine', DEFAULT_DOC_MIN_COSINE);
}

/** The row buffer may be reused/unaligned — copy into a fresh, 0-aligned buffer. */
export function bytesToFloat32(u8: Uint8Array): Float32Array {
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

/**
 * Recency blend for the episodic corpora (messages + summaries). The store
 * spans years by design (100 MB cap), and pure RRF gave a two-year-old message
 * exactly the same standing as last week's on equal rank — while the fact tier
 * already blends recency (search.ts). Sized against RRF's own steps: one
 * adjacent-rank gap near the top is ~2.5e-4 and grows toward the tail, so the
 * full boost lets a fresh hit win over a one-rank-better but months-old
 * neighbour and can never jump two ranks. Validated against the
 * recall-golden.json floors (scripts/recall-eval.mjs).
 */
export const EPISODIC_RECENCY_WEIGHT = 2.5e-4;
export const EPISODIC_RECENCY_HALF_LIFE_DAYS = 30;

/**
 * Fuse two ranked lists by reciprocal rank fusion. Returns fused hits, best
 * first, ties broken by `tiebreak` (higher wins). The first list's hit object
 * wins on id collisions (it usually carries the richer snippet); the second
 * leg's evidence fields are grafted on via `graft`. When `recencyTs` is given
 * (Unix seconds of the hit), the blend above is folded into the score.
 */
function rrfFuse<T extends { id: number }>(
  lists: T[][],
  limit: number,
  tiebreak: (hit: T) => number,
  graft: (prior: T, other: T) => void,
  recencyTs?: (hit: T) => number
): Array<T & { score: number }> {
  const merged = new Map<number, T>();
  const rrf = new Map<number, number>();
  for (const list of lists) {
    list.forEach((hit, i) => {
      rrf.set(hit.id, (rrf.get(hit.id) ?? 0) + 1 / (RRF_K + i + 1));
      const prior = merged.get(hit.id);
      if (!prior) merged.set(hit.id, hit);
      else graft(prior, hit);
    });
  }
  const now = Date.now() / 1000;
  const boost = (hit: T): number => {
    if (!recencyTs) return 0;
    const ageDays = Math.max(0, (now - recencyTs(hit)) / 86_400);
    return EPISODIC_RECENCY_WEIGHT * Math.exp(-ageDays / EPISODIC_RECENCY_HALF_LIFE_DAYS);
  };
  return [...merged.values()]
    .map((hit) => ({ ...hit, score: (rrf.get(hit.id) ?? 0) + boost(hit) }))
    .sort((a, b) => b.score - a.score || tiebreak(b) - tiebreak(a))
    .slice(0, limit);
}

// ---- episodic messages ----

export interface MessageSearchOptions {
  limit?: number;
  /** Exclude hits from this thread (the current chat — its history is already in context). */
  excludeThreadId?: string | null;
  /** Max characters of a semantic hit's excerpt (FTS hits use the FTS snippet). */
  snippetChars?: number;
  /**
   * Restrict hits to these roles BEFORE top-k, not after: inject wants user
   * messages only, and long assistant replies (more chunks, more shots at the
   * gate) otherwise consume the whole candidate budget. Absent = all roles
   * (the MCP search_past_chats drill-down deliberately surfaces both).
   */
  roles?: CoreRole[];
}

/**
 * bm25-gated FTS leg over captured messages. [] on no match, malformed index, or
 * a pre-v2 DB — retrieval must never throw across a turn or a tool call.
 */
export function ftsSearchMessages(
  db: DatabaseSync,
  rawQuery: string,
  opts: MessageSearchOptions = {}
): CoreSearchHit[] {
  const match = buildMatchQuery(rawQuery);
  if (!match) return [];
  const limit = opts.limit ?? FTS_CANDIDATES;
  const exclude = opts.excludeThreadId ?? null;
  const roles = opts.roles?.length ? opts.roles : null;
  try {
    // `roles` values come from the closed CoreRole union — the interpolation
    // only ever adds bound placeholders, never user text.
    const roleSql = roles ? ` AND m.role IN (${roles.map(() => '?').join(', ')})` : '';
    const rows = db
      .prepare(
        `SELECT m.id AS id, m.thread_id AS threadId, m.turn_id AS turnId, m.role AS role,
                m.ts AS ts, m.text AS text,
                snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet,
                bm25(messages_fts) AS score
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         WHERE messages_fts MATCH ?
           AND (? IS NULL OR m.thread_id <> ?)${roleSql}
         ORDER BY score
         LIMIT ?`
      )
      .all(match, exclude, exclude, ...(roles ?? []), limit) as Array<Record<string, unknown>>;
    return rows
      .map((r) => ({
        id: r.id as number,
        threadId: r.threadId as string,
        turnId: (r.turnId as string | null) ?? null,
        role: r.role as CoreRole,
        ts: r.ts as number,
        text: r.text as string,
        snippet: r.snippet as string,
        score: r.score as number,
        // Carried on every path (fused or FTS-only): inject's strong-raw gate
        // reads it, and the fused hit's `score` is rewritten to the RRF scale.
        ftsScore: r.score as number
      }))
      .filter((h) => h.score <= FTS_SCORE_CEILING);
  } catch (e) {
    report('recall.search', 'returned no episodic hits from the FTS leg', e);
    return [];
  }
}

/**
 * Brute-force cosine top-N over the cached message vectors for `model`. Streams
 * rows instead of materializing a full id→vector map — the message set can reach
 * tens of thousands of rows, and a per-turn multi-MB allocation is the thing to
 * avoid; the arithmetic itself is cheap. Chunk vectors are preferred; the v1
 * lead-vector table covers messages without chunks. Rows with a dim mismatch
 * (stale model collision) are skipped. [] on any failure (e.g. old DB without
 * the tables).
 */
export function semanticSearchMessagesCore(
  db: DatabaseSync,
  qVec: Float32Array,
  model: string,
  opts: { limit: number; minCosine: number; excludeThreadId?: string | null; snippetChars?: number; roles?: CoreRole[] }
): CoreSearchHit[] {
  if (opts.limit <= 0) return [];
  const exclude = opts.excludeThreadId ?? null;
  const roleSet = opts.roles?.length ? new Set<string>(opts.roles) : null;
  const snippetChars = opts.snippetChars ?? 400;
  const qMag = Math.sqrt(qVec.reduce((s, v) => s + v * v, 0));
  if (qMag === 0) return [];
  try {
    const hasChunks = (db.prepare(
      `SELECT EXISTS(SELECT 1 FROM message_chunk_vectors WHERE model = ?) AS n`
    ).get(model) as { n: number }).n === 1;
    const stmt = hasChunks
      ? db.prepare(
        `SELECT v.message_id AS id, v.vec AS vec, m.thread_id AS threadId, m.turn_id AS turnId,
                m.role AS role, m.ts AS ts, m.text AS fullText, c.text AS text,
                c.end_offset AS endOffset, LENGTH(m.text) AS fullLength
         FROM message_chunk_vectors v
         JOIN message_chunks c ON c.message_id = v.message_id AND c.chunk_index = v.chunk_index
         JOIN messages m ON m.id = v.message_id
         WHERE v.model = ? AND (? IS NULL OR m.thread_id <> ?)
         UNION ALL
         SELECT v.message_id AS id, v.vec AS vec, m.thread_id AS threadId, m.turn_id AS turnId,
                m.role AS role, m.ts AS ts, m.text AS fullText, m.text AS text,
                LENGTH(m.text) AS endOffset, LENGTH(m.text) AS fullLength
         FROM message_vectors v JOIN messages m ON m.id = v.message_id
         WHERE v.model = ? AND NOT EXISTS (
           SELECT 1 FROM message_chunk_vectors cv WHERE cv.message_id = v.message_id AND cv.model = ?
         ) AND (? IS NULL OR m.thread_id <> ?)`
      )
      : db.prepare(
        `SELECT v.message_id AS id, v.vec AS vec, m.thread_id AS threadId, m.turn_id AS turnId,
                m.role AS role, m.ts AS ts, m.text AS fullText, m.text AS text,
                LENGTH(m.text) AS endOffset, LENGTH(m.text) AS fullLength
         FROM message_vectors v JOIN messages m ON m.id = v.message_id
         WHERE v.model = ? AND (? IS NULL OR m.thread_id <> ?)`
      );
    const params = hasChunks
      ? [model, exclude, exclude, model, model, exclude, exclude]
      : [model, exclude, exclude];
    const top: CoreSearchHit[] = [];
    for (const row of stmt.iterate(...params) as Iterable<Record<string, unknown>>) {
      if (roleSet && !roleSet.has(row.role as string)) continue;
      const vec = bytesToFloat32(row.vec as Uint8Array);
      if (vec.length !== qVec.length) continue;
      let dot = 0;
      let mag = 0;
      for (let i = 0; i < vec.length; i++) {
        dot += vec[i] * qVec[i];
        mag += vec[i] * vec[i];
      }
      const denom = qMag * Math.sqrt(mag);
      const cos = denom === 0 ? 0 : dot / denom;
      if (cos < opts.minCosine) continue;
      const text = row.text as string;
      const excerpt = text.length <= snippetChars
        ? text
        : (row.endOffset as number) >= (row.fullLength as number)
          ? `…${text.slice(-(snippetChars - 1))}`
          : `${text.slice(0, snippetChars - 1)}…`;
      const hit: CoreSearchHit = {
        id: row.id as number,
        threadId: row.threadId as string,
        turnId: (row.turnId as string | null) ?? null,
        role: row.role as CoreRole,
        ts: row.ts as number,
        text: row.fullText as string,
        snippet: excerpt,
        score: cos,
        cosine: cos
      };
      insertTopN(top, hit, cos, opts.limit);
    }
    return top;
  } catch (e) {
    report('recall.search', 'returned no episodic hits from the cosine leg', e);
    return [];
  }
}

/** Insertion into a small sorted top-N, deduped by id (limit is single digits in practice). */
function insertTopN<T extends { id: number; cosine?: number }>(
  top: T[],
  hit: T,
  cos: number,
  limit: number
): void {
  const prior = top.findIndex((t) => t.id === hit.id);
  if (prior !== -1) {
    if ((top[prior].cosine ?? 0) >= cos) return;
    top.splice(prior, 1);
  }
  const at = top.findIndex((t) => cos > (t.cosine ?? 0));
  if (at === -1) {
    if (top.length < limit) top.push(hit);
  } else {
    top.splice(at, 0, hit);
    if (top.length > limit) top.pop();
  }
}

/** True when ANY message vector is cached (any model) — the pre-embed gate. */
export function hasMessageVectorsCore(db: DatabaseSync): boolean {
  try {
    const row = db.prepare(
      `SELECT (EXISTS(SELECT 1 FROM message_chunk_vectors) OR EXISTS(SELECT 1 FROM message_vectors)) AS n`
    ).get() as { n: number };
    return row.n === 1;
  } catch {
    // quiet: the question is whether any vector is cached, and a DB with no
    // vector tables answers it — the missing table IS the no.
    return false;
  }
}

/** Resolved options for one cosine-leg scan (minCosine already read from meta). */
export interface SemanticScanOptions {
  limit: number;
  minCosine: number;
  excludeThreadId: string | null;
  snippetChars?: number;
  /** Same contract as MessageSearchOptions.roles; rides the scan-worker message. */
  roles?: CoreRole[];
}

export interface HybridMessageOptions extends MessageSearchOptions {
  embedQuery?: EmbedQueryFn;
  /**
   * Override for the cosine leg — e.g. run the O(N) scan in a worker process
   * instead of on the caller's event loop. Defaults to the in-process scan.
   * A throw degrades to FTS-only, same as a failed embed.
   */
  semanticScan?: (qe: QueryEmbedding, opts: SemanticScanOptions) => Promise<CoreSearchHit[]>;
  /** Optional sink: wall time of the semantic leg (cosine scan + fusion), ms. */
  timingSink?: { semantic?: number };
}

/**
 * Hybrid episodic search: the FTS leg (bm25-gated) fused with a cosine leg over
 * the cached message vectors via reciprocal rank fusion. When the semantic leg is
 * unavailable (embeddings off/not-ready/erroring) the result is exactly the gated
 * FTS ranking — the zero-regression path. Output `score` is the RRF score
 * (higher = better, unlike bm25); `ftsScore`/`cosine` carry the per-leg evidence.
 */
export async function hybridSearchMessages(
  db: DatabaseSync,
  rawQuery: string,
  opts: HybridMessageOptions = {}
): Promise<CoreSearchHit[]> {
  const limit = opts.limit ?? 5;
  const fts = ftsSearchMessages(db, rawQuery, {
    limit: FTS_CANDIDATES,
    excludeThreadId: opts.excludeThreadId,
    roles: opts.roles
  });

  let sem: CoreSearchHit[] = [];
  if (opts.embedQuery && hasMessageVectorsCore(db)) {
    const semStart = Date.now();
    try {
      const qe = await opts.embedQuery();
      if (qe) {
        const scanOpts: SemanticScanOptions = {
          limit: SEMANTIC_CANDIDATES,
          minCosine: readSemanticMinCosine(db),
          excludeThreadId: opts.excludeThreadId ?? null,
          snippetChars: opts.snippetChars,
          roles: opts.roles
        };
        sem = opts.semanticScan
          ? await opts.semanticScan(qe, scanOpts)
          : semanticSearchMessagesCore(db, qe.vec, qe.model, scanOpts);
      }
    } catch (e) {
      // The semantic leg is optional; a dead embedder must never break a turn.
      // It is not free, though: the answer that comes back is FTS-only, and
      // nothing about its shape says so.
      report('recall.search', 'ranked episodic hits on FTS alone', e);
    }
    if (opts.timingSink) opts.timingSink.semantic = Date.now() - semStart;
  }
  // Single-list RRF on the FTS-only path keeps `score` on one scale (RRF,
  // higher = better) for every caller — raw bm25 leaking through here inverted
  // any downstream cross-source sort. Ordering is unchanged (RRF is monotone
  // in bm25 rank); the per-leg evidence stays in ftsScore.
  if (sem.length === 0) return rrfFuse([fts], limit, (h) => h.ts, () => {}, (h) => h.ts);

  // First sighting wins (FTS hits carry the real snippet); the other leg's
  // evidence is grafted onto it.
  return rrfFuse(
    [fts, sem],
    limit,
    (h) => h.ts,
    (prior, other) => {
      prior.cosine = prior.cosine ?? other.cosine;
    },
    (h) => h.ts
  );
}

// ---- durable facts ----

/**
 * bm25-gated FTS leg over active facts. Unlike the main process's lexical fact
 * tier (rankFactsLexically: recency-blended, trigram-backed), this is the plain
 * hybrid leg used by the MCP search_facts tool.
 */
export function ftsSearchFacts(db: DatabaseSync, rawQuery: string, limit = FTS_CANDIDATES): CoreFactHit[] {
  const match = buildMatchQuery(rawQuery);
  if (!match) return [];
  try {
    const rows = db
      .prepare(
        `SELECT f.id AS id, f.text AS text, bm25(facts_fts) AS score
         FROM facts_fts
         JOIN facts f ON f.id = facts_fts.rowid
         WHERE facts_fts MATCH ? AND f.status = 'active'
         ORDER BY score
         LIMIT ?`
      )
      .all(match, limit) as Array<{ id: number; text: string; score: number }>;
    return rows.filter((r) => r.score <= FTS_SCORE_CEILING);
  } catch (e) {
    report('recall.facts', 'returned no fact hits from the FTS leg', e);
    return [];
  }
}

/**
 * The semantic floor for explicit fact search. Matches the injection path's
 * STANDARD_FACT_MIN_COSINE (inject.ts): below it a "hit" is just the nearest
 * stored fact to an arbitrary query, not a match.
 */
export const FACT_SEARCH_MIN_COSINE = 0.72;

/**
 * Cosine top-N over fact_vectors, floored at `minCosine`. RRF only reranks
 * what the legs supply — without a floor this leg always filled its quota, so
 * search_facts returned the user's nearest personal facts for ANY query and
 * its "no matching facts" reply was effectively dead code.
 * [] on any failure (e.g. old DB without the table).
 */
export function semanticSearchFactsCore(
  db: DatabaseSync,
  qVec: Float32Array,
  model: string,
  limit: number,
  minCosine = FACT_SEARCH_MIN_COSINE
): CoreFactHit[] {
  const qMag = Math.sqrt(qVec.reduce((s, v) => s + v * v, 0));
  if (qMag === 0 || limit <= 0) return [];
  try {
    const scored: CoreFactHit[] = [];
    const rows = db
      .prepare(
        `SELECT v.fact_id AS id, v.vec AS vec, f.text AS text
         FROM fact_vectors v JOIN facts f ON f.id = v.fact_id
         WHERE v.model = ? AND f.status = 'active'`
      )
      .iterate(model) as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      const vec = bytesToFloat32(row.vec as Uint8Array);
      if (vec.length !== qVec.length) continue;
      let dot = 0;
      let mag = 0;
      for (let i = 0; i < vec.length; i++) {
        dot += vec[i] * qVec[i];
        mag += vec[i] * vec[i];
      }
      const denom = qMag * Math.sqrt(mag);
      const cos = denom === 0 ? 0 : dot / denom;
      if (cos < minCosine) continue;
      scored.push({ id: row.id as number, text: row.text as string, score: cos });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  } catch (e) {
    report('recall.facts', 'returned no fact hits from the cosine leg', e);
    return [];
  }
}

/** Hybrid facts search: FTS leg + semantic leg fused by RRF; FTS-only when semantic fails. */
export async function hybridSearchFacts(
  db: DatabaseSync,
  rawQuery: string,
  opts: { limit?: number; embedQuery?: EmbedQueryFn } = {}
): Promise<CoreFactHit[]> {
  const limit = opts.limit ?? 10;
  const fts = ftsSearchFacts(db, rawQuery, FTS_CANDIDATES);
  let sem: CoreFactHit[] = [];
  if (opts.embedQuery) {
    try {
      const qe = await opts.embedQuery();
      if (qe) sem = semanticSearchFactsCore(db, qe.vec, qe.model, SEMANTIC_CANDIDATES);
    } catch (e) {
      // Semantic leg optional — but search_facts without it is a different tool.
      report('recall.facts', 'ranked facts on FTS alone', e);
    }
  }
  if (sem.length === 0) return fts.slice(0, limit);
  return rrfFuse([fts, sem], limit, () => 0, () => {});
}

// ---- thread summaries (Level 1.5) ----

export interface SummarySearchOptions {
  limit?: number;
  excludeThreadId?: string | null;
  embedQuery?: EmbedQueryFn;
  /** Same contract as HybridMessageOptions.semanticScan, for the summary leg. */
  semanticScan?: (qe: QueryEmbedding, opts: SemanticScanOptions) => Promise<CoreSummaryHit[]>;
}

/** bm25-gated FTS leg over thread summaries. [] on a pre-v3 DB without the table. */
export function ftsSearchSummaries(
  db: DatabaseSync,
  rawQuery: string,
  opts: { limit?: number; excludeThreadId?: string | null } = {}
): CoreSummaryHit[] {
  const match = buildMatchQuery(rawQuery);
  if (!match) return [];
  const limit = opts.limit ?? FTS_CANDIDATES;
  const exclude = opts.excludeThreadId ?? null;
  try {
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.thread_id AS threadId, s.text AS text,
                s.first_ts AS firstTs, s.last_ts AS lastTs,
                bm25(summaries_fts) AS score
         FROM summaries_fts
         JOIN summaries s ON s.id = summaries_fts.rowid
         WHERE summaries_fts MATCH ?
           AND (? IS NULL OR s.thread_id <> ?)
         ORDER BY score
         LIMIT ?`
      )
      .all(match, exclude, exclude, limit) as Array<Record<string, unknown>>;
    return rows
      .map((r) => ({
        id: r.id as number,
        threadId: r.threadId as string,
        text: r.text as string,
        firstTs: r.firstTs as number,
        lastTs: r.lastTs as number,
        score: r.score as number,
        ftsScore: r.score as number
      }))
      .filter((h) => h.score <= FTS_SCORE_CEILING);
  } catch (e) {
    report('recall.summaries', 'returned no summary hits from the FTS leg', e);
    return [];
  }
}

/**
 * Cosine top-N over summary_vectors, gated by the summary-specific min-cosine
 * (see DEFAULT_SUMMARY_MIN_COSINE — long passages score lower than messages).
 * [] on any failure, including a pre-v3 DB.
 */
export function semanticSearchSummariesCore(
  db: DatabaseSync,
  qVec: Float32Array,
  model: string,
  opts: { limit: number; minCosine: number; excludeThreadId?: string | null }
): CoreSummaryHit[] {
  if (opts.limit <= 0) return [];
  const exclude = opts.excludeThreadId ?? null;
  const qMag = Math.sqrt(qVec.reduce((s, v) => s + v * v, 0));
  if (qMag === 0) return [];
  try {
    const scored: CoreSummaryHit[] = [];
    const rows = db
      .prepare(
        `SELECT v.summary_id AS id, v.vec AS vec, s.thread_id AS threadId, s.text AS text,
                s.first_ts AS firstTs, s.last_ts AS lastTs
         FROM summary_vectors v JOIN summaries s ON s.id = v.summary_id
         WHERE v.model = ? AND (? IS NULL OR s.thread_id <> ?)`
      )
      .iterate(model, exclude, exclude) as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      const vec = bytesToFloat32(row.vec as Uint8Array);
      if (vec.length !== qVec.length) continue;
      let dot = 0;
      let mag = 0;
      for (let i = 0; i < vec.length; i++) {
        dot += vec[i] * qVec[i];
        mag += vec[i] * vec[i];
      }
      const denom = qMag * Math.sqrt(mag);
      const cos = denom === 0 ? 0 : dot / denom;
      if (cos < opts.minCosine) continue;
      // Streaming top-N like the message scan — no full above-threshold
      // materialization (each row carries the whole summary text).
      insertTopN(scored, {
        id: row.id as number,
        threadId: row.threadId as string,
        text: row.text as string,
        firstTs: row.firstTs as number,
        lastTs: row.lastTs as number,
        score: cos,
        cosine: cos
      }, cos, opts.limit);
    }
    return scored;
  } catch (e) {
    report('recall.summaries', 'returned no summary hits from the cosine leg', e);
    return [];
  }
}

/**
 * Hybrid summary search: FTS + cosine legs fused by RRF, same shape as episodic
 * messages. Degrades to FTS-only without embeddings, and to [] on a pre-v3 DB.
 */
export async function hybridSearchSummaries(
  db: DatabaseSync,
  rawQuery: string,
  opts: SummarySearchOptions = {}
): Promise<CoreSummaryHit[]> {
  const limit = opts.limit ?? 3;
  const fts = ftsSearchSummaries(db, rawQuery, {
    limit: FTS_CANDIDATES,
    excludeThreadId: opts.excludeThreadId
  });
  let sem: CoreSummaryHit[] = [];
  if (opts.embedQuery) {
    try {
      const qe = await opts.embedQuery();
      if (qe) {
        const scanOpts: SemanticScanOptions = {
          limit: SEMANTIC_CANDIDATES,
          minCosine: readSummaryMinCosine(db),
          excludeThreadId: opts.excludeThreadId ?? null
        };
        sem = opts.semanticScan
          ? await opts.semanticScan(qe, scanOpts)
          : semanticSearchSummariesCore(db, qe.vec, qe.model, scanOpts);
      }
    } catch (e) {
      // Semantic leg optional. It is also the leg that carries sk→en, so an
      // FTS-only summary answer is a much narrower one.
      report('recall.summaries', 'ranked summaries on FTS alone', e);
    }
  }
  // Same one-scale rule as hybridSearchMessages: FTS-only still returns RRF scores.
  if (sem.length === 0) return rrfFuse([fts], limit, (h) => h.lastTs, () => {}, (h) => h.lastTs);
  return rrfFuse(
    [fts, sem],
    limit,
    (h) => h.lastTs,
    (prior, other) => {
      prior.cosine = prior.cosine ?? other.cosine;
    },
    (h) => h.lastTs
  );
}

// ---- indexed connected-folder documents ----
//
// Same corpus pattern as summaries, but the handle is a per-folder index DB
// (folder-index/store.ts schema: docs / docs_fts / doc_vectors), not
// recall.sqlite. Shared here so the main process and the stem-recall MCP
// server search folder indexes with identical mechanics.

/** Resolved options for one doc cosine scan (minCosine already read from the folder db). */
export interface DocScanOptions {
  limit: number;
  minCosine: number;
  snippetChars?: number;
}

export interface DocSearchOptions {
  limit?: number;
  /** Max characters of a semantic hit's excerpt (FTS hits use the FTS snippet). */
  snippetChars?: number;
  embedQuery?: EmbedQueryFn;
  /**
   * Override for the cosine leg — run the O(N) scan somewhere other than the
   * caller's event loop (same contract as HybridMessageOptions.semanticScan).
   * A throw degrades to FTS-only.
   */
  semanticScan?: (qe: QueryEmbedding, opts: DocScanOptions) => Promise<CoreDocHit[]>;
}

/**
 * Below this many docs the bm25 noise gate is skipped: bm25 magnitudes scale
 * with IDF, and in a small corpus every score collapses toward 0 — the -0.1
 * ceiling would suppress perfectly good hits from a 20-note vault. Noise the
 * gate exists to strain is a large-corpus phenomenon anyway.
 */
const DOC_FTS_GATE_MIN_DOCS = 32;

/** bm25-gated FTS leg over one folder index's documents (gate is scale-aware). */
export function ftsSearchDocs(
  db: DatabaseSync,
  rawQuery: string,
  opts: { limit?: number } = {}
): CoreDocHit[] {
  const match = buildMatchQuery(rawQuery);
  if (!match) return [];
  const limit = opts.limit ?? FTS_CANDIDATES;
  try {
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM docs`).get() as { n: number }).n;
    const rows = db
      .prepare(
        `SELECT d.id AS id, d.rel_path AS relPath, d.title AS title, d.mtime AS mtime,
                d.text AS text,
                snippet(docs_fts, 0, '«', '»', '…', 12) AS snippet,
                bm25(docs_fts) AS score
         FROM docs_fts
         JOIN docs d ON d.id = docs_fts.rowid
         WHERE docs_fts MATCH ?
         ORDER BY score
         LIMIT ?`
      )
      .all(match, limit) as Array<Record<string, unknown>>;
    return rows
      .map((r) => ({
        id: r.id as number,
        relPath: r.relPath as string,
        title: r.title as string,
        mtime: r.mtime as number,
        text: r.text as string,
        snippet: r.snippet as string,
        score: r.score as number,
        ftsScore: r.score as number
      }))
      .filter((h) => total < DOC_FTS_GATE_MIN_DOCS || h.score <= FTS_SCORE_CEILING);
  } catch (e) {
    report('folder-index.search', 'returned no document hits from the FTS leg', e);
    return [];
  }
}

/** Cosine top-N over one folder index's doc vectors, gated by the doc min-cosine. */
export function semanticSearchDocsCore(
  db: DatabaseSync,
  qVec: Float32Array,
  model: string,
  opts: { limit: number; minCosine: number; snippetChars?: number }
): CoreDocHit[] {
  try {
    return semanticSearchDocsCoreOrThrow(db, qVec, model, opts);
  } catch (e) {
    report('folder-index.search', 'returned no document hits from the cosine leg', e);
    return [];
  }
}

/**
 * The same scan with SQLite failures left to propagate. Only the scan worker
 * wants this: it searches a folder index over a cached handle it does not own,
 * and a swallowed failure there is indistinguishable from "nothing matched" —
 * the caller resolves happily and never falls back in-process (scan.ts).
 */
export function semanticSearchDocsCoreOrThrow(
  db: DatabaseSync,
  qVec: Float32Array,
  model: string,
  opts: { limit: number; minCosine: number; snippetChars?: number }
): CoreDocHit[] {
  if (opts.limit <= 0) return [];
  const snippetChars = opts.snippetChars ?? 400;
  const qMag = Math.sqrt(qVec.reduce((s, v) => s + v * v, 0));
  if (qMag === 0) return [];
  const scored: CoreDocHit[] = [];
  const rows = db
    .prepare(
      `SELECT v.doc_id AS id, v.vec AS vec, d.rel_path AS relPath, d.title AS title,
              d.mtime AS mtime, d.text AS text
       FROM doc_vectors v JOIN docs d ON d.id = v.doc_id
       WHERE v.model = ?`
    )
    .iterate(model) as Iterable<Record<string, unknown>>;
  for (const row of rows) {
    const vec = bytesToFloat32(row.vec as Uint8Array);
    if (vec.length !== qVec.length) continue;
    let dot = 0;
    let mag = 0;
    for (let i = 0; i < vec.length; i++) {
      dot += vec[i] * qVec[i];
      mag += vec[i] * vec[i];
    }
    const denom = qMag * Math.sqrt(mag);
    const cos = denom === 0 ? 0 : dot / denom;
    if (cos < opts.minCosine) continue;
    const text = row.text as string;
    // Streaming top-N — every scored row used to carry the doc's full text
    // into an unbounded array before the sort.
    insertTopN(scored, {
      id: row.id as number,
      relPath: row.relPath as string,
      title: row.title as string,
      mtime: row.mtime as number,
      text,
      snippet: text.length <= snippetChars ? text : `${text.slice(0, snippetChars - 1)}…`,
      score: cos,
      cosine: cos
    }, cos, opts.limit);
  }
  return scored;
}

/**
 * Hybrid document search over one folder index: FTS + cosine legs fused by RRF.
 * Degrades to FTS-only without embeddings; [] on an empty/missing index.
 */
export async function hybridSearchDocs(
  db: DatabaseSync,
  rawQuery: string,
  opts: DocSearchOptions = {}
): Promise<CoreDocHit[]> {
  const limit = opts.limit ?? 3;
  const fts = ftsSearchDocs(db, rawQuery, { limit: FTS_CANDIDATES });
  let sem: CoreDocHit[] = [];
  if (opts.embedQuery) {
    try {
      const qe = await opts.embedQuery();
      if (qe) {
        const scanOpts: DocScanOptions = {
          limit: SEMANTIC_CANDIDATES,
          minCosine: readDocMinCosine(db),
          snippetChars: opts.snippetChars
        };
        sem = opts.semanticScan
          ? await opts.semanticScan(qe, scanOpts)
          : semanticSearchDocsCore(db, qe.vec, qe.model, scanOpts);
      }
    } catch (e) {
      // Semantic leg optional.
      report('folder-index.search', 'ranked documents on FTS alone', e);
    }
  }
  // One-scale rule (see hybridSearchMessages). For docs it is load-bearing
  // beyond a single index: folder-index/index.ts merges hits ACROSS folder
  // indexes by `score`, and raw bm25 here (negative, more-negative = better)
  // both inverted the FTS-only ranking and lost against any embedded folder's
  // positive RRF scores.
  if (sem.length === 0) return rrfFuse([fts], limit, (h) => h.mtime, () => {});
  return rrfFuse(
    [fts, sem],
    limit,
    (h) => h.mtime,
    (prior, other) => {
      prior.cosine = prior.cosine ?? other.cosine;
    }
  );
}
