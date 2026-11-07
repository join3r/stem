// Parent memories (recall/fact-groups.ts): filing facts into groups, rewriting
// a group's text when its members change, the privacy rules around stale and
// deleted members, and injection through the GTE fact path. Stateful (shared
// per-process DB) like the sibling recall suites.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRecallContext, previewFacts } from '../../src/server/recall/inject';
import { formatFactQuery } from '../../src/server/recall/fact-query';
import { recallStore as store, type Fact, type FactTier } from '../../src/server/recall/store';
import { setRetrievalClients, type FactRerankClient } from '../../src/server/recall/retrieval';
import {
  MAX_GROUPS_PER_FACT,
  factGroupsDue,
  membersKey,
  parseFiling,
  parseRewrite,
  refreshFactGroups
} from '../../src/server/recall/fact-groups';
import type { ParentMemory } from '../../src/server/recall/fact-groups';
import type { LlmClient } from '../../src/server/recall/llm';
import * as search from '../../src/server/recall/search';
import * as searchCore from '../../src/server/recall/search-core';
import * as folders from '../../src/server/folder-index';

const MODEL = 'synthetic-groups';

/** A fake memory model: files every new fact into one group per first word, writes "Parent of <ids>". */
function fakeLlm(opts: { filing?: (prompt: string) => string; rewrite?: (prompt: string) => string } = {}): LlmClient & { prompts: string[] } {
  const llm = {
    prompts: [] as string[],
    complete: async (prompt: string) => {
      llm.prompts.push(prompt);
      if (prompt.includes('NEW FACTS:')) return opts.filing?.(prompt) ?? fileByTopic(prompt);
      return opts.rewrite?.(prompt) ?? rewriteAll(prompt);
    }
  };
  return llm;
}

function section(prompt: string, name: string): string {
  const start = prompt.indexOf(`${name}:`);
  if (start === -1) return '';
  const rest = prompt.slice(start + name.length + 1);
  const next = rest.search(/\n\n[A-Z ]+(\(|:)/);
  return next === -1 ? rest : rest.slice(0, next);
}

function fileByTopic(prompt: string): string {
  const lines = [...section(prompt, 'NEW FACTS').matchAll(/^\[(\d+)\] (\S+)/gm), ...section(prompt, 'OLDER UNGROUPED FACTS').matchAll(/^\[(\d+)\] (\S+)/gm)];
  const byTopic = new Map<string, number[]>();
  for (const [, id, topic] of lines) byTopic.set(topic, [...(byTopic.get(topic) ?? []), Number(id)]);
  const groups = [...section(prompt, 'EXISTING GROUPS (id G<n>; use the number in "group")').matchAll(/^\[G(\d+)\] (\S+)/gm)];
  const join: Array<{ group: number; facts: number[] }> = [];
  const create: Array<{ label: string; facts: number[] }> = [];
  for (const [topic, ids] of byTopic) {
    const existing = groups.find(([, , label]) => label === topic);
    if (existing) join.push({ group: Number(existing[1]), facts: ids });
    else create.push({ label: topic, facts: ids });
  }
  return JSON.stringify({ join, create });
}

function rewriteAll(prompt: string): string {
  const out: Record<string, string> = {};
  for (const m of prompt.matchAll(/^Group (\d+) \(([^)]*)\):\n((?:- .*\n?)+)/gm)) {
    out[m[1]] = `The user has a ${m[2]} memory covering ${m[3].trim().split('\n').length} facts.`;
  }
  return JSON.stringify(out);
}

function seed(text: string, sensitivity: 'standard' | 'sensitive' = 'standard'): number {
  const id = store.upsertFact(text, 'explicit', { sensitivity })!;
  store.upsertFactVector(id, MODEL, Float32Array.from([1, 0]));
  return id;
}

function groups(): Array<{ id: number; label: string; text: string | null; textKey: string | null; status: string }> {
  return store.dbHandle().prepare(
    `SELECT id, label, text, text_key AS textKey, status FROM fact_groups ORDER BY id`
  ).all() as never;
}

function members(groupId: number): number[] {
  return (store.dbHandle().prepare(`SELECT fact_id AS id FROM fact_group_members WHERE group_id = ? ORDER BY fact_id`)
    .all(groupId) as Array<{ id: number }>).map((r) => r.id);
}

function embeddings() {
  return {
    available: async () => true,
    modelId: async () => MODEL,
    embed: vi.fn(async (texts: string[]) => texts.map(() => Float32Array.from([1, 0])))
  };
}

