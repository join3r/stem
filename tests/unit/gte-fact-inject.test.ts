import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRecallContext } from '../../src/server/recall/inject';
import { formatFactQuery } from '../../src/server/recall/fact-query';
import { recallStore as store, type Fact, type FactTier } from '../../src/server/recall/store';
import { getRerankClient, setRetrievalClients, type FactRerankClient } from '../../src/server/recall/retrieval';
import type { RerankResult } from '../../src/server/recall/rerank';
import * as search from '../../src/server/recall/search';
import * as searchCore from '../../src/server/recall/search-core';
import * as folders from '../../src/server/folder-index';

const MODEL = 'synthetic-fact-isolation';

function seed(text: string, sensitivity: 'standard' | 'sensitive' = 'standard'): number {
  const id = store.upsertFact(text, 'explicit', { sensitivity })!;
  store.upsertFactVector(id, MODEL, Float32Array.from([1, 0]));
  return id;
}

function chosen(): { facts: Fact[]; tier: FactTier } {
  return { facts: [], tier: 'none' };
}

function embeddings() {
  return {
    available: async () => true,
    modelId: async () => MODEL,
    embed: vi.fn(async (texts: string[], kind?: 'query' | 'passage') =>
      texts.map((text) => Float32Array.from(kind === 'query' && !text.startsWith('Earlier messages') ? [0, 1] : [1, 0])))
  };
}

function pilot(score: (text: string) => number = () => 5): FactRerankClient {
  return {
    modelId: 'synthetic-gte',
    factQuery: formatFactQuery,
    maxFacts: 16,
    available: async () => true,
    factGateScore: async () => 0,
    // Deliberately return reversed candidates: injection owns pilot ordering.
    rerank: vi.fn(async (_query: string, docs: string[]) =>
      docs.map((text, index) => ({ index, score: score(text) })).reverse())
  };
}

function searchSinks() {
  const vectors: number[][] = [];
  const summaries = vi.spyOn(searchCore, 'hybridSearchSummaries').mockImplementation(async (_db, _query, options = {}) => {
    const embedded = await options.embedQuery?.();
    if (embedded) vectors.push(Array.from(embedded.vec));
    return [];
  });
  const messages = vi.spyOn(search, 'searchMemoryHybrid').mockImplementation(async (_query, options = {}) => {
    const embedded = await options.getQueryEmbedding?.();
    if (embedded) vectors.push(Array.from(embedded.vec));
    return [];
  });
  const docs = vi.spyOn(folders, 'searchFolderDocs').mockImplementation(async (_query, options = {}) => {
    const embedded = await options.embedQuery?.();
    if (embedded) vectors.push(Array.from(embedded.vec));
    return [];
  });
  return { summaries, messages, docs, vectors };
}

