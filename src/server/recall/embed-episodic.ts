import { degrade } from '../degrade';
import type { EmbeddingsClient } from './embeddings';
import { recallStore } from './store';
const { getEpisodicGeneration, getMessageEmbedWatermark, getMessagesForEmbedding, replaceMessageChunks, setMessageEmbedWatermark, upsertMessageChunkVector, upsertMessageVector } = recallStore;

// Background embedding of captured messages for semantic episodic search.
// Watermark-driven (meta key, model-tagged) and always off the turn path: the
// ready-transition hook and a post-turn debounce in index.ts call embedNewMessages,
// which walks everything past the watermark in batches. The watermark advances
// after each batch, so a crash or embed failure resumes exactly where it stopped.

/**
 * Messages shorter than this carry no retrievable signal ("ok", "thanks", "áno")
 * and only pollute cosine space — skipped, though the watermark still passes them.
 */
export const EPISODIC_EMBED_MIN_CHARS = 20;
/**
 * Embed at most this much of a message. e5's 512-token window is roughly
 * 1200–2000 chars of mixed SK/EN text; the lead-in almost always carries the
 * topic. The stored text is untouched — this bounds only the embedding input.
 */
export const EPISODIC_EMBED_MAX_CHARS = 1500;
export const EPISODIC_CHUNK_TARGET_CHARS = 1200;
export const EPISODIC_CHUNK_OVERLAP_CHARS = 200;

/** Deterministic embedding input for a message; null = skip (too short). */
export function episodicEmbedText(text: string): string | null {
  const t = text.trim();
  if (t.length < EPISODIC_EMBED_MIN_CHARS) return null;
  return t.slice(0, EPISODIC_EMBED_MAX_CHARS);
}

export interface EpisodicChunk {
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  text: string;
}

/** Sentence/paragraph-aware deterministic chunks for semantic episodic recall. */
export function chunkEpisodicText(text: string): EpisodicChunk[] {
  const source = text.trim();
  if (source.length < EPISODIC_EMBED_MIN_CHARS) return [];
  const chunks: EpisodicChunk[] = [];
  let start = 0;
  while (start < source.length) {
    const hardEnd = Math.min(source.length, start + EPISODIC_EMBED_MAX_CHARS);
    let end = Math.min(source.length, start + EPISODIC_CHUNK_TARGET_CHARS);
    if (hardEnd < source.length) {
      const floor = Math.min(hardEnd, start + 600);
      let best = -1;
      for (const sep of ['\n\n', '. ', '! ', '? ', '\n']) {
        const before = source.lastIndexOf(sep, hardEnd - 1);
        if (before >= floor) {
          const candidate = before + sep.length;
          if (best === -1 || Math.abs(candidate - end) < Math.abs(best - end)) best = candidate;
        }
      }
      if (best !== -1) end = best;
      else end = hardEnd;
    } else {
      end = source.length;
    }
    chunks.push({ chunkIndex: chunks.length, startOffset: start, endOffset: end, text: source.slice(start, end) });
    if (end >= source.length) break;
    start = Math.max(start + 1, end - EPISODIC_CHUNK_OVERLAP_CHARS);
  }
  return chunks;
}

// Overlapping kicks (ready-transition + post-turn debounce firing together) must
// not double-embed a batch; one pass at a time, extra kicks no-op.
let running = false;

/**
 * Embed every message past the watermark for the client's current model, in
 * batches. Returns how many vectors were written. Never throws: any failure
 * (embeddings not ready, worker died mid-batch) just ends the pass — the
 * unadvanced watermark makes the next kick retry from the same spot.
 */
export async function embedNewMessages(
  emb: EmbeddingsClient,
  opts: { batchSize?: number } = {}
): Promise<number> {
  if (running) return 0;
  running = true;
  const batchSize = opts.batchSize ?? 64;
  let written = 0;
  try {
    if (!(await emb.available())) return written;
    const model = await emb.modelId();
    if (!model) return written;
    // Reset recall mid-pass reuses message rowids (VACUUM), so every write below
    // an await belongs to the erased store. The watermark is the one that hurts:
    // getMessagesForEmbedding selects `WHERE id > watermark`, so resurrecting it
    // would leave every message captured after the reset unembedded until new
    // rowids climb back past the pre-reset high-water mark. Same barrier as
    // summarize/distill.
    const episodicGeneration = getEpisodicGeneration();
    const intact = () => getEpisodicGeneration() === episodicGeneration;
    for (;;) {
      const batch = getMessagesForEmbedding(getMessageEmbedWatermark(model), batchSize);
      if (batch.length === 0) break;
      const embeddable = batch.flatMap((m) => {
        const chunks = chunkEpisodicText(m.text);
        replaceMessageChunks(m.id, chunks);
        return chunks.map((chunk) => ({ messageId: m.id, ...chunk }));
      });
      if (embeddable.length > 0) {
        for (let i = 0; i < embeddable.length; i += 64) {
          const slice = embeddable.slice(i, i + 64);
          const vecs = await emb.embed(slice.map((e) => e.text), 'passage');
          if (!intact()) return written;
          slice.forEach((e, j) => {
            upsertMessageChunkVector(e.messageId, e.chunkIndex, model, vecs[j]);
            // Keep the v1 lead-vector path populated until every consumer has
            // completed its chunk-schema migration.
            if (e.chunkIndex === 0) upsertMessageVector(e.messageId, model, vecs[j]);
          });
        }
        written += new Set(embeddable.map((e) => e.messageId)).size;
      }
      if (!intact()) return written;
      setMessageEmbedWatermark(model, batch[batch.length - 1].id);
    }
  } catch (err) {
    // Embed failure mid-pass: stop here. The watermark only moved past batches
    // that were fully written, so nothing is lost — just deferred. But the
    // caller wraps this in activity.track and we return a count, not a throw,
    // so a pass that died halfway would otherwise be filed as a finished one.
    degrade('recall.embed', 'stopped the episodic embed pass early', err, {
      activity: 'memory.episodicEmbed'
    });
  } finally {
    running = false;
  }
  return written;
}
