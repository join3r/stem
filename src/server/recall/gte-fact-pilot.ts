import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { FactRerankStatus, RetrievalSettings } from '../../shared/types';
import type { EmbedWorkerManager } from './embed-manager';
import type { FactRerankClient } from './retrieval';
import type { LocalRerankModelSpec } from './rerank-catalog';
import { RerankUnavailableError } from './rerank';
import { formatFactQuery } from './fact-query';
import { GTE_EMBED_MODELS, usesGteMemory } from '../../shared/recall-recommended';

import { GTE_FACT_PILOT_ID, GTE_FACT_PILOT_FILES } from './gte-model-artifact';
export { GTE_FACT_PILOT_ID, GTE_FACT_PILOT_FILES } from './gte-model-artifact';

// Unchanged by the 20261021 release: its training held fact scores to epoch2,
// and at this floor its fact benchmarks matched epoch2's within a few percent.
export const GTE_FACT_PILOT_FLOOR = -1.6370911598205566;
// The skill floors belong to the 20261021 weights (gte-model-artifact.ts) and
// were measured on 815 real turns that training never saw
// (recall-bench/gte-skill-train-20261010, gold-v3, production query and
// shortlist), scored both on macOS and in the Linux server image: the q8 graph's
// logits differ between the two by up to several points on some pairs (epoch2
// as much), so each floor sits where both platforms agree.
//
// Lowered 2026-11-06 because a wrong load turned out to be cheap. Judging 100 real
// VPS turns that inlined a skill: the model followed 13 of 14 fitting skills and
// acted on none of the 71 that did not fit. So a wrong load costs ~700 tokens,
// not a wrong action, and the floors now buy recall at about one wrong-load turn
// in nine instead of one in fifty. Linux only; macOS was not re-scored.
// A skill without example requests is scored on its description alone:
// Linux 42/81 needed skills served with 76 wrong-load turns (was −3.25: 36 with 21).
export const GTE_SKILL_FLOOR = -4.5;
// A skill with example requests is scored as the best of its description and
// each example (skills/examples.ts). Linux 51/81 served with 89 wrong-load
// turns (was −0.5: 44 with 17; −4.5 would serve 55 with 178). Raising the inline
// cap from 2 to 3 or 4 served one more turn at most, so it stays at 2.
export const GTE_SKILL_EXAMPLE_FLOOR = -3.5;

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
  return usesGteMemory(r)
    && r.embeddings.mode === 'local' && GTE_EMBED_MODELS.includes(r.embeddings.localModel);
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
    async skillExampleFloor() { return ready() ? GTE_SKILL_EXAMPLE_FLOOR : null; },
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
        ? 'Stem GTE Memory requires built-in EmbeddingGemma 2 or Qwen3 Embedding 0.6B.' : verificationError;
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