beforeEach(() => {
  store.resetFacts();
  store.resetEpisodic();
  store.setMaxRelevantFacts(32);
  store.setUsageWeight(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  setRetrievalClients({ embeddings: null, rerank: null });
});

afterAll(() => store.close());

describe('GTE fact injection isolation', () => {
  it('uses contextual fact embedding and reranking while all episodic/document searches share the current query', async () => {
    const id = seed('Synthetic preference for railway journeys');
    const embed = embeddings();
    const gte = pilot();
    const qwen = pilot();
    setRetrievalClients({ embeddings: embed, rerank: qwen });
    const sinks = searchSinks();
    const selected = chosen();
    const current = 'A čo potom?';
    const previous = ['Plánujem cestu vlakom.'];
    await buildRecallContext(current, { factReranker: gte, previousUserMessages: previous, currentThreadId: 'active', chosen: selected });

    expect(selected.facts.map((fact) => fact.id)).toEqual([id]);
    expect(gte.rerank).toHaveBeenCalledWith(formatFactQuery(current, previous), [expect.any(String)], 1);
    expect(embed.embed.mock.calls).toEqual([
      [[formatFactQuery(current, previous)], 'query'],
      [[current], 'query']
    ]);
    expect(sinks.summaries).toHaveBeenCalledWith(expect.anything(), current, expect.objectContaining({ excludeThreadId: 'active' }));
    expect(sinks.messages).toHaveBeenCalledWith(current, expect.objectContaining({ excludeThreadId: 'active', roles: ['user'] }));
    expect(sinks.docs).toHaveBeenCalledWith(current, expect.anything());
    expect(sinks.vectors).toEqual([[0, 1], [0, 1], [0, 1]]);
    expect(qwen.rerank).not.toHaveBeenCalled();
    expect(getRerankClient()).toBe(qwen);
  });

  it('keeps the configured baseline query and shared embedding when the pilot is absent', async () => {
    seed('Synthetic baseline fact');
    const embed = embeddings();
    const baseline = {
      available: async () => true,
      factGateScore: async () => 0,
      rerank: vi.fn(async (_query: string, docs: string[]) => docs.map((_text, index) => ({ index, score: 5 })))
    };
    setRetrievalClients({ embeddings: embed, rerank: baseline, factRerank: async () => null });
    searchSinks();
    const selected = chosen();
    await buildRecallContext('Current question', { previousUserMessages: ['Earlier question'], chosen: selected });
    expect(baseline.rerank).toHaveBeenCalledWith('Current question', [expect.any(String)], 1);
    expect(embed.embed.mock.calls).toEqual([[['Current question'], 'query']]);
    expect(selected.tier).toBe('reranked');
    expect(getRerankClient()).toBe(baseline);
  });

  it('applies the sensitive +2 boundary and preserves raw-logit ordering across sensitivities', async () => {
    const standardBoundary = seed('Standard at floor');
    const sensitiveBoundary = seed('Sensitive at margin', 'sensitive');
    const sensitiveHigher = seed('Sensitive above standard', 'sensitive');
    const standardHigher = seed('Standard below sensitive');
    const sensitiveRejected = seed('Sensitive just below margin', 'sensitive');
    const standardRejected = seed('Standard just below floor');
    const scores = new Map([
      ['Standard at floor', 0], ['Sensitive at margin', 2],
      ['Sensitive above standard', 3], ['Standard below sensitive', 2.5],
      ['Sensitive just below margin', 1.999], ['Standard just below floor', -0.001]
    ]);
    setRetrievalClients({ embeddings: embeddings(), rerank: null });
    searchSinks();
    const selected = chosen();
    await buildRecallContext('Question', { factReranker: pilot((text) => scores.get(text)!), chosen: selected });
    expect(selected.facts.map((fact) => fact.id)).toEqual([sensitiveHigher, standardHigher, sensitiveBoundary, standardBoundary]);
    expect(selected.facts.map((fact) => fact.id)).not.toContain(sensitiveRejected);
    expect(selected.facts.map((fact) => fact.id)).not.toContain(standardRejected);
  });

  it('caps selected unpinned facts at 16 and breaks equal logits by numeric fact id', async () => {
    const ids = Array.from({ length: 20 }, (_unused, index) => seed(`Synthetic candidate number ${index}`));
    setRetrievalClients({ embeddings: embeddings(), rerank: null });
    searchSinks();
    const selected = chosen();
    await buildRecallContext('Question', { factReranker: pilot(() => 1), chosen: selected });
    expect(selected.facts.map((fact) => fact.id)).toEqual([...ids].sort((a, b) => a - b).slice(0, 16));
  });

  it('drops pinned and reranked snapshots when facts are reset during an outstanding rerank', async () => {
    const pinnedId = seed('Erased pinned synthetic fact');
    store.setFactPinned(pinnedId, true);
    seed('Erased candidate synthetic fact');
    setRetrievalClients({ embeddings: embeddings(), rerank: null });
    searchSinks();
    let release!: (results: RerankResult[]) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const reply = new Promise<RerankResult[]>((resolve) => { release = resolve; });
    const gte = pilot();
    gte.rerank = async () => { started(); return reply; };
    const selected = chosen();
    const pending = buildRecallContext('Question', { factReranker: gte, chosen: selected });
    await waiting;
    store.resetFacts();
    seed('Fresh replacement must not inherit erased selection');
    release([{ index: 0, score: 10 }]);
    expect(await pending).toBeNull();
    expect(selected).toEqual({ facts: [], tier: 'none' });
  });
});
