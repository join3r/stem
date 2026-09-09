import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { FactRerankStatus, RetrievalSettings } from '../../shared/types';
import type { EmbedWorkerManager } from './embed-manager';
import type { FactRerankClient } from './retrieval';
import type { LocalRerankModelSpec } from './rerank-catalog';
import { RerankUnavailableError } from './rerank';
import { formatFactQuery } from './fact-query';

import { GTE_FACT_PILOT_ID, GTE_FACT_PILOT_FILES } from './gte-model-artifact';
export { GTE_FACT_PILOT_ID, GTE_FACT_PILOT_FILES } from './gte-model-artifact';

export const GTE_FACT_PILOT_FLOOR = -1.6370911598205566;
// Frozen by the separate skill-selection evaluation; do not use the fact floor.
export const GTE_SKILL_FLOOR = -3.9743599891662598;

export async function verifyGteFactModel(directory: string): Promise<void> {
  if (!isAbsolute(directory)) throw new Error('The GTE fact model directory must be absolute');
  for (const [file, expected] of Object.entries(GTE_FACT_PILOT_FILES)) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(directory, file))) hash.update(chunk);
    if (hash.digest('hex') !== expected) throw new Error(`GTE fact model does not match the measured pilot: ${file}`);
  }
}

/** The installed files never override an explicit dropdown choice. */
export function gteFactPilotEligible(r: RetrievalSettings): boolean {
  return r.reranker.factModel === GTE_FACT_PILOT_ID
    && r.embeddings.mode === 'local' && r.embeddings.localModel === 'qwen3-embedding-0.6b'
    && r.reranker.mode === 'local' && r.reranker.localModel === 'qwen3-reranker-0.6b';
}

export function createGteFactPilot(deps: {
  directory: string;
  manager: EmbedWorkerManager;
  getSettings: () => Promise<RetrievalSettings>;
  onFailure: (error: unknown) => void;
  /** Managed installations fetch the pinned release only while the settings select it. */
  prepare?: (directory: string, options: { signal: AbortSignal; onProgress: (percent: number) => void }) => Promise<void>;
  onProgress?: () => void;
  /** Test seam; production always verifies the pinned files above. */
  verify?: (directory: string) => Promise<void>;
}): { start(): void; retry(): void; resolve(): Promise<FactRerankClient | null>; status(): Promise<FactRerankStatus>; dispose(): void } {
  let started = false;
  let verified = false;
  let disposed = false;
  let verificationError: string | undefined;
  let preparation: AbortController | undefined;
  let progressPct: number | undefined;
  let generation = 0;
  let retryWorker = false;
  const spec: LocalRerankModelSpec = {
    id: GTE_FACT_PILOT_ID,
    repo: GTE_FACT_PILOT_ID,
    localPath: deps.directory,
    dtype: 'q8',
    approxSizeMB: 342,
    label: 'Stem GTE Memory',
    scoring: 'gte-scalar',
    minRelevantScore: GTE_SKILL_FLOOR,
    factGateScore: GTE_FACT_PILOT_FLOOR
  };
  const ready = () => {
    const s = deps.manager.rerankStatus();
    return !disposed && verified && s.model === spec.id && s.state === 'ready';
  };
  const client: FactRerankClient = {
    modelId: spec.id,
    factQuery: formatFactQuery,
    maxFacts: 16,
    async available() { return ready(); },
    async minRelevantScore() { return ready() ? spec.minRelevantScore : null; },
    async factGateScore() { return ready() ? spec.factGateScore : null; },
    async rerank(query, docs, topN) {
      if (!ready()) throw new RerankUnavailableError('GTE fact model is not ready');
      return docs.length ? deps.manager.rerank(query, docs, topN) : [];
    }
  };
  function start(): void {
    if (started || disposed) return;
    started = true;
    const run = ++generation;
    const controller = new AbortController();
    preparation = controller;
    const active = () => !disposed && run === generation;
    void (async () => {
      if (deps.prepare) {
        const eligible = gteFactPilotEligible(await deps.getSettings());
        if (!active()) return;
        if (!eligible) { started = false; preparation = undefined; return; }
        await deps.prepare(deps.directory, {
          signal: controller.signal,
          onProgress(percent) {
            if (!active()) return;
            progressPct = percent;
            deps.onProgress?.();
          }
        });
      }
      if (!active()) return;
      await (deps.verify ?? verifyGteFactModel)(deps.directory);
      if (!active()) return;
      verified = true;
      preparation = undefined;
      progressPct = undefined;
      const eligible = gteFactPilotEligible(await deps.getSettings());
      if (active() && eligible) deps.manager.ensureRerank(spec);
    })().catch((error) => {
      // quiet: active failures go to onFailure (log/activity/UI); cancelled generations no longer own the selection.
      if (active()) {
        preparation = undefined;
        progressPct = undefined;
        verificationError = error instanceof Error ? error.message : String(error);
        deps.onFailure(error);
      }
    });
  }
  async function resolve(): Promise<FactRerankClient | null> {
    if (disposed) return null;
    const eligible = gteFactPilotEligible(await deps.getSettings());
    if (disposed) return null;
    if (!eligible) {
      retryWorker = false;
      if (deps.prepare && !verified && started) {
        ++generation;
        preparation?.abort();
        preparation = undefined;
        progressPct = undefined;
        verificationError = undefined;
        started = false;
      }
      if (deps.manager.rerankStatus().state !== 'idle') deps.manager.reconfigureRerank(null);
      return null;
    }
    start();
    if (!verified) return null;
    if (retryWorker) {
      retryWorker = false;
      deps.manager.ensureRerank(spec, { force: true });
    } else deps.manager.ensureRerank(spec);
    return ready() ? client : null;
  }
  return {
    start,
    retry() {
      if (disposed) return;
      if (verified && deps.manager.rerankStatus().state === 'error') retryWorker = true;
      if (!verificationError) return;
      verificationError = undefined;
      started = false;
      start();
    },
    resolve,
    async status() {
      await resolve();
      const settings = await deps.getSettings();
      const selected = settings.reranker.mode === 'local' && settings.reranker.factModel === spec.id;
      const availability = deps.prepare
        ? { installed: !disposed && verified, downloadable: !disposed }
        : { installed: !disposed };
      if (disposed || !selected) return { ...availability, status: { model: spec.id, state: 'idle' } };
      const error = !gteFactPilotEligible(settings)
        ? 'Stem GTE Memory requires built-in Qwen3 Embedding and a compatible reranker configuration.' : verificationError;
      return {
        ...availability,
        status: error ? { model: spec.id, state: 'error', error }
          : progressPct !== undefined ? { model: spec.id, state: 'downloading', progressPct }
          : !verified ? { model: spec.id, state: 'loading' }
            : { ...deps.manager.rerankStatus(), model: spec.id }
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ++generation;
      preparation?.abort();
      deps.manager.dispose();
    }
  };
}
