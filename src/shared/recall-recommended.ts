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
//
// 0.5.2 put Stem GTE Memory on top of that pair: a fact-and-skill model trained
// for CS/SK/DE/EN that beat the Qwen3 reranker gate on recall and speed in the
// same benches (docs/gte-memory-pilot.md). It needs the two Qwen3 models under
// it, so the recommendation is now all three, and the popup for 0.5.2 offers it
// to everyone whose reranker section predates the field.
//
// 0.6.0 swaps the embedder under it for EmbeddingGemma 2: on the same two real
// corpora, both ONNX q8 on transformers.js 4.3.1, it put 68–73% of the
// relevant facts into the reranker's top-24 pool against Qwen3's 38–39%, at
// about half the RAM (Stem mail "Gemma 2 vs Qwen3 Embedding Benchmark",
// 2026-10-09). GTE scores (query, fact) pairs on its own absolute floor, so it
// runs on either built-in embedder; a better pool is more for it to pick from.
// Any Qwen3 embedder — built-in or on the user's endpoint — now gets the offer.

export const RECOMMENDED_EMBED_MODEL = 'embeddinggemma-2';
/**
 * Built-in embedders Stem GTE Memory runs on: the recommendation, plus the
 * Qwen3 it was measured on, which keeps working for installs that stay on it.
 */
export const GTE_EMBED_MODELS: readonly string[] = [RECOMMENDED_EMBED_MODEL, 'qwen3-embedding-0.6b'];
export const RECOMMENDED_RERANK_MODEL = 'qwen3-reranker-0.6b';
export const RECOMMENDED_FACT_MODEL = 'gte-memory-20260905-epoch2';

/**
 * The release whose "what's new" popup carries the switch-to-recommended
 * callout. Compared against the popup's unseen list, so an install that
 * upgrades across it sees the offer exactly once, and one that declined is
 * not asked again by the next release.
 */
export const RECALL_DEFAULTS_RELEASE = '0.6.0';

export interface RecallSetupStatus {
  /** The bundled EmbeddingGemma 2. */
  embedOk: boolean;
  /** The bundled Qwen3 Reranker 0.6B. */
  rerankOk: boolean;
  /** Stem GTE Memory selected for facts and skills (only meaningful with rerankOk). */
  factOk: boolean;
}

export function recallSetupStatus(retrieval: RetrievalSettings): RecallSetupStatus {
  const e = retrieval.embeddings;
  const r = retrieval.reranker;
  return {
    embedOk: e.mode === 'local' && e.localModel === RECOMMENDED_EMBED_MODEL,
    rerankOk: r.mode === 'local' && r.localModel === RECOMMENDED_RERANK_MODEL,
    factOk: r.mode === 'local' && r.factModel === RECOMMENDED_FACT_MODEL
  };
}

/**
 * The settings patch that moves a setup onto the recommendation, touching only
 * the stage(s) that are not already there. Null when nothing needs to change.
 */
export function recommendedRetrievalPatch(retrieval: RetrievalSettings): PartialRetrievalSettings | null {
  const { embedOk, rerankOk, factOk } = recallSetupStatus(retrieval);
  if (embedOk && rerankOk && factOk) return null;
  const patch: PartialRetrievalSettings = {};
  if (!embedOk) patch.embeddings = { mode: 'local', localModel: RECOMMENDED_EMBED_MODEL };
  // GTE sits on the Qwen3 reranker, so the reranker stage is one patch either way.
  if (!rerankOk || !factOk) {
    patch.reranker = { mode: 'local', localModel: RECOMMENDED_RERANK_MODEL, factModel: RECOMMENDED_FACT_MODEL };
  }
  return patch;
}
