import { resolveRerankSpec } from './rerank-catalog';
import type { LocalRerankModelSpec } from './rerank-catalog';
import { RerankUnavailableError } from './rerank';
import type { RerankClient } from './rerank';
import type { EmbedWorkerManager } from './embed-manager';
import type { RerankerSettings, RetrievalSettings } from '../../shared/types';

// RerankClient over the bundled local cross-encoder. Same contract as the local
// embeddings client: available() NEVER awaits readiness — it kicks the worker
// (spawn/download) and answers with the current state. Not-ready reads as
// unavailable, so inject degrades to the cosine ranking and no chat turn ever
// waits on a model download. Config is read fresh per call so a settings change
// applies on the next turn without a restart.

// Takes the whole retrieval config for the same reason the embeddings client
// does: a model id means nothing without the list of imported models.
export function createLocalRerankClient(
  getSettings: () => Promise<RetrievalSettings>,
  manager: EmbedWorkerManager
): RerankClient {
  async function spec(): Promise<LocalRerankModelSpec | null> {
    const r = await getSettings();
    return r.reranker.mode === 'local' ? resolveRerankSpec(r) : null;
  }

  return {
    async available() {
      const sp = await spec();
      if (!sp) return false;
      manager.ensureRerank(sp); // fire-and-forget: starts download/load if idle
      const st = manager.rerankStatus();
      return st.model === sp.id && st.state === 'ready';
    },
    // Only once the model is actually ready: a floor for a model that is still
    // downloading would let a caller apply bge's calibration to whatever the
    // previous backend returns.
    async minRelevantScore() {
      const sp = await spec();
      if (!sp) return null;
      const st = manager.rerankStatus();
      return st.model === sp.id && st.state === 'ready' ? sp.minRelevantScore : null;
    },
    async factGateScore() {
      const sp = await spec();
      if (!sp) return null;
      const st = manager.rerankStatus();
      return st.model === sp.id && st.state === 'ready' ? sp.factGateScore : null;
    },
    async rerank(query, docs, topN) {
      const sp = await spec();
      if (!sp) throw new RerankUnavailableError('local reranker not enabled');
      const st = manager.rerankStatus();
      if (st.model !== sp.id || st.state !== 'ready') {
        manager.ensureRerank(sp);
        throw new RerankUnavailableError('local reranker model not ready');
      }
      if (docs.length === 0) return [];
      return manager.rerank(query, docs, topN);
    }
  };
}

/**
 * Route each call to the backend the current mode selects. Mode is read fresh
 * per call, mirroring the embeddings router, so switching Off/Built-in/Server
 * in Settings takes effect on the next turn with no restart.
 */
export function createRerankRouter(deps: {
  getMode: () => Promise<RerankerSettings['mode']>;
  local: RerankClient;
  remote: RerankClient;
}): RerankClient {
  async function pick(): Promise<RerankClient | null> {
    const mode = await deps.getMode();
    return mode === 'local' ? deps.local : mode === 'remote' ? deps.remote : null;
  }
  return {
    async available() {
      return (await (await pick())?.available()) ?? false;
    },
    async minRelevantScore() {
      const client = await pick();
      return (await client?.minRelevantScore?.()) ?? null;
    },
    async factGateScore() {
      const client = await pick();
      return (await client?.factGateScore?.()) ?? null;
    },
    async rerank(query, docs, topN) {
      const client = await pick();
      if (!client) throw new RerankUnavailableError('reranker is off');
      return client.rerank(query, docs, topN);
    }
  };
}
