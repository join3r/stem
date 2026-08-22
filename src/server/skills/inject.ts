import { degrade } from '../degrade';
import { getEmbeddingsClient, getRerankClient } from '../recall/retrieval';
import type { EmbeddingsClient } from '../recall/embeddings';
import type { RerankClient } from '../recall/rerank';
import { dot, magnitude } from '../recall/vector';
import { ensureSkillVectors, skillVectorText, type SkillEmbedder } from './vectors';
import { DEFAULT_SHORTLIST_SIZE, queryHasSignal, selectCut, type CutReason, type CutResult } from './gate';

// Per-turn skill selection: which saved procedures the model gets, and in what
// depth. This is the half of the skills rebuild that takes retrieval away from
// the backend, which broadcasts every skill's name+description into the system
// prompt on every turn. Because that injection is unconditional, the injected
// count is identical for every skill and carries no information — no precision
// signal about which skill was worth loading can exist by construction.
//
// The pipeline mirrors durable-fact selection in `recall/inject.ts`: embed the
// incoming message, cosine-rank the library against it, blend in the usage
// signal, optionally rerank, and gate. Two things differ, both because a skill
// is a procedure rather than a datum:
//
//   - Selection has two OUTPUTS, not one. Skills clearing the gate are `inlined`
//     with their full body — the agentskills convention of listing descriptions
//     and letting the model `read` the SKILL.md itself depends on the model
//     volunteering a tool call, a behaviour that fired twice in 225 sessions of
//     local history. Bodies average ~1.4 KB, so inlining the top 2 costs about
//     the same as recall's existing per-turn spend and removes that dependency
//     entirely. Everything else is `indexed` by name+description only, so the
//     model still knows what exists.
//
//   - The no-embeddings fallback is index-only. Recall degrades to a lexical
//     (BM25 + trigram) tier because a wrongly-injected fact is inert background
//     data. A wrongly-inlined skill is not: the block tells the model to FOLLOW
//     it, so a noisy match is an instruction to do the wrong thing. Name and
//     description are inert either way, so when we cannot rank we list
//     everything and inline nothing. A skill nobody loaded is a missed
//     shortcut; a skill wrongly loaded is a wrong action.

/**
 * The shape selection needs from a skill. Structural on purpose: `skills/store.ts`
 * satisfies it, and taking records as an argument keeps this module free of the
 * filesystem and trivially testable.
 */
export interface SkillRecordish {
  slug: string;
  name: string;
  description: string;
  body: string;
  /** Who asked for it — 'user' when the user requested it, 'assistant' when auto-saved. */
  origin?: string;
  enabled?: boolean;
}

export interface InlinedSkill {
  slug: string;
  name: string;
  description: string;
  body: string;
  origin?: string;
}

export interface IndexedSkill {
  slug: string;
  name: string;
  description: string;
}

/** Why this turn inlined what it did — for the log, never for the prompt. */
export interface SkillDecision {
  reason: CutReason | 'no-embeddings' | 'low-signal';
  /** Candidates that could be ranked (had a usable vector). */
  candidates: number;
  topCosine?: number;
  inlined: string[];
}

export interface SkillSelection {
  /** Full bodies — whatever survived the cut, capped at `maxInlined`. */
  inlined: InlinedSkill[];
  /** Everything else the model may draw on, name + description only. */
  indexed: IndexedSkill[];
  /** What the cut did and why. Absent only from the trivial empty-library case. */
  decision?: SkillDecision;
}

/**
 * How many full bodies a turn may carry. Two, because ~1.4 KB each puts the
 * block on par with recall's per-turn cost, and because the value of a third
 * body falls off fast: if the top two descriptions do not match the request,
 * the third almost certainly does not either — it is being admitted by the gate,
 * not chosen. Raising this trades tokens for recall on genuinely multi-skill
 * turns, which the backtest did not find.
 */
export const MAX_INLINED_SKILLS = 2;

