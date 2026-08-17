import { localModelCacheKey, resolveEmbedSpec } from './embed-catalog';
import type { LocalEmbedModelSpec } from './embed-catalog';
import { EmbeddingsUnavailableError } from './embeddings';
import type { EmbeddingsClient, EmbedKind } from './embeddings';
import type { EmbedWorkerManager } from './embed-manager';
import type { EmbeddingsSettings, RetrievalSettings } from '../../shared/types';

// EmbeddingsClient over the bundled local model. The crucial contract:
// available() NEVER awaits readiness — it kicks the worker (spawn/download) and
// answers with the current state. Not-ready reads as unavailable, so callers
// take their existing lexical/recency fallbacks and no chat turn ever waits on
// a 120 MB download. Config is read fresh per call (same pattern as the HTTP
// client) so a settings change applies on the next turn without a restart.

// The whole retrieval config rather than the embeddings half: which model
// `localModel` names can only be answered together with the list of imported
// ones (see resolveEmbedSpec).
export function createLocalEmbeddingsClient(
  getSettings: () => Promise<RetrievalSettings>,
  manager: EmbedWorkerManager
): EmbeddingsClient {
  async function spec(): Promise<LocalEmbedModelSpec | null> {
    const r = await getSettings();
    return r.embeddings.mode === 'local' ? resolveEmbedSpec(r) : null;
  }

  return {
    async available() {
      const sp = await spec();
      if (!sp) return false;
      manager.ensure(sp); // fire-and-forget: starts download/load if idle
      const st = manager.status();
      return st.model === sp.id && st.state === 'ready';
    },
    async modelId() {
      const sp = await spec();
      return sp ? localModelCacheKey(sp) : null;
    },
    async embed(texts: string[], kind: EmbedKind = 'passage') {
      const sp = await spec();
      if (!sp) throw new EmbeddingsUnavailableError('local embeddings not enabled');
      const st = manager.status();
      if (st.model !== sp.id || st.state !== 'ready') {
        manager.ensure(sp);
        throw new EmbeddingsUnavailableError('local embedding model not ready');
      }
      if (texts.length === 0) return [];
      return manager.embed(texts, kind);
    }
  };
}

/**
 * Route each call to the backend the current mode selects. Mode is read fresh
 * per call, mirroring the fresh-config-getter pattern, so switching Off/Local/
 * Remote in Settings takes effect on the next turn with no restart.
 */
export function createEmbeddingsRouter(deps: {
  getMode: () => Promise<EmbeddingsSettings['mode']>;
  local: EmbeddingsClient;
  remote: EmbeddingsClient;
}): EmbeddingsClient {
  async function pick(): Promise<EmbeddingsClient | null> {
    const mode = await deps.getMode();
    return mode === 'local' ? deps.local : mode === 'remote' ? deps.remote : null;
  }
  return {
    async available() {
      return (await (await pick())?.available()) ?? false;
    },
    async modelId() {
      return (await (await pick())?.modelId()) ?? null;
    },
    async embed(texts, kind) {
      const client = await pick();
      if (!client) throw new EmbeddingsUnavailableError('embeddings are off');
      return client.embed(texts, kind);
    }
  };
}
