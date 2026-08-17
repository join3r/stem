import { registerServer } from './guard';
import type { IpcDeps } from './deps';
import {
  addMemoryNote,
  clearEpisodicMemory,
  clearFactsMemory,
  forgetFact,
  getMemorySettings,
  listThreadSummaries,
  readMemoryFiles,
  removeThreadSummary,
  setEpisodicLimit,
  setMaxRelevantFactCount,
  setMemoryEnabled,
  setTidyUpThreshold
} from '../workspace/memory';

import {
  getMemoryRebuildStatus,
  pauseMemoryRebuild,
  resumeMemoryRebuild,
  startMemoryRebuild
} from '../recall/rebuild';
import { previewFacts } from '../recall/inject';
import { consolidateFacts } from '../recall/consolidate';
import { processExplicitNote } from '../recall/note';
import { DEFAULT_LOCAL_EMBED_MODEL, EMBED_CATALOG, resolveEmbedSpec } from '../recall/embed-catalog';
import { importCustomModel, importLocalModels } from '../recall/embed-import';
import { embedModelsDir } from '../workspace/paths';
import { DEFAULT_LOCAL_RERANK_MODEL, RERANK_CATALOG, resolveRerankSpec } from '../recall/rerank-catalog';
import {
  coerceCustomModel,
  memoryRunOf,
  readSettings,
  removeCustomModel,
  saveCustomModel,
  UNUSABLE_MODEL_ERROR
} from '../workspace/settings';
import type { LlmClient } from '../recall/llm';
import type {
  ActiveFacts,
  ConflictResolution,
  CustomEmbedModel,
  CustomModelResult,
  CustomRerankModel,
  ImportModelResult,
  LocalEmbedStatus,
  LocalRerankStatus,
  RemoteRetrievalHealth
} from '../../shared/types';
import { recallStore } from '../recall/store';
import * as activity from '../activity';
const { getAutoResolvedConflicts, getEpisodicStats, getActiveFactIds, getFactsByIds, getFactDetails, getMemoryConflicts, setFactPinned: storeSetFactPinned, confirmFact: storeConfirmFact, resolveMemoryConflict: storeResolveMemoryConflict, restoreSupersededFact: storeRestoreSupersededFact } = recallStore;