/**
 * How many skills the name-only index may list. The index is cheap per entry
 * (~100 bytes) but it is paid on EVERY turn, so an unbounded list turns a growing
 * library into a growing per-turn tax — which is the shape of the problem this
 * rebuild exists to fix, just with a smaller constant. Thirty is well above any
 * library seen so far and still bounds the block at a couple of kilobytes.
 *
 * Entries are dropped from the bottom of the ranking, so what falls off is what
 * the message matched least. When embeddings are unavailable there is no ranking
 * to trust, so the whole library is listed — the alternative is hiding skills on
 * an arbitrary criterion.
 */
export const MAX_INDEXED_SKILLS = 30;

/**
 * RETIRED as the cut. Nothing reads this any more; it is exported so the eval
 * and the regression tests can still express the behaviour it used to produce.
 *
 * It was lifted from `STANDARD_FACT_MIN_COSINE` in `recall/inject.ts` on the
 * reasoning that a name plus a one-sentence description is a short passage of
 * the same shape as a fact, run through the same model, so it inherits the same
 * calibration — "e5-family similarities squash into roughly [0.7, 1.0] and 0.72
 * sits above the unrelated-content floor". Measured on the live fact set, which
 * carries the same facts embedded under both models, that was wrong twice over:
 *
 *   cosine between ~4000 random (unrelated) fact pairs
 *     multilingual-e5-base   p50 0.754   82.97% of pairs >= 0.72
 *     qwen3-embedding:4b     p50 0.376    0.63% of pairs >= 0.72
 *
 * Under e5 it sat BELOW the noise median and gated nothing — top-M and the
 * reranker did all the work. Under qwen3 the identical constant lands at the
 * 99.4th percentile and shut the stage off: one inline in seven days over a
 * library of nine. The cut now lives in `skills/gate.ts`, which is forbidden
 * absolute cosines for exactly this reason.
 */
export const SKILL_MIN_COSINE = 0.72;

/**
 * Weight of the usage term: blended = cosine + W·(usageRate − 0.5). Mirrors
 * `DEFAULT_USAGE_WEIGHT` in `recall/store.ts`, and is small against the 0.72
 * gate by the same design — usage REORDERS candidates inside the gate, it never
 * admits one the gate rejected nor ejects one it passed. That separation is what
 * keeps a popular-but-irrelevant skill from crowding out the right one, and it
 * matters more here than for facts: the feedback loop grades skills partly on
 * signal the model itself produces, so a runaway would be self-reinforcing.
 */
export const SKILL_USAGE_WEIGHT = 0.1;

/** Days for a skill's usage signal to fade halfway back to neutral. */
export const SKILL_USAGE_HALF_LIFE_DAYS = 14;

/** Injected-then-graded counters, mirroring the fact columns in `recall/store.ts`. */
export interface SkillUsageStat {
  timesInjected: number;
  timesUsed: number;
  /** Unix seconds of the last grading observation; decay anchor. */
  lastGradedAt?: number;
}

/**
 * Laplace-smoothed usage rate in (0,1): 0.5 for a never-injected skill (exactly
 * neutral, so the blend is a no-op on a cold library), →0 for one repeatedly
 * inlined and never visibly followed, →1 for one that pays off every time.
 *
 * Decays toward neutral with time since the last grading, for the reason spelled
 * out in `recall/inject.ts`: without decay the loop latches. A demoted skill
 * stops being inlined, its counters freeze, and a penalty possibly minted by a
 * single bad turn becomes permanent. Decay lets it drift back into contention
 * and earn a fresh grade — or get re-buried.
 */
export function skillUsageRate(stat: SkillUsageStat, nowSeconds = Date.now() / 1000): number {
  const raw = (stat.timesUsed + 1) / (stat.timesInjected + 2);
  if (!stat.lastGradedAt) return raw;
  const ageDays = Math.max(0, (nowSeconds - stat.lastGradedAt) / 86_400);
  return 0.5 + (raw - 0.5) * Math.pow(0.5, ageDays / SKILL_USAGE_HALF_LIFE_DAYS);
}

