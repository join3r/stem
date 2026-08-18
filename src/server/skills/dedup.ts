import { degrade } from '../degrade';
import { getEmbeddingsClient } from '../recall/retrieval';
import { dot, magnitude } from '../recall/vector';
import { sectionText } from './grade';
import { ensureSkillVectors, skillVectorText, type SkillEmbedder, type SkillVectorInput } from './vectors';

// Write-time near-duplicate check, mirroring `DEFAULT_DUP_COSINE` in
// recall/store.ts. Skills accumulate duplicates faster than facts do, because two
// people describing the same procedure a month apart will not pick the same name:
// the library this replaces had several entries covering the same task under
// different slugs, and the periodic curator merging them after the fact was always
// the second-best moment to notice.
//
// Catching it at write time is better for a reason the curator can't match: the
// caller is still holding the draft, so the answer can be "update THAT one" and be
// acted on immediately, with the new evidence folded into the skill that already
// has the usage history.
//
// Runs on creates only. An update names its target explicitly, and resembling the
// skill you are updating is not a defect.
//
// Two checks, not one (added 2026-08-11). The name+description gate answers "is
// this the same skill?" and the Steps gate answers "is this the same procedure?",
// and the duplicate that actually landed in the library was the second without
// being the first. See SKILL_BODY_DUP_COSINE.

/**
 * Same value as recall's fact dedup, calibrated against the same embedder. Set
 * high on purpose: two genuinely different procedures for related tasks ("open a
 * video", "read a video's captions") sit well below it, and the cost of a false
 * positive here — refusing a skill that should exist — is worse than the cost of a
 * near-duplicate the curator will merge later.
 */
export const SKILL_DUP_COSINE = 0.94;

/**
 * The second gate, over the two bodies' `## Steps` text. Name+description is how
 * a skill is FRAMED, and two people — or one model on two mornings — framing the
 * same procedure differently is exactly the duplicate that gets written: the
 * 08-11 pair (`extract-youtube-transcript` vs `extract-youtube-video-details`)
 * ran the same yt-dlp caption pipeline and scored **0.824** on name+description,
 * nowhere near the 0.94 gate. Steps are the procedure itself, so two framings of
 * one procedure converge there.
 *
 * Lower than SKILL_DUP_COSINE because the comparison is longer text with shared
 * boilerplate (numbered lines, "Call …", the same tool names), which compresses
 * the useful range upward — but still high, on the same reasoning: a false block
 * is a refused skill, a miss is a tidy-up job. 0.93 is provisional and set by
 * argument, not evidence; the near-miss warnings below are what will replace the
 * argument with a distribution.
 */
export const SKILL_BODY_DUP_COSINE = 0.93;

export interface DuplicateHit {
  slug: string;
  cosine: number;
  /** Which gate fired. Callers may ignore it; the bridge's message is the same either way. */
  via?: 'name' | 'body';
}

/** A record as this module needs it: the vector inputs, plus a body when there is one. */
type DedupRecord = SkillVectorInput & { body?: string };

/** How far below a gate still counts as worth logging, so the threshold gets calibrated on data. */
const NEAR_MISS_MARGIN = 0.03;

function warnNearMiss(check: 'name+description' | 'body', slug: string, cosine: number, gate: number): void {
  if (cosine >= gate - NEAR_MISS_MARGIN && cosine < gate) {
    console.warn(`[skills dedup] near-miss (${check}): ${slug} at ${cosine.toFixed(3)} vs ${gate}`);
  }
}

/**
 * The existing skill this draft would duplicate, or null. Best-effort: with no
 * embeddings available it returns null rather than blocking the write — a missed
 * duplicate is a tidy-up job, a blocked save is lost work.
 *
 * Two checks in order. Name+description first, because those vectors are cached
 * in the sidecar and already warm from retrieval. Only if that finds nothing does
 * the body check run, which embeds on the fly.
 */
export async function findDuplicateSkill(
  draft: { name: string; description: string; body?: string },
  records: DedupRecord[],
  embeddings = getEmbeddingsClient()
): Promise<DuplicateHit | null> {
  const others = records.filter((r) => r.slug !== draft.name);
  if (!embeddings || others.length === 0) return null;
  try {
    if (!(await embeddings.available())) return null;
    const model = await embeddings.modelId();
    if (!model) return null;
    const embedder: SkillEmbedder = { model, embed: (texts) => embeddings.embed(texts, 'passage') };
    const vectors = await ensureSkillVectors(others, embedder);
    const [vec] = await embedder.embed([skillVectorText({ slug: draft.name, ...draft })]);
    if (!vec) return null;

    const mag = magnitude(vec) || 1;
    let best: DuplicateHit | null = null;
    for (const record of others) {
      const other = vectors.get(record.slug);
      if (!other || other.length !== vec.length) continue;
      const cosine = dot(vec, other) / (mag * (magnitude(other) || 1));
      if (cosine >= SKILL_DUP_COSINE && (!best || cosine > best.cosine)) best = { slug: record.slug, cosine, via: 'name' };
      else warnNearMiss('name+description', record.slug, cosine, SKILL_DUP_COSINE);
    }
    if (best) return best;

    return await findBodyDuplicate(draft.body ?? '', others, embedder);
  } catch (error) {
    // null is also how this says "nothing resembles the draft", so a write that
    // skipped the check entirely looks exactly like one that passed it.
    degrade('skills.dedup', 'let a possible duplicate skill through', error);
    return null;
  }
}

/**
 * The Steps-vs-Steps check. Runs only on creates that survived the first gate.
 *
 * Body vectors are computed here and thrown away rather than cached in
 * `.skills-vectors.json`, which is the opposite of what retrieval does and is
 * deliberate: the sidecar exists so that editing one description does not
 * re-embed the library, and adding a 4 KB body vector per skill would put that
 * cost on every edit — permanently, for every skill — to serve one check that
 * runs only when a new skill is being created. Creates are rare. Paying the whole
 * library's embedding cost at that moment is the cheaper side of the trade.
 */
async function findBodyDuplicate(
  draftBody: string,
  others: DedupRecord[],
  embedder: SkillEmbedder
): Promise<DuplicateHit | null> {
  const draftSteps = sectionText(draftBody, 'Steps').trim();
  if (!draftSteps) return null;
  // A record with no body cannot be compared — the caller passed a projection
  // that dropped it, and guessing from name+description is what already failed.
  const candidates = others
    .map((r) => ({ slug: r.slug, steps: sectionText(r.body ?? '', 'Steps').trim() }))
    .filter((c) => c.steps.length > 0);
  if (candidates.length === 0) return null;

  const vecs = await embedder.embed([draftSteps, ...candidates.map((c) => c.steps)]);
  const draftVec = vecs[0];
  if (!draftVec) return null;
  const mag = magnitude(draftVec) || 1;

  let best: DuplicateHit | null = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const other = vecs[i + 1];
    if (!other || other.length !== draftVec.length) continue;
    const cosine = dot(draftVec, other) / (mag * (magnitude(other) || 1));
    if (cosine >= SKILL_BODY_DUP_COSINE && (!best || cosine > best.cosine))
      best = { slug: candidates[i].slug, cosine, via: 'body' };
    else warnNearMiss('body', candidates[i].slug, cosine, SKILL_BODY_DUP_COSINE);
  }
  return best;
}
