import type { LocalModelDtype, LocalRerankModelId, RetrievalSettings } from '../../shared/types';

// Curated specs for the bundled local reranker (cross-encoder) backend. Pure
// data (no Electron imports) so it's unit-testable and shareable with the
// utility-process worker, mirroring embed-catalog.ts. Each entry is a known-good
// ONNX build on the Hugging Face hub with a transformers.js-standard layout.

export interface LocalRerankModelSpec {
  /** A {@link LocalRerankModelId}, or `custom:<repo>` for a model the user imported. */
  id: string;
  /** HF repo with transformers.js-compatible ONNX weights. */
  repo: string;
  /** Quantization passed to transformers.js `dtype`. */
  dtype: LocalModelDtype;
  approxSizeMB: number;
  /** UI display name. */
  label: string;
  /**
   * How the model turns a (query, doc) pair into a logit.
   * - 'classifier': sequence-classification head; tokenize with text_pair, read
   *   logits[0]. The XLM-R cross-encoder family.
   * - 'causal-yes-no': a causal LM judged on its last-position "yes" vs "no"
   *   logits (score = yesLogit − noLogit, the log-odds of yes — the same raw-
   *   logit scale the floors below are measured on). The pair is wrapped in the
   *   model's chat template with `instruct`; the worker owns the template
   *   because it is the Qwen3-Reranker contract, but the instruct line is data:
   *   it states THIS deployment's relevance question and was fixed when the
   *   floors were measured — changing it invalidates them.
   */
  scoring: 'classifier' | 'causal-yes-no';
  /** Task instruction for 'causal-yes-no' scoring; ignored by classifiers. */
  instruct?: string;
  /**
   * Raw-logit floor below which this model's score means "not relevant", for
   * callers that need a yes/no rather than an ordering (skill inlining). Lives
   * here, next to the weights it was measured against, because it is a property
   * of THIS model and of nothing else — the mistake that put a cosine floor in
   * the ranking logic and left it there across an embedder swap.
   *
   * Only meaningful for the bundled local models: a remote /rerank server runs
   * an arbitrary model on an unknown scale (Cohere-style endpoints normalise to
   * 0..1, this one does not), so remote callers get no floor and must fall back
   * to a scale-free rule.
   */
  minRelevantScore: number;
  /**
   * Raw-logit floor for the fact-injection gate (inject.ts): a durable fact
   * scoring below this against the user's message is noise, not context. A
   * separate number from minRelevantScore because it is a separate measurement:
   * facts ANSWER the query directly (unlike skill descriptions), and the gate is
   * applied to production-style BATCHED scoring, whose padding drift the skill
   * floor explicitly excludes. Same ownership rule: this is a property of THIS
   * model's logit scale and lives next to the weights it was measured against.
   */
  factGateScore: number;
}

