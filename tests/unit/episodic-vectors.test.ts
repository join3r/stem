// Semantic episodic search: message-vector store helpers, the watermark-driven
// embed pass, hybrid FTS+cosine retrieval (RRF), and the one-embed-per-turn
// contract in buildRecallContext. Fake embedders throughout — real-inference
// quality is scored by scripts/recall-eval.mjs. Stateful and order-dependent
// (shared per-process DB, mirroring recall.test.ts); tests reset what they need.
import { afterAll, describe, expect, it } from 'vitest';
import { recallStore as store } from '../../src/server/recall/store';
import * as search from '../../src/server/recall/search';
import * as inject from '../../src/server/recall/inject';
import * as retrieval from '../../src/server/recall/retrieval';
import {
  EPISODIC_EMBED_MAX_CHARS,
  EPISODIC_EMBED_MIN_CHARS,
  embedNewMessages,
  episodicEmbedText
} from '../../src/server/recall/embed-episodic';

afterAll(() => store.close());

const MODEL = 'test-model';

function seededIds(): number[] {
  return store.getMessagesForEmbedding(0, 1000).map((m) => m.id);
}

describe('message vector store', () => {
  it('round-trips vectors, prunes other models, and reports stats', () => {
    store.resetEpisodic();
    store.recordMessage({ threadId: 'V', turnId: 'v1', role: 'user', text: 'a message that gets a cached vector' });
    const [id] = seededIds();
    store.upsertMessageVector(id, MODEL, Float32Array.from([0.1, 0.2]));
    store.upsertMessageVector(id, 'other-model', Float32Array.from([0.3, 0.4]));
    expect(store.getEpisodicVectorStats(MODEL)).toEqual({ messageCount: 1, embeddedCount: 1 });
    store.pruneMessageVectorsExceptModel(MODEL);
    expect(store.getEpisodicVectorStats('other-model').embeddedCount).toBe(0);
    expect(store.getEpisodicVectorStats(MODEL).embeddedCount).toBe(1);
  });

  it('watermark round-trips and a model mismatch reads as 0', () => {
    store.setMessageEmbedWatermark(MODEL, 42);
    expect(store.getMessageEmbedWatermark(MODEL)).toBe(42);
    expect(store.getMessageEmbedWatermark('another-model')).toBe(0);
  });

  it('semanticSearchMessages ranks by cosine, gates on minCosine, excludes the current thread, skips dim mismatches', () => {
    store.resetEpisodic();
    store.recordMessage({ threadId: 'S1', turnId: 's1', role: 'user', text: 'closest match to the query vector' });
    store.recordMessage({ threadId: 'S2', turnId: 's2', role: 'user', text: 'second closest match to the query' });
    store.recordMessage({ threadId: 'S3', turnId: 's3', role: 'user', text: 'below the cosine floor entirely' });
    store.recordMessage({ threadId: 'S4', turnId: 's4', role: 'user', text: 'wrong dimensionality gets skipped' });
    const [a, b, c, d] = seededIds();
    store.upsertMessageVector(a, MODEL, Float32Array.from([1, 0]));
    store.upsertMessageVector(b, MODEL, Float32Array.from([0.9, Math.sqrt(1 - 0.81)]));
    store.upsertMessageVector(c, MODEL, Float32Array.from([0, 1]));
    store.upsertMessageVector(d, MODEL, Float32Array.from([1, 0, 0]));
    const q = Float32Array.from([1, 0]);

    const hits = store.semanticSearchMessages(q, MODEL, { limit: 5, minCosine: 0.5 });
    expect(hits.map((h) => h.id)).toEqual([a, b]); // c gated, d dim-skipped
    expect(hits[0].cosine).toBeCloseTo(1);
    expect(hits[0].score).toBeCloseTo(1); // score carries the cosine on semantic hits

    const excl = store.semanticSearchMessages(q, MODEL, { limit: 5, minCosine: 0.5, excludeThreadId: 'S1' });
    expect(excl.map((h) => h.id)).toEqual([b]);

    expect(store.semanticSearchMessages(q, 'unknown-model', { limit: 5, minCosine: 0 })).toEqual([]);
  });

  it('resetEpisodic clears vectors and the embed watermark; pruning leaves no orphans', () => {
    store.setMessageEmbedWatermark(MODEL, 99);
    store.resetEpisodic();
    expect(store.getEpisodicVectorStats(MODEL)).toEqual({ messageCount: 0, embeddedCount: 0 });
    expect(store.getMessageEmbedWatermark(MODEL)).toBe(0);

    store.recordMessage({ threadId: 'P', turnId: 'p1', role: 'user', text: 'message that will be pruned away' });
    store.upsertMessageVector(seededIds()[0], MODEL, Float32Array.from([1, 0]));
    store.setEpisodicLimitBytes(1); // absurdly small → prune everything
    expect(store.enforceEpisodicLimit()).toBeGreaterThan(0);
    expect(store.getEpisodicVectorStats(MODEL)).toEqual({ messageCount: 0, embeddedCount: 0 });
    store.setEpisodicLimitBytes(0);
  });

  it('the limit counts chat text, not vectors: a vector-heavy file keeps its history', () => {
    store.resetEpisodic();
    const text = 'x'.repeat(1000);
    for (let i = 0; i < 6; i++) store.recordMessage({ threadId: 'L', turnId: `l${i}`, role: 'user', text: `${i}${text}` });
    // Big vectors push the file far past 20 kB while the chat text stays ~6 kB.
    for (const id of seededIds()) store.upsertMessageVector(id, MODEL, new Float32Array(20_000).fill(0.5));
    expect(store.getEpisodicStats().textBytes).toBe(6 * 1001);
    expect(store.getEpisodicStats().sizeBytes).toBeGreaterThan(20_000);
    store.setEpisodicLimitBytes(20_000);
    expect(store.enforceEpisodicLimit()).toBe(0);
    expect(store.messageCount()).toBe(6);

    // Over the text limit: oldest go first, newest kept within 85% of it.
    store.setEpisodicLimitBytes(4000); // target 3400 → the newest 3 fit
    expect(store.enforceEpisodicLimit()).toBe(3);
    expect(store.getMessagesForEmbedding(0, 10).map((m) => m.text[0])).toEqual(['3', '4', '5']);
    expect(store.getEpisodicVectorStats(MODEL)).toEqual({ messageCount: 3, embeddedCount: 3 });
    store.setEpisodicLimitBytes(0);
  });
});

