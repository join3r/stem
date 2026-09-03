import type { PartialRetrievalSettings, RetrievalSettings } from './types';

// The measured-best recall setup, as one answer both the Memory tab's "Recall
// quality" row and the post-update recommendation read from. The evidence is
// recall-bench/ (two gold sets, 60 and 77 hand-adjudicated real turns; kept
// outside the repo): a Qwen3 embedder feeding the Qwen3 reranker gate beat the
// E5/Gemma embedders, every cosine gate, deeper pools and an external memory
// system. The bundled 0.6B tied the 4B Qwen3 served via Ollama on both benches,
// so the recommendation names the built-in model and nothing external — a
// server endpoint is for people who already run one, not a quality upgrade.

export const RECOMMENDED_EMBED_MODEL = 'qwen3-embedding-0.6b';
export const RECOMMENDED_RERANK_MODEL = 'qwen3-reranker-0.6b';

/**
 * The release whose "what's new" popup carries the switch-to-recommended
 * callout. Compared against the popup's unseen list, so an install that
 * upgrades across it sees the offer exactly once, and one that declined is
 * not asked again by the next release.
 */
export const RECALL_DEFAULTS_RELEASE = '0.5.0';

export interface RecallSetupStatus {
  /** A Qwen3 embedder — the bundled one, or a qwen3-embedding model on the user's own endpoint (they tied). */
  embedOk: boolean;
  /** The Qwen3 reranker, bundled or on the user's own endpoint. */
  rerankOk: boolean;
}

export function recallSetupStatus(retrieval: RetrievalSettings): RecallSetupStatus {
  const e = retrieval.embeddings;
  const r = retrieval.reranker;
  return {
    embedOk:
      (e.mode === 'local' && e.localModel === RECOMMENDED_EMBED_MODEL) ||
      (e.mode === 'remote' && /qwen3-embedding/i.test(e.model ?? '')),
    rerankOk:
      (r.mode === 'local' && r.localModel === RECOMMENDED_RERANK_MODEL) ||
      (r.mode === 'remote' && /qwen3-reranker/i.test(r.model ?? ''))
  };
}

/**
 * The settings patch that moves a setup onto the recommendation, touching only
 * the stage(s) that are not already there — a remote Qwen3 embedder is left
 * alone rather than re-embedding every fact for no measured gain. Null when
 * nothing needs to change.
 */
export function recommendedRetrievalPatch(retrieval: RetrievalSettings): PartialRetrievalSettings | null {
  const { embedOk, rerankOk } = recallSetupStatus(retrieval);
  if (embedOk && rerankOk) return null;
  const patch: PartialRetrievalSettings = {};
  if (!embedOk) patch.embeddings = { mode: 'local', localModel: RECOMMENDED_EMBED_MODEL };
  if (!rerankOk) patch.reranker = { mode: 'local', localModel: RECOMMENDED_RERANK_MODEL };
  return patch;
}
