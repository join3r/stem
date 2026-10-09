import type { EmbedKind } from './embeddings';
import type {
  LocalEmbedModelId,
  LocalModelDtype,
  RetrievalSettings
} from '../../shared/types';

// Curated specs for the bundled local embedding backend. Pure data + string
// helpers (no Electron imports) so the catalog is unit-testable and shareable
// with the utility-process worker. Each entry is a known-good ONNX build on the
// Hugging Face hub, verified to download anonymously; dims and prompt prefixes
// come from the upstream model cards, so don't edit them independently.

export interface LocalEmbedModelSpec {
  /** A {@link LocalEmbedModelId}, or `custom:<repo>` for a model the user imported. */
  id: string;
  /** HF repo with transformers.js-compatible ONNX weights. */
  repo: string;
  /**
   * Vector dimension. Documentation, not a contract: the worker reports the real
   * one from its load probe and vectors carry their own, which is why an
   * imported model may sit here as null until it has loaded once.
   */
  dim: number | null;
  /** Quantization passed to transformers.js `dtype`. */
  dtype: LocalModelDtype;
  approxSizeMB: number;
  /** UI display name. */
  label: string;
  /** Training-time prompt prefixes; prepended verbatim per EmbedKind. */
  prefixes: Record<EmbedKind, string>;
  /**
   * How token states become one vector. Encoder models (e5, Gemma) mean-pool;
   * decoder-style embedders (Qwen3) read the last token, and mean-pooling them
   * yields vectors that load fine and rank wrong. 'sentence_embedding' is a
   * model that pools inside its own graph (EmbeddingGemma 2): the worker loads
   * it text-only and reads that output instead of running a pipeline.
   * Absent means 'mean'.
   */
  pooling?: 'mean' | 'last_token' | 'sentence_embedding';
  /**
   * Embed one text per forward pass. Set for exports whose fused attention
   * mis-attends across padding on the bundled runtime: a mixed-length batch of
   * Qwen3-Embedding-0.6B measured min cosine 0.90–0.92 against the same texts
   * embedded alone (recall-bench/bench2/cosine_scale.mjs, 2026-09-03). Same
   * class of bug as the reranker's one-pair-per-pass rule in embed-worker.ts.
   */
  unbatched?: boolean;
}

export const EMBED_CATALOG: Record<LocalEmbedModelId, LocalEmbedModelSpec> = {
  // Default since 2026-10-09 (0.6.0). Measured 2026-10-09 against Qwen3 0.6B,
  // both ONNX q8 on transformers.js 4.3.1, same Mac and threads (Stem mail
  // "Gemma 2 vs Qwen3 Embedding Benchmark", report in the task's
  // files/embedding-onnx-q8-20261009/): relevant facts in the top-24 pool
  // 67.8% vs 39.0% on bench #1 and 73.5% vs 38.3% on bench #2, about half the
  // peak RAM (1.27 vs 2.81 GB), and batched vectors identical to single ones,
  // so it batches where Qwen3 cannot. Text-only: the same checkpoint carries
  // vision/audio encoders that produced bit-identical text vectors and twice
  // the memory, so the worker drops them. Its cosines sit on their own scale
  // (embed-scale.ts). Needs transformers.js 4.3+ (EmbeddingGemma2Model).
  'embeddinggemma-2': {
    id: 'embeddinggemma-2',
    repo: 'onnx-community/embeddinggemma-2-ONNX',
    dim: 768,
    dtype: 'q8',
    approxSizeMB: 315,
    label: 'EmbeddingGemma 2',
    // Model card's retrieval prompts, the ones the benchmark used.
    prefixes: { query: 'task: search result | query: ', passage: 'title: none | text: ' },
    pooling: 'sentence_embedding'
  },
  // Default 2026-09-03 → 2026-10-09. Measured on both recall benches (recall-bench/
  // README + bench2/README): tied or edged the qwen3-embedding:4b Ollama
  // sidecar end-to-end with either reranker (bench #1 F1 0.26 vs 0.26, bench #2
  // 0.23 vs 0.21) at a quarter of the weights, and beat every e5/Gemma bundled
  // model. Its cosines sit on a different scale from e5 — see embed-scale.ts,
  // which is why switching embedders is more than changing this id.
  'qwen3-embedding-0.6b': {
    id: 'qwen3-embedding-0.6b',
    repo: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    dim: 1024,
    dtype: 'q8',
    approxSizeMB: 640,
    label: 'Qwen3 Embedding 0.6B',
    // Model card: queries carry a one-line task instruction, documents none.
    // The task wording is the one the benches were measured with; rewording it
    // moves the cosine scale the floors in embed-scale.ts are calibrated on.
    prefixes: {
      query:
        'Instruct: Given a user message to a personal assistant, retrieve stored facts about the user that are relevant to answering it\nQuery:',
      passage: ''
    },
    pooling: 'last_token',
    unbatched: true
  },
  'multilingual-e5-small': {
    id: 'multilingual-e5-small',
    repo: 'Xenova/multilingual-e5-small',
    dim: 384,
    dtype: 'q8',
    approxSizeMB: 120,
    label: 'Multilingual E5 Small',
    prefixes: { query: 'query: ', passage: 'passage: ' }
  }
};

