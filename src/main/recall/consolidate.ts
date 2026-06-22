import {
  applyConsolidation,
  getAllFacts,
  setMeta,
  type ConsolidationOps,
  type ConsolidationResult,
  type Fact
} from './store';
import { isRecallEnabled } from '../workspace/memory';
import { PENDING_KEY } from './distill';
import type { LlmClient } from './llm';

// Level 1 cleanup: the consolidation pass. Distillation only ever ADDS facts and
// can only dedup byte-for-byte (normalizeFact), so over time the set accumulates
// reworded near-duplicates and stale/contradicted facts. This pass periodically
// hands the whole fact list to the LLM and asks for merge/correct/drop operations,
// then applies them transactionally. Default posture is KEEP: only ids the model
// names are touched, so a flaky/lazy reply is a no-op, never a memory wipe.

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

  let ops: ConsolidationOps;
  try {
    const reply = await llm.complete(buildPrompt(facts));
    ops = parseConsolidation(reply);
  } catch {
    // Leave the pending counter so a later cycle retries.
    return ZERO;
  }

  const protectedIds = new Set(facts.filter(isProtected).map((f) => f.id));
  const clamped = clampOps(ops, protectedIds, facts.length);
  const result = applyConsolidation(clamped);

  setMeta(PENDING_KEY, '0');
  return result;
}
