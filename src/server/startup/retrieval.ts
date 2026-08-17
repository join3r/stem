import { host } from '../host';
import { readSettings, saveCustomModel } from '../workspace/settings';
import { embedModelsDir, embedSocketPath, recallDbPath } from '../workspace/paths';

import { embedNewMessages } from '../recall/embed-episodic';
import { scanAllIndexedFolders } from '../folder-index';
import { getEmbeddingsClient, setRetrievalClients } from '../recall/retrieval';
import { startEmbedEndpoint } from '../recall/embed-endpoint';
import { createHttpEmbeddingsClient, type EmbeddingsClient } from '../recall/embeddings';
import { createHttpRerankClient } from '../recall/rerank';
import { isCustomModelId, localModelCacheKey, resolveEmbedSpec } from '../recall/embed-catalog';
import { createEmbedWorkerManager, type EmbedWorkerManager } from '../recall/embed-manager';
import { createEmbeddingsRouter, createLocalEmbeddingsClient } from '../recall/embed-local';
import { resolveRerankSpec } from '../recall/rerank-catalog';
import { createLocalRerankClient, createRerankRouter } from '../recall/rerank-local';
import { createRemoteHealthTracker, type RemoteHealthTracker } from '../recall/remote-health';
import { spawnEmbedWorker } from '../recall/embed-worker-host';
import { createScanWorkerManager, type ScanWorkerManager } from '../recall/scan-manager';
import { spawnScanWorker } from '../recall/scan-worker-host';
import { setScanWorkerManager } from '../recall/scan';
import * as activity from '../activity';
import { log } from '../log';
import { recallStore } from '../recall/store';
const { getEpisodicGeneration, getFactsGeneration, getFactsMissingVector, pruneMessageVectorsExceptModel, pruneSummaryVectorsExceptModel, pruneVectorsExceptModel, getSummariesMissingVector, upsertFactVectorForSnapshot, upsertSummaryVector } = recallStore;

export interface RetrievalRuntime {
  embedManager: EmbedWorkerManager;
  scanManager: ScanWorkerManager;
  /** Verdict cache for the user's remote retrieval endpoints (mode === 'remote'). */
  remoteHealth: RemoteHealthTracker;
}

/**
 * Mirror a local model's download/load lifecycle into the activity registry.
 * Event-driven rather than call-scoped — start and finish arrive as separate
 * status callbacks — so it closes by kind rather than by handle. A model that
 * is already cached reports straight to 'ready' with nothing open, and
 * `endByKind` no-ops, which is the correct "no work happened" outcome.
 */
function trackModelStatus(
  kind: 'models.embed' | 'models.rerank',
  label: string,
  status: { state: string; progressPct?: number; dim?: number; error?: string }
): void {
  if (status.state === 'downloading' || status.state === 'loading') {
    const handle = activity.begin(kind, label, { stepped: true });
    // Loading has no byte progress of its own; hold the bar at full rather than
    // letting it snap back to 0% after the download finishes.
    activity.progress(handle, {
      done: status.state === 'loading' ? 100 : Math.max(0, Math.min(100, status.progressPct ?? 0)),
      total: 100
    });
    return;
  }
  if (status.state === 'error') {
    activity.fail(kind, status.error ?? 'Model failed to load', label);
    return;
  }
  if (status.state === 'ready') {
    activity.endByKind(kind, { worked: true, detail: status.dim ? `Ready · ${status.dim}-dim` : 'Ready' });
  }
}

/** Last thing written per log key, so a repeating status writes one line. */
const lastLoggedStatus = new Map<string, string>();

/**
 * Whether `value` differs from what was last logged for `key`. Uninteresting
 * transitions are recorded too (with no line) rather than skipped, so a stage
 * that recovers and then fails the same way again still gets a second line.
 */
function changed(key: string, value: string): boolean {
  if (lastLoggedStatus.get(key) === value) return false;
  lastLoggedStatus.set(key, value);
  return true;
}