describe('episodic embed pass', () => {
  function fakeClient(behavior?: { failOnCall?: number }) {
    const calls: Array<{ texts: string[]; kind?: string }> = [];
    let n = 0;
    return {
      calls,
      client: {
        available: async () => true,
        modelId: async () => MODEL,
        embed: async (texts: string[], kind?: 'query' | 'passage') => {
          n += 1;
          if (behavior?.failOnCall === n) throw new Error('worker died');
          calls.push({ texts, kind });
          return texts.map(() => Float32Array.from([1, 0]));
        }
      }
    };
  }

  it('embeds as passages, skips tiny messages (watermark still advances), truncates long ones', async () => {
    store.resetEpisodic();
    store.recordMessage({ threadId: 'E', turnId: 'e1', role: 'user', text: 'ok' }); // < min chars
    store.recordMessage({ threadId: 'E', turnId: 'e2', role: 'user', text: 'a normal-length message that carries retrievable signal' });
    store.recordMessage({ threadId: 'E', turnId: 'e3', role: 'user', text: `long preamble ${'x'.repeat(3000)}` });
    const fake = fakeClient();

    const written = await embedNewMessages(fake.client);
    expect(written).toBe(2); // "ok" skipped
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].kind).toBe('passage');
    expect(fake.calls[0].texts[1]).toHaveLength(EPISODIC_EMBED_MAX_CHARS);
    expect(store.getMessageEmbedWatermark(MODEL)).toBe(Math.max(...seededIds()));
    expect(store.getEpisodicVectorStats(MODEL).embeddedCount).toBe(2);

    expect(await embedNewMessages(fake.client)).toBe(0); // watermark: nothing new
    expect(fake.calls).toHaveLength(1);
  });

  it('a mid-run failure stops the pass at the last completed batch and resumes on the next kick', async () => {
    store.resetEpisodic();
    for (let i = 0; i < 3; i++) {
      store.recordMessage({ threadId: 'R', turnId: `r${i}`, role: 'user', text: `resumable batch message number ${i} with enough length` });
    }
    const failing = fakeClient({ failOnCall: 2 });
    expect(await embedNewMessages(failing.client, { batchSize: 2 })).toBe(2); // batch 1 lands, batch 2 dies
    const ids = seededIds();
    expect(store.getMessageEmbedWatermark(MODEL)).toBe(ids[1]); // not advanced past the failure

    expect(await embedNewMessages(fakeClient().client, { batchSize: 2 })).toBe(1); // resumes with the third
    expect(store.getEpisodicVectorStats(MODEL).embeddedCount).toBe(3);
  });

  it('episodicEmbedText policy is deterministic', () => {
    expect(episodicEmbedText('ok')).toBeNull();
    expect(episodicEmbedText('x'.repeat(EPISODIC_EMBED_MIN_CHARS))).toHaveLength(EPISODIC_EMBED_MIN_CHARS);
    expect(episodicEmbedText('y'.repeat(5000))).toHaveLength(EPISODIC_EMBED_MAX_CHARS);
  });
});