export const RERANK_CATALOG: Record<LocalRerankModelId, LocalRerankModelSpec> = {
  // Multilingual cross-encoder (XLM-R based). Verified 2026-07-04 against the
  // live fact set: promotes the cross-lingual (Slovak query → English facts)
  // matches that cosine ranking misses, ~22 ms/pair on an M4 Max at q8.
  // NOTE: onnx-community/gte-multilingual-reranker-base is NOT an alternative —
  // its custom `model_type: "new"` is unsupported by transformers.js.
  'bge-reranker-v2-m3': {
    id: 'bge-reranker-v2-m3',
    repo: 'onnx-community/bge-reranker-v2-m3-ONNX',
    dtype: 'q8',
    approxSizeMB: 570,
    label: 'BGE Reranker v2 M3',
    scoring: 'classifier',
    // Measured 2026-08-10 on tests/fixtures/skill-retrieval-golden.json (20
    // positives / 12 negatives, cosine shortlist of 4, ONE PAIR PER FORWARD
    // PASS — see below):
    //
    //     −7   loaded 0.750   noise 0.000   false-load 0.083
    //     −8   loaded 0.850   noise 0.000   false-load 0.167
    //     −9   loaded 0.950   noise 0.050   false-load 0.250
    //    −10   loaded 0.950   noise 0.100   false-load 0.250
    //
    // −9 rather than the point that minimises total error, because the two
    // errors do not cost the same. A skill that fails to load costs the whole
    // feature — that is the regression this replaced, and it ran for a week. A
    // skill that loads when it should not costs ~2.4 KB and is recoverable: the
    // block instructs the model to say so when a loaded procedure does not fit.
    // Buy recall with false loads here, not the other way round.
    //
    // Deep in the negatives, not near the sigmoid's 0 boundary, because this
    // model scores "does this passage ANSWER the query" and a skill description
    // answers nothing — it says when to reach for a procedure. Every pair
    // therefore lands low; what carries the signal is that non-matches saturate
    // hard at about −11 while a real match lifts several logits clear of it.
    //
    // THIS NUMBER IS ONLY VALID FOR UNBATCHED SCORING. The identical (query,
    // doc) pair scores −7.890 alone, −8.090 in a batch of two and −8.289 in a
    // batch of six: padding to the batch's longest sequence leaks into the
    // logit. Ordering shrugs that off, which is why it went unnoticed in the
    // rerank-for-ranking path, but a 0.4-logit drift straddles any threshold
    // near here. Callers that compare against this MUST score one pair per
    // forward pass. Re-measure with `npm run eval:skill-retrieval -- --rerank`
    // before changing it.
    minRelevantScore: -9,
    // Measured 2026-08-13 on the fact-injection benchmark (recall-bench/: 60
    // real turns, dual-labeled + adjudicated gold, scored with production-style
    // batch-8 forward passes — so unlike minRelevantScore this floor already
    // absorbs padding drift). Sweep over the union candidate pool:
    //
    //    −6   P 0.23  R 0.19  leaks  9/60 turns
    //    −8   P 0.15  R 0.30  leaks 23/60   (+2 sensitive margin → leaks 4)
    //   −10   admits the trigram-fill noise tier this gate exists to kill
    //
    // −8 with the sensitive margin (inject.ts) rather than −6: recall parity
    // with the old fill-to-limit pipeline at 6× its precision, and the margin —
    // not a harsher global floor — is what removes the sensitive-fact leaks.
    // Re-run recall-bench/ (README has the procedure) before changing it.
    factGateScore: -8
  },
  // Causal-LM reranker (Qwen3 family) scored on its yes/no logits. Measured
  // 2026-08-15 on recall-bench/: on identical candidate pools it separates the
  // association-type matches ("check kubernetes" → the user's Grafana fact)
  // that the XLM-R classifier above cannot — best F1 0.26 vs 0.19, recall
  // reach 0.45 vs 0.27. The price is speed: ~80 ms/pair vs ~22, and ONE PAIR
  // PER FORWARD PASS is mandatory (see embed-worker.ts — this v4-targeted GQA
  // export mis-attends across padding on the bundled transformers.js 3.8.1,
  // shifting every row in a mixed-length batch by whole logit units).
  'qwen3-reranker-0.6b': {
    id: 'qwen3-reranker-0.6b',
    repo: 'onnx-community/Qwen3-Reranker-0.6B-ONNX',
    dtype: 'q8',
    approxSizeMB: 1163,
    label: 'Qwen3 Reranker 0.6B',
    scoring: 'causal-yes-no',
    // Frozen with the floors below — rewording it re-poses the question the
    // yes/no logits answer, which moves their scale.
    instruct:
      'Given a user message to a personal assistant, judge whether this stored fact about the user is relevant to answering it',
    // Measured 2026-08-15 on tests/fixtures/skill-retrieval-golden.json, one
    // pair per pass, same loaded/noise/false-load protocol as above:
    //
    //    −3   loaded 0.700   noise 0.000   false-load 0.100
    //    −4   loaded 0.750   noise 0.167   false-load 0.150
    //    −5   loaded 0.750   noise 0.500   false-load 0.400
    //
    // −4 buys the last cheap recall before noise blows up. Honest caveat: BGE
    // above is BETTER at this task (loaded 0.950 / noise 0.050 at its −9) —
    // skill descriptions say when to reach for a procedure rather than answer
    // the query, and the yes/no framing punishes that indirection. This model
    // earns its place on fact injection, not skill inlining.
    minRelevantScore: -4,
    // Measured 2026-08-15 on the fact-injection benchmark (recall-bench/
    // rerank_qwen3_onnx.mjs: 60 real turns, gold-labeled, THE SHIPPED CONFIG —
    // q8 ONNX weights, unbatched forward passes, shipped 24-candidate pools):
    //
    //    −4    F1 0.16  P 0.11  R 0.25  leaks 8
    //    −2    F1 0.25  P 0.30  R 0.21  leaks 4
    //    −1.5  F1 0.26  P 0.36  R 0.21  noise@clean 0.3  leaks 3
    //     0    F1 0.18  P 0.35  R 0.12  leaks 1
    //
    // −1.5 is the sweep's best F1 and beats the bge gate above on every axis
    // but raw recall (0.21 vs 0.27) while quartering its leaks (3 vs 12).
    // Matches the fp16 reference within measurement noise (q8 costs nothing).
    // Re-run recall-bench/ (README has the procedure) before changing it.
    factGateScore: -1.5
  }
};

export const DEFAULT_LOCAL_RERANK_MODEL: LocalRerankModelId = 'bge-reranker-v2-m3';

/**
 * The spec for whichever local reranker the settings select — curated, or
 * synthesised when the user imported one Stem has no entry for. Same contract
 * and same reasons as resolveEmbedSpec: never index RERANK_CATALOG with a
 * settings id directly, because a custom id lands on `undefined`.
 *
 * A custom entry's floors are the ones the import dialog prefilled from the
 * curated model with its scoring mode, NOT measurements of these weights — the
 * dialog says so where it asks, and `npm run eval:skill-retrieval` is how they
 * stop being a guess.
 */
export function resolveRerankSpec(r: RetrievalSettings): LocalRerankModelSpec {
  const catalog = RERANK_CATALOG[r.reranker.localModel as LocalRerankModelId];
  if (catalog) return catalog;
  const custom: LocalRerankModelSpec | undefined = r.customRerankModels.find(
    (m) => m.id === r.reranker.localModel
  );
  return custom ?? RERANK_CATALOG[DEFAULT_LOCAL_RERANK_MODEL];
}
