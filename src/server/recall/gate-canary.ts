import canary from './gate-canary.json';

// A check that the gate model still scores the way its floors were measured.
//
// The fact and skill gates compare a cross-encoder logit against a fixed floor
// (gte-fact-pilot.ts). The model is 8-bit quantized, and its logits are not a
// property of the weights alone: the same pair has scored differently
//   - after a runtime upgrade (transformers.js 3.8.1 to 4.3.1 moved logits by
//     up to 3.4, and the old kernels were up to 5.5 off the float model);
//   - on another platform (macOS arm64 against the Linux x64 server image:
//     median 0.07 apart over 12,000 pairs, but 8.4 at the worst).
// Either moves every score against a floor that stays where it is, and nothing
// in the app could notice. Both times it was found by hand, weeks later.
//
// So a small set of synthetic pairs ships with the scores they got where the
// floors were measured (gate-canary.json; scripts/gate-canary.mjs records
// them). The model scores them again when it has loaded, and in CI, and a
// difference from the reference is reported. The check moves no floor: it
// says the floors need measuring again, which is a benchmark's job.
//
// What the first two references showed (2026-11-11, same weights, same
// transformers.js 4.3.1): each platform repeats its own scores exactly, run
// after run. Against each other, the Mac and the server image differ by 0.11
// at the median, but 14 of the 44 pairs differ by half a logit or more and
// one by 5.3 — the pairs in the middle of the range, which are the ones a
// floor decides. Two pairs land on opposite sides of a floor. So "same as the
// reference" is a strict test on purpose: a machine that scores like the
// other platform does is, for the gates, a different machine.

export interface CanaryPair {
  query: string;
  doc: string;
}

export interface GateCanary {
  /** The model release the reference scores belong to (GTE_MODEL_VERSION). */
  model: string;
  pairs: CanaryPair[];
  /** Scores per `<platform>-<arch>`, in pair order. */
  reference: Record<string, number[]>;
}

export const GATE_CANARY = canary as unknown as GateCanary;

/** How a run's scores differ from a reference: absolute differences in logits. */
export interface GateDrift {
  /** The reference compared against: this platform's own, or the nearest one. */
  against: string;
  /** Whether `against` was measured on this platform and architecture. */
  ownPlatform: boolean;
  pairs: number;
  median: number;
  mean: number;
  max: number;
  /** Share of pairs that moved by {@link DRIFT_PAIR_LOGITS} or more. */
  moved: number;
  drifted: boolean;
}

/**
 * A pair counts as moved at this many logits: a tenth of the distance between
 * the gate floors, and far above anything the same kernels produce twice
 * (which is nothing).
 */
export const DRIFT_PAIR_LOGITS = 0.5;
/** Drift: the typical pair moved this far … */
export const DRIFT_MEDIAN_LOGITS = 0.1;
/** … or this share of pairs moved by {@link DRIFT_PAIR_LOGITS}. The two measured platforms are 32% apart. */
export const DRIFT_MOVED_SHARE = 0.1;

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Compare one run against one reference. Null when they are not the same length. */
export function compareGateScores(scores: readonly number[], reference: readonly number[]): Omit<GateDrift, 'against' | 'ownPlatform'> | null {
  if (scores.length === 0 || scores.length !== reference.length) return null;
  const diffs = scores.map((s, i) => Math.abs(s - reference[i]!)).sort((a, b) => a - b);
  const med = median(diffs);
  const moved = diffs.filter((d) => d >= DRIFT_PAIR_LOGITS).length / diffs.length;
  return {
    pairs: diffs.length,
    median: med,
    mean: diffs.reduce((sum, d) => sum + d, 0) / diffs.length,
    max: diffs[diffs.length - 1]!,
    moved,
    drifted: med >= DRIFT_MEDIAN_LOGITS || moved >= DRIFT_MOVED_SHARE
  };
}

/**
 * Judge a run on `platform` (`<process.platform>-<process.arch>`). Its own
 * reference is used when there is one; a platform nobody measured is held to
 * the nearest reference, since its floors are those platforms' floors. Null
 * when the canary holds no usable reference.
 */
export function gateDrift(scores: readonly number[], platform: string, canarySet: GateCanary = GATE_CANARY): GateDrift | null {
  const own = canarySet.reference[platform];
  const candidates = own ? [[platform, own] as const] : Object.entries(canarySet.reference);
  let best: GateDrift | null = null;
  for (const [name, reference] of candidates) {
    const d = compareGateScores(scores, reference);
    // Nearest by the mean: a median hides the few pairs that moved far, and those are the difference.
    if (d && (!best || d.mean < best.mean)) best = { against: name, ownPlatform: name === platform, ...d };
  }
  return best;
}

/** One line for the log: what was compared, and how far apart it was. */
export function describeGateDrift(d: GateDrift, platform: string): Record<string, unknown> {
  return {
    platform,
    against: d.against,
    pairs: d.pairs,
    median: Number(d.median.toFixed(3)),
    max: Number(d.max.toFixed(2)),
    moved: `${Math.round(d.moved * 100)}%`,
    drifted: d.drifted,
    // A platform with no reference of its own runs on floors measured elsewhere.
    ...(d.ownPlatform ? {} : { floorsMeasuredHere: false })
  };
}

/** Score every canary pair, one at a time, as the gates do. */
export async function scoreGateCanary(
  score: (query: string, doc: string) => Promise<number>,
  canarySet: GateCanary = GATE_CANARY
): Promise<number[]> {
  const scores: number[] = [];
  for (const pair of canarySet.pairs) scores.push(await score(pair.query, pair.doc));
  return scores;
}
