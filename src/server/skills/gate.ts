// Where the ranked candidate list gets CUT: which skills are inlined with their
// full bodies, and which are merely listed by name. Split out of `inject.ts`
// because the cut is the one decision in skill selection that a fixed constant
// cannot make correctly, and because a pure module (no fs, no clients, no
// Electron) can be compiled standalone and driven by the real-inference eval —
// see scripts/skill-retrieval-eval.mjs.
//
// WHY THIS EXISTS. The original cut was `cosine >= SKILL_MIN_COSINE`, a 0.72
// lifted from `STANDARD_FACT_MIN_COSINE` in recall/inject.ts on the reasoning
// that both stages embed a short passage through the same model, so both inherit
// the same calibration. Measured against the user's own `fact_vectors` table —
// which happens to hold the same facts embedded under two models — both halves
// of that reasoning fail:
//
//   cosine between ~4000 random (i.e. unrelated) fact pairs
//     multilingual-e5-base   p50 0.754   82.97% of pairs >= 0.72
//     qwen3-embedding:4b     p50 0.376    0.63% of pairs >= 0.72
//
// A cosine is a point on a distribution, and the distribution is a property of
// the model, not of the texts. Under e5 the constant sat at the 16th percentile
// of pure noise — it admitted 83% of unrelated content, which is to say it never
// gated anything and top-M plus the reranker did all the discrimination. Under
// qwen3 the same constant lands at the 99.4th percentile and shuts the stage off
// entirely: over five days of real use it fired once, on a library of eight.
//
// Nothing in the code changed. The distribution moved underneath it.
//
// WHY NOT JUST RECALIBRATE. Because `retrieval.embeddings` accepts any
// OpenAI-compatible endpoint, so the set of models a user can configure is
// unbounded and no table of per-model constants can cover it. The rule this
// module follows instead: no absolute cosine may appear in a decision. Every
// threshold here is either a rank, a count, or a ratio measured against the
// candidate set of the same query — all of which survive a model swap because
// the numerator and denominator move together.

/** One ranked candidate. `cosine` is raw similarity, never a usage-blended score. */
export interface ScoredSkill {
  slug: string;
  cosine: number;
  /**
   * Raw cross-encoder logit, when a reranker ran — the same scalar
   * `embed-worker.ts` already sorts by, NOT a sigmoid of it. Two reasons to keep
   * it raw: the useful operating range for skill descriptions sits around −8,
   * where sigmoid underflows to ~3e-4 and throws away the resolution the cut
   * depends on; and the sigmoid's nominal 0.5 boundary is meaningless here
   * anyway (see `DEFAULT_MIN_RERANK_SCORE`).
   *
   * Unlike a cosine this is at least a *per-model constant* rather than a
   * per-model-and-per-corpus one, which is why it can carry an absolute
   * threshold — provided that threshold is stored next to the model.
   */
  rerankScore?: number;
}

/**
 * - `rerank`   — bi-encoder shortlists, cross-encoder decides against an
 *                absolute threshold. Needs `rerankScore` populated. Preferred.
 * - `relative` — distribution-relative cut on cosine alone, for when no
 *                reranker is available.
 * - `fixed`    — the legacy absolute-cosine cut, kept ONLY so the eval can
 *                report what it costs. Not for production use.
 * - `topk`     — no relevance test at all: always inline the top `maxInlined`.
 *                The "budget" baseline; the eval's upper bound on recall and
 *                its worst case on false inlines.
 */
export type CutStrategy = 'rerank' | 'relative' | 'fixed' | 'topk';

export interface CutOptions {
  strategy?: CutStrategy;
  /** Hard cap on inlined bodies, whatever the scores say. */
  maxInlined?: number;
  /** `fixed` only: the absolute floor. */
  minCosine?: number;
  /** `rerank` only: floor on the raw cross-encoder logit. */
  minRerankScore?: number;
  /**
   * `rerank` only: how many cosine-ranked candidates the cross-encoder sees.
   * Bounds cost (cross-encoding is ~22 ms/pair against ~0 for a cached cosine)
   * and, measurably, improves precision — the bi-encoder's ordering keeps a
   * topically-unrelated skill out of the cross-encoder's reach even when the
   * cross-encoder would have scored it above the floor.
   */
  shortlistSize?: number;
  /** `relative` only: how far above the background the top candidate must sit. */
  minZ?: number;
  /** `relative` only: how wide the gap at the cut point must be, in background sigma. */
  minGapSigma?: number;
  /** `relative` only: smallest background sample that yields a usable sigma. */
  minBackground?: number;
}

export interface CutStats {
  /** Mean/stdev of the background — the candidates no cut point can reach. */
  backgroundMean: number;
  backgroundStdev: number;
  backgroundSize: number;
  /** (top cosine − background mean) / sigma. */
  topZ: number;
  /** Gap below rank i, in sigma, for each admissible cut point i (1-based). */
  gapSigma: number[];
}

