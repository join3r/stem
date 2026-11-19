// Stem Recall regression suite — ported from scripts/recall-verify.mjs.
// Exercises the REAL store/search/inject/distill/consolidate modules against the
// throwaway DB from tests/setup-unit.ts. Tests are stateful and ORDER-DEPENDENT
// (they share one DB, mirroring the original probe), so keep them sequential.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recallStore as store, DEFAULT_CONSOLIDATE_CHUNK, DEFAULT_MAX_RELEVANT_FACTS } from '../../src/server/recall/store';
import * as search from '../../src/server/recall/search';
import * as inject from '../../src/server/recall/inject';
import * as retrieval from '../../src/server/recall/retrieval';
import * as distill from '../../src/server/recall/distill';
import * as consolidate from '../../src/server/recall/consolidate';

afterAll(() => store.close());

describe('Stem Recall', () => {
  it('seeds episodic messages across threads', () => {
    store.recordMessage({ threadId: 'A', turnId: 't1', role: 'user', text: 'Nájdi informácie o mojom zdravotnom stave v emailoch' });
    store.recordMessage({
      threadId: 'A',
      turnId: 't1',
      role: 'assistant',
      text: 'Your UZ Gent cardiology appointment is on June 30; Dr. Janssens noted slightly elevated cholesterol and asked for a follow-up blood test.'
    });
    store.recordMessage({ threadId: 'B', turnId: 't9', role: 'user', text: 'how do decoder-only LLMs differ from BERT' });
    expect(store.messageCount()).toBe(3);
  });

  it('cross-chat recall finds thread A health content', () => {
    const hits = search.searchMemory('what is my UZ Gent cardiology appointment', { excludeThreadId: 'B', limit: 5 });
    expect(hits.some((h) => h.threadId === 'A' && /UZ Gent/.test(h.text))).toBe(true);
  });

  it('excludeThreadId removes the current thread', () => {
    const hits = search.searchMemory('UZ Gent cardiology', { excludeThreadId: 'A', limit: 5 });
    expect(hits.some((h) => h.threadId === 'A')).toBe(false);
  });

  it('unrelated query does not return health content', () => {
    const hits = search.searchMemory('decoder-only BERT architecture', { excludeThreadId: 'A', limit: 5 });
    expect(hits.some((h) => /UZ Gent/.test(h.text))).toBe(false);
  });

  it('re-recording the same message is a no-op (dedup)', () => {
    const before = store.messageCount();
    store.recordMessage({ threadId: 'A', turnId: 't1', role: 'user', text: 'Nájdi informácie o mojom zdravotnom stave v emailoch' });
    expect(store.messageCount()).toBe(before);
  });

  it('keeps identical messages from different turns', () => {
    const before = store.messageCount();
    store.recordMessage({ threadId: 'repeat', turnId: 'turn-1', role: 'user', text: 'yes, please' });
    store.recordMessage({ threadId: 'repeat', turnId: 'turn-2', role: 'user', text: 'yes, please' });
    expect(store.messageCount()).toBe(before + 2);
  });

  it('Slovak query recalls Slovak content', () => {
    store.recordMessage({ threadId: 'C', turnId: 'c1', role: 'user', text: 'Mám kardiologické vyšetrenie v Gente budúci týždeň' });
    const sk = search.searchMemory('kardiologické vyšetrenie', { excludeThreadId: 'B', limit: 5 });
    expect(sk.some((h) => h.threadId === 'C')).toBe(true);
  });

  it('fact upsert dedups by normalized text and a correction updates source', () => {
    store.upsertFact('User has a cardiology follow-up at UZ Gent', 'distilled');
    store.upsertFact('user has a cardiology follow-up at uz gent.', 'explicit'); // same norm → updates
    const facts = store.getFacts();
    expect(facts.filter((f) => /cardiology follow-up at UZ Gent/i.test(f.text)).length).toBe(1);
    expect(facts.find((f) => /cardiology follow-up/i.test(f.text))?.source).toBe('explicit');
  });

  it('inject builds a context block with facts + relevant hits, excluding current thread', async () => {
    const ctx = (await inject.buildRecallContext('what is my UZ Gent cardiology appointment', { currentThreadId: 'B' })) ?? '';
    expect(ctx).toMatch(/stem_memory_data/i);
    expect(ctx).toMatch(/UZ Gent/i);
    // The pointer to the search tools is in the rules, which go out once per chat.
    expect(inject.RECALL_RULES).toMatch(/search_past_chats/);
  });

  it('parseFacts reads JSON arrays and bullets, dropping secrets', () => {
    const pf = distill.parseFacts('Here you go:\n["The user lives in Slovakia", "The user prefers Slovak"]');
    expect(pf.length).toBe(2);
    expect(pf).toContain('The user prefers Slovak');
    const pf2 = distill.parseFacts('- The user is a developer\n- their password is hunter2');
    expect(pf2).toContain('The user is a developer');
    expect(pf2.some((f) => /password/i.test(f))).toBe(false);
  });

  it('distill writes facts from new messages and a watermark prevents reprocessing', async () => {
    const stubLlm = { complete: async () => '["The user has an upcoming UZ Gent cardiology appointment"]' };
    const wrote = await distill.distillNewMessages(stubLlm);
    expect(wrote).toBeGreaterThanOrEqual(1);
    expect(store.getFacts().some((f) => /UZ Gent cardiology appointment/i.test(f.text))).toBe(true);
    const wroteAgain = await distill.distillNewMessages(stubLlm);
    expect(wroteAgain).toBe(0);
  });

  it('parseConsolidation reads merge/correct/drop and no-ops on garbage', () => {
    const pc = consolidate.parseConsolidation('sure:\n{"merge":[{"ids":[1,2],"text":"merged"}],"correct":[{"id":3,"text":"fixed"}],"drop":[4]}');
    expect(pc.merge.length).toBe(1);
    expect(pc.correct.length).toBe(1);
    expect(pc.drop[0]).toBe(4);
    const pcBad = consolidate.parseConsolidation('no json here at all');
    expect(pcBad.merge.length + pcBad.correct.length + pcBad.drop.length).toBe(0);
  });

  it('clampOps strips protected-id ops and rejects mass deletes', () => {
    const clampProt = consolidate.clampOps({ merge: [{ ids: [10, 11], text: 'x' }], correct: [{ id: 11, text: 'y' }], drop: [11] }, new Set([11]), 8);
    expect(clampProt.merge.length + clampProt.correct.length + clampProt.drop.length).toBe(0);
    const clampMass = consolidate.clampOps({ merge: [], correct: [], drop: [1, 2, 3] }, new Set(), 4);
    expect(clampMass.drop.length).toBe(0);
  });

  it('clampOps rejects ids that were not present in the model prompt', () => {
    const clamped = consolidate.clampOps(
      {
        merge: [{ ids: [1, 99], text: 'escaped merge' }],
        correct: [{ id: 99, text: 'escaped correction' }],
        drop: [2, 99]
      },
      new Set(),
      3,
      new Set([1, 2, 3])
    );
    expect(clamped).toEqual({ merge: [], correct: [], drop: [2] });
  });

  it('clampOps rejects malformed and overlapping merge groups atomically', () => {
    const clamped = consolidate.clampOps(
      {
        merge: [
          { ids: [1, 99, 2], text: 'contains an out-of-scope id' },
          { ids: [3, 3, 4], text: 'contains a duplicate id' },
          { ids: [5, 6], text: 'first valid merge' },
          { ids: [6, 7], text: 'overlaps the first merge' }
        ],
        correct: [
          { id: 5, text: 'overlaps the accepted merge' },
          { id: 7, text: 'unclaimed after rejected merge' }
        ],
        drop: [6, 8, 8]
      },
      new Set(),
      8,
      new Set([1, 2, 3, 4, 5, 6, 7, 8])
    );

    expect(clamped).toEqual({
      merge: [{ ids: [5, 6], text: 'first valid merge' }],
      correct: [{ id: 7, text: 'unclaimed after rejected merge' }],
      drop: [8]
    });
  });

  it('clampOps lets merges retire most of a duplicate-heavy chunk but rejects runaway groups', () => {
    // A migration-era store is ~2x duplicated: merging half the chunk away is the
    // *correct* outcome and must survive the blast-radius guard (merges are
    // content-preserving and reversible). Ten pairs → ten losers of twenty facts.
    const pairs = Array.from({ length: 10 }, (_, i) => ({ ids: [i * 2 + 1, i * 2 + 2], text: `fact ${i}` }));
    const ok = consolidate.clampOps({ merge: pairs, correct: [], drop: [] }, new Set(), 20);
    expect(ok.merge).toHaveLength(10);
    // One merge swallowing 20 ids is a model gone wild, not a duplicate cluster.
    const wild = consolidate.clampOps(
      { merge: [{ ids: Array.from({ length: 20 }, (_, i) => i + 1), text: 'everything' }], correct: [], drop: [] },
      new Set(),
      20
    );
    expect(wild.merge).toHaveLength(0);
  });

  it('consolidate reports chunks the model failed on instead of pretending a clean pass', async () => {
    const res = await consolidate.consolidateFacts(
      { complete: async () => { throw new Error('model down'); } },
      { force: true }
    );
    expect(res.failedChunks).toBeGreaterThan(0);
    expect(res.merged + res.corrected + res.dropped).toBe(0);
  });

  it('consolidate merges reworded duplicates and never drops a protected fact', async () => {
    store.upsertFact('The user lives in Bratislava, Slovakia', 'distilled');
    store.upsertFact('The user is based in Bratislava', 'distilled'); // reworded duplicate
    store.upsertFact('The user has a dog named Rex', 'distilled');
    store.upsertFact('The user works as a software engineer', 'distilled');
    store.upsertFact('The user wants you to remember the WiFi name is HomeNet', 'explicit'); // protected

    const all = store.getAllFacts();
    const idA = all.find((f) => /lives in Bratislava, Slovakia/.test(f.text))!.id;
    const idB = all.find((f) => /based in Bratislava/.test(f.text))!.id;
    const idProt = all.find((f) => /HomeNet/.test(f.text))!.id;

    const consolidateLlm = {
      complete: async () =>
        JSON.stringify({ merge: [{ ids: [idA, idB], text: 'The user lives in Bratislava, Slovakia' }], correct: [], drop: [idProt] })
    };
    const res = await consolidate.consolidateFacts(consolidateLlm);
    const afterFacts = store.getAllFacts();
    expect(afterFacts.filter((f) => /Bratislava/.test(f.text) && f.status === 'active').length).toBe(1);
    expect(afterFacts.some((f) => /Bratislava/.test(f.text) && f.status === 'superseded')).toBe(true);
    expect(res.merged).toBe(1);
    expect(afterFacts.some((f) => /HomeNet/.test(f.text))).toBe(true);
    expect(res.dropped).toBe(0);
  });

  it('consolidate applies a correction in place', async () => {
    const engId = store.getAllFacts().find((f) => /software engineer/.test(f.text))!.id;
    const correctLlm = {
      complete: async () => JSON.stringify({ merge: [], correct: [{ id: engId, text: 'The user works as a data scientist' }], drop: [] })
    };
    const corrRes = await consolidate.consolidateFacts(correctLlm, { force: true });
    expect(store.getAllFacts().some((f) => /data scientist/.test(f.text))).toBe(true);
    expect(corrRes.corrected).toBe(1);
  });

  it('shouldConsolidate flips only past the configurable threshold', () => {
    store.setMeta('consolidate_pending', '0');
    expect(distill.shouldConsolidate()).toBe(false);
    store.setMeta('consolidate_pending', '5');
    expect(distill.shouldConsolidate()).toBe(true);

    expect(store.getTidyThreshold()).toBe(5);
    store.setTidyThreshold(10);
    expect(store.getTidyThreshold()).toBe(10);
    expect(distill.shouldConsolidate()).toBe(false); // pending 5 < 10
    store.setTidyThreshold(0);
    store.setMeta('consolidate_pending', '999');
    expect(distill.shouldConsolidate()).toBe(false); // 0 disables auto tidy-up
  });

  it('enforces the episodic size limit by pruning', () => {
    expect(store.getEpisodicLimitBytes()).toBe(100 * 1024 * 1024);
    store.setEpisodicLimitBytes(50 * 1024 * 1024);
    expect(store.getEpisodicLimitBytes()).toBe(50 * 1024 * 1024);
    store.setEpisodicLimitBytes(0);
    expect(store.enforceEpisodicLimit()).toBe(0); // unlimited → no prune
    const beforePrune = store.messageCount();
    store.setEpisodicLimitBytes(1); // absurdly small → prune everything
    const pruned = store.enforceEpisodicLimit();
    expect(pruned).toBeGreaterThan(0);
    expect(pruned).toBeLessThanOrEqual(beforePrune);
    expect(store.messageCount()).toBe(0);
  });

  it('resets facts and episodic independently', () => {
    store.upsertFact('The user keeps a fact for the reset test', 'distilled');
    store.recordMessage({ threadId: 'R', turnId: 'r1', role: 'user', text: 'a message for the reset test' });
    store.resetFacts();
    expect(store.getFacts().length).toBe(0);
    expect(store.messageCount()).toBe(1);
    store.upsertFact('The user keeps another fact', 'distilled');
    store.resetEpisodic();
    expect(store.messageCount()).toBe(0);
    expect(store.getFacts().length).toBe(1);
  });
});

