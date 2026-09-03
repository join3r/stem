// Absolute cosine floors, per embedder family. A cosine is not a probability:
// the same "0.82" is a near-verbatim match for one model and unreachable for
// another. Every floor below was originally calibrated for the e5 family
// ("e5 squashes into [0.7, 1.0]", search-core.ts), and applying those numbers to
// Qwen3 vectors silently killed whole retrieval legs — first the fact-injection
// semantic tier (recall-bench/, 2026-08-13), then, unnoticed until the embedder
// became the default, the episodic message/summary/doc legs and search_facts.
//
// The Qwen3 column is a MEASURED translation, not a guess: on the bench #2
// corpus (recall-bench/bench2/cosine_scale.mjs, 2026-09-03) both models
// embedded the same 77 turn queries against the same facts, user messages and
// summaries, and each e5 floor was mapped to the Qwen3 cosine that passes the
// same share of pairs (quantile matching). 0.6B (bundled) and 4b (Ollama) landed
// within 0.05 of each other on every floor, so they share one profile:
//
//                 e5 floor   pass rate   Qwen3-0.6B   qwen3:4b   shipped
//   message         0.82      36.6%        0.373       0.363      0.37
//   summary/doc     0.78      55.6%        0.285       0.235      0.26
//   factSearch      0.72      98.0%        0.195       0.163      0.18
//   strongRaw       0.88       1.6%        0.526       0.539      0.53
//   coinject        0.60     100.0%        0.115       0.095      0.10
//
// Every gold-relevant (turn, fact) pair in the bench clears the factSearch
// floor under both models (min 0.31 / 0.35 vs 0.18). The pass rates also say
// something uncomfortable about the e5 floors themselves — factSearch and
// coinject pass nearly everything — but re-tuning selectivity is a separate,
// benchmarked decision; this file only keeps behaviour constant across an
// embedder swap. The meta-table tunables (readMinCosine) still override.
// Pure data + one string test; no imports so both worker and main can share it.

export type CosineScale = 'e5' | 'qwen3';

export interface CosineFloors {
  /** Episodic message hits (hybridSearchMessages semantic leg). */
  message: number;
  /** Thread-summary hits; long multi-topic passages score lower than messages. */
  summary: number;
  /** Connected-folder document hits; embedded like summaries (title + lead). */
  doc: number;
  /** Explicit search_facts semantic leg: below it a hit is just the nearest fact. */
  factSearch: number;
  /** A raw user message strong enough to ride alongside a summary of its thread. */
  strongRaw: number;
  /** Two chosen facts close enough to be about the same subject (relation sweep). */
  coinject: number;
}

export const COSINE_FLOORS: Record<CosineScale, CosineFloors> = {
  e5: { message: 0.82, summary: 0.78, doc: 0.78, factSearch: 0.72, strongRaw: 0.88, coinject: 0.6 },
  qwen3: { message: 0.37, summary: 0.26, doc: 0.26, factSearch: 0.18, strongRaw: 0.53, coinject: 0.1 }
};

/**
 * Which scale a vector-cache model key lives on. Keys are `local:<hf repo>` for
 * bundled/imported models and the bare model name for a server endpoint, so one
 * substring test covers `local:onnx-community/Qwen3-Embedding-0.6B-ONNX`,
 * `qwen3-embedding:4b` and an imported Qwen3 export alike. Everything else —
 * e5, Gemma, bge, unknown — keeps the e5 numbers, which is the pre-existing
 * behaviour, not a claim that they fit.
 */
export function cosineScaleFor(modelKey: string): CosineScale {
  return /qwen3/i.test(modelKey) ? 'qwen3' : 'e5';
}

/** The floors for the embedder behind `modelKey`. */
export function cosineFloorsFor(modelKey: string): CosineFloors {
  return COSINE_FLOORS[cosineScaleFor(modelKey)];
}
