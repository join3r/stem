
import {
  buildMatchQuery as coreBuildMatchQuery,
  buildTrigramQuery,
  FTS_SCORE_CEILING,
  hybridSearchMessages,
  type EmbedQueryFn,
  type QueryEmbedding
} from './search-core';
import { scanMessagesOffThread } from './scan';
import { degrade } from '../degrade';
import { recallStore, type SearchHit, type SearchOptions, type Fact } from './store';
const { search: storeSearch, countFacts, dbHandle, factTermSearch, factTrigramSearch } = recallStore;

// The stable retrieval interface. Everything in the MAIN process that recalls
// past conversation goes through here; the mechanics live in search-core.ts,
// which is shared verbatim with the standalone recall MCP server — behavior
// changes belong there so both processes stay in lockstep.

export {
  RRF_K,
  FTS_CANDIDATES,
  SEMANTIC_CANDIDATES,
  FTS_SCORE_CEILING
} from './search-core';
export type { QueryEmbedding } from './search-core';

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression. Each word becomes a
 * quoted term (so punctuation/operators can never break MATCH syntax) and the
 * terms are OR-ed, which is the right recall-oriented default. Returns null when
 * there's nothing searchable.
 */
export function buildMatchQuery(raw: string): string | null {
  return coreBuildMatchQuery(raw);
}

// Recency blend for the lexical fact tier. The weight is deliberately small versus
// typical bm25 magnitudes so recency only breaks near-ties between comparably strong
// lexical matches — it never overrides a clearly stronger match.
const FACT_RECENCY_HALF_LIFE_DAYS = 30;
const FACT_RECENCY_WEIGHT = 0.3;

/** Exponential recency decay in [0,1]: 1 for a just-touched fact, →0 for old ones. */
export function recencyWeight(ageDays: number): number {
  return Math.exp(-Math.max(0, ageDays) / FACT_RECENCY_HALF_LIFE_DAYS);
}

/**
 * A sensitive fact on the lexical tier needs a materially strong term match, not
 * just any token overlap — the counterpart of its stricter 0.82 cosine gate on
 * the semantic tier (inject.ts). Well below the -0.1 noise ceiling.
 *
 * Do NOT reach for a different constant here to make this bar separate a direct
 * match from an incidental one: bm25 cannot express that distinction, and the two
 * are ordered the wrong way round. Measured on a live store, single-term matches,
 * more-negative = stronger:
 *
 *   N=2    "what should I know about my diabetes?"      -0.000001  (direct)
 *   N=3    "any management tips for my team offsite?"   -0.465973  (incidental)
 *   N=21   "what should I know about my diabetes?"      -2.592862  (direct)
 *   N=21   "any management tips for my team offsite?"   -2.036765  (incidental)
 *
 * The match to admit is the WEAKER of each pair, so every threshold shape —
 * constant, corpus-scaled, ratio-to-top-hit, outlier-vs-pool — admits the leak
 * whenever it admits the direct hit. (-0.000001 is fts5's clamped-IDF floor: at
 * N=2, n=1 the IDF term is log(1)=0 and it substitutes an epsilon, so that score
 * carries no match strength at all.) What actually suppresses an incidental hit
 * at scale is the noise ceiling below, once the shared word is common enough for
 * its IDF to collapse — which is why this bar stands down with it.
 *
 * The separating signal is semantic, and the semantic tier's scale-free 0.82
 * cosine gate is where sensitive facts are really protected. See the sensitive
 * case in tests/unit/recall-v2.test.ts, which pins the measurement.
 */
export const SENSITIVE_LEXICAL_MAX_BM25 = -1;

/**
 * Below this many facts both lexical bm25 gates are skipped: bm25
 * magnitudes scale with IDF, and in a small store every score collapses toward
 * 0 — the same scale-awareness as ftsSearchDocs' DOC_FTS_GATE_MIN_DOCS. The
 * one-incidental-shared-word noise the ceiling exists for is a large-store
 * phenomenon; in a 20-fact store a term match IS a direct match.
 *
 * Sized against ALL facts, not just active ones: bm25's IDF and avgdl come from
 * the whole facts_fts index, which keeps a row per superseded fact too (retiring
 * a fact flips its status, it doesn't delete it). A store with 28 active and 300
 * superseded facts has full-scale bm25.
 */
export const FACT_LEXICAL_GATE_MIN_FACTS = 32;

