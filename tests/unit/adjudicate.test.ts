import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADJUDICATE_PROMPT_HEADER,
  MAX_ADJUDICATE_ATTEMPTS,
  adjudicateOpenConflicts
} from '../../src/server/recall/adjudicate';
import type { LlmClient } from '../../src/server/recall/llm';
import { recallStore as store } from '../../src/server/recall/store';
import * as retrieval from '../../src/server/recall/retrieval';

afterAll(() => store.close());
beforeEach(() => {
  store.resetFacts();
});

const reply = (json: unknown): LlmClient => ({ complete: async () => JSON.stringify(json) });

function seedConflict(textA: string, textB: string, over: { sourceA?: string; sourceB?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const a = store.upsertFact(textA, {
    source: over.sourceA ?? 'distilled',
    evidence: [{ messageId: null, threadId: null, role: null, timestamp: now - 86_400, excerpt: `evidence for: ${textA}`, origin: 'folder_doc', folderId: 'f', relPath: 'a.pdf' }]
  })!;
  const b = store.upsertFact(textB, {
    source: over.sourceB ?? 'distilled',
    evidence: [{ messageId: null, threadId: null, role: null, timestamp: now, excerpt: `evidence for: ${textB}`, origin: 'folder_doc', folderId: 'f', relPath: 'b.pdf' }]
  })!;
  const conflictId = store.createFactConflict(a, b, 'test conflict')!;
  return { a, b, conflictId };
}

describe('adjudicateOpenConflicts', () => {
  it('applies an a_wins verdict: loser superseded by winner, resolution recorded', async () => {
    const { a, b } = seedConflict('The fee is €134.07 per month.', 'The fee is €129.15 per month.');
    const res = await adjudicateOpenConflicts(reply({ outcome: 'a_wins' }));
    expect(res.resolved).toBe(1);
    expect(store.getFactDetails(a)?.status).toBe('active');
    expect(store.getFactDetails(b)?.status).toBe('superseded');
    expect(store.getFactDetails(b)?.supersededBy).toBe(a);
    expect(store.getMemoryConflicts()).toHaveLength(0);
    const audit = store.getAutoResolvedConflicts();
    expect(audit).toHaveLength(1);
    expect(audit[0].resolution).toBe('auto_supersede');
  });

  it('applies a both_true verdict: both reactivate, auto_keep_both recorded', async () => {
    const { a, b } = seedConflict('Invoice 20260003 totals €9,608.10.', 'Invoice 20260004 totals €11,291.40.');
    const res = await adjudicateOpenConflicts(reply({ outcome: 'both_true' }));
    expect(res.resolved).toBe(1);
    expect(store.getFactDetails(a)?.status).toBe('active');
    expect(store.getFactDetails(b)?.status).toBe('active');
    expect(store.getAutoResolvedConflicts()[0]?.resolution).toBe('auto_keep_both');
  });

  it('applies a rewrite verdict: atomic replacements inherit provenance, originals superseded', async () => {
    const { a, b } = seedConflict(
      'The user has PZP and GAP insurance with Kooperativa.',
      'The car has DEFEND GAP MAX insurance from Fortegra.'
    );
    const res = await adjudicateOpenConflicts(reply({
      outcome: 'rewrite',
      facts: ['The user has PZP insurance with Kooperativa.', 'The car has DEFEND GAP MAX insurance from Fortegra (replacing earlier GAP cover).']
    }));
    expect(res.resolved).toBe(1);
    expect(store.getFactDetails(a)?.status).toBe('superseded');
    expect(store.getFactDetails(b)?.status).toBe('superseded');
    const replacements = store.getAllFacts().filter((f) => f.status === 'active');
    expect(replacements).toHaveLength(2);
    for (const f of replacements) {
      const details = store.getFactDetails(f.id)!;
      // Union of both sides' evidence rides along on each replacement.
      expect(details.evidence.length).toBe(2);
    }
    expect(store.getAutoResolvedConflicts()[0]?.resolution).toBe('auto_rewrite');
    expect(store.getMemoryConflicts()).toHaveLength(0);
  });

  it('queues rewrite replacements for the neighbour sweep when embeddings are up', async () => {
    const embeddings = {
      available: async () => true,
      modelId: async () => 'adj-model',
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0]))
    };
    retrieval.setRetrievalClients({ embeddings, rerank: null });
    try {
      const neighbour = store.upsertFact('The user pays 40 euro monthly for car insurance.', 'distilled')!;
      store.upsertFactVector(neighbour, 'adj-model', Float32Array.from([1, 0]));
      seedConflict('The user has PZP with Kooperativa.', 'The car has GAP insurance from Fortegra.');
      const res = await adjudicateOpenConflicts(reply({
        outcome: 'rewrite',
        facts: ['The user has PZP insurance with Kooperativa.']
      }));
      expect(res.resolved).toBe(1);
      // Replacements never pass distillation's write-time sweep, and the
      // one-shot backfill has stamped itself done — without this queue entry
      // they were the only facts never cross-checked against a neighbour.
      const pending = store.dbHandle().prepare(
        `SELECT COUNT(*) AS n FROM fact_relation_checks WHERE verdict IS NULL AND origin = 'sweep'`
      ).get() as { n: number };
      expect(pending.n).toBeGreaterThan(0);
    } finally {
      retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    }
  });

  it('skips a rewrite with too many replacement facts (conflict stays open)', async () => {
    seedConflict('Fact ra.', 'Fact rb.');
    const res = await adjudicateOpenConflicts(reply({
      outcome: 'rewrite',
      facts: ['1', '2', '3', '4', '5']
    }));
    expect(res.resolved).toBe(0);
    expect(res.skipped).toBe(1);
    expect(store.getMemoryConflicts()).toHaveLength(1);
  });

  it('never adjudicates a conflict involving an explicit fact', async () => {
    seedConflict('The user has GAP with Kooperativa.', 'The car has DEFEND GAP MAX.', { sourceA: 'explicit' });
    const llm: LlmClient = {
      complete: async (prompt) => {
        if (prompt.includes(ADJUDICATE_PROMPT_HEADER)) throw new Error('must not adjudicate explicit conflicts');
        return '{}';
      }
    };
    const res = await adjudicateOpenConflicts(llm);
    expect(res).toEqual({ resolved: 0, skipped: 0 });
    expect(store.getMemoryConflicts()).toHaveLength(1);
  });

  it('caps attempts: a conflict the model can never parse falls back to manual-only', async () => {
    seedConflict('Fact ca.', 'Fact cb.');
    let calls = 0;
    const garbage: LlmClient = { complete: async () => { calls += 1; return 'not json'; } };
    for (let i = 0; i < MAX_ADJUDICATE_ATTEMPTS; i += 1) {
      expect((await adjudicateOpenConflicts(garbage)).skipped).toBe(1);
    }
    expect(calls).toBe(MAX_ADJUDICATE_ATTEMPTS);
    // Cap reached: no further model calls, conflict remains open for the user.
    expect(await adjudicateOpenConflicts(garbage)).toEqual({ resolved: 0, skipped: 0 });
    expect(calls).toBe(MAX_ADJUDICATE_ATTEMPTS);
    expect(store.getMemoryConflicts()).toHaveLength(1);
  });

  it('does not spend an attempt on a model that is merely down', async () => {
    seedConflict('Fact da.', 'Fact db.');
    let calls = 0;
    const down: LlmClient = { complete: async () => { calls += 1; throw new Error('model unreachable'); } };

    // The attempt is counted BEFORE the call so a crash mid-call still costs one.
    // An error we caught is the other case: three unlucky passes used to drop the
    // conflict to manual-only for good, with nothing to say the model was the
    // problem rather than the pair.
    for (let i = 0; i < MAX_ADJUDICATE_ATTEMPTS + 1; i += 1) {
      expect((await adjudicateOpenConflicts(down)).skipped).toBe(1);
    }
    expect(calls).toBe(MAX_ADJUDICATE_ATTEMPTS + 1);

    // And the conflict is still adjudicable once the model is back.
    expect((await adjudicateOpenConflicts(reply({ outcome: 'a_wins' }))).resolved).toBe(1);
  });

  it('applies nothing when facts are reset while the model call is in flight', async () => {
    seedConflict('Fact ea.', 'Fact eb.');
    const llm: LlmClient = {
      complete: async () => {
        store.resetFacts();
        return JSON.stringify({ outcome: 'a_wins' });
      }
    };
    const res = await adjudicateOpenConflicts(llm);
    expect(res.resolved).toBe(0);
    expect(store.getAutoResolvedConflicts()).toHaveLength(0);
  });
});
