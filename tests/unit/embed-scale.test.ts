// Embedder-aware cosine floors: the e5 numbers are the historical defaults and
// must not move; Qwen3 keys — bundled, imported, or a server model name — get
// the measured translation; anything unrecognised keeps the e5 behaviour.
import { describe, expect, it } from 'vitest';
import { COSINE_FLOORS, cosineFloorsFor, cosineScaleFor } from '../../src/server/recall/embed-scale';
import { DEFAULT_SEMANTIC_MIN_COSINE, DEFAULT_SUMMARY_MIN_COSINE, FACT_SEARCH_MIN_COSINE } from '../../src/server/recall/search-core';
import { COINJECT_MIN_COSINE, STRONG_RAW_MIN_COSINE } from '../../src/server/recall/inject';
import { EMBED_CATALOG, localModelCacheKey } from '../../src/server/recall/embed-catalog';

describe('cosine floors per embedder scale', () => {
  it('keeps the e5 floors exactly where they were', () => {
    expect(COSINE_FLOORS.e5).toEqual({ message: 0.82, summary: 0.78, doc: 0.78, factSearch: 0.72, strongRaw: 0.88, coinject: 0.6 });
    expect(DEFAULT_SEMANTIC_MIN_COSINE).toBe(0.82);
    expect(DEFAULT_SUMMARY_MIN_COSINE).toBe(0.78);
    expect(FACT_SEARCH_MIN_COSINE).toBe(0.72);
    expect(STRONG_RAW_MIN_COSINE).toBe(0.88);
    expect(COINJECT_MIN_COSINE).toBe(0.6);
  });

  it('recognises Qwen3 by any key shape and everything else as e5', () => {
    expect(cosineScaleFor(localModelCacheKey(EMBED_CATALOG['qwen3-embedding-0.6b']))).toBe('qwen3');
    expect(cosineScaleFor('qwen3-embedding:4b')).toBe('qwen3');
    expect(cosineScaleFor('local:me/Qwen3-Embedding-4B-ONNX')).toBe('qwen3');
    for (const key of [localModelCacheKey(EMBED_CATALOG['multilingual-e5-small']), 'local:onnx-community/embeddinggemma-300m-ONNX', 'bge-m3', ''])
      expect(cosineScaleFor(key)).toBe('e5');
  });

  it('translates every floor downwards for Qwen3, in the same order as e5', () => {
    const e5 = COSINE_FLOORS.e5;
    const q = cosineFloorsFor('qwen3-embedding:4b');
    for (const k of Object.keys(e5) as (keyof typeof e5)[]) expect(q[k]).toBeLessThan(e5[k]);
    expect(q.strongRaw).toBeGreaterThan(q.message);
    expect(q.message).toBeGreaterThan(q.summary);
    expect(q.summary).toBeGreaterThanOrEqual(q.doc);
    expect(q.factSearch).toBeGreaterThan(q.coinject);
  });
});
