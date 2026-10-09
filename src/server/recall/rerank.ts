// Generic reranker seam for Stem Recall. A true cross-encoder re-scores
// candidate documents against the query — the precision stage after embedding
// retrieval. The interface is backend-agnostic (the bundled model in
// rerank-local.ts, Stem GTE Memory in gte-fact-pilot.ts), so it can be reused
// anywhere a query→documents ranking is needed.

export interface RerankResult {
  /** Index into the input `documents` array. */
  index: number;
  score: number;
}

export interface RerankClient {
  /** Whether a usable (enabled + ready) backend is present right now. */
  available(): Promise<boolean>;
  /**
   * The raw-score floor below which this backend's scores mean "not relevant",
   * or null when the scale is unknowable. Ranking callers ignore this; only a
   * caller that needs a yes/no (skill inlining) reads it, and a null answer is
   * its signal to fall back to a scale-free rule rather than invent a constant.
   */
  minRelevantScore?(): Promise<number | null>;
  /**
   * The raw-score floor for the fact-injection gate, or null when the scale is
   * unknowable (same reasoning as minRelevantScore — the caller then applies
   * its scale-free margin rule instead).
   */
  factGateScore?(): Promise<number | null>;
  /**
   * Rerank `docs` against `query`; returns up to `topN` results, best first.
   * `index` refers into the input `docs`. Throws {@link RerankUnavailableError}
   * when unconfigured, or a plain Error on any transport/shape failure.
   */
  rerank(query: string, docs: string[], topN: number): Promise<RerankResult[]>;
}

/** Thrown when the reranker is off or not ready — callers fall back. */
export class RerankUnavailableError extends Error {
  constructor(message = 'reranker not available') {
    super(message);
    this.name = 'RerankUnavailableError';
  }
}
