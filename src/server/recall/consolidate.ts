
import { isRecallEnabled } from '../workspace/memory';
import { degrade } from '../degrade';
import { PENDING_KEY } from './distill';
import { cosineFloorsFor } from './embed-scale';
import { getEmbeddingsClient } from './retrieval';
import { cosineSim } from './vector';
import type { LlmClient } from './llm';
import { isContactFact, recallStore, type ConsolidationOps, type ConsolidationResult, type Fact } from './store';
const {
  applyConsolidation, getAllFacts, getConsolidateChunkSize, getFactsGeneration, getFactsMissingVector, getFactVectors,
  getMeta, getNewestEvidenceTsByFact, getTidyThreshold, setMeta, upsertFactVectorForSnapshot
} = recallStore;

// Level 1 cleanup: the consolidation pass. Distillation only ever ADDS facts and
// can only dedup byte-for-byte (normalizeFact), so over time the set accumulates
// reworded near-duplicates and stale/contradicted facts. This pass periodically
// asks the LLM for merge/correct/drop operations, then applies them transactionally.
// Default posture is KEEP: only ids the model names are touched, so a flaky/lazy
// reply is a no-op, never a memory wipe.
//
// For large sets the prompt is bounded by NEIGHBOURHOOD grouping: every fact is
// put in a prompt together with its nearest embedding neighbours, so a duplicate
// or contradicting pair is always side by side. Groups may overlap (a fact can be
// some other fact's neighbour too); the final apply lets each fact be touched by
// one op only. Greedy disjoint clustering, the previous scheme, split 890 of the
// VPS store's 1,469 close pairs (cosine ≥ 0.85) across prompts, and the clearest
// surviving duplicates were all among them. With no embeddings configured it
// falls back to sequential size-chunks (still bounded, best effort). Each group
// is clamped independently, against MAX_DROP_FRACTION of its own size.
//
// Two scopes. 'recent' (the automatic pass after new facts arrive) reviews only
// the facts added since the last pass, each with its neighbours; 'full' (the
// Tidy up button, and automatically once the store has grown by a quarter
// since the last full pass) reviews every fact. Folder
// facts never enter either: they are condensed document contents, not things
// the user said, sit below the injection floor, and their documents are
// searchable on their own — on the VPS they were a third of every pass.

// Below this many facts there's nothing worth consolidating.
const MIN_FACTS = 6;
// Reject a chunk's ops if its DROPS alone would retire more than this fraction —
// a cheap guard against the model nuking memory. Merge losers are deliberately
// exempt: a merge is content-preserving (the survivor's text subsumes the losers)
// and, since v2, reversible (losers are superseded, not deleted) — and a store full
// of migration-era duplicates legitimately needs >40% of a chunk merged away.
const MAX_DROP_FRACTION = 0.4;
// A duplicate cluster is a handful of rewordings; a merge swallowing more ids than
// this is a model gone wild, so the group is rejected (left for a later pass).
const MAX_MERGE_GROUP = 8;

const INSTRUCTIONS = `You are cleaning up a long-term memory of DURABLE facts about a single user and the people and things in their life. Each fact is listed as "[id] text". Some are reworded duplicates of each other; some have been superseded or contradicted by a later, more accurate fact. Your job is to propose a minimal set of edits that makes the memory accurate and non-redundant.

Return ONLY a JSON object (no prose, no markdown fences) with this shape:
{
  "merge":   [{"ids": [<ids of facts that say the same thing>], "text": "<the single best combined wording>"}],
  "correct": [{"id": <id>, "text": "<corrected wording>"}],
  "drop":    [<ids of facts made redundant or false by another fact>]
}

Rules:
- DEFAULT TO KEEP. Only act on facts you are confident are duplicates, superseded, or wrong. If unsure, leave a fact out of all three lists.
- merge: group facts that express the SAME underlying fact (rewordings, or one subsuming another). Give the cleanest single statement as "text". Do not merge facts that are merely related but distinct.
- correct: only when a fact is factually wrong given a later fact — keep the corrected truth.
- drop: only a fact another fact already fully covers or directly contradicts, OR a fact about a one-off dated event (a trip, reservation, appointment, deadline) whose date is clearly in the past. A fact without a date is never stale — keep it.
- When two facts directly contradict, keep the one with the later evidence date — unless a date stated inside the text says otherwise (evidence dates are message times and can lie).
- A fact annotated "(injected N×, never used)" has repeatedly been offered to the assistant without ever mattering to a reply. Treat that as SUPPORTING evidence when deciding whether it is redundant or stale — but usage alone is NEVER a reason to drop a fact that is unique and plausibly true.
- NEVER drop, merge, or alter a fact marked PROTECTED — the user explicitly asked to remember it.
- Keep wording as short third-person statements, and keep each fact's subject: "The user ..." for the user, the person's or thing's name for anyone or anything else. Facts about different subjects are never duplicates of each other.
- If nothing needs changing, return {"merge":[],"correct":[],"drop":[]}.`;

