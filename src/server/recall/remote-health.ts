import { EmbeddingsUnavailableError, type EmbeddingsClient } from './embeddings';
import { RerankUnavailableError, type RerankClient } from './rerank';
import type { RemoteEndpointHealth, RemoteRetrievalHealth } from '../../shared/types';

// Health bookkeeping for the user's own remote retrieval endpoints. The local
// models stream a whole lifecycle (download/load/ready) out of the worker; a
// remote endpoint has no lifecycle to stream — the only truth available is
// whether the most recent real request worked. So this is a verdict cache, not
// a monitor: the wrapped clients record every embed/rerank outcome as a side
// effect of the calls recall makes anyway, and nothing here ever probes the
// endpoint on its own. Without it, a dead endpoint degrades every recall pass
// with no trace outside the background-activity log — which is exactly the
// silence the Memory-tab red markers exist to break.

export type RemoteStage = 'embeddings' | 'reranker';

export interface RemoteHealthTracker {
  get(): RemoteRetrievalHealth;
  /** Fired when either stage's verdict actually changes (not per request). */
  onChange(cb: (health: RemoteRetrievalHealth) => void): () => void;
  /** Record a request outcome (the Test button reports through these too). */
  recordOk(stage: RemoteStage): void;
  recordError(stage: RemoteStage, error: string): void;
  /**
   * Settings for `stage` changed: the verdict described an endpoint that may no
   * longer be configured, so forget it rather than leave a red marker pointing
   * at a config the user just fixed (or stopped using).
   */
  reset(stage: RemoteStage): void;
  /** An EmbeddingsClient that reports its outcomes here, else identical. */
  wrapEmbeddings(client: EmbeddingsClient): EmbeddingsClient;
  /** A RerankClient that reports its outcomes here, else identical. */
  wrapRerank(client: RerankClient): RerankClient;
}

export function createRemoteHealthTracker(): RemoteHealthTracker {
  const health: Record<RemoteStage, RemoteEndpointHealth> = {
    embeddings: { state: 'unknown' },
    reranker: { state: 'unknown' }
  };
  const listeners = new Set<(h: RemoteRetrievalHealth) => void>();

  function get(): RemoteRetrievalHealth {
    return { embeddings: { ...health.embeddings }, reranker: { ...health.reranker } };
  }

  function set(stage: RemoteStage, next: RemoteEndpointHealth): void {
    const prev = health[stage];
    if (prev.state === next.state && prev.error === next.error) return;
    health[stage] = next;
    for (const cb of listeners) cb(get());
  }

  /**
   * "Not configured" is not a failure of the endpoint — it is the router
   * declining to call one — so it must not paint a red marker. Everything else
   * a request throws is the endpoint (or the way to it) being broken.
   */
  function isUnavailable(err: unknown): boolean {
    return err instanceof EmbeddingsUnavailableError || err instanceof RerankUnavailableError;
  }

  function record<T>(stage: RemoteStage, work: Promise<T>): Promise<T> {
    return work.then(
      (value) => {
        set(stage, { state: 'ok' });
        return value;
      },
      (err: unknown) => {
        if (!isUnavailable(err)) {
          set(stage, { state: 'error', error: err instanceof Error ? err.message : 'request failed' });
        }
        throw err;
      }
    );
  }

  return {
    get,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    recordOk: (stage) => set(stage, { state: 'ok' }),
    recordError: (stage, error) => set(stage, { state: 'error', error }),
    reset: (stage) => set(stage, { state: 'unknown' }),
    wrapEmbeddings(client) {
      return {
        available: () => client.available(),
        modelId: () => client.modelId(),
        embed: (texts, kind, opts) => record('embeddings', client.embed(texts, kind, opts))
      };
    },
    wrapRerank(client) {
      return {
        available: () => client.available(),
        // Score floors pass through untouched (the HTTP client doesn't define
        // them, but the wrapper shouldn't be the reason a client that does
        // loses them).
        ...(client.minRelevantScore ? { minRelevantScore: () => client.minRelevantScore!() } : {}),
        ...(client.factGateScore ? { factGateScore: () => client.factGateScore!() } : {}),
        rerank: (query, docs, topN) => record('reranker', client.rerank(query, docs, topN))
      };
    }
  };
}