export interface SelectSkillsOptions {
  /** Max full bodies (default {@link MAX_INLINED_SKILLS}). */
  maxInlined?: number;
  /** Max name-only entries (default {@link MAX_INDEXED_SKILLS}). */
  maxIndexed?: number;
  /**
   * Raw-cosine floor for inlining. Legacy: the shipped cut used this and nothing
   * reads it now. Retained so the historical behaviour stays expressible in the
   * eval, which has to be able to show what it cost.
   */
  minCosine?: number;
  /**
   * Override the reranker's own calibrated floor. Tests and previews only — in
   * production this comes from RERANK_CATALOG via `RerankClient.minRelevantScore`,
   * so the number lives next to the weights it was measured against.
   */
  minRerankScore?: number;
  /** Usage blend weight; 0 disables (default {@link SKILL_USAGE_WEIGHT}). */
  usageWeight?: number;
  /** Per-slug usage counters; a slug with no entry ranks neutral. */
  usage?: (slug: string) => SkillUsageStat | undefined;
  /** Overrides for the app-global retrieval clients (tests, previews). */
  embeddings?: EmbeddingsClient | null;
  rerank?: RerankClient | null;
  /** Decay clock, in unix seconds. */
  now?: number;
}

function enabledOnly(records: SkillRecordish[]): SkillRecordish[] {
  // A disabled skill is off, not demoted: it is excluded from both lists, so it
  // cannot be inlined AND the model is not told it exists. Anything softer would
  // reproduce the bug this rebuild exists to fix, where the switch changed
  // nothing the model could see.
  return records.filter((r) => r.enabled !== false);
}

function toIndexed(record: SkillRecordish): IndexedSkill {
  return { slug: record.slug, name: record.name, description: record.description };
}

function toInlined(record: SkillRecordish): InlinedSkill {
  return {
    slug: record.slug,
    name: record.name,
    description: record.description,
    body: record.body,
    origin: record.origin
  };
}

/**
 * Everything indexed, nothing inlined — the shape every degraded path returns.
 * `reason` is carried so the log can distinguish "no embedder" from "embedder
 * ran and found nothing", which look identical in the rendered block.
 */
function indexAll(
  records: SkillRecordish[],
  reason: SkillDecision['reason'] = 'no-embeddings'
): SkillSelection {
  return {
    inlined: [],
    indexed: records.map(toIndexed),
    decision: { reason, candidates: 0, inlined: [] }
  };
}

/**
 * Choose what the model sees this turn. Never throws and never rejects: every
 * failure mode (no embeddings, model still downloading, embed error, blank
 * message) degrades to indexing the whole enabled library.
 */