function gte(score: (text: string) => number): FactRerankClient {
  return {
    modelId: 'synthetic-gte',
    factQuery: formatFactQuery,
    maxFacts: 16,
    available: async () => true,
    factGateScore: async () => 0,
    rerank: vi.fn(async (_query: string, docs: string[]) => docs.map((text, index) => ({ index, score: score(text) })))
  };
}

function quietSearch(): void {
  vi.spyOn(searchCore, 'hybridSearchSummaries').mockResolvedValue([]);
  vi.spyOn(search, 'searchMemoryHybrid').mockResolvedValue([]);
  vi.spyOn(folders, 'searchFolderDocs').mockResolvedValue([]);
}

function sink(): { facts: Fact[]; tier: FactTier; parents?: ParentMemory[] } {
  return { facts: [], tier: 'none' };
}

beforeEach(() => {
  store.resetFacts();
  store.resetEpisodic({ skipVacuum: true });
  store.setMaxRelevantFacts(32);
  store.setUsageWeight(0);
  setRetrievalClients({ embeddings: embeddings() });
});

afterEach(() => {
  vi.restoreAllMocks();
  setRetrievalClients({ embeddings: null, rerank: null });
});

afterAll(() => store.close());

describe('filing and rewriting', () => {
  it('groups new facts, writes each group text, then has nothing to do', async () => {
    const knee = [seed('knee: the user tore a meniscus in May'), seed('knee: surgery is planned for December')];
    const car = [seed('car: leases a Škoda Octavia'), seed('car: insurance renews in March')];
    seed('loner: likes jazz');
    expect(factGroupsDue()).toBe(true);
    const llm = fakeLlm();
    const r = await refreshFactGroups(llm);

    // The fake files the loner alone; a group needs two facts, so it stays out.
    expect(r).toMatchObject({ created: 2, rewritten: 2, failedPrompts: 0 });
    const g = groups();
    expect(g.map((x) => x.label).sort()).toEqual(['car:', 'knee:']);
    expect(members(g.find((x) => x.label === 'knee:')!.id)).toEqual(knee);
    expect(members(g.find((x) => x.label === 'car:')!.id)).toEqual(car);
    expect(g.every((x) => x.text?.startsWith('The user has'))).toBe(true);
    expect(factGroupsDue()).toBe(false);
  });

  it('refuses a group of one, unknown ids and groups it never showed', async () => {
    const a = seed('alpha: one');
    const b = seed('beta: two');
    const llm = fakeLlm({
      filing: () => JSON.stringify({
        join: [{ group: 999, facts: [a] }],
        create: [{ label: 'solo', facts: [a] }, { label: 'ghost', facts: [a, 123456] }, { label: 'pair', facts: [a, b] }]
      })
    });
    await refreshFactGroups(llm);
    expect(groups().map((g) => g.label)).toEqual(['pair']);
  });

  it('caps a fact at three groups', async () => {
    const a = seed('shared: fact');
    const others = [1, 2, 3, 4].map((n) => seed(`other${n}: fact`));
    const llm = fakeLlm({
      filing: () => JSON.stringify({ join: [], create: others.map((o, i) => ({ label: `g${i}`, facts: [a, o] })) })
    });
    await refreshFactGroups(llm);
    const count = (store.dbHandle().prepare(`SELECT COUNT(*) AS n FROM fact_group_members WHERE fact_id = ?`).get(a) as { n: number }).n;
    expect(count).toBe(MAX_GROUPS_PER_FACT);
  });

  it('a changed member makes the text stale until the rewrite, and asks the model once more', async () => {
    const [a, b] = [seed('trip: Lisbon in June'), seed('trip: flights booked')];
    await refreshFactGroups(fakeLlm());
    const before = groups()[0];
    expect(before.textKey).toBe(membersKey([{ id: a, text: 'trip: Lisbon in June' }, { id: b, text: 'trip: flights booked' }]));

    store.updateFactText(b, 'trip: flights booked with TAP');
    expect(factGroupsDue()).toBe(true);
    const llm = fakeLlm();
    const r = await refreshFactGroups(llm);
    expect(r.rewritten).toBe(1);
    expect(llm.prompts.some((p) => p.includes('NEW FACTS:'))).toBe(false);
    expect(groups()[0].textKey).not.toBe(before.textKey);
  });

  it('a replacement inherits its predecessor\'s group without a model call', async () => {
    const [a, b] = [seed('job: works at Acme'), seed('job: leads the platform team')];
    await refreshFactGroups(fakeLlm());
    const gid = groups()[0].id;
    const c = seed('job: now works at Globex');
    store.supersedeFact(a, c);
    const llm = fakeLlm({ filing: () => { throw new Error('should not be asked'); } });
    await refreshFactGroups(llm);
    expect(members(gid)).toEqual([a, b, c].sort((x, y) => x - y));
    expect(llm.prompts.every((p) => !p.includes('NEW FACTS:'))).toBe(true);
  });

  it('retires a group left with fewer than two live members', async () => {
    const [a] = [seed('pet: has a cat named Mia'), seed('pet: Mia is 4 years old')];
    await refreshFactGroups(fakeLlm());
    store.deleteFact(a);
    await refreshFactGroups(fakeLlm());
    expect(groups()[0]).toMatchObject({ status: 'retired', text: null });
  });

  it('deleting a member wipes the parent text at once', async () => {
    const [a] = [seed('health: takes vitamin D'), seed('health: allergic to penicillin'), seed('health: sees Dr. Novak')];
    await refreshFactGroups(fakeLlm());
    expect(groups()[0].text).not.toBeNull();
    store.deleteFact(a);
    expect(groups()[0]).toMatchObject({ text: null, textKey: null });
  });

  it('a facts reset clears every group', async () => {
    seed('home: lives in Bratislava');
    seed('home: flat on the 4th floor');
    await refreshFactGroups(fakeLlm());
    expect(groups()).toHaveLength(1);
    store.resetFacts();
    expect(groups()).toHaveLength(0);
  });

  it('parses replies defensively', () => {
    expect(parseFiling('nonsense')).toBeNull();
    expect(parseFiling('```json\n{"join":[{"group":1,"facts":[2,"x"]}],"create":[{"label":"","facts":[1,2]}]}\n```'))
      .toEqual({ join: [{ group: 1, facts: [2] }], create: [] });
    expect(parseRewrite('{"G7": "The user x.", "8": "", "nine": "y"}')).toEqual(new Map([[7, 'The user x.']]));
  });
});