/**
 * Lexical (BM25) relevance ranking of durable facts against a raw user message —
 * the no-embeddings fallback tier. Exact term matches rank first (bm25-gated like
 * every other FTS leg, with a mild recency blend so near-ties prefer fresher
 * facts); trigram substring matches (inflected/partial forms the term index
 * misses) fill any remaining room. Sensitivity keeps a stricter bar here too:
 * sensitive facts need a strong bm25 match and never ride the trigram fill,
 * whose recency ordering carries no relevance signal at all. Returns up to
 * `limit` facts, best first; empty when the query has no searchable terms or
 * nothing matches — callers then fall back to recency.
 */
export function rankFactsLexically(
  rawQuery: string,
  limit: number,
  nowSec?: number,
  opts: { trigramFill?: boolean } = {}
): Fact[] {
  if (limit <= 0) return [];
  // One count per query: chooseFacts' getInjectableFacts() can't stand in for it,
  // since the gate is sized against every fact row and that list holds only the
  // active, injectable ones.
  const gated = countFacts() >= FACT_LEXICAL_GATE_MIN_FACTS;
  // trigramFill:false is how the no-reranker injection fallback keeps the
  // recency-ordered trigram leg out of the final selection — but only at scale.
  // In a small store a trigram substring IS a direct match ("live" → "lives"),
  // the same reasoning that stands the bm25 gates down below the threshold.
  const trigramFill = (opts.trigramFill ?? true) || !gated;
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const ranked: Fact[] = [];
  const seen = new Set<number>();

  const termMatch = buildMatchQuery(rawQuery);
  if (termMatch) {
    // Pull a pool wider than `limit`, then re-sort with the recency blend folded in.
    factTermSearch(termMatch, Math.max(limit * 4, limit))
      .filter((f) => !gated || f.score <= FTS_SCORE_CEILING)
      .filter((f) => f.sensitivity !== 'sensitive' || !gated || f.score <= SENSITIVE_LEXICAL_MAX_BM25)
      .map((f) => ({ f, blended: f.score - FACT_RECENCY_WEIGHT * recencyWeight((now - f.updatedAt) / 86400) }))
      .sort((a, b) => a.blended - b.blended)
      .forEach(({ f }) => {
        if (seen.has(f.id)) return;
        seen.add(f.id);
        ranked.push(f);
      });
  }

  if (trigramFill && ranked.length < limit) {
    const trigMatch = buildTrigramQuery(rawQuery);
    if (trigMatch) {
      for (const f of factTrigramSearch(trigMatch, limit)) {
        if (seen.has(f.id) || f.sensitivity === 'sensitive') continue;
        seen.add(f.id);
        ranked.push(f);
        if (ranked.length >= limit) break;
      }
    }
  }

  return ranked.slice(0, limit);
}

/**
 * Search past conversations for text relevant to `rawQuery`. Returns [] when the
 * query has no searchable terms or nothing matches — callers degrade silently.
 */
export function searchMemory(rawQuery: string, options: SearchOptions = {}): SearchHit[] {
  const match = buildMatchQuery(rawQuery);
  if (!match) return [];
  try {
    return storeSearch(match, options);
  } catch (e) {
    // A malformed index / unexpected SQL error must never break a turn. The []
    // it becomes is the same [] a query with no matches gets, so the turn goes
    // on believing the store had nothing to say.
    degrade('recall.search', 'returned no episodic hits', e);
    return [];
  }
}

export interface HybridOptions extends SearchOptions {
  /**
   * Lazy query-embed thunk (memoized by the caller so fact ranking and episodic
   * search share one embed per turn). Absent/null result/throw → FTS-only.
   */
  getQueryEmbedding?: () => Promise<QueryEmbedding | null>;
  /** Restrict hits to these roles before top-k (see MessageSearchOptions.roles). */
  roles?: Array<'user' | 'assistant'>;
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
export async function searchMemoryHybrid(rawQuery: string, options: HybridOptions = {}): Promise<SearchHit[]> {
  return hybridSearchMessages(dbHandle(), rawQuery, {
    limit: options.limit ?? 5,
    excludeThreadId: options.excludeThreadId,
    roles: options.roles,
    embedQuery: options.getQueryEmbedding as EmbedQueryFn | undefined,
    // The O(N) cosine scan runs in the scan worker when available, keeping the
    // chat-turn hot path off the main event loop (in-process fallback inside).
    semanticScan: scanMessagesOffThread,
    timingSink: options.timingSink
  });
}

export type { SearchHit } from './store';