const EMPTY_OPS: ConsolidationOps = { merge: [], correct: [], drop: [] };

function isProtected(f: Fact): boolean {
  return f.source === 'explicit';
}

/** The facts tidy-up is responsible for: active, and not condensed from a folder document. */
function tidyPool(facts: Fact[]): Fact[] {
  return facts.filter((f) => f.status === 'active' && !f.source.startsWith('folder:') && !isContactFact(f));
}

/**
 * Each fact's nearest neighbours that must share a prompt with it, among those
 * at or above the embedder's strongRaw floor (Gemma 2: 0.72). On the VPS store
 * (733 chat facts) 3 neighbours above that floor puts every pair at cosine
 * ≥ 0.88 side by side in 34 prompts; 5 neighbours cost 47 for one more pair.
 */
const TIDY_NEIGHBOURS = 3;
/**
 * The automatic pass widens to the whole store once the facts learned since the
 * last full pass reach this share of the store. Paced by learning, not the
 * clock: a week offline costs nothing, and someone writing hundreds of messages
 * a day gets proportionally more passes. On the VPS store (~730 chat facts,
 * ~25 new a day) that is roughly one full pass a week.
 */
const FULL_TIDY_GROWTH = 0.25;
/** `<facts generation>:<highest fact id at the last full pass>`. */
const FULL_TIDY_KEY = 'consolidate_full_watermark';
/** `<facts generation>:<highest fact id reviewed>` — ids restart after a reset. */
const SEED_WATERMARK_KEY = 'consolidate_seed_watermark';

export type TidyScope = 'recent' | 'full';

/**
 * Is a whole-store pass due? Yes on the first pass ever, then whenever enough
 * new facts have been learned since the last one (FULL_TIDY_GROWTH). Retired
 * facts count as learned: churn is new material too. Never when auto tidy-up is off.
 */
export function fullTidyDue(): boolean {
  const threshold = getTidyThreshold();
  if (threshold === 0) return false;
  const all = getAllFacts().filter((f) => !f.source.startsWith('folder:') && !isContactFact(f));
  const active = all.filter((f) => f.status === 'active').length;
  if (active < MIN_FACTS) return false;
  const last = readWatermark(FULL_TIDY_KEY, getFactsGeneration());
  if (last === 0) return true;
  const learned = all.filter((f) => f.id > last).length;
  return learned >= Math.max(threshold, Math.ceil(active * FULL_TIDY_GROWTH));
}

function readWatermark(key: string, factsGeneration: number): number {
  const [gen, id] = (getMeta(key) ?? '').split(':').map((n) => Number.parseInt(n, 10));
  return gen === factsGeneration && Number.isFinite(id) ? id : 0;
}

