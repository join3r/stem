import {
  applyConsolidation,
  getAllFacts,
  getConsolidateChunkSize,
  getFactsMissingVector,
  getFactVectors,
  setMeta,
  upsertFactVector,
  type ConsolidationOps,
  type ConsolidationResult,
  type Fact
} from './store';
import { isRecallEnabled } from '../workspace/memory';
import { PENDING_KEY } from './distill';
import { getEmbeddingsClient } from './retrieval';
import { cosineSim } from './vector';
import type { LlmClient } from './llm';

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
// Reject the whole batch if it would delete more than this fraction of the set —
// a cheap guard against the model nuking memory.
const MAX_DROP_FRACTION = 0.4;

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
- drop: only a fact another fact already fully covers or directly contradicts.
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
  } catch {
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
 * Strip any op touching a PROTECTED id, then reject the entire batch (return empty
 * ops) if it would still delete more than MAX_DROP_FRACTION of the set. `total` is
 * the current fact count; `protectedIds` the set the model must never touch.
 */
export function clampOps(ops: ConsolidationOps, protectedIds: Set<number>, total: number): ConsolidationOps {
  const merge = ops.merge
    .map((m) => ({ ...m, ids: m.ids.filter((id) => !protectedIds.has(id)) }))
    .filter((m) => m.ids.length >= 2);
  const correct = ops.correct.filter((c) => !protectedIds.has(c.id));
  const drop = ops.drop.filter((id) => !protectedIds.has(id));

  // Worst-case removals: every explicit drop + every merge's losers.
  const mergeLosers = merge.reduce((n, m) => n + (m.ids.length - 1), 0);
  const wouldRemove = drop.length + mergeLosers;
  if (total > 0 && wouldRemove / total > MAX_DROP_FRACTION) return { ...EMPTY_OPS };

  return { merge, correct, drop };
}

function buildPrompt(facts: Fact[]): string {
  const lines = facts
    .map((f) => `[${f.id}] ${f.text}${isProtected(f) ? '  (PROTECTED)' : ''}`)
    .join('\n');
  return `${INSTRUCTIONS}\n\nFacts:\n${lines}`;
}

const ZERO: ConsolidationResult = { merged: 0, corrected: 0, dropped: 0 };

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
async function chunkFacts(facts: Fact[]): Promise<Fact[][]> {
  const size = chunkTarget(facts.length, getConsolidateChunkSize());
  const emb = getEmbeddingsClient();
  if (!emb || !(await emb.available())) return sizeChunks(facts, size);
  try {
    const model = (await emb.modelId()) ?? '';
    const missing = getFactsMissingVector(model);
    if (missing.length > 0) {
      const vecs = await emb.embed(missing.map((f) => f.text));
      missing.forEach((f, i) => upsertFactVector(f.id, model, vecs[i]));
    }
    return greedyClusters(facts, getFactVectors(model), size);
  } catch {
    return sizeChunks(facts, size); // endpoint hiccup → still bounded, best effort
  }
}

/**
 * Run one consolidation pass over the durable facts. Returns counts of what
 * changed. Always resets the pending counter when it actually ran the model (so a
 * no-change result doesn't re-trigger immediately), but NOT when the model call
 * threw — those messages should be retried next cycle.
 */
export async function consolidateFacts(
  llm: LlmClient,
  opts: { force?: boolean } = {}
): Promise<ConsolidationResult> {
  if (!isRecallEnabled()) return ZERO;
  const facts = getAllFacts();
  // The automatic pass skips small sets (nothing worth a model call); a manual
  // trigger (`force`) still needs at least two facts to merge anything.
  if (facts.length < (opts.force ? 2 : MIN_FACTS)) return ZERO;

  // One prompt while small; cluster into bounded chunks once the set is large.
  const chunks = facts.length <= getConsolidateChunkSize() ? [facts] : await chunkFacts(facts);
  const protectedIds = new Set(facts.filter(isProtected).map((f) => f.id));

  const combined: ConsolidationOps = { merge: [], correct: [], drop: [] };
  let anyFailed = false;
  for (const chunk of chunks) {
    let chunkOps: ConsolidationOps;
    try {
      chunkOps = parseConsolidation(await llm.complete(buildPrompt(chunk)));
    } catch {
      anyFailed = true; // leave this chunk for a later cycle
      continue;
    }
    // Clamp per chunk against its own size: bounds the model's blast radius to
    // MAX_DROP_FRACTION of each chunk, which bounds the aggregate to the same
    // fraction of the whole set — no brittle all-or-nothing global rejection.
    const clamped = clampOps(chunkOps, protectedIds, chunk.length);
    combined.merge.push(...clamped.merge);
    combined.correct.push(...clamped.correct);
    combined.drop.push(...clamped.drop);
  }

  const result = applyConsolidation(combined);
  // Only clear the pending counter when every chunk ran — a failed chunk (model
  // error) should be retried next cycle rather than marked done.
  if (!anyFailed) setMeta(PENDING_KEY, '0');
  return result;
}