/** The Memory tab's surface: facts, episodic store, rebuild, and retrieval status. */
export function registerMemoryIpc(deps: IpcDeps): void {
  registerServer('memory:get', () => getMemorySettings());
  registerServer('memory:setEnabled', async (_e, enabled: boolean) => {
    const settings = await setMemoryEnabled(enabled);
    // Restart applies the recall-MCP change to the live backend (no-op on the fake).
    await deps.runtime().restart();
    return settings;
  });
  registerServer('memory:read', () => readMemoryFiles());
  registerServer('memory:addNote', async (_e, text: string) => {
    const result = await addMemoryNote(String(text ?? ''));
    if (result.saved && result.factId != null) {
      // Canonicalize + reconcile off the acknowledgement path (same hidden
      // one-shot seam as distillation); the raw note is already durable.
      const llm: LlmClient = {
        complete: async (prompt) =>
          deps.runtime().complete(prompt, await memoryRunOf((s) => s.memory.model))
      };
      const factId = result.factId;
      setTimeout(() => void processExplicitNote(factId, llm), 0);
    }
    return result;
  });
  registerServer('memory:forget', async (_e, id: number) => {
    await forgetFact(id);
    return readMemoryFiles();
  });
  registerServer('memory:setPinned', async (_e, id: number, pinned: boolean) => {
    storeSetFactPinned(id, pinned);
    return readMemoryFiles();
  });
  registerServer('memory:confirmFact', async (_e, id: number) => {
    storeConfirmFact(id);
    return readMemoryFiles();
  });
  registerServer('memory:factDetails', (_e, id: number) => getFactDetails(id));
  registerServer('memory:conflicts', () => getMemoryConflicts());
  registerServer('memory:autoResolvedConflicts', () => getAutoResolvedConflicts());
  registerServer('memory:resolveConflict', async (_e, id: number, resolution: ConflictResolution) => {
    storeResolveMemoryConflict(id, resolution);
    return readMemoryFiles();
  });
  registerServer('memory:restoreFact', async (_e, id: number) => {
    storeRestoreSupersededFact(id);
    return readMemoryFiles();
  });
  registerServer('memory:rebuildStatus', () => getMemoryRebuildStatus());
  registerServer('memory:startRebuild', () => {
    const status = startMemoryRebuild();
    deps.scheduleMemoryRebuild();
    return status;
  });
  registerServer('memory:pauseRebuild', () => pauseMemoryRebuild());
  registerServer('memory:resumeRebuild', () => {
    const status = resumeMemoryRebuild();
    deps.scheduleMemoryRebuild();
    return status;
  });
  registerServer('memory:resetFacts', () => clearFactsMemory());
  registerServer('memory:resetEpisodic', () => clearEpisodicMemory());
  registerServer('memory:episodicStats', () => getEpisodicStats());
  registerServer('memory:summaries', () => listThreadSummaries());
  registerServer('memory:deleteSummary', (_e, id: number) => removeThreadSummary(id));
  // Background-activity feed for the toolbar indicator. Read-only: the snapshot
  // and a "panel opened" acknowledgement that clears the sticky failure marker.
  registerServer('activity:snapshot', () => activity.snapshot());
  registerServer('activity:markSeen', () => activity.markSeen());
  registerServer('embeddings:localStatus', async (): Promise<LocalEmbedStatus> => {
    // Opening the panel doubles as a kick (idempotent while healthy), so someone
    // who goes straight to Memory → advanced right after launch sees the worker
    // start immediately instead of an idle state until the startup timer lands.
    const retrieval = (await readSettings()).retrieval;
    if (!deps.e2e && retrieval.embeddings.mode === 'local') {
      deps.embedManager()?.ensure(resolveEmbedSpec(retrieval));
    }
    return deps.embedManager()?.status() ?? { model: DEFAULT_LOCAL_EMBED_MODEL, state: 'idle' };
  });
  registerServer('reranker:localStatus', async (): Promise<LocalRerankStatus> => {
    // Same panel-open kick as embeddings:localStatus, for the reranker model.
    const retrieval = (await readSettings()).retrieval;
    if (!deps.e2e && retrieval.reranker.mode === 'local') {
      deps.embedManager()?.ensureRerank(resolveRerankSpec(retrieval));
    }
    return deps.embedManager()?.rerankStatus() ?? { model: DEFAULT_LOCAL_RERANK_MODEL, state: 'idle' };
  });
  /**
   * Weights the user brought themselves, from a folder on the machine Stem runs
   * on. Stem never ships or downloads them on that machine's behalf — this is
   * the whole offline story, so a refusal has to say what is wrong by name.
   */
  registerServer('models:import', async (_e, dir: string): Promise<ImportModelResult> => {
    const result = importLocalModels(String(dir ?? ''), embedModelsDir());
    if (!result.ok) return result;
    // Load what just arrived: force past the 5-minute error backoff, since the
    // reason it is in error is exactly the thing this call fixed.
    const settings = await readSettings();
    for (const model of result.models) {
      if (model.stage === 'embed' && settings.retrieval.embeddings.localModel === model.id) {
        deps.embedManager()?.ensure(EMBED_CATALOG[model.id as keyof typeof EMBED_CATALOG], { force: true });
      }
      if (model.stage === 'rerank' && settings.retrieval.reranker.localModel === model.id) {
        deps.embedManager()?.ensureRerank(RERANK_CATALOG[model.id as keyof typeof RERANK_CATALOG], { force: true });
      }
    }
    return result;
  });
  /**
   * The other half of import: a model no catalog entry matches, brought in with
   * the description the dialog assembled — what the folder said (repo,
   * quantization, size) plus the handful of answers a directory listing cannot
   * give. Files first, entry second, so a folder that turns out to be
   * incomplete never leaves behind a name for a model that cannot load.
   *
   * Deliberately does NOT select the model. Import is "this now exists"; making
   * it the active one is a separate click, and re-embedding the whole fact store
   * is not something to do to somebody who was only copying files in.
   */
  registerServer(
    'models:importCustom',
    async (
      _e,
      dir: string,
      stage: 'embed' | 'rerank',
      model: CustomEmbedModel | CustomRerankModel
    ): Promise<CustomModelResult> => {
      const described = coerceCustomModel(stage, model);
      if (!described) return { ok: false, error: UNUSABLE_MODEL_ERROR };
      const copied = importCustomModel(String(dir ?? ''), described.repo, described.dtype, embedModelsDir());
      if (!copied.ok) return copied;
      return saveCustomModel(stage, described);
    }
  );
  /** Edits to an imported model's description; its files are already in place. */
  registerServer(
    'models:saveCustom',
    (_e, stage: 'embed' | 'rerank', model: CustomEmbedModel | CustomRerankModel): Promise<CustomModelResult> =>
      saveCustomModel(stage, model)
  );
  /** Forget an imported model. The weights stay on disk — see removeCustomModel. */
  registerServer(
    'models:removeCustom',
    (_e, stage: 'embed' | 'rerank', id: string): Promise<CustomModelResult> =>
      removeCustomModel(stage, String(id ?? ''))
  );
  registerServer(
    'retrieval:remoteHealth',
    (): RemoteRetrievalHealth =>
      deps.remoteHealth()?.get() ?? { embeddings: { state: 'unknown' }, reranker: { state: 'unknown' } }
  );
  registerServer('memory:activeFacts', (_e, threadId: string | null): ActiveFacts | null => {
    if (!threadId) return null;
    const rec = getActiveFactIds(threadId);
    if (!rec) return null;
    const facts = getFactsByIds(rec.factIds).map((f) => ({
      id: f.id,
      text: f.text,
      source: f.source,
      sensitivity: f.sensitivity,
      reason: rec.reasons[f.id] ?? f.selectionReason,
      // What the model was told on THAT turn, not what the fact looks like now:
      // a conflict raised since would otherwise backdate itself onto a turn that
      // saw the fact as settled, and one resolved since would erase a label the
      // turn really carried. Rows written before the flag existed have no
      // recorded answer, so they fall back to the old current-status guess.
      ...((rec.disputed[f.id] ?? (f.status === 'conflicted')) ? { disputed: true } : {})
    }));
    return { facts, tier: rec.tier };
  });
  registerServer('memory:previewFacts', async (_e, text: string): Promise<ActiveFacts> => {
    const { facts, tier } = await previewFacts(text ?? '');
    return { facts: facts.map((f) => ({
      id: f.id,
      text: f.text,
      source: f.source,
      sensitivity: f.sensitivity,
      reason: f.selectionReason,
      ...(f.disputed ? { disputed: true } : {})
    })), tier };
  });
  registerServer('memory:setEpisodicLimit', (_e, bytes: number) => setEpisodicLimit(bytes));
  registerServer('memory:setTidyThreshold', (_e, n: number) => setTidyUpThreshold(n));
  registerServer('memory:setMaxRelevantFacts', (_e, n: number) => setMaxRelevantFactCount(n));
  registerServer('memory:consolidate', async () => {
    // Same hidden one-shot seam distillation uses; `force` bypasses the size floor
    // so a manual run always executes.
    const llm: LlmClient = {
      complete: async (prompt) =>
        deps.runtime().complete(prompt, await memoryRunOf((s) => s.memory.model))
    };
    const result = await consolidateFacts(llm, { force: true });
    return { ...result, contents: await readMemoryFiles() };
  });
}
