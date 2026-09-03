// The one verdict on "is this the measured-best recall setup", shared by the
// Memory tab's Recall quality row and the post-update popup's switch offer. The
// patch it hands back must move only the stage that is off the recommendation.
import { describe, expect, it } from 'vitest';
import {
  RECALL_DEFAULTS_RELEASE,
  RECOMMENDED_EMBED_MODEL,
  RECOMMENDED_RERANK_MODEL,
  recallSetupStatus,
  recommendedRetrievalPatch
} from '../../src/shared/recall-recommended';
import { DEFAULT_LOCAL_EMBED_MODEL } from '../../src/server/recall/embed-catalog';
import { DEFAULT_LOCAL_RERANK_MODEL } from '../../src/server/recall/rerank-catalog';
import type { RetrievalSettings } from '../../src/shared/types';

function retrieval(over: {
  embeddings?: Partial<RetrievalSettings['embeddings']>;
  reranker?: Partial<RetrievalSettings['reranker']>;
}): RetrievalSettings {
  return {
    embeddings: { mode: 'local', localModel: RECOMMENDED_EMBED_MODEL, baseUrl: '', model: '', apiKey: null, ...over.embeddings },
    reranker: { mode: 'local', localModel: RECOMMENDED_RERANK_MODEL, baseUrl: '', model: '', apiKey: null, ...over.reranker },
    customEmbedModels: [],
    customRerankModels: []
  };
}

describe('recall recommendation', () => {
  it('names the catalog defaults — a fresh install is already the recommendation', () => {
    expect(RECOMMENDED_EMBED_MODEL).toBe(DEFAULT_LOCAL_EMBED_MODEL);
    expect(RECOMMENDED_RERANK_MODEL).toBe(DEFAULT_LOCAL_RERANK_MODEL);
    expect(recommendedRetrievalPatch(retrieval({}))).toBeNull();
  });

  it('is pinned to the release whose popup carries the offer', () => {
    expect(RECALL_DEFAULTS_RELEASE).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('accepts a Qwen3 embedder on the user\'s own endpoint — it tied, so it is not re-embedded', () => {
    const r = retrieval({ embeddings: { mode: 'remote', model: 'qwen3-embedding:4b' } });
    expect(recallSetupStatus(r)).toEqual({ embedOk: true, rerankOk: true });
    expect(recommendedRetrievalPatch(r)).toBeNull();
  });

  it('patches only the stage that is off the recommendation', () => {
    const bge = retrieval({ reranker: { localModel: 'bge-reranker-v2-m3' } });
    expect(recommendedRetrievalPatch(bge)).toEqual({
      reranker: { mode: 'local', localModel: RECOMMENDED_RERANK_MODEL }
    });

    const e5 = retrieval({ embeddings: { localModel: 'multilingual-e5-base' } });
    expect(recommendedRetrievalPatch(e5)).toEqual({
      embeddings: { mode: 'local', localModel: RECOMMENDED_EMBED_MODEL }
    });
  });

  it('moves the pre-0.5 default (e5-base + bge) and a switched-off setup onto both models', () => {
    const old = retrieval({
      embeddings: { localModel: 'multilingual-e5-base' },
      reranker: { localModel: 'bge-reranker-v2-m3' }
    });
    expect(recommendedRetrievalPatch(old)).toEqual({
      embeddings: { mode: 'local', localModel: RECOMMENDED_EMBED_MODEL },
      reranker: { mode: 'local', localModel: RECOMMENDED_RERANK_MODEL }
    });

    const off = retrieval({ embeddings: { mode: 'off' }, reranker: { mode: 'off' } });
    expect(recallSetupStatus(off)).toEqual({ embedOk: false, rerankOk: false });
    expect(recommendedRetrievalPatch(off)?.embeddings?.mode).toBe('local');
  });

  it('a remote non-Qwen3 endpoint is not the recommendation', () => {
    const r = retrieval({
      embeddings: { mode: 'remote', model: 'nomic-embed-text' },
      reranker: { mode: 'remote', model: 'bge-reranker-v2-m3' }
    });
    expect(recallSetupStatus(r)).toEqual({ embedOk: false, rerankOk: false });
  });
});