/** Parse the model's reply into consolidation ops. Defensive: any malformation → no-op. */
export function parseConsolidation(output: string): ConsolidationOps {
  const trimmed = output.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return { ...EMPTY_OPS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch (error) {
    // Empty ops are also how the model says "nothing needs changing", and the
    // caller believes it: the chunk counts as reviewed, the pending counter is
    // cleared, and a model that never returns JSON simply retires consolidation.
    degrade('recall.consolidate', 'read the reply as no changes', error);
    return { ...EMPTY_OPS };
  }
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY_OPS };
  const obj = parsed as Record<string, unknown>;

  const merge: ConsolidationOps['merge'] = [];
  if (Array.isArray(obj.merge)) {
    for (const m of obj.merge) {
      if (!m || typeof m !== 'object') continue;
      const ids = (m as { ids?: unknown }).ids;
      const text = (m as { text?: unknown }).text;
      if (Array.isArray(ids) && typeof text === 'string') {
        const cleanIds = ids.filter((n): n is number => Number.isInteger(n));
        if (cleanIds.length >= 2 && text.trim()) merge.push({ ids: cleanIds, text });
      }
    }
  }
  const correct: ConsolidationOps['correct'] = [];
  if (Array.isArray(obj.correct)) {
    for (const c of obj.correct) {
      if (!c || typeof c !== 'object') continue;
      const id = (c as { id?: unknown }).id;
      const text = (c as { text?: unknown }).text;
      if (Number.isInteger(id) && typeof text === 'string' && text.trim()) {
        correct.push({ id: id as number, text });
      }
    }
  }
  const drop: number[] = [];
  if (Array.isArray(obj.drop)) {
    for (const id of obj.drop) if (Number.isInteger(id)) drop.push(id as number);
  }
  return { merge, correct, drop };
}

/**
 * Strip any op touching a PROTECTED id, reject oversized merge groups, then reject
 * the entire batch (return empty ops) if its drops alone would retire more than
 * MAX_DROP_FRACTION of the set. `total` is the current fact count; `protectedIds`
 * the set the model must never touch.
 */
export function clampOps(
  ops: ConsolidationOps,
  protectedIds: Set<number>,
  total: number,
  allowedIds?: Set<number>
): ConsolidationOps {
  const allowed = (id: number) => !protectedIds.has(id) && (!allowedIds || allowedIds.has(id));
  const claimed = new Set<number>();
  const merge: ConsolidationOps['merge'] = [];
  for (const candidate of ops.merge) {
    const uniqueIds = new Set(candidate.ids);
    // Validate the group as one operation. Filtering a protected, unknown,
    // duplicated, or already-claimed id could turn a malformed proposal into a
    // different valid-looking merge that the model never actually requested.
    if (
      candidate.ids.length < 2 ||
      candidate.ids.length > MAX_MERGE_GROUP ||
      uniqueIds.size !== candidate.ids.length ||
      candidate.ids.some((id) => !allowed(id) || claimed.has(id))
    ) continue;
    merge.push(candidate);
    for (const id of candidate.ids) claimed.add(id);
  }

  const correct: ConsolidationOps['correct'] = [];
  for (const candidate of ops.correct) {
    if (!allowed(candidate.id) || claimed.has(candidate.id)) continue;
    correct.push(candidate);
    claimed.add(candidate.id);
  }

  const drop: number[] = [];
  for (const id of ops.drop) {
    if (!allowed(id) || claimed.has(id)) continue;
    drop.push(id);
    claimed.add(id);
  }

  if (total > 0 && drop.length / total > MAX_DROP_FRACTION) return { ...EMPTY_OPS };

  return { merge, correct, drop };
}

/** A fact must fail this often before its disuse is worth telling the model. */
const NEVER_USED_MIN_INJECTIONS = 5;

export function buildPrompt(facts: Fact[], evidenceTs?: Map<number, number>): string {
  const lines = facts
    .map((f) => {
      // Evidence date, not updated_at: consolidation itself bumps updated_at, so
      // only the newest evidence row says when a fact was actually last asserted.
      // Without a date per line, the "later, more accurate fact" and stale-event
      // rules have nothing to stand on but id order — which is wrong whenever an
      // old fact was re-asserted after a newer-id one.
      const ts = evidenceTs?.get(f.id);
      const dated = ts != null ? ` (evidence dated ${new Date(ts * 1000).toISOString().slice(0, 10)})` : '';
      const neverUsed = f.timesInjected >= NEVER_USED_MIN_INJECTIONS && f.timesUsed === 0;
      const marks = `${isProtected(f) ? '  (PROTECTED)' : ''}${neverUsed ? `  (injected ${f.timesInjected}×, never used)` : ''}`;
      return `[${f.id}]${dated} ${f.text}${marks}`;
    })
    .join('\n');
  const today = new Date().toISOString().slice(0, 10);
  return `${INSTRUCTIONS}\n\nToday's date: ${today}.\n\nFacts:\n${lines}`;
}