/**
 * A local model's lifecycle, written to stem.log — the same events
 * {@link trackModelStatus} mirrors into the activity registry.
 *
 * That registry is an in-app surface and nothing else, so a model that fails to
 * load on someone else's machine leaves behind nothing they can send us: the
 * report arrives as "the embedding model failed" and stops there. Here the
 * transitions worth reading after the fact get one line each — the load that
 * started, the one that failed with its message, the model that came up.
 *
 * Keyed on model+state+error rather than the state alone, because these statuses
 * repeat: download progress posts ~4/s, and available() re-kicks a failed model
 * every ERROR_RETRY_MS for as long as the app runs. A second identical line says
 * nothing the first didn't; a changed message is a different failure and earns
 * its own. Exported because that dedupe is the part that regresses into spam.
 */
export function logModelStatus(
  stage: 'embeddings' | 'reranker',
  status: { model: string; state: string; dim?: number; error?: string }
): void {
  // Progress ticks share the 'downloading' state, so they collapse into the one
  // line that says a download began.
  if (!changed(`local:${stage}`, `${status.model}:${status.state}:${status.error ?? ''}`)) return;
  if (status.state === 'idle') return; // "nothing is loaded" is not an event
  log('retrieval', `local ${stage} model ${status.state}`, {
    model: status.model,
    ...(status.dim ? { dim: status.dim } : {}),
    ...(status.error ? { error: status.error } : {})
  });
}

/**
 * A remote endpoint's verdict, when it turns bad. Only the failures are written:
 * unlike a local model there is no lifecycle worth narrating, and 'ok' is the
 * state every working install sits in.
 */
export function logRemoteHealth(
  stage: 'embeddings' | 'reranker',
  health: { state: string; error?: string }
): void {
  if (!changed(`remote:${stage}`, `${health.state}:${health.error ?? ''}`)) return;
  if (health.state !== 'error') return;
  log('retrieval', `remote ${stage} endpoint failing`, { error: health.error });
}

/**
 * Backfill thread-summary vectors (Level 1.5 search) for the freshly-ready
 * model. Every upsert sits under an await, so the pass snapshots the episodic
 * epoch and drops its writes when a "Reset recall" moved it: reset deletes the
 * summaries and the VACUUM lets new ones reclaim those ids, and a late upsert
 * would bind an old embedding to an unrelated summary. Returns how many
 * summaries were embedded.
 */
export async function backfillSummaryVectors(emb: EmbeddingsClient, model: string): Promise<number> {
  const episodicGeneration = getEpisodicGeneration();
  const intact = () => getEpisodicGeneration() === episodicGeneration;
  pruneSummaryVectorsExceptModel(model);
  const missing = getSummariesMissingVector(model);
  const handle = activity.begin('memory.summaryEmbed', 'Embedding chat summaries', { stepped: true });
  let done = 0;
  for (let i = 0; i < missing.length; i += 64) {
    if (!intact()) break;
    const batch = missing.slice(i, i + 64);
    const vecs = await emb.embed(batch.map((s) => s.text), 'passage');
    if (!intact()) break;
    batch.forEach((s, j) => upsertSummaryVector(s.id, model, vecs[j]));
    done += batch.length;
    activity.progress(handle, { done, total: missing.length });
  }
  activity.end(handle, {
    worked: done > 0,
    detail: `Embedded ${done.toLocaleString()} summar${done === 1 ? 'y' : 'ies'}`
  });
  return done;
}

/**
 * Stem Recall relevance ranking. Embeddings route per the settings mode: the
 * bundled local model (in a utility process; the out-of-box default) or the
 * user's own HTTP endpoint. Config is read fresh each turn, so switching mode
 * or repointing endpoints in Settings takes effect on the next fact-ranking
 * pass with no restart. Off/not-ready → the clients report unavailable and
 * inject falls back to lexical/recency selection — a chat turn never waits on
 * a model download.
 */