export type CutReason =
  /** Nothing to choose from. */
  | 'empty'
  /** Too few candidates for a background sample; the whole library fits the budget. */
  | 'small-library'
  /** A gap in the score profile separated a head group from the pack. */
  | 'separated'
  /** The profile was flat: no candidate stood out, so nothing was inlined. */
  | 'no-separation'
  /** `fixed`/`rerank` strategy: candidates cleared the absolute floor. */
  | 'above-floor'
  /** `fixed`/`rerank` strategy: nothing cleared the absolute floor. */
  | 'below-floor'
  /** `rerank` strategy asked for, but no candidate carried a cross-encoder score. */
  | 'no-rerank-score'
  /** `topk` strategy: no relevance test was applied. */
  | 'topk';

export interface CutResult {
  /** Slugs to inline, best first. Everything else belongs in the name-only index. */
  inlined: string[];
  reason: CutReason;
  /** Present whenever a background could be computed; for eval reporting. */
  stats?: CutStats;
}

/** Bodies per turn. Unchanged from inject.ts — this module only moves the *test*. */
export const DEFAULT_MAX_INLINED = 2;

/**
 * How far above the background pack the top candidate must sit before anything
 * is inlined. This is the query-level question "is ANY saved procedure relevant
 * here", and it is what a bare acknowledgement ("Áno", "ok thanks") has to fail.
 *
 * Measured on the golden fixture with qwen3-embedding:4b, this term turns out to
 * do almost nothing on its own: sweeping it from 1.5 to 3.0 moves `loaded` by at
 * most one query and `false-load` not at all, because a topically adjacent
 * negative posts a perfectly good z. It is kept because it is the only guard
 * against admitting a head group that is itself down in the noise, which the gap
 * test alone cannot see. Do not expect it to carry the decision.
 */
export const DEFAULT_MIN_Z = 2.0;

/**
 * How wide the gap at the cut point must be, measured in background sigma. This
 * is the discriminative question — not "is the top score high" but "is there a
 * visible step down from the head group to the pack".
 *
 * It catches what `minZ` alone cannot. A query in the user's non-English
 * language lifts every English description a little, so the whole profile rises
 * together and the top candidate can post a high z while still being nothing
 * special: the observed "aké je dnes počasie v Bratislave" scored z = 3.16 with
 * a gap of only 1.05 sigma, and would have inlined an unrelated skill on z alone.
 *
 * 1.2 is NOT the sweep's optimum. On the golden fixture 2.0 scores 0.900/0.333
 * against 1.2's 0.950/0.583, and is the better point by (loaded − false-load).
 * 1.2 is kept deliberately, because that metric weights the two errors equally
 * and this system does not: a missed skill costs the whole feature, while a
 * wrongly loaded one costs ~2.4 KB and is recoverable — the block instructs the
 * model to say so when a loaded procedure does not fit. Revisit if the cost of a
 * false load ever stops being just tokens.
 *
 * This whole path is the FALLBACK. When a cross-encoder is available the cut
 * belongs to `rerank`, which reaches 0.900/0.083 on the same fixture.
 */
export const DEFAULT_MIN_GAP_SIGMA = 1.2;

/**
 * Below this many background candidates the sigma is too noisy to divide by.
 * Four is the smallest sample where one outlier cannot dominate the spread.
 */
export const DEFAULT_MIN_BACKGROUND = 4;

/** Legacy absolute floor, retained for `fixed` so the eval can price it. */
export const LEGACY_MIN_COSINE = 0.72;

/**
 * Words below which a message cannot justify inlining anything.
 *
 * Every test in this module grades the CANDIDATE side: is the top skill's score
 * separated from the pack, is it above the model's floor. A near-empty message
 * degenerates the QUERY side instead, and no candidate-side test can see that —
 * against two words, every score is noise, and noise occasionally clears any
 * floor. Observed live (2026-08-22): "Try now", a bare nudge in a coding thread,
 * cleared the calibrated cross-encoder floor and inlined an insurance-claim
 * procedure. The same turn under `relative` would have been just as exposed:
 * z and gap measure the profile's shape, not whether the question made sense.
 *
 * So the gate refuses the question rather than re-grading the answers. A word
 * count, not a stopword list, because the user writes Slovak and English and a
 * list is per-language; three, because the observed failures are one- and
 * two-word acknowledgements ("Áno", "ok", "Try now", "skús teraz") while real
 * requests that name a task run longer. What a gated turn loses is bounded: the
 * library is still listed by name, so the model can ask for a skill it wants.
 */
export const MIN_QUERY_WORDS = 3;

/** Whether the message is substantial enough to rank the library against. */
export function queryHasSignal(query: string): boolean {
  let words = 0;
  for (const token of query.split(/\s+/)) {
    // Bare punctuation ("?", "...") is not a word in any language involved.
    if (/[\p{L}\p{N}]/u.test(token)) words += 1;
    if (words >= MIN_QUERY_WORDS) return true;
  }
  return false;
}

/**
 * Cosine-ranked candidates handed to the cross-encoder.
 *
 * Note there is deliberately NO default for `minRerankScore` to sit beside this.
 * That floor is a property of one specific reranker and lives in RERANK_CATALOG
 * next to the weights it was measured against; a default here would be this
 * module quietly asserting a fact about a model it has never seen, which is the
 * exact shape of the bug the file exists to fix. `rerank` without an explicit
 * floor returns `no-rerank-score` and the caller degrades.
 */