const ZERO: ConsolidationResult = { merged: 0, corrected: 0, dropped: 0, failedChunks: 0 };

// Manual tidy-up and the post-distill automatic pass can be requested at the
// same time. Serialize their model snapshots through final apply so one pass can
// never partially reinterpret a merge after the other retires a member.
let consolidationQueue: Promise<void> = Promise.resolve();

export function consolidateFacts(
  llm: LlmClient,
  opts: { force?: boolean; scope?: TidyScope } = {}
): Promise<ConsolidationResult> {
  const run = consolidationQueue.then(
    () => runConsolidation(llm, opts),
    () => runConsolidation(llm, opts)
  );
  consolidationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Even-sized chunk target so a large set splits into balanced chunks (no tiny tail). */
function chunkTarget(total: number, max: number): number {
  const n = Math.max(1, Math.ceil(total / max));
  return Math.ceil(total / n);
}

function sizeChunks(facts: Fact[], size: number): Fact[][] {
  const out: Fact[][] = [];
  for (let i = 0; i < facts.length; i += size) out.push(facts.slice(i, i + size));
  return out;
}

/**
 * Neighbourhood groups: each seed's "star" (the seed plus its TIDY_NEIGHBOURS
 * nearest pool facts at ≥ `floor`) goes into one group, so every
 * seed-neighbour pair shares a prompt. A star brings only the neighbours not
 * already sharing a group with its seed, and a seed already placed with all of
 * them adds nothing. Stars are visited breadth-first along the neighbour graph
 * and packed into the open group while the union fits, which keeps related
 * stars together.
 */
function neighbourhoodGroups(
  seeds: Fact[],
  pool: Fact[],
  vectors: Map<number, Float32Array>,
  size: number,
  floor: number
): Fact[][] {
  const byId = new Map(pool.map((f) => [f.id, f]));
  const pooled = pool.filter((f) => vectors.has(f.id));
  const k = Math.min(TIDY_NEIGHBOURS, size - 1);
  const stars = new Map<number, number[]>();
  for (const seed of seeds) {
    const sv = vectors.get(seed.id);
    if (!sv) continue;
    const near = pooled
      .filter((f) => f.id !== seed.id)
      .map((f) => ({ id: f.id, score: cosineSim(sv, vectors.get(f.id)!) }))
      .filter((n) => n.score >= floor)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((n) => n.id);
    stars.set(seed.id, [seed.id, ...near]);
  }

  const groups: Fact[][] = [];
  let open = new Set<number>();
  // Group indexes each fact belongs to; the open group is index groups.length.
  const memberOf = new Map<number, Set<number>>();
  const together = (a: number, b: number): boolean => {
    const ga = memberOf.get(a);
    const gb = memberOf.get(b);
    return !!ga && !!gb && [...ga].some((g) => gb.has(g));
  };
  const place = ([seed, ...near]: number[]): void => {
    const missing = near.filter((id) => !together(seed, id));
    if (missing.length === 0 && memberOf.has(seed)) return;
    const star = [seed, ...missing];
    const union = new Set([...open, ...star]);
    if (union.size > size && open.size > 0) {
      groups.push([...open].map((id) => byId.get(id)!));
      open = new Set(star);
    } else {
      open = union;
    }
    for (const id of open) {
      const set = memberOf.get(id) ?? new Set<number>();
      set.add(groups.length);
      memberOf.set(id, set);
    }
  };
  const visited = new Set<number>();
  for (const first of stars.keys()) {
    if (visited.has(first)) continue;
    const queue = [first];
    visited.add(first);
    while (queue.length > 0) {
      const star = stars.get(queue.shift()!)!;
      place(star);
      for (const id of star) {
        if (stars.has(id) && !visited.has(id)) {
          visited.add(id);
          queue.push(id);
        }
      }
    }
  }
  if (open.size > 0) groups.push([...open].map((id) => byId.get(id)!));
  // Seeds without a vector (an embedding gap) still get reviewed, via size-chunks.
  const without = seeds.filter((f) => !vectors.has(f.id));
  if (without.length > 0) groups.push(...sizeChunks(without, size));
  return groups;
}

/** Split the seeds into bounded prompts: neighbourhood groups when embeddings are available. */
async function groupFacts(seeds: Fact[], pool: Fact[], factsGeneration: number): Promise<Fact[][]> {
  const size = getConsolidateChunkSize();
  const emb = getEmbeddingsClient();
  if (!emb || !(await emb.available())) return sizeChunks(seeds, chunkTarget(seeds.length, size));
  if (getFactsGeneration() !== factsGeneration) return [];
  try {
    const model = (await emb.modelId()) ?? '';
    if (getFactsGeneration() !== factsGeneration) return [];
    const missing = getFactsMissingVector(model);
    if (missing.length > 0) {
      const vecs = await emb.embed(
        missing.map((f) => f.text),
        'passage'
      );
      // A reset may reuse integer fact ids. Never attach vectors calculated for
      // the pre-reset rows to newly-created rows that happen to reuse those ids.
      if (getFactsGeneration() !== factsGeneration) return [];
      missing.forEach((f, i) =>
        upsertFactVectorForSnapshot(f.id, f.text, factsGeneration, model, vecs[i])
      );
    }
    return neighbourhoodGroups(seeds, pool, getFactVectors(model), size, cosineFloorsFor(model).strongRaw);
  } catch {
    // quiet: the size-chunk fallback still puts every seed in front of the
    // model — only the grouping that would have put a duplicate pair in the
    // same prompt is lost, and the next pass groups from scratch.
    return sizeChunks(seeds, chunkTarget(seeds.length, size)); // endpoint hiccup → still bounded, best effort
  }
}

/**
 * Run one consolidation pass over the durable facts. Returns counts of what
 * changed. Always resets the pending counter when it actually ran the model (so a
 * no-change result doesn't re-trigger immediately), but NOT when the model call
 * threw — those messages should be retried next cycle.
 *
 * `force` (the Tidy up button) bypasses the size floor and always reviews the
 * whole store; otherwise `scope` picks recent (default) or full.
 */
async function runConsolidation(
  llm: LlmClient,
  opts: { force?: boolean; scope?: TidyScope } = {}
): Promise<ConsolidationResult> {
  if (!isRecallEnabled()) return ZERO;
  const factsGeneration = getFactsGeneration();
  const facts = tidyPool(getAllFacts());
  // The automatic pass skips small sets (nothing worth a model call); a manual
  // trigger (`force`) still needs at least two facts to merge anything.
  if (facts.length < (opts.force ? 2 : MIN_FACTS)) return ZERO;
  const full = opts.force || opts.scope === 'full';
  const highestId = Math.max(...facts.map((f) => f.id));
  const watermark = readWatermark(SEED_WATERMARK_KEY, factsGeneration);
  const seeds = full ? facts : facts.filter((f) => f.id > watermark);
  // Stamped up front, failures included: a group the model keeps failing must
  // not re-run the whole store on every distill cycle. New facts it missed are
  // still behind the watermark for the next recent pass.
  if (full) setMeta(FULL_TIDY_KEY, `${factsGeneration}:${Math.max(...getAllFacts().map((f) => f.id))}`);
  if (seeds.length === 0) {
    setMeta(PENDING_KEY, '0');
    return ZERO;
  }

  // One prompt while small; neighbourhood groups once the set is large.
  const chunks = facts.length <= getConsolidateChunkSize() ? [facts] : await groupFacts(seeds, facts, factsGeneration);
  if (getFactsGeneration() !== factsGeneration) return ZERO;
  const protectedIds = new Set(facts.filter(isProtected).map((f) => f.id));
  const evidenceTs = getNewestEvidenceTsByFact();

  const reviewedChunks: Array<{
    ops: ConsolidationOps;
    allowedIds: Set<number>;
    expectedText: Map<number, string>;
    total: number;
  }> = [];
  let failedChunks = 0;
  for (const chunk of chunks) {
    let chunkOps: ConsolidationOps;
    try {
      chunkOps = parseConsolidation(await llm.complete(buildPrompt(chunk, evidenceTs)));
    } catch (error) {
      if (getFactsGeneration() !== factsGeneration) return ZERO;
      // failedChunks holds the pending counter back so the chunk is retried, but
      // it reaches nobody: the activity row for a pass where every chunk failed
      // reads "Merged 0, corrected 0, dropped 0" — a healthy tidy-up's wording.
      degrade('recall.consolidate', 'left the chunk for a later cycle', error);
      failedChunks += 1; // leave this chunk for a later cycle
      continue;
    }
    // Reset is a cancellation barrier. In particular, integer ids may already
    // belong to new post-reset facts by the time this model reply arrives.
    if (getFactsGeneration() !== factsGeneration) return ZERO;
    // Clamp per chunk against its own size: bounds the model's blast radius to
    // MAX_DROP_FRACTION of each chunk, which bounds the aggregate to the same
    // fraction of the whole set — no brittle all-or-nothing global rejection.
    // Treat the prompt's ids as a capability boundary. A model must never be
    // able to name and mutate a fact it was not shown in this chunk.
    const allowedIds = new Set(chunk.map((fact) => fact.id));
    const clamped = clampOps(chunkOps, protectedIds, chunk.length, allowedIds);
    reviewedChunks.push({
      ops: clamped,
      allowedIds,
      expectedText: new Map(chunk.map((fact) => [fact.id, fact.text])),
      total: chunk.length
    });
  }

  if (getFactsGeneration() !== factsGeneration) return ZERO;

  // Protection can change while the model is thinking (for example, the user
  // confirms a learned fact). Re-clamp each reviewed chunk at the final apply
  // boundary against the live protected set. Keeping each chunk's original
  // allowed-id set preserves both the prompt capability boundary and its local
  // blast-radius calculation.
  const currentFacts = getAllFacts();
  const currentProtectedIds = new Set(currentFacts.filter(isProtected).map((fact) => fact.id));
  const currentActiveById = new Map(currentFacts.filter((fact) => fact.status === 'active').map((fact) => [fact.id, fact]));
  const combined: ConsolidationOps = { merge: [], correct: [], drop: [] };
  for (const reviewed of reviewedChunks) {
    // IDs alone are insufficient: another mutation can retire or rewrite a row
    // without resetting the whole fact store. Restrict the final capability set
    // to members that are all still active and text-identical to the prompt.
    // clampOps rejects a merge atomically when even one member falls outside it.
    const finalAllowedIds = new Set(
      [...reviewed.allowedIds].filter((id) => {
        const current = currentActiveById.get(id);
        return !!current && current.text === reviewed.expectedText.get(id);
      })
    );
    const revalidated = clampOps(reviewed.ops, currentProtectedIds, reviewed.total, finalAllowedIds);
    combined.merge.push(...revalidated.merge);
    combined.correct.push(...revalidated.correct);
    combined.drop.push(...revalidated.drop);
  }

  // Groups overlap, so two of them can act on the same fact. First op wins;
  // a merge that loses any member to an earlier op is dropped whole. The
  // drop ceiling here is the whole pool's — each group was already held to
  // its own share above.
  const result = applyConsolidation(clampOps(combined, currentProtectedIds, facts.length));
  // Only clear the pending counter when every chunk ran — a failed chunk (model
  // error) should be retried next cycle rather than marked done.
  if (failedChunks === 0) {
    setMeta(PENDING_KEY, '0');
    setMeta(SEED_WATERMARK_KEY, `${factsGeneration}:${highestId}`);
  }
  return { ...result, failedChunks };
}