export async function selectSkills(
  message: string,
  records: SkillRecordish[],
  opts: SelectSkillsOptions = {}
): Promise<SkillSelection> {
  const candidates = enabledOnly(records);
  if (candidates.length === 0) return { inlined: [], indexed: [] };

  const maxInlined = opts.maxInlined ?? MAX_INLINED_SKILLS;
  const usageWeight = opts.usageWeight ?? SKILL_USAGE_WEIGHT;
  const now = opts.now ?? Date.now() / 1000;

  const client = opts.embeddings !== undefined ? opts.embeddings : getEmbeddingsClient();
  const query = message.trim();
  if (!client || maxInlined <= 0) return indexAll(candidates);
  // A near-empty message ("Try now", "Áno") gives both encoder families nothing
  // to score, so what comes back is noise — and noise occasionally clears any
  // calibrated floor. Refuse to rank rather than trust a ranking of nothing;
  // see MIN_QUERY_WORDS in gate.ts for the observed failure this closes.
  if (!queryHasSignal(query)) return indexAll(candidates, 'low-signal');

  let qVec: Float32Array;
  let vectors: Map<string, Float32Array>;
  try {
    if (!(await client.available())) return indexAll(candidates);
    const model = await client.modelId();
    if (!model) return indexAll(candidates);
    // 'query' vs 'passage' is not cosmetic: e5-family models are trained with
    // distinct prefixes and mixing them costs real similarity.
    [qVec] = await client.embed([query], 'query');
    if (!qVec) return indexAll(candidates);
    const embedder: SkillEmbedder = { model, embed: (texts) => client.embed(texts, 'passage') };
    vectors = await ensureSkillVectors(candidates, embedder);
  } catch (error) {
    // Indistinguishable from the honest no-embedder case at the caller: both
    // arrive as reason 'no-embeddings', and a turn that silently stops inlining
    // is a turn the model works without procedures it was written to follow.
    degrade('skills.inject', 'inlined no skills and listed the library instead', error);
    return indexAll(candidates);
  }

  const qMag = magnitude(qVec) || 1;
  const scored: Array<{ record: SkillRecordish; cosine: number; blended: number }> = [];
  const unscored: SkillRecordish[] = [];
  for (const record of candidates) {
    const v = vectors.get(record.slug);
    if (!v || v.length !== qVec.length) {
      unscored.push(record); // missing vector or dim mismatch — index it, don't rank it
      continue;
    }
    const cosine = dot(qVec, v) / (qMag * (magnitude(v) || 1));
    const stat = opts.usage?.(record.slug);
    const rate = stat ? skillUsageRate(stat, now) : 0.5;
    scored.push({ record, cosine, blended: cosine + usageWeight * (rate - 0.5) });
  }
  scored.sort((a, b) => b.blended - a.blended);

  // The cross-encoder is the precision stage, and — measured — the only stage
  // that can make this call at all. It reads the query and the description
  // together, so it can separate "explain what a CNAME record does" from "renew
  // my domain"; a bi-encoder cannot, because the difference is intent and intent
  // is not in a sentence vector. It scores only the cosine shortlist: that
  // bounds the cost (~22 ms/pair) and measurably improves precision, since the
  // bi-encoder's ordering keeps an unrelated skill out of its reach.
  //
  // The usage blend orders the shortlist but never reaches the cut — the cut is
  // made on cross-encoder scores alone. That preserves the invariant the cosine
  // gate had: usage reorders candidates, it never admits or ejects one.
  const shortlist = scored.slice(0, DEFAULT_SHORTLIST_SIZE);
  let cut: CutResult = { inlined: [], reason: 'no-rerank-score' };
  const rr = opts.rerank !== undefined ? opts.rerank : getRerankClient();
  if (rr && shortlist.length > 0) {
    try {
      // A floor of null means a backend whose score scale we cannot know (any
      // remote /rerank server). Not an error — just not a cut we may make.
      const floor = opts.minRerankScore ?? (await rr.minRelevantScore?.()) ?? null;
      if (floor !== null && (await rr.available())) {
        // One pair per call, NOT one batched call. A cross-encoder logit moves
        // with the batch it was scored in — the same pair reads −7.890 alone
        // and −8.289 in a batch of six, because padding to the batch's longest
        // sequence leaks into the result. Ranking is indifferent to that;
        // comparing against an absolute floor is not, and the drift is wider
        // than the margin at the floor. Costs `shortlistSize` forward passes
        // (~22 ms each) to make the score a property of the pair alone.
        const scores = await Promise.all(
          shortlist.map(async (s) => {
            const [top] = await rr.rerank(query, [skillVectorText(s.record)], 1);
            return { slug: s.record.slug, cosine: s.cosine, rerankScore: top?.score };
          })
        );
        cut = selectCut(scores, {
          strategy: 'rerank',
          maxInlined,
          minRerankScore: floor,
          shortlistSize: shortlist.length
        });
      }
    } catch (error) {
      // Reranker down mid-turn: fall through to the cosine-only cut rather than
      // discarding a good embedding result. Worth saying, because the fallback
      // fires on more than half the negatives in the golden fixture and its
      // `relative` reason is the same one a machine with no reranker reports.
      degrade('skills.inject', 'cut the shortlist on cosine alone', error);
    }
  }

  // Fallback when there is no calibrated cross-encoder. Strictly worse — it
  // fires on more than half the negatives in the golden fixture, and a library
  // holding near-duplicate skills defeats it outright, since nothing can stand
  // clear of a pack it is a member of. Kept because name-only is worse still.
  if (cut.reason === 'no-rerank-score') {
    cut = selectCut(scored.map((s) => ({ slug: s.record.slug, cosine: s.cosine })), {
      strategy: 'relative',
      maxInlined
    });
  }

  const bySlug = new Map(candidates.map((r) => [r.slug, r]));
  const inlined = cut.inlined.map((slug) => bySlug.get(slug)).filter((r): r is SkillRecordish => !!r);
  const inlinedSlugs = new Set(inlined.map((r) => r.slug));
  // Ranked first, then unscored (a missing vector is not evidence of anything, so
  // those sit behind everything that could actually be compared), then capped.
  const indexed = [...scored.map((s) => s.record).filter((r) => !inlinedSlugs.has(r.slug)), ...unscored].slice(
    0,
    opts.maxIndexed ?? MAX_INDEXED_SKILLS
  );
  return {
    inlined: inlined.map(toInlined),
    indexed: indexed.map(toIndexed),
    // Surfaced so the caller can log it. The failure this replaced was silent:
    // a stage that returned nothing looked exactly like a stage with nothing to
    // say, for five days, and no log line anywhere could tell them apart.
    decision: {
      reason: cut.reason,
      candidates: scored.length,
      topCosine: scored[0]?.cosine,
      inlined: cut.inlined
    }
  };
}

