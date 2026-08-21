import type { EmbeddingsClient } from '../recall/embeddings';
import { docEmbedText } from './scan';
import type { FolderIndexStore } from './store';
import * as activity from '../activity';

// Background embedding of indexed folder documents — one thin vector per doc
// (title + lead text), mirroring the never-throwing shape of embed-episodic's
// embedNewMessages. "Missing a vector for the current model" is the work list,
// so a crash mid-pass just resumes with whatever is still missing; a model
// switch prunes stale vectors and the same query refills them.

// Batch kept small: doc leads are long, and the local ONNX worker runs batches
// of 8. On a CPU HTTP endpoint one request holds the server for the whole
// batch (a 16-doc batch measured 1–2 minutes on the VPS, 2026-08-21) and a
// query queued behind it waits it out — 8 halves the worst wait.
const BATCH_SIZE = 8;
// Breathing room between batches. Priority is handled by the embed schedule
// (embeddings.ts waits out in-flight queries before each passage request);
// this bounds sustained CPU saturation so the rest of the turn pipeline —
// reranker, the LLM — isn't starved for the entire backlog.
const BATCH_PAUSE_MS = 1_000;

/**
 * Embed every doc in `store` missing a vector for the client's current model.
 * Returns how many vectors were written. Never throws: any failure ends the
 * pass and the next kick retries the remainder.
 */
export async function embedMissingDocVectors(
  store: FolderIndexStore,
  emb: EmbeddingsClient
): Promise<number> {
  let written = 0;
  try {
    if (!(await emb.available())) return written;
    const model = await emb.modelId();
    if (!model) return written;
    store.pruneVectorsExceptModel(model);
    for (;;) {
      const batch = store.getDocsMissingVector(model, BATCH_SIZE);
      if (batch.length === 0) break;
      const inputs = batch
        .map((d) => ({ id: d.id, text: docEmbedText(d.title, d.text) }))
        .filter((d): d is { id: number; text: string } => d.text !== null);
      if (inputs.length === 0) break; // Defensive: the store already filters short docs.
      const vecs = await emb.embed(inputs.map((d) => d.text), 'passage');
      inputs.forEach((d, i) => store.upsertDocVector(d.id, model, vecs[i]));
      written += inputs.length;
      await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
    }
  } catch (error) {
    // Embeddings not ready / worker died mid-batch: written vectors stay, the
    // rest remain "missing" and the next pass picks them up. Still non-fatal —
    // but reported, because the caller only sees a count and can't tell a failed
    // pass from a folder that had nothing to embed.
    activity.fail('folders.embed', error);
  }
  return written;
}
