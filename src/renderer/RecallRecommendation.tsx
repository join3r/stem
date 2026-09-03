import { useState } from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import type { PartialRetrievalSettings, RetrievalSettings } from '../shared/types';
import { recallSetupStatus, recommendedRetrievalPatch } from '../shared/recall-recommended';

// The one-time offer inside the "what's new" popup for the release that changed
// the recall defaults. Fresh installs already get the Qwen3 models; an existing
// install keeps whatever it had stored, which is exactly the person this is for.
// Applying is the same settings write the Memory tab makes — the models download
// in the background and facts re-index against the new embedder as recall runs —
// so nothing here is a second path to the same state.

/** Human name for the stage a setup is running, for the "you have X" line. */
function describe(retrieval: RetrievalSettings): string {
  const { embedOk, rerankOk } = recallSetupStatus(retrieval);
  const parts: string[] = [];
  if (!embedOk) {
    const e = retrieval.embeddings;
    parts.push(
      e.mode === 'off'
        ? 'keyword-only ranking'
        : e.mode === 'remote'
          ? `the ${e.model || 'server'} embedder on your own endpoint`
          : `the ${e.localModel} embedder`
    );
  }
  if (!rerankOk) {
    const r = retrieval.reranker;
    parts.push(
      r.mode === 'off'
        ? 'no reranker'
        : r.mode === 'remote'
          ? `the ${r.model || 'server'} reranker on your own endpoint`
          : `the ${r.localModel} reranker`
    );
  }
  return parts.join(' and ');
}

export function RecallRecommendation({
  retrieval,
  onApply
}: {
  retrieval: RetrievalSettings;
  /** Persist the patch; resolves when the server has it. */
  onApply: (patch: PartialRetrievalSettings) => Promise<unknown>;
}) {
  const [state, setState] = useState<'offer' | 'applying' | 'done' | 'error'>('offer');
  const [error, setError] = useState<string | null>(null);
  const patch = recommendedRetrievalPatch(retrieval);
  if (!patch) return null;
  const both = Boolean(patch.embeddings && patch.reranker);

  async function apply() {
    if (!patch) return;
    setState('applying');
    try {
      await onApply(patch);
      setState('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  }

  return (
    <div className="callout callout-info release-notes-recommend" role="note" aria-label="Recommended memory setup">
      {state === 'done' ? (
        <p>
          <Check size={13} /> <strong>Switched.</strong> The {both ? 'models download' : 'model downloads'} in
          the background; Manage → Memory shows the progress, and recall keeps working on the old setup
          until it is ready.
        </p>
      ) : (
        <>
          <p>
            <strong>Memory search has a new recommended setup.</strong> This version ships the Qwen3
            Embedding 0.6B and Qwen3 Reranker 0.6B models, which chose the right facts best in both of
            our measurements. Your Stem still uses {describe(retrieval)}, because an update never
            changes a setting you made.
          </p>
          {state === 'error' && (
            <p className="retrieval-status-error">
              <TriangleAlert size={12} /> Could not switch: {error}. You can still change it under Manage →
              Memory.
            </p>
          )}
          <div className="push-row">
            <button className="push default" onClick={apply} disabled={state === 'applying'}>
              {state === 'applying' ? 'Switching…' : 'Switch to the recommended setup'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