export function initRetrieval(deps: {
  e2e: boolean;
  /** Push on a client channel — the model download/load status streams. */
  emit: (channel: string, payload: unknown) => void;
}): RetrievalRuntime {
  const embedManager = createEmbedWorkerManager({ spawn: spawnEmbedWorker, cacheDir: embedModelsDir });
  // Recall's O(N) cosine scans and episodic VACUUMs run in their own utility
  // process so they never block the main event loop; everything degrades to the
  // in-process implementations if the worker is unavailable (see recall/scan.ts).
  const scanManager = createScanWorkerManager({ spawn: spawnScanWorker, dbPath: () => recallDbPath() });
  setScanWorkerManager(scanManager);
  const getRetrieval = async () => (await readSettings()).retrieval;
  const getEmbedSettings = async () => (await getRetrieval()).embeddings;
  const getRerankSettings = async () => (await getRetrieval()).reranker;
  const localEmbeddings = createLocalEmbeddingsClient(getRetrieval, embedManager);
  // Remote endpoints have no lifecycle to stream the way the local worker does,
  // so their health is the recorded outcome of the requests recall makes anyway
  // — the wrappers below write it, and the Memory tab's red markers read it.
  const remoteHealth = createRemoteHealthTracker();
  remoteHealth.onChange((health) => {
    deps.emit('retrieval:remoteHealth', health);
    // Same silence as a local model's, for the same reason. onChange carries
    // BOTH stages whenever either one moves, which is what the dedupe is for
    // here: a stuck embeddings endpoint must not re-log every time the reranker
    // changes its mind.
    for (const stage of ['embeddings', 'reranker'] as const) logRemoteHealth(stage, health[stage]);
  });
  setRetrievalClients({
    embeddings: createEmbeddingsRouter({
      getMode: async () => (await getEmbedSettings()).mode,
      local: localEmbeddings,
      remote: remoteHealth.wrapEmbeddings(
        createHttpEmbeddingsClient(async () => {
          const e = await getEmbedSettings();
          return e.mode === 'remote' && e.baseUrl && e.model
            ? { baseUrl: e.baseUrl, model: e.model, apiKey: e.apiKey }
            : null;
        })
      )
    }),
    // Precision rerank stage: the bundled cross-encoder (co-hosted in the embed
    // worker) or the user's own Cohere/Jina-style /rerank endpoint (llama.cpp
    // --reranking, vLLM, Infinity, TEI — note Ollama can't serve one). Off/not
    // ready → inject degrades to the cosine ranking.
    rerank: createRerankRouter({
      getMode: async () => (await getRerankSettings()).mode,
      local: createLocalRerankClient(getRetrieval, embedManager),
      remote: remoteHealth.wrapRerank(
        createHttpRerankClient(async () => {
          const r = await getRerankSettings();
          return r.mode === 'remote' && r.baseUrl && r.model
            ? { baseUrl: r.baseUrl, model: r.model, apiKey: r.apiKey }
            : null;
        })
      )
    })
  });
  // Serve query embeddings to the stem-recall MCP server over a local unix
  // socket, so search_past_chats gets the same hybrid (semantic) retrieval as
  // auto-inject. Listen failures are logged and non-fatal (tool stays FTS-only).
  const embedEndpoint = startEmbedEndpoint({
    socketPath: embedSocketPath(),
    getClient: getEmbeddingsClient
  });
  host().onShutdown(() => {
    void embedEndpoint.close();
  });
  embedManager.onRerankStatus((status) => {
    deps.emit('reranker:localStatus', status);
    trackModelStatus('models.rerank', 'Preparing reranker model', status);
    logModelStatus('reranker', status);
  });
  embedManager.onStatus((status) => {
    deps.emit('embeddings:localStatus', status);
    trackModelStatus('models.embed', 'Preparing embedding model', status);
    logModelStatus('embeddings', status);
    // The model just came up: prune vectors from previously-used models (local
    // vectors are cheap to regenerate; keeps recall.sqlite tidy) and backfill any
    // facts missing a vector in the background. Without this, inject would embed
    // the entire fact set inline in the first semantic turn — many seconds on CPU.
    if (status.state !== 'ready') return;
    void (async () => {
      try {
        const retrieval = await getRetrieval();
        const e = retrieval.embeddings;
        if (e.mode !== 'local' || e.localModel !== status.model) return;
        const spec = resolveEmbedSpec(retrieval);
        // An imported model's dimension is not knowable from its folder, so it
        // is recorded from the load probe the first time the model comes up —
        // the only moment anything learns it.
        if (status.dim && isCustomModelId(spec.id) && spec.dim !== status.dim) {
          await saveCustomModel('embed', { ...spec, dim: status.dim });
        }
        const key = localModelCacheKey(spec);
        const factsGeneration = getFactsGeneration();
        pruneVectorsExceptModel(key);
        const missing = getFactsMissingVector(key);
        // Stepped, because after a model switch this is thousands of vectors and
        // the count is the only honest answer to "why is search worse right now".
        const factHandle = activity.begin('memory.factEmbed', 'Embedding facts', { stepped: true });
        let factsDone = 0;
        for (let i = 0; i < missing.length; i += 64) {
          if (getFactsGeneration() !== factsGeneration) break;
          const batch = missing.slice(i, i + 64);
          const vecs = await localEmbeddings.embed(
            batch.map((f) => f.text),
            'passage'
          );
          if (getFactsGeneration() !== factsGeneration) break;
          batch.forEach((f, j) =>
            upsertFactVectorForSnapshot(f.id, f.text, factsGeneration, key, vecs[j])
          );
          factsDone += batch.length;
          activity.progress(factHandle, { done: factsDone, total: missing.length });
        }
        activity.end(factHandle, {
          worked: factsDone > 0,
          detail: `Embedded ${factsDone.toLocaleString()} fact${factsDone === 1 ? '' : 's'}`
        });
        // Same hygiene + backfill for thread-summary vectors (Level 1.5 search).
        await backfillSummaryVectors(localEmbeddings, key);
        // Same hygiene + backfill for the episodic message vectors (semantic
        // episodic search). Watermark-driven and self-guarding, so a concurrent
        // post-turn kick can't double-embed.
        pruneMessageVectorsExceptModel(key);
        await activity.track(
          'memory.episodicEmbed',
          'Embedding messages',
          () => embedNewMessages(localEmbeddings),
          (n) => ({ worked: n > 0, detail: `Embedded ${n.toLocaleString()} message${n === 1 ? '' : 's'}` })
        );
        // Indexed connected folders: top up their doc vectors now that the
        // model is up (the scan pass is incremental and self-guarding).
        await scanAllIndexedFolders();
      } catch (error) {
        // non-fatal: inject tops up lazily on the next semantic turn. Recorded
        // so a backfill that never completes after a model switch is visible.
        activity.fail('memory.factEmbed', error, 'Embedding facts');
      }
    })();
  });
  // Kick the download/load shortly after launch (instead of on the first turn
  // that needs it) so the model is usually ready before the user accumulates
  // enough facts to matter. The delay only yields the window/backend startup
  // burst — keep it short, or the Manage panel shows a misleading idle state
  // ("not downloaded yet") on every restart until the kick lands. Skipped under
  // E2E: hermetic runs must not hit the network.
  if (!deps.e2e) {
    setTimeout(() => {
      void getRetrieval().then((r) => {
        if (r.embeddings.mode === 'local') embedManager.ensure(resolveEmbedSpec(r));
        if (r.reranker.mode === 'local') embedManager.ensureRerank(resolveRerankSpec(r));
      });
    }, 1_500);
  }
  return { embedManager, scanManager, remoteHealth };
}
