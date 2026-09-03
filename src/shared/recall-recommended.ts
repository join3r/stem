import type { PartialRetrievalSettings, RetrievalSettings } from './types';

// The measured-best recall setup, as one answer both the Memory tab's "Recall
// quality" row and the post-update recommendation read from. The evidence is
// recall-bench/ (two gold sets, 60 and 77 hand-adjudicated real turns; kept
// outside the repo): a Qwen3 embedder feeding the Qwen3 reranker gate beat the
// E5/Gemma embedders, every cosine gate, deeper pools and an external memory
// system. The bundled 0.6B tied the 4B Qwen3 served via Ollama on both benches,
// so the recommendation is the two built-in models and nothing external: a
// server endpoint buys no quality, and it is one more thing that can be down.
// Anything else — including a Qwen3 on the user's own endpoint — gets the offer,
// with the wording telling a remote-Qwen3 user that quality stays the same.

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
  /** The bundled Qwen3 Embedding 0.6B. */
  embedOk: boolean;
  /** The bundled Qwen3 Reranker 0.6B. */
  rerankOk: boolean;
  /**
   * A qwen3-embedding model on the user's own endpoint. Not the recommendation
   * (it needs a server the built-in one does not), but it measured the same, so
   * the offer and the row say "same quality", not "better".
   */
  embedRemoteQwen3: boolean;
}

export function recallSetupStatus(retrieval: RetrievalSettings): RecallSetupStatus {
  const e = retrieval.embeddings;
  const r = retrieval.reranker;
  return {
    embedOk: e.mode === 'local' && e.localModel === RECOMMENDED_EMBED_MODEL,
    rerankOk: r.mode === 'local' && r.localModel === RECOMMENDED_RERANK_MODEL,
    embedRemoteQwen3: e.mode === 'remote' && /qwen3-embedding/i.test(e.model ?? '')
  };
}

/**
 * The settings patch that moves a setup onto the recommendation, touching only
 * the stage(s) that are not already there. Null when nothing needs to change.
 */
export function recommendedRetrievalPatch(retrieval: RetrievalSettings): PartialRetrievalSettings | null {
  const { embedOk, rerankOk } = recallSetupStatus(retrieval);
  if (embedOk && rerankOk) return null;
  const patch: PartialRetrievalSettings = {};
  if (!embedOk) patch.embeddings = { mode: 'local', localModel: RECOMMENDED_EMBED_MODEL };
  if (!rerankOk) patch.reranker = { mode: 'local', localModel: RECOMMENDED_RERANK_MODEL };
  return patch;
}
