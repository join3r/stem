// Generic reranker seam for Stem Recall. Talks to a Cohere/Jina-style /rerank
// endpoint the user runs (llama.cpp --reranking, vLLM, Infinity, TEI). A true
// cross-encoder re-scores candidate documents against the query — the precision
// stage after embedding retrieval. Like the embeddings client this is fetch-only
// and reads its config fresh on each call, so it can be reused anywhere a
// query→documents ranking is needed.

export interface RerankConfig {
  baseUrl: string;
  model: string;
  apiKey?: string | null;
}

export interface RerankResult {
  /** Index into the input `documents` array. */
  index: number;
  score: number;
}

export interface RerankClient {
  /** Whether a usable (enabled + configured) endpoint is present right now. */
  available(): Promise<boolean>;
  /**
   * The raw-score floor below which this backend's scores mean "not relevant",
   * or null when the scale is unknowable. Ranking callers ignore this; only a
   * caller that needs a yes/no (skill inlining) reads it, and a null answer is
   * its signal to fall back to a scale-free rule rather than invent a constant.
   *
   * Null for every remote server by construction: /rerank endpoints run
   * arbitrary models and normalise differently (Cohere-style returns 0..1, a
   * local cross-encoder returns unbounded logits), so a number here would be a
   * guess about someone else's model.
   */
  minRelevantScore?(): Promise<number | null>;
  /**
   * The raw-score floor for the fact-injection gate, or null when the scale is
   * unknowable (every remote server, same reasoning as minRelevantScore — the
   * caller then applies its scale-free margin rule instead).
   */
  factGateScore?(): Promise<number | null>;
  /**
   * Rerank `docs` against `query`; returns up to `topN` results, best first.
   * `index` refers into the input `docs`. Throws {@link RerankUnavailableError}
   * when unconfigured, or a plain Error on any transport/shape failure.
   */
  rerank(query: string, docs: string[], topN: number): Promise<RerankResult[]>;
}

/** Thrown when the endpoint is disabled/unconfigured — callers fall back. */
export class RerankUnavailableError extends Error {
  constructor(message = 'rerank endpoint not configured') {
    super(message);
    this.name = 'RerankUnavailableError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

function trimUrl(base: string): string {
  return base.replace(/\/+$/, '');
}

export function createHttpRerankClient(
  getConfig: () => Promise<RerankConfig | null>,
  opts: { timeoutMs?: number } = {}
): RerankClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post(url: string, body: unknown, apiKey: string | null | undefined): Promise<Response> {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } catch (err) {
      // Same mapping as the embeddings client: the abort's stock message
      // ("This operation was aborted") reaches the Memory-tab banner verbatim
      // and reads like a crash rather than the slowness it is.
      if (timedOut) {
        throw new Error(`rerank: ${url} → no response within ${Math.round(timeoutMs / 1000)}s (endpoint reachable but slow)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async available() {
      return (await getConfig()) !== null;
    },
    async rerank(query, docs, topN) {
      const cfg = await getConfig();
      if (!cfg) throw new RerankUnavailableError();
      if (docs.length === 0) return [];

      const base = trimUrl(cfg.baseUrl);
      const body = { model: cfg.model, query, documents: docs, top_n: topN };
      // Servers disagree on the path: try /rerank, fall back to /v1/rerank.
      let res = await post(`${base}/rerank`, body, cfg.apiKey);
      if (res.status === 404 || res.status === 405) res = await post(`${base}/v1/rerank`, body, cfg.apiKey);
      if (!res.ok) throw new Error(`rerank: ${base}/rerank → HTTP ${res.status}`);

      const json = (await res.json()) as { results?: Array<{ index?: number; relevance_score?: number; score?: number }> };
      const results = json?.results;
      if (!Array.isArray(results)) throw new Error('rerank: response missing results[]');
      return results
        .map((r) => ({ index: r.index, score: r.relevance_score ?? r.score }))
        .filter((r): r is RerankResult => typeof r.index === 'number' && typeof r.score === 'number')
        // Re-sort defensively; some servers already return sorted desc.
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);
    }
  };
}
