import * as activity from '../activity';
import { degrade } from '../degrade';
import type { EmbeddingsClient } from './embeddings';
import { recallStore } from './store';
const { getFactsGeneration, getFactsMissingVector, upsertFactVectorForSnapshot } = recallStore;

// Background embedding of facts that have no vector for the current model —
// the whole fact set right after a model switch, a handful after a distill
// pass. Kicked by the local worker's ready hook and by any semantic turn that
// finds facts missing; one pass at a time, extra kicks no-op. Always off the
// turn path: until 2026-09-03 a turn embedded every missing fact inline before
// ranking, which after a switch to a CPU model was the whole set — 1,580 facts,
// sixteen minutes, no answer. A fact without a vector is simply not in the
// cosine leg until the pass reaches it; the lexical leg still sees it.

const BATCH = 32;
let running = false;

/**
 * Up to this many missing facts a turn embeds inline (urgently) before
 * ranking — the facts distilled since the last turn, so a fact learned a
 * minute ago is already in the cosine leg. More than this is a backlog (a
 * model switch, a restored archive) and goes to {@link embedMissingFactVectors}.
 */
export const INLINE_FACT_EMBED_MAX = 64;

/**
 * Embed every fact missing a vector for `model`, in batches, writing each batch
 * as it lands. Returns how many were written. Never throws: a failure ends the
 * pass and the next kick resumes from whatever is still missing.
 */
export async function embedMissingFactVectors(emb: EmbeddingsClient, model: string): Promise<number> {
  if (running) return 0;
  running = true;
  let done = 0;
  let handle: activity.ActivityHandle | null = null;
  try {
    // Every write below an await belongs to the store as it was when the pass
    // began: "Reset memory" mid-pass must not bind a vector to a reused id.
    const factsGeneration = getFactsGeneration();
    const missing = getFactsMissingVector(model);
    if (missing.length === 0) return 0;
    // Stepped, because after a model switch this is thousands of vectors and
    // the count is the only honest answer to "why is search worse right now".
    handle = activity.begin('memory.factEmbed', 'Embedding facts', { stepped: true });
    for (let i = 0; i < missing.length; i += BATCH) {
      if (getFactsGeneration() !== factsGeneration) break;
      const batch = missing.slice(i, i + BATCH);
      const vecs = await emb.embed(
        batch.map((f) => f.text),
        'passage'
      );
      if (getFactsGeneration() !== factsGeneration) break;
      batch.forEach((f, j) => upsertFactVectorForSnapshot(f.id, f.text, factsGeneration, model, vecs[j]));
      done += batch.length;
      activity.progress(handle, { done, total: missing.length });
    }
  } catch (err) {
    // Batches already written stay written; the next kick picks up the rest.
    degrade('recall.embed', 'stopped the fact embed pass early', err, { activity: 'memory.factEmbed' });
  } finally {
    running = false;
    // On the failure path degrade() already closed the entry, so end() no-ops.
    if (handle) {
      activity.end(handle, {
        worked: done > 0,
        detail: `Embedded ${done.toLocaleString()} fact${done === 1 ? '' : 's'}`
      });
    }
  }
  return done;
}