// Fact relevance ranking (embeddings + reranker). Uses fake clients so the suite
// stays offline. Shares the same DB as above; closeForTest runs in the file-level
// afterAll. resetFacts() at the start of each test makes the fact set deterministic.
describe('Stem Recall — fact relevance ranking', () => {
  // These cases seed ~46 facts and assert that relevance — not recency — decides
  // what survives the per-turn cap. Pin the cap so the suite stays independent of
  // DEFAULT_MAX_RELEVANT_FACTS.
  beforeAll(() => store.setMaxRelevantFacts(8));
  afterAll(() => store.setMaxRelevantFacts(DEFAULT_MAX_RELEVANT_FACTS));

  // Keyword-encoding fake embedder: a text matching `key` maps to [1,0], else [0,1],
  // so the query and any fact sharing the keyword have cosine 1 and everything else 0.
  function keywordEmbeddings(key: RegExp) {
    let calls = 0;
    return {
      client: {
        available: async () => true,
        modelId: async () => 'fake-model',
        embed: async (texts: string[]) => {
          calls += 1;
          return texts.map((t) => Float32Array.from(key.test(t) ? [1, 0] : [0, 1]));
        }
      },
      calls: () => calls
    };
  }

  it('surfaces a relevant buried fact past the inject threshold (fixes the silent drop)', async () => {
    store.resetFacts();
    const emb = keywordEmbeddings(/pangolin/i);
    retrieval.setRetrievalClients({ embeddings: emb.client, rerank: null });

    store.upsertFact('The user once met a pangolin in Borneo', 'distilled'); // oldest → dropped by the recency cap
    for (let i = 0; i < 45; i++) store.upsertFact(`The user has misc preference ${i}`, 'distilled');
    expect(store.getAllFacts().length).toBeGreaterThan(store.getMaxRelevantFacts());

    const ctx = (await inject.buildRecallContext('tell me about the pangolin', {})) ?? '';
    expect(ctx).toMatch(/pangolin/); // relevance pulls the oldest fact back in
    expect(ctx).not.toMatch(/misc preference 40/); // irrelevant facts are filtered out
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
  });

  it('embeds the message as a query and fact backfill as passages', async () => {
    // Prefix-sensitive local models depend on this: get it backwards and e5's
    // query/passage asymmetry quietly degrades every ranking.
    store.resetFacts();
    const kinds: Array<string | undefined> = [];
    retrieval.setRetrievalClients({
      embeddings: {
        available: async () => true,
        modelId: async () => 'fake-model',
        embed: async (texts: string[], kind?: 'query' | 'passage') => {
          kinds.push(kind);
          return texts.map(() => Float32Array.from([1, 0]));
        }
      },
      rerank: null
    });
    for (let i = 0; i < 45; i++) store.upsertFact(`The user has misc preference ${i}`, 'distilled');

    await inject.buildRecallContext('what are my preferences', {});
    expect(kinds).toEqual(['query', 'passage']); // message first, then the missing-vector backfill
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
  });

  it('a flat cosine distribution admits nothing semantic; only the direct lexical match injects', async () => {
    store.resetFacts();
    // This embedder scores every fact identically against the query — pure
    // ambiguity. The old pipeline injected ALL of them (its absolute gate saw
    // three passing scores); the z-gate correctly reads "nothing stands out"
    // and stands aside for the lexical direct match.
    const emb = keywordEmbeddings(/anything/i);
    retrieval.setRetrievalClients({ embeddings: emb.client, rerank: null });

    store.upsertFact('The user lives in Bratislava', 'distilled');
    store.upsertFact('The user has a dog named Rex', 'distilled');
    store.upsertFact('The user codes in TypeScript', 'distilled');

    const ctx = (await inject.buildRecallContext('where do I live', {})) ?? '';
    expect(emb.calls()).toBe(2); // query + passage-vector backfill still run
    expect(ctx).toMatch(/Bratislava/);
    expect(ctx).not.toMatch(/Rex/);
    expect(ctx).not.toMatch(/TypeScript/);
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
  });

  it('does not inject recency filler when embeddings error and lexical search misses', async () => {
    store.resetFacts();
    retrieval.setRetrievalClients({
      embeddings: {
        available: async () => true,
        modelId: async () => 'fake-model',
        embed: async () => {
          throw new Error('endpoint down');
        }
      },
      rerank: null
    });
    for (let i = 0; i < 50; i++) store.upsertFact(`The user holds opinion number ${i}`, 'distilled');

    const ctx = await inject.buildRecallContext('what do I think', {});
    expect(ctx).toBeNull();
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
  });

  it('reranker reorders the cosine shortlist', async () => {
    store.resetFacts();
    // All facts embed identically → cosine ties → shortlist is the first M by id.
    const flat = {
      available: async () => true,
      modelId: async () => 'fake-model',
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0]))
    };
    // Reranker promotes whichever doc mentions a zebra.
    const rerank = {
      available: async () => true,
      rerank: async (_q: string, docs: string[], topN: number) =>
        docs
          .map((d, index) => ({ index, score: /zebra/i.test(d) ? 1 : 0 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, topN)
    };
    retrieval.setRetrievalClients({ embeddings: flat, rerank });

    for (let i = 0; i < 8; i++) store.upsertFact(`The user has trait ${i}`, 'distilled');
    store.upsertFact('The user owns a zebra named Stripes', 'distilled'); // id ~9: in the shortlist, not cosine top-K
    for (let i = 0; i < 40; i++) store.upsertFact(`The user has habit ${i}`, 'distilled');

    const ctx = (await inject.buildRecallContext('any animals?', {})) ?? '';
    expect(ctx).toMatch(/zebra/); // the reranker pulled it into the injected set
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
  });

  it('degrades to cosine ranking (not recency) when the reranker errors', async () => {
    store.resetFacts();
    const emb = keywordEmbeddings(/pangolin/i);
    // Reranker is "available" but every call throws — a dead/misconfigured endpoint.
    const brokenRerank = {
      available: async () => true,
      rerank: async () => {
        throw new Error('ECONNREFUSED');
      }
    };
    retrieval.setRetrievalClients({ embeddings: emb.client, rerank: brokenRerank });

    store.upsertFact('The user once met a pangolin in Borneo', 'distilled'); // oldest
    for (let i = 0; i < 45; i++) store.upsertFact(`The user has misc preference ${i}`, 'distilled');

    const ctx = (await inject.buildRecallContext('tell me about the pangolin', {})) ?? '';
    expect(ctx).toMatch(/pangolin/); // embeddings still rank it; rerank failure didn't nuke the path
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
  });

  it('lexical BM25 fallback surfaces a buried keyword fact with NO embeddings configured', async () => {
    store.resetFacts();
    retrieval.setRetrievalClients({ embeddings: null, rerank: null }); // no model at all

    store.upsertFact('The user once met a pangolin in Borneo', 'distilled'); // oldest → dropped by recency cap
    for (let i = 0; i < 45; i++) store.upsertFact(`The user has misc preference ${i}`, 'distilled');
    expect(store.getAllFacts().length).toBeGreaterThan(store.getMaxRelevantFacts());

    const ctx = (await inject.buildRecallContext('tell me about the pangolin', {})) ?? '';
    expect(ctx).toMatch(/stem_memory_data/i);
    expect(ctx).toMatch(/pangolin/); // lexical match pulls the buried oldest fact back in — no embeddings used
  });

  it('lexical fallback returns no facts when the query shares no terms with any fact', async () => {
    store.resetFacts();
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    for (let i = 0; i < 50; i++) store.upsertFact(`The user holds opinion number ${i}`, 'distilled');

    // "what do I think" → only searchable token is "think", which no fact contains.
    const ctx = (await inject.buildRecallContext('what do I think', {})) ?? '';
    expect(ctx).toBe('');
  });

  it('trigram substring hits are reranker candidates, never direct injections', async () => {
    store.resetFacts();
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    if (!store.factsTrigramAvailable()) return; // skip where the trigram tokenizer is unavailable

    store.upsertFact('The user is optimizing the reranking stage of their pipeline', 'distilled');
    for (let i = 0; i < 45; i++) store.upsertFact(`The user dislikes vegetable ${i}`, 'distilled');

    // "rank" is no unicode61 token in "reranking", but it is a trigram substring
    // of it. Without a reranker the trigram leg stays out of the injection —
    // its ordering is recency, which carries no relevance signal.
    const ungated = (await inject.buildRecallContext('how does rank work here', {})) ?? '';
    expect(ungated).not.toMatch(/reranking stage/);

    // With the gate up, the same trigram hit enters the candidate pool and the
    // cross-encoder decides — this is what keeps morphology recall (Slovak
    // inflections) alive under the gated pipeline.
    retrieval.setRetrievalClients({
      embeddings: null,
      rerank: {
        available: async () => true,
        factGateScore: async () => -8,
        rerank: async (_q: string, docs: string[], topN: number) =>
          docs
            .map((d, index) => ({ index, score: /reranking/.test(d) ? 0 : -11 }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topN)
      }
    });
    const gated = (await inject.buildRecallContext('how does rank work here', {})) ?? '';
    expect(gated).toMatch(/reranking stage/);
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
  });

  it('v2 injection is structured, partial, and points at on-demand search', async () => {
    store.resetFacts();
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    store.upsertFact('The user lives in Bratislava', 'distilled');

    const all = (await inject.buildRecallContext('where do I live', {})) ?? '';
    expect(all).toMatch(/stem_memory_data/);
    expect(inject.RECALL_RULES).toMatch(/search_facts/);

    // Above it the injected set is partial: say so and point at the facts tool,
    // so off-topic-but-relevant context (family, vehicle) can still be found.
    for (let i = 0; i < 45; i++) store.upsertFact(`The user has misc preference ${i}`, 'distilled');
    const subset = (await inject.buildRecallContext('tell me about Bratislava', {})) ?? '';
    expect(subset).toMatch(/stem_memory_data/);
  });

  it('recencyWeight decays monotonically from 1 to ~0', () => {
    expect(search.recencyWeight(0)).toBeCloseTo(1, 10);
    expect(search.recencyWeight(30)).toBeLessThan(search.recencyWeight(0));
    expect(search.recencyWeight(3650)).toBeLessThan(0.01);
    expect(search.recencyWeight(-5)).toBeCloseTo(1, 10); // negative age clamps to "fresh"
  });

  it('rankFactsLexically prefers an exact-term match over a recency-only candidate', () => {
    store.resetFacts();
    store.upsertFact('The user kayaks every summer', 'distilled');
    store.upsertFact('The user prefers tea over coffee', 'distilled');
    const ranked = search.rankFactsLexically('do I drink coffee', 3);
    expect(ranked[0]?.text).toMatch(/tea over coffee/); // lexical hit ranks first
  });

  it('caches vectors as BLOBs and re-flags them missing on a model change', () => {
    store.resetFacts();
    store.upsertFact('The user keeps a fact for the vector round-trip test', 'distilled');
    const id = store.getAllFacts()[0].id;
    const vec = Float32Array.from([0.1, 0.2, 0.3, 0.4]);

    store.upsertFactVector(id, 'm1', vec);
    const got = store.getFactVectors('m1').get(id)!;
    expect(Array.from(got)).toEqual(Array.from(vec)); // bit-identical round-trip
    expect(store.getFactsMissingVector('m1').length).toBe(0);
    // A different model has no vector yet → the fact is "missing" and gets re-embedded.
    expect(store.getFactsMissingVector('m2').some((f) => f.id === id)).toBe(true);
  });

  it('stores the vector of a conflicted fact, so it stops counting as missing', () => {
    // Every turn embeds the facts reported missing. A conflicted fact was
    // reported missing but its vector was refused, so two facts on the server
    // were embedded again on every turn for months.
    store.resetFacts();
    store.upsertFact('The user lives in Bratislava', 'distilled');
    store.upsertFact('The user lives in Košice', 'distilled');
    const [a, b] = store.getAllFacts();
    store.createFactConflict(a.id, b.id, 'two home towns');
    const missing = store.getFactsMissingVector('m1');
    expect(missing.map((f) => f.id).sort()).toEqual([a.id, b.id].sort());
    const gen = store.getFactsGeneration();
    for (const f of missing) {
      expect(store.upsertFactVectorForSnapshot(f.id, f.text, gen, 'm1', Float32Array.from([1, 0]))).toBe(true);
    }
    expect(store.getFactsMissingVector('m1')).toEqual([]);
  });

  it('smart-chunks a large fact set and merges duplicates split far apart by id', async () => {
    store.resetFacts();
    store.setConsolidateChunkSize(4); // force chunking with a small set

    // zebra facts share a vector (cosine 1 → cluster together); fillers are distinct
    // and orthogonal to zebra, so similarity clustering — not id order — groups dupes.
    const emb = {
      available: async () => true,
      modelId: async () => 'cluster-model',
      embed: async (texts: string[]) =>
        texts.map((t, i) => (/zebra/i.test(t) ? Float32Array.from([1, 0, 0]) : Float32Array.from([0, 1, i + 1])))
    };
    retrieval.setRetrievalClients({ embeddings: emb, rerank: null });

    // The model merges any chunk that contains two zebra facts (ids read from the prompt).
    const mergeZebra = {
      complete: async (prompt: string) => {
        const ids = [...prompt.matchAll(/\[(\d+)\][^\n]*zebra/gi)].map((m) => Number(m[1]));
        return ids.length >= 2
          ? JSON.stringify({ merge: [{ ids, text: 'The user owns a zebra' }], correct: [], drop: [] })
          : JSON.stringify({ merge: [], correct: [], drop: [] });
      }
    };

    store.upsertFact('The user has a pet zebra', 'distilled'); // first by id
    for (let i = 0; i < 10; i++) store.upsertFact(`The user enjoys hobby ${i}`, 'distilled');
    store.upsertFact('The user keeps a zebra at home', 'distilled'); // last by id — far from the first

    expect(store.getAllFacts().length).toBeGreaterThan(store.getConsolidateChunkSize());
    const res = await consolidate.consolidateFacts(mergeZebra, { force: true });

    // A naive id-order chunk would split the two zebras; clustering kept them together.
    expect(res.merged).toBe(1);
    expect(store.getAllFacts().filter((f) => /zebra/i.test(f.text) && f.status === 'active').length).toBe(1);
    expect(store.getAllFacts().some((f) => /zebra/i.test(f.text) && f.status === 'superseded')).toBe(true);

    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    store.setConsolidateChunkSize(DEFAULT_CONSOLIDATE_CHUNK);
  });
});

