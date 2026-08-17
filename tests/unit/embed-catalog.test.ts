// Catalog suite — the pure data/helpers behind the local embedding backend:
// prompt prefixes (the multilingual models are prefix-sensitive), the vector-
// cache key namespace, and the mode → effective-cache-key mapping.
import { describe, expect, it } from 'vitest';
import {
  applyPrefixes,
  DEFAULT_LOCAL_EMBED_MODEL,
  effectiveEmbedModelKey,
  EMBED_CATALOG,
  localModelCacheKey,
  resolveEmbedSpec
} from '../../src/server/recall/embed-catalog';
import type { CustomEmbedModel, RetrievalSettings } from '../../src/shared/types';

const base: RetrievalSettings = {
  embeddings: {
    mode: 'local',
    localModel: 'multilingual-e5-small',
    baseUrl: 'http://localhost:11434',
    model: 'qwen3-embedding:8b',
    apiKey: null
  },
  reranker: { mode: 'off', localModel: 'bge-reranker-v2-m3', baseUrl: '', model: '', apiKey: null },
  customEmbedModels: [],
  customRerankModels: []
};

/** An imported model, as the import dialog would have written it. */
const imported: CustomEmbedModel = {
  id: 'custom:me/bge-small',
  repo: 'me/bge-small',
  label: 'BGE Small',
  dtype: 'q8',
  approxSizeMB: 130,
  dim: null,
  prefixes: { query: '', passage: '' }
};

/** `base` with the embeddings stage patched. */
function withEmbeddings(patch: Partial<RetrievalSettings['embeddings']>, custom: CustomEmbedModel[] = []): RetrievalSettings {
  return { ...base, embeddings: { ...base.embeddings, ...patch }, customEmbedModels: custom };
}

describe('embed catalog', () => {
  it('applies the e5 query/passage prefixes verbatim', () => {
    const spec = EMBED_CATALOG['multilingual-e5-small'];
    expect(applyPrefixes(spec, 'query', ['kde bývam?'])).toEqual(['query: kde bývam?']);
    expect(applyPrefixes(spec, 'passage', ['I live in Košice'])).toEqual(['passage: I live in Košice']);
  });

  it('applies the EmbeddingGemma prompt prefixes from its model card', () => {
    const spec = EMBED_CATALOG['embeddinggemma-300m'];
    expect(applyPrefixes(spec, 'query', ['x'])).toEqual(['task: search result | query: x']);
    expect(applyPrefixes(spec, 'passage', ['x'])).toEqual(['title: none | text: x']);
  });

  it('namespaces local cache keys so they can never collide with remote model ids', () => {
    for (const spec of Object.values(EMBED_CATALOG)) {
      expect(localModelCacheKey(spec)).toBe(`local:${spec.repo}`);
    }
  });

  it('has a default model that exists in the catalog', () => {
    expect(EMBED_CATALOG[DEFAULT_LOCAL_EMBED_MODEL]).toBeDefined();
  });

  it('maps mode to the effective vector-cache key', () => {
    expect(effectiveEmbedModelKey(base)).toBe('local:Xenova/multilingual-e5-small');
    expect(effectiveEmbedModelKey(withEmbeddings({ mode: 'remote' }))).toBe('qwen3-embedding:8b');
    expect(effectiveEmbedModelKey(withEmbeddings({ mode: 'off' }))).toBe('');
  });

  // The whole point of the resolver: `EMBED_CATALOG[localModel]` type-checks for
  // an imported id and hands back undefined, which then fails a long way from
  // here — in the worker, as a model that will not load.
  it('resolves an imported model by id, and keys its vectors like any other local one', () => {
    const settings = withEmbeddings({ localModel: imported.id }, [imported]);
    expect(resolveEmbedSpec(settings)).toBe(imported);
    expect(effectiveEmbedModelKey(settings)).toBe('local:me/bge-small');
  });

  it('falls back to the default model when the selected id names nothing', () => {
    const settings = withEmbeddings({ localModel: 'custom:gone/missing' });
    expect(resolveEmbedSpec(settings).id).toBe(DEFAULT_LOCAL_EMBED_MODEL);
  });
});
