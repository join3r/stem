import { useState } from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import type { PartialRetrievalSettings, RetrievalSettings } from '../shared/types';
import { recallSetupStatus, recommendedRetrievalPatch } from '../shared/recall-recommended';

// The one-time offer inside the "what's new" popup for the release that changed
// the recall defaults. Fresh installs already get the Qwen3 models; an existing
// install keeps whatever it had stored, which is exactly the person this is for.
// Two buttons, because a recommendation with only an accept button reads as a
// demand: Switch applies the same settings write the Memory tab makes (models
// download in the background, facts re-index against the new embedder as recall
// runs), Keep leaves everything as it is and says so. Either way the popup's
// seen-marker means nobody is asked twice.

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
  const [state, setState] = useState<'offer' | 'applying' | 'done' | 'kept' | 'error'>('offer');
  const [error, setError] = useState<string | null>(null);
  const patch = recommendedRetrievalPatch(retrieval);
  if (!patch) return null;
  const both = Boolean(patch.embeddings && patch.reranker);
  const { embedRemoteQwen3 } = recallSetupStatus(retrieval);

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

  if (state === 'done') {
    return (
      <div className="callout callout-info release-notes-recommend" role="note" aria-label="Recommended memory setup">
        <p>
          <Check size={13} /> <strong>Switched.</strong> The {both ? 'models download' : 'model downloads'} in
          the background and your memory is re-indexed as it is used; Manage → Memory shows the progress,
          and recall keeps working on the old setup until the new one is ready.
        </p>
      </div>
    );
  }
  if (state === 'kept') {
    return (
      <div className="callout callout-info release-notes-recommend" role="note" aria-label="Recommended memory setup">
        <p>
          <Check size={13} /> <strong>Kept.</strong> Nothing changed. The switch is under Manage → Memory
          whenever you want it.
        </p>
      </div>
    );
  }
  return (
    <div className="callout callout-info release-notes-recommend" role="note" aria-label="Recommended memory setup">
      <p>
        <strong>Memory search has a new recommended setup.</strong> This version ships the Qwen3 Embedding
        0.6B and Qwen3 Reranker 0.6B models, which chose the right facts best in both of our measurements.
        Your Stem still uses {describe(retrieval)}, because an update never changes a setting you made.
        {embedRemoteQwen3 && (
          <>
            {' '}
            Your endpoint's Qwen3 measured the same as the built-in one, so this switch gains no quality; it
            stops memory search depending on that server, and re-indexes your memory once.
          </>
        )}
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
        <button className="push" onClick={() => setState('kept')} disabled={state === 'applying'}>
          Keep my current setup
        </button>
      </div>
    </div>
  );
}