describe('hybrid episodic search (RRF)', () => {
  it('fuses the FTS and semantic legs with hand-computed RRF ordering', async () => {
    store.resetEpisodic();
    store.recordMessage({ threadId: 'HA', turnId: 'h1', role: 'user', text: 'alpha content with no query tokens at all' });
    store.recordMessage({ threadId: 'HB', turnId: 'h2', role: 'user', text: 'bravo charlie together in one message here' });
    store.recordMessage({ threadId: 'HC', turnId: 'h3', role: 'user', text: 'charlie alone appears in this message body' });
    // Filler docs keep the query terms rare (bm25 IDF goes negative when a term
    // is in most of a tiny corpus, which would push real matches past the gate).
    for (let i = 0; i < 5; i++) {
      store.recordMessage({ threadId: 'HF', turnId: `hf${i}`, role: 'user', text: `unrelated filler document number ${i} about nothing` });
    }
    const [a, b] = seededIds();
    store.upsertMessageVector(a, MODEL, Float32Array.from([1, 0])); // cos 1 → sem rank 1
    store.upsertMessageVector(b, MODEL, Float32Array.from([0.95, Math.sqrt(1 - 0.9025)])); // cos .95 → sem rank 2

    const hits = await search.searchMemoryHybrid('bravo charlie', {
      limit: 5,
      getQueryEmbedding: async () => ({ vec: Float32Array.from([1, 0]), model: MODEL })
    });
    // fts: [B, C] (B matches both terms); sem: [A, B].
    // RRF(B) = 1/61 + 1/62 > RRF(A) = 1/61 > RRF(C) = 1/62.
    expect(hits.map((h) => h.id)).toEqual([b, a, seededIds()[2]]);
    expect(hits[0].score).toBeCloseTo(1 / 61 + 1 / 62);
    expect(hits[0].cosine).toBeCloseTo(0.95); // both-leg evidence grafted
    expect(hits[1].cosine).toBeCloseTo(1);
    expect(hits[2].cosine).toBeUndefined(); // FTS-only hit
  });

  it('degrades to exactly the gated FTS ranking when the semantic leg is unavailable', async () => {
    const plain = search
      .searchMemory('bravo charlie', { limit: 12 })
      .filter((h) => h.score <= search.FTS_SCORE_CEILING)
      .slice(0, 5)
      .map((h) => h.id);
    for (const opts of [
      {},
      { getQueryEmbedding: async () => null },
      {
        getQueryEmbedding: async () => {
          throw new Error('embedder down');
        }
      }
    ]) {
      const hits = await search.searchMemoryHybrid('bravo charlie', { limit: 5, ...opts });
      expect(hits.map((h) => h.id)).toEqual(plain);
    }
  });

  it('gates semantic-only hits on the configured min cosine', async () => {
    const weak = Float32Array.from([Math.SQRT1_2, Math.SQRT1_2]); // cos ≈ 0.707 vs [1,0] < 0.82 default
    store.upsertMessageVector(seededIds()[2], MODEL, weak);
    const hits = await search.searchMemoryHybrid('zzz nothing lexical zzz', {
      limit: 5,
      getQueryEmbedding: async () => ({ vec: Float32Array.from([1, 0]), model: MODEL })
    });
    // Only the two strong vectors survive the 0.82 floor; the 0.707 one is gated.
    expect(hits.map((h) => h.id).sort()).toEqual(seededIds().slice(0, 2).sort());
  });
});

describe('buildRecallContext — one query embed per turn', () => {
  it('embeds the query once (kind "query"), and a semantic-only hit reaches the context block', async () => {
    store.resetEpisodic();
    store.resetFacts();
    store.recordMessage({ threadId: 'CTX', turnId: 'c1', role: 'user', text: 'the rosemary plant on the balcony is thriving now' });
    const [id] = seededIds();
    const kinds: Array<string | undefined> = [];
    const client = {
      available: async () => true,
      modelId: async () => MODEL,
      embed: async (texts: string[], kind?: 'query' | 'passage') => {
        kinds.push(kind);
        return texts.map(() => Float32Array.from([1, 0]));
      }
    };
    store.upsertMessageVector(id, MODEL, Float32Array.from([1, 0]));
    retrieval.setRetrievalClients({ embeddings: client, rerank: null });
    store.upsertFact('The user enjoys gardening on the balcony', 'distilled'); // below threshold → cheap path
    try {
      const timings: import('../../src/server/recall/inject').RecallTimings = {};
      // Slovak query, zero lexical overlap with the stored English message.
      const ctx = (await inject.buildRecallContext('ako sa darí mojej rastline?', { timings })) ?? '';
      expect(kinds).toEqual(['query', 'passage']); // one query embed plus fact-vector backfill
      expect(ctx).toMatch(/rosemary plant on the balcony/); // semantic-only recall
      expect(timings.semantic).toBeGreaterThanOrEqual(0);
    } finally {
      retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    }
  });
});