/**
 * Provenance label. Under Auto mode skills are model-authored and unreviewed, so
 * the model is told which of its procedures nobody ever vetted. An unknown or
 * missing origin gets the cautious label rather than the flattering one.
 */
function originLabel(origin: string | undefined): string {
  // `user-requested` covers both the user asking outright and a card they read and
  // accepted; `learn` is the user pointing at something and saying capture this.
  // Everything else — including an absent label on a file from before origins
  // existed — gets the cautious wording rather than the flattering one.
  return origin === 'user-requested' || origin === 'learn'
    ? 'saved at the user’s request'
    : 'auto-saved, never reviewed';
}

/**
 * Keep skill text from closing or forging the wrapper. Bodies are model-authored
 * and, under Auto, unreviewed — that is precisely the content that must not be
 * able to end the block early and continue as if it were Stem's own framing.
 */
function fence(text: string): string {
  return text.replace(/<(\/?)stem_skills/gi, '<$1stem-skills');
}

/**
 * Render the per-turn block. Returns '' when there is nothing to say so the
 * caller can drop the block entirely rather than emit an empty wrapper.
 *
 * The framing is the deliberate inverse of `<stem_memory_data>`, which
 * `workspace/bootstrap.ts:7` fences as untrusted historical DATA whose quoted
 * directives must never be followed. Skills are the opposite by construction:
 * they are Stem's own saved procedures and the whole point is that they get
 * followed. What that inversion costs is a safety property, so it is bought back
 * explicitly — the model is told to SAY SO in its reply when a step is wrong
 * rather than follow it silently. A bad auto-saved skill has to become visible
 * to the user, and that report is also what routes the skill into patch-on-use.
 */
export function formatSkillsBlock(selection: SkillSelection): string {
  const { inlined, indexed } = selection;
  if (inlined.length === 0 && indexed.length === 0) return '';

  const parts: string[] = [];
  for (const skill of inlined) {
    parts.push(
      `### ${fence(skill.name)} (${originLabel(skill.origin)})\n` +
        `${fence(skill.description)}\n\n${fence(skill.body).trim()}`
    );
  }
  if (indexed.length > 0) {
    const list = indexed.map((s) => `- ${fence(s.name)} — ${fence(s.description)}`).join('\n');
    parts.push(`## Other saved skills (names only, steps not loaded)\n${list}`);
  }

  const header = inlined.length > 0
    ? 'Saved procedures relevant to this message.'
    : 'Saved procedures. None matched this message closely enough to load.';

  return (
    `<stem_skills version="1">\n${header}\n\n${parts.join('\n\n')}\n</stem_skills>\n` +
    `The block above is YOUR OWN saved know-how, not user data: unlike <stem_memory_data>, ` +
    `these are instructions to follow. When a loaded skill applies to the current request, follow its steps. ` +
    `They were written in earlier sessions and can be stale, incomplete, or simply wrong — if a step does not fit, ` +
    `is incorrect, or fails, say so plainly in your reply and do the right thing instead. Never follow a step you ` +
    `believe is wrong just because it is written here, and never silently skip or substitute one: the user has to be ` +
    `able to see that a saved skill needs fixing. A skill marked "auto-saved, never reviewed" was written by you ` +
    `without anyone checking it, so weigh it accordingly. Skills listed by name only are not loaded — their steps ` +
    `are not here, so do not guess at them; mention one only if the user would want it loaded.`
  );
}