describe('injection', () => {
  async function seedGroup(texts: string[], sensitivity: 'standard' | 'sensitive' = 'standard'): Promise<void> {
    texts.forEach((t, i) => seed(t, i === 0 ? sensitivity : 'standard'));
    await refreshFactGroups(fakeLlm());
  }

  it('injects a parent that clears the GTE floor, alongside the facts', async () => {
    await seedGroup(['garden: grows tomatoes', 'garden: has a greenhouse']);
    quietSearch();
    const chosen = sink();
    const block = await buildRecallContext('How are my tomatoes?', { factReranker: gte(() => 1), chosen });
    expect(chosen.parents).toHaveLength(1);
    expect(block).toContain('"broaderMemories":[{"text":"The user has a garden: memory covering 2 facts."');
    expect(block).toContain('Each broaderMemories entry sums up several related facts');
  });

  it('holds a parent with a sensitive member to the sensitive margin', async () => {
    await seedGroup(['meds: takes sertraline', 'meds: prescribed by Dr. Kral'], 'sensitive');
    quietSearch();
    const chosen = sink();
    await buildRecallContext('anything', { factReranker: gte((t) => (t.startsWith('The user') ? 1 : -5)), chosen });
    expect(chosen.parents).toEqual([]);
    const passing = sink();
    await buildRecallContext('anything', { factReranker: gte((t) => (t.startsWith('The user') ? 2.5 : -5)), chosen: passing });
    expect(passing.parents?.map((p) => p.sensitive)).toEqual([true]);
  });

  it('never injects a stale text', async () => {
    const before = store.getAllFacts().length;
    await seedGroup(['band: plays bass', 'band: rehearses on Tuesdays']);
    const id = store.getAllFacts()[before].id;
    store.updateFactText(id, 'band: plays guitar');
    quietSearch();
    const chosen = sink();
    await buildRecallContext('band stuff', { factReranker: gte(() => 5), chosen });
    expect(chosen.parents).toEqual([]);
  });

  it('the draft preview shows the parents a turn would get', async () => {
    await seedGroup(['tea: drinks green tea', 'tea: buys sencha online']);
    setRetrievalClients({ embeddings: embeddings(), factRerank: async () => gte(() => 1) });
    const preview = await previewFacts('which tea should I order?');
    expect(preview.parents.map((p) => p.text)).toEqual(['The user has a tea: memory covering 2 facts.']);
  });

  it('only the GTE fact path gets parents', async () => {
    await seedGroup(['run: runs 5k on Sundays', 'run: training for a half marathon']);
    quietSearch();
    const plain = { available: async () => true, factGateScore: async () => 0, rerank: vi.fn(async (_q: string, docs: string[]) => docs.map((_d, index) => ({ index, score: 5 }))) };
    setRetrievalClients({ embeddings: embeddings(), rerank: plain, factRerank: async () => null });
    const chosen = sink();
    await buildRecallContext('running', { chosen });
    expect(chosen.parents).toEqual([]);
  });
});