// Active-facts debug surface: previewFacts reports the chosen set + the tier that
// produced it, and the per-thread store round-trips the injected ids (dropping any
// since deleted). Shares the same DB; resetFacts() makes each case deterministic.
describe('Stem Recall — active facts', () => {
  beforeAll(() => store.setMaxRelevantFacts(8));
  afterAll(() => store.setMaxRelevantFacts(DEFAULT_MAX_RELEVANT_FACTS));

  function keywordEmbeddings(key: RegExp) {
    return {
      available: async () => true,
      modelId: async () => 'fake-model',
      embed: async (texts: string[]) => texts.map((t) => Float32Array.from(key.test(t) ? [1, 0] : [0, 1]))
    };
  }

  it('previewFacts relevance-ranks even below the old threshold', async () => {
    store.resetFacts();
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    store.upsertFact('The user lives in Bratislava', 'distilled');
    store.upsertFact('The user has a dog named Rex', 'distilled');
    const r = await inject.previewFacts('where do I live');
    expect(r.tier).toBe('lexical');
    expect(r.facts.map((f) => f.text)).toEqual(['The user lives in Bratislava']);
  });

  it('previewFacts reports tier "embedding" when ranking past the threshold', async () => {
    store.resetFacts();
    retrieval.setRetrievalClients({ embeddings: keywordEmbeddings(/pangolin/i), rerank: null });
    store.upsertFact('The user once met a pangolin in Borneo', 'distilled');
    for (let i = 0; i < 45; i++) store.upsertFact(`The user has misc preference ${i}`, 'distilled');
    const r = await inject.previewFacts('tell me about the pangolin');
    expect(r.tier).toBe('embedding');
    expect(r.facts.some((f) => /pangolin/i.test(f.text))).toBe(true);
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
  });

  it('previewFacts reports tier "lexical" when embeddings are off but a term matches', async () => {
    store.resetFacts();
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    store.upsertFact('The user once met a pangolin in Borneo', 'distilled');
    for (let i = 0; i < 45; i++) store.upsertFact(`The user has misc preference ${i}`, 'distilled');
    const r = await inject.previewFacts('tell me about the pangolin');
    expect(r.tier).toBe('lexical');
    expect(r.facts.some((f) => /pangolin/i.test(f.text))).toBe(true);
  });

  it('previewFacts reports tier "none" when nothing matches lexically', async () => {
    store.resetFacts();
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    for (let i = 0; i < 50; i++) store.upsertFact(`The user holds opinion number ${i}`, 'distilled');
    const r = await inject.previewFacts('what do I think');
    expect(r.tier).toBe('none');
    expect(r.facts).toHaveLength(0);
  });

  it('setActiveFacts/getActiveFactIds round-trip; getFactsByIds drops deleted ids in order', () => {
    store.resetFacts();
    store.upsertFact('Fact one for the active set', 'distilled');
    store.upsertFact('Fact two for the active set', 'distilled');
    const [a, b] = store.getAllFacts();
    const missing = 999999; // never assigned

    store.setActiveFacts('THREAD-X', [b.id, missing, a.id], 'embedding');
    const rec = store.getActiveFactIds('THREAD-X');
    expect(rec).toEqual({ factIds: [b.id, missing, a.id], reasons: {}, disputed: {}, tier: 'embedding' });

    const resolved = store.getFactsByIds(rec!.factIds);
    expect(resolved.map((f) => f.id)).toEqual([b.id, a.id]); // order preserved, missing dropped

    // Upsert replaces the row for the same thread.
    store.setActiveFacts('THREAD-X', [a.id], 'all');
    expect(store.getActiveFactIds('THREAD-X')).toEqual({ factIds: [a.id], reasons: {}, disputed: {}, tier: 'all' });

    expect(store.getActiveFactIds('NO-SUCH-THREAD')).toBeNull();
  });

  it('records the disputed flag as it was at injection time, and keeps legacy rows unknown', () => {
    store.resetFacts();
    store.upsertFact('The user was disputed when injected', 'distilled');
    store.upsertFact('The user was settled when injected', 'distilled');
    const [a, b] = store.getAllFacts();

    store.setActiveFacts(
      'THREAD-D',
      [{ id: a.id, disputed: true }, { id: b.id, reason: 'lexical' }],
      'embedding'
    );
    const rec = store.getActiveFactIds('THREAD-D')!;
    // false is RECORDED, not omitted — that is what makes it distinguishable
    // from a row written before the flag existed.
    expect(rec.disputed).toEqual({ [a.id]: true, [b.id]: false });

    // Legacy shapes — a bare id and an object without the key — stay unknown, so
    // the IPC layer can keep guessing from current status for them alone.
    store.setActiveFacts('THREAD-L', [a.id], 'embedding');
    expect(store.getActiveFactIds('THREAD-L')!.disputed[a.id]).toBeUndefined();
    store.dbHandle()
      .prepare(`UPDATE active_facts SET fact_ids = ? WHERE thread_id = ?`)
      .run(JSON.stringify([{ id: a.id, reason: 'lexical' }]), 'THREAD-L');
    expect(store.getActiveFactIds('THREAD-L')!.disputed[a.id]).toBeUndefined();
  });
});