export const DEFAULT_SHORTLIST_SIZE = 4;

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Population stdev — this is the whole background, not a sample drawn from it. */
function stdev(xs: number[], mu: number): number {
  return Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / xs.length);
}

/**
 * Decide the cut. Pure and total: it never throws, and every degenerate input
 * (empty, tiny library, flat profile, zero variance) has a named reason rather
 * than an implicit fallthrough, because the failure this module exists to fix
 * was precisely a silent one — a stage that returned nothing, logged nothing,
 * and looked exactly like a stage with nothing to say.
 */
export function selectCut(scored: ScoredSkill[], opts: CutOptions = {}): CutResult {
  const strategy = opts.strategy ?? 'relative';
  const maxInlined = Math.max(0, opts.maxInlined ?? DEFAULT_MAX_INLINED);
  if (scored.length === 0 || maxInlined === 0) return { inlined: [], reason: 'empty' };

  // Defensive copy: callers rank before calling, but the cut's correctness must
  // not depend on that and sorting a handful of entries costs nothing.
  const s = [...scored].sort((a, b) => b.cosine - a.cosine);

  if (strategy === 'topk') {
    return { inlined: s.slice(0, maxInlined).map((c) => c.slug), reason: 'topk' };
  }

  if (strategy === 'fixed') {
    const floor = opts.minCosine ?? LEGACY_MIN_COSINE;
    const above = s.filter((c) => c.cosine >= floor).slice(0, maxInlined);
    return {
      inlined: above.map((c) => c.slug),
      reason: above.length > 0 ? 'above-floor' : 'below-floor'
    };
  }

  if (strategy === 'rerank') {
    // An absent score — or an uncalibrated backend — is not a low score. It
    // means the cut cannot be made here, and inlining nothing would be
    // indistinguishable from a confident no. The caller degrades to `relative`
    // on this reason.
    const shortlist = s.slice(0, opts.shortlistSize ?? DEFAULT_SHORTLIST_SIZE);
    const floor = opts.minRerankScore;
    if (typeof floor !== 'number' || !shortlist.some((c) => typeof c.rerankScore === 'number')) {
      return { inlined: [], reason: 'no-rerank-score' };
    }
    const above = shortlist
      .filter((c) => typeof c.rerankScore === 'number' && c.rerankScore >= floor)
      .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0))
      .slice(0, maxInlined);
    return {
      inlined: above.map((c) => c.slug),
      reason: above.length > 0 ? 'above-floor' : 'below-floor'
    };
  }

  const minZ = opts.minZ ?? DEFAULT_MIN_Z;
  const minGapSigma = opts.minGapSigma ?? DEFAULT_MIN_GAP_SIGMA;
  const minBackground = opts.minBackground ?? DEFAULT_MIN_BACKGROUND;

  // Deepest admissible cut. One candidate must always remain below it, or there
  // is no gap to measure and no pack to stand out from.
  const maxCut = Math.min(maxInlined, s.length - 1);

  // The background is everything no cut point can reach: ranks maxCut+1..n. It
  // is deliberately the SAME reference distribution for every cut point, so the
  // gap figures below are comparable to each other.
  const background = s.slice(maxCut + 1).map((c) => c.cosine);
  if (background.length < minBackground) {
    // A library this small fits the inline budget whole; there is nothing to be
    // selective about and no sample to be selective with. Caller may prefer to
    // inline everything at this size — see the budget discussion in inject.ts.
    return { inlined: s.slice(0, maxInlined).map((c) => c.slug), reason: 'small-library' };
  }

  const mu = mean(background);
  const sigma = stdev(background, mu);
  const gapSigma: number[] = [];
  for (let i = 1; i <= maxCut; i++) {
    gapSigma.push(sigma === 0 ? 0 : (s[i - 1].cosine - s[i].cosine) / sigma);
  }
  const stats: CutStats = {
    backgroundMean: mu,
    backgroundStdev: sigma,
    backgroundSize: background.length,
    topZ: sigma === 0 ? 0 : (s[0].cosine - mu) / sigma,
    gapSigma
  };

  // Zero variance means every background candidate scored identically — either a
  // degenerate library or a broken embedder. Either way there is no evidence of
  // separation, and dividing by it would manufacture some.
  if (sigma === 0) return { inlined: [], reason: 'no-separation', stats };

  // Search deepest cut first so a genuinely multi-skill turn can take two bodies,
  // and require the candidate admitted at that depth to clear `minZ` as well —
  // a wide gap low in the list means nothing if the head group is itself in the
  // noise. z is monotone decreasing in rank, so the first depth satisfying both
  // tests is the right one.
  for (let i = maxCut; i >= 1; i--) {
    const z = (s[i - 1].cosine - mu) / sigma;
    if (gapSigma[i - 1] >= minGapSigma && z >= minZ) {
      return { inlined: s.slice(0, i).map((c) => c.slug), reason: 'separated', stats };
    }
  }
  return { inlined: [], reason: 'no-separation', stats };
}