export const DEFAULT_LOCAL_EMBED_MODEL: LocalEmbedModelId = 'embeddinggemma-2';

/**
 * The spec for whichever local embedder the settings select — a curated entry or
 * one synthesised when the user imported weights Stem has no entry for.
 *
 * Every call site goes through this rather than indexing EMBED_CATALOG directly:
 * a bare lookup returns `undefined` for a custom id, which type-checks (the
 * settings field is a plain string) and then fails somewhere far from here.
 * Takes the whole retrieval config because the selection and the list of custom
 * models are two halves of one answer, and pairing the wrong ones is the bug
 * this signature makes unrepresentable.
 */
export function resolveEmbedSpec(r: RetrievalSettings): LocalEmbedModelSpec {
  const catalog = EMBED_CATALOG[r.embeddings.localModel as LocalEmbedModelId];
  if (catalog) return catalog;
  // A CustomEmbedModel IS a spec — this assignment is what keeps the two shapes
  // in step, since the worker is handed it verbatim.
  const custom: LocalEmbedModelSpec | undefined = r.customEmbedModels.find(
    (m) => m.id === r.embeddings.localModel
  );
  // Only reachable if an entry vanished between two reads; coercion guarantees
  // the id is one of the two sets, and removal refuses while it is selected.
  return custom ?? EMBED_CATALOG[DEFAULT_LOCAL_EMBED_MODEL];
}

/** Whether `id` names an imported model rather than a catalog one. */
export function isCustomModelId(id: string): boolean {
  return id.startsWith('custom:');
}

/** The settings id for an imported model, namespaced so it can't collide with a catalog id. */
export function customModelId(repo: string): string {
  return `custom:${repo}`;
}

/**
 * Vector-cache key for a local model. The `local:` namespace keeps it disjoint
 * from the bare model ids the removed own-server mode keyed vectors under, so
 * a stale one can never be silently reused for a different model.
 */
export function localModelCacheKey(spec: LocalEmbedModelSpec): string {
  return `local:${spec.repo}`;
}

/** Prepend the model's training-time prefix for this kind to every text. */
export function applyPrefixes(spec: LocalEmbedModelSpec, kind: EmbedKind, texts: string[]): string[] {
  const prefix = spec.prefixes[kind];
  return texts.map((t) => prefix + t);
}

/**
 * The model id that keys the vector cache under the current settings: the local
 * cache key, or '' when embeddings are off.
 */
export function effectiveEmbedModelKey(r: RetrievalSettings): string {
  return r.embeddings.mode === 'local' ? localModelCacheKey(resolveEmbedSpec(r)) : '';
}
