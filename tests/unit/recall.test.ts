// Stem Recall regression suite — ported from scripts/recall-verify.mjs.
// Exercises the REAL store/search/inject/distill/consolidate modules against the
// throwaway DB from tests/setup-unit.ts. Tests are stateful and ORDER-DEPENDENT
// (they share one DB, mirroring the original probe), so keep them sequential.
import { afterAll, describe, expect, it } from 'vitest';
import * as store from '../../src/main/recall/store';
import * as search from '../../src/main/recall/search';
import * as inject from '../../src/main/recall/inject';
import * as distill from '../../src/main/recall/distill';
import * as consolidate from '../../src/main/recall/consolidate';

afterAll(() => store.closeForTest());

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

  it('inject builds a context block with facts + relevant hits, excluding current thread', () => {
    const ctx = inject.buildRecallContext('what is my UZ Gent cardiology appointment', { currentThreadId: 'B' }) ?? '';
    expect(ctx).toMatch(/durable facts/i);
    expect(ctx).toMatch(/UZ Gent/);
    expect(ctx).toMatch(/search_past_chats/);
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
    expect(afterFacts.filter((f) => /Bratislava/.test(f.text)).length).toBe(1);
    expect(res.merged).toBe(1);
    expect(afterFacts.some((f) => /HomeNet/.test(f.text))).toBe(true);
    expect(res.dropped).toBe(0);
  });

  it('consolidate applies a correction in place', async () => {
    const engId = store.getAllFacts().find((f) => /software engineer/.test(f.text))!.id;
    const correctLlm = {
      complete: async () => JSON.stringify({ merge: [], correct: [{ id: engId, text: 'The user works as a data scientist' }], drop: [] })
    };
    const corrRes = await consolidate.consolidateFacts(correctLlm);
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
