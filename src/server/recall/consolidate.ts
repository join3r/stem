
import { isRecallEnabled } from '../workspace/memory';
import { degrade } from '../degrade';
import { PENDING_KEY } from './distill';
import { getEmbeddingsClient } from './retrieval';
import { cosineSim } from './vector';
import type { LlmClient } from './llm';
import { recallStore, type ConsolidationOps, type ConsolidationResult, type Fact } from './store';
const { applyConsolidation, getAllFacts, getConsolidateChunkSize, getFactsGeneration, getFactsMissingVector, getFactVectors, getNewestEvidenceTsByFact, setMeta, upsertFactVectorForSnapshot } = recallStore;

// Level 1 cleanup: the consolidation pass. Distillation only ever ADDS facts and
// can only dedup byte-for-byte (normalizeFact), so over time the set accumulates
// reworded near-duplicates and stale/contradicted facts. This pass periodically
// asks the LLM for merge/correct/drop operations, then applies them transactionally.
// Default posture is KEEP: only ids the model names are touched, so a flaky/lazy
// reply is a no-op, never a memory wipe.
//
// For large sets the prompt is bounded by SMART chunking: facts are grouped into
// similarity clusters (via the embeddings seam) so likely duplicates/contradictions
// land in the same prompt. Naive size-chunking would scatter a duplicate pair
// across two prompts and never merge them; clustering keeps them together. With no
// embeddings configured it falls back to sequential size-chunks (still bounded,
// best effort). Each chunk is clamped independently — which also bounds the
// aggregate removal to MAX_DROP_FRACTION of the whole set.

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

const INSTRUCTIONS = `You are cleaning up a long-term memory of DURABLE facts about a single user. Each fact is listed as "[id] text". Some are reworded duplicates of each other; some have been superseded or contradicted by a later, more accurate fact. Your job is to propose a minimal set of edits that makes the memory accurate and non-redundant.

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
- Keep wording as short third-person statements ("The user ...").
- If nothing needs changing, return {"merge":[],"correct":[],"drop":[]}.`;

const EMPTY_OPS: ConsolidationOps = { merge: [], correct: [], drop: [] };

function isProtected(f: Fact): boolean {
  return f.source === 'explicit';
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
  opts: { force?: boolean } = {}
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
 * Greedy similarity clustering: take the next unassigned fact as a seed and pull
 * in its nearest unassigned neighbours by cosine, up to `size`. Near-duplicates
 * (which are semantically close) therefore land in the same chunk where the model
 * can actually merge them. Deterministic — seeds are visited in id order.
 */
function greedyClusters(facts: Fact[], vectors: Map<number, Float32Array>, size: number): Fact[][] {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const withVec = facts.filter((f) => vectors.has(f.id));
  const without = facts.filter((f) => !vectors.has(f.id));
  const unassigned = new Set(withVec.map((f) => f.id));
  const chunks: Fact[][] = [];

  for (const seed of withVec) {
    if (!unassigned.has(seed.id)) continue;
    unassigned.delete(seed.id);
    const sv = vectors.get(seed.id)!;
    const neighbours = [...unassigned]
      .map((id) => ({ id, score: cosineSim(sv, vectors.get(id)!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, size - 1);
    for (const n of neighbours) unassigned.delete(n.id);
    chunks.push([seed, ...neighbours.map((n) => byId.get(n.id)!)]);
  }
  // Facts without a vector (e.g. an embedding gap) still get cleaned, via size-chunks.
  if (without.length > 0) chunks.push(...sizeChunks(without, size));
  return chunks;
}

/** Split facts into bounded chunks: similarity clusters when embeddings are available. */
async function chunkFacts(facts: Fact[], factsGeneration: number): Promise<Fact[][]> {
  const size = chunkTarget(facts.length, getConsolidateChunkSize());
  const emb = getEmbeddingsClient();
  if (!emb || !(await emb.available())) return sizeChunks(facts, size);
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
    return greedyClusters(facts, getFactVectors(model), size);
  } catch {
    // quiet: the size-chunk fallback still puts every fact in front of the
    // model — only the clustering that would have put a duplicate pair in the
    // same prompt is lost, and the next pass re-clusters from scratch.
    return sizeChunks(facts, size); // endpoint hiccup → still bounded, best effort
  }
}

/**
 * Run one consolidation pass over the durable facts. Returns counts of what
 * changed. Always resets the pending counter when it actually ran the model (so a
 * no-change result doesn't re-trigger immediately), but NOT when the model call
 * threw — those messages should be retried next cycle.
 */
async function runConsolidation(
  llm: LlmClient,
  opts: { force?: boolean } = {}
): Promise<ConsolidationResult> {
  if (!isRecallEnabled()) return ZERO;
  const factsGeneration = getFactsGeneration();
  const facts = getAllFacts().filter((f) => f.status === 'active');
  // The automatic pass skips small sets (nothing worth a model call); a manual
  // trigger (`force`) still needs at least two facts to merge anything.
  if (facts.length < (opts.force ? 2 : MIN_FACTS)) return ZERO;

  // One prompt while small; cluster into bounded chunks once the set is large.
  const chunks = facts.length <= getConsolidateChunkSize() ? [facts] : await chunkFacts(facts, factsGeneration);
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

  const result = applyConsolidation(combined);
  // Only clear the pending counter when every chunk ran — a failed chunk (model
  // error) should be retried next cycle rather than marked done.
  if (failedChunks === 0) setMeta(PENDING_KEY, '0');
  return { ...result, failedChunks };
}
