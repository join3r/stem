import { localModelCacheKey, resolveEmbedSpec } from './embed-catalog';
import type { LocalEmbedModelSpec } from './embed-catalog';
import { DEFAULT_EMBED_BUDGETS, EmbeddingsUnavailableError, scheduledEmbed } from './embeddings';
import type { EmbedBudgets, EmbeddingsClient, EmbedKind, EmbedOptions } from './embeddings';
import { embedSchedule, type EmbedSchedule } from './embed-schedule';
import type { EmbedWorkerManager } from './embed-manager';
import type { EmbeddingsSettings, RetrievalSettings } from '../../shared/types';

// EmbeddingsClient over the bundled local model. The crucial contract:
// available() NEVER awaits readiness — it kicks the worker (spawn/download) and
// answers with the current state. Not-ready reads as unavailable, so callers
// take their existing lexical/recency fallbacks and no chat turn ever waits on
// a 120 MB download. Config is read fresh per call so a settings change
// applies on the next turn without a restart.
//
// Traffic goes through the shared embed traffic rules (scheduledEmbed):
// passages in bounded batches on the long budget, one at the worker at a time,
// bisected on timeout; queries registered so backfills yield, on the busy
// budget when a batch is already out. A CPU running Qwen3 0.6B failed exactly
// that way when it was handed the whole fact set as one request (2026-09-03).

// The worker's historical query budget, kept: a query right after load also
// pays the first ONNX run's warm-up, which the shared 30s default doesn't cover.
const LOCAL_QUERY_TIMEOUT_MS = 60_000;

export const LOCAL_EMBED_BUDGETS: EmbedBudgets = { ...DEFAULT_EMBED_BUDGETS, timeoutMs: LOCAL_QUERY_TIMEOUT_MS };

// The whole retrieval config rather than the embeddings half: which model
// `localModel` names can only be answered together with the list of imported
// ones (see resolveEmbedSpec).
export function createLocalEmbeddingsClient(
  getSettings: () => Promise<RetrievalSettings>,
  manager: EmbedWorkerManager,
  opts: { budgets?: Partial<EmbedBudgets>; schedule?: EmbedSchedule } = {}
): EmbeddingsClient {
  const budgets: EmbedBudgets = { ...LOCAL_EMBED_BUDGETS, ...opts.budgets };
  const schedule = opts.schedule ?? embedSchedule;

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
    async embed(texts: string[], kind: EmbedKind = 'passage', opts?: EmbedOptions) {
      const sp = await spec();
      if (!sp) throw new EmbeddingsUnavailableError('local embeddings not enabled');
      const st = manager.status();
      if (st.model !== sp.id || st.state !== 'ready') {
        manager.ensure(sp);
        throw new EmbeddingsUnavailableError('local embedding model not ready');
      }
      return scheduledEmbed(
        (batch, k, timeoutMs) => manager.embed(batch, k, { timeoutMs }),
        texts,
        kind,
        budgets,
        schedule,
        opts
      );
    }
  };
}

/**
 * Route each call to the local backend unless the mode is Off. Mode is read
 * fresh per call, mirroring the fresh-config-getter pattern, so switching
 * Off/Built-in in Settings takes effect on the next turn with no restart.
 */
export function createEmbeddingsRouter(deps: {
  getMode: () => Promise<EmbeddingsSettings['mode']>;
  local: EmbeddingsClient;
}): EmbeddingsClient {
  async function pick(): Promise<EmbeddingsClient | null> {
    return (await deps.getMode()) === 'local' ? deps.local : null;
  }
  return {
    async available() {
      return (await (await pick())?.available()) ?? false;
    },
    async modelId() {
      return (await (await pick())?.modelId()) ?? null;
    },
    async embed(texts, kind, opts) {
      const client = await pick();
      if (!client) throw new EmbeddingsUnavailableError('embeddings are off');
      return client.embed(texts, kind, opts);
    }
  };
}
