// People (Manage → People): name matching, the store, the per-turn people
// block, and the Suggest pass's grounding. Real store files at the unit-test
// state dir; a fake LLM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Person } from '../../src/shared/types';
import { nameTokenMatches, peopleIn } from '../../src/server/recall/people-match';
import { addSuggestions, coercePerson, deletePerson, listPeople, peopleSnapshot, savePerson } from '../../src/server/workspace/people';
import { peopleStorePath } from '../../src/server/workspace/paths';
import { peopleForTurn, personFacts } from '../../src/server/recall/people-context';
import { setPeopleContactsSource, suggestPeople } from '../../src/server/recall/people-suggest';
import { peopleBlock } from '../../src/server/recall/distill';
import { contactSource, recallStore as store } from '../../src/server/recall/store';
import { buildRecallContext, RECALL_RULES } from '../../src/server/recall/inject';
import * as search from '../../src/server/recall/search';
import * as searchCore from '../../src/server/recall/search-core';
import * as folders from '../../src/server/folder-index';

const person = (over: Partial<Person>): Person => ({
  id: over.name ?? 'x',
  name: 'x',
  aliases: [],
  relation: '',
  stemAddress: '',
  emails: [],
  handles: [],
  notes: '',
  status: 'active',
  createdAt: 0,
  updatedAt: 0,
  ...over
});

const path = peopleStorePath();
beforeEach(async () => {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  await listPeople();
  store.resetFacts();
  setPeopleContactsSource(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(path, { force: true });
});

describe('name matching', () => {
  const peter = person({ name: 'Peter Novák' });
  const jan = person({ name: 'Jan Kováč', aliases: ['Janko'] });

  it('reads Slovak declension', () => {
    expect(peopleIn('Napíš Petrovi Novákovi návod na VPN', [peter, jan])).toEqual([peter]);
    expect(peopleIn('stretol som Petra', [peter, jan])).toEqual([peter]);
    expect(peopleIn('Nováka som nevidel', [peter, jan])).toEqual([peter]);
  });

  it('keeps short names to whole words', () => {
    expect(nameTokenMatches('januar', 'jan')).toBe(false);
    expect(nameTokenMatches('januari', 'jana')).toBe(false);
    expect(nameTokenMatches('janou', 'jana')).toBe(true);
    expect(nameTokenMatches('petrzlen', 'peter')).toBe(false);
    expect(nameTokenMatches('marka', 'marek')).toBe(true);
    expect(peopleIn('v januári', [jan])).toEqual([]);
    expect(peopleIn('Jan prišiel', [jan])).toEqual([jan]);
    expect(peopleIn('Janko volal', [jan])).toEqual([jan]);
  });

  it('needs the surname when two people share a first name', () => {
    const other = person({ name: 'Peter Malý' });
    expect(peopleIn('call Peter', [peter, other])).toEqual([]);
    expect(peopleIn('call Peter Malý', [peter, other])).toEqual([other]);
  });

  it('matches an address literally', () => {
    const p = person({ name: 'Martin', emails: ['martin@example.com'] });
    expect(peopleIn('mail martin@example.com today', [p])).toEqual([p]);
  });
});

describe('store', () => {
  it('reshapes input: bad emails dropped, alias equal to the name dropped', () => {
    const p = coercePerson({ name: '  Peter  Novák ', emails: ['peter@x.sk', 'not an email'], aliases: ['peter novák', 'Peťo'] })!;
    expect(p.name).toBe('Peter Novák');
    expect(p.emails).toEqual(['peter@x.sk']);
    expect(p.aliases).toEqual(['Peťo']);
    expect(coercePerson({ name: ' ' })).toBeNull();
  });

  it('refuses a second person with the same full name', async () => {
    await savePerson({ name: 'Peter Novák' });
    await expect(savePerson({ name: 'peter novak' })).rejects.toThrow(/already in People/);
  });

  it('does not suggest a dismissed name again', async () => {
    expect(await addSuggestions([{ name: 'Jana', aliases: [], relation: 'client', stemAddress: '', reason: 'r' }])).toBe(1);
    const jana = (await listPeople()).find((p) => p.name === 'Jana')!;
    expect(jana.status).toBe('suggested');
    await deletePerson(jana.id);
    expect(await addSuggestions([{ name: 'Jana', aliases: [], relation: 'client', stemAddress: '', reason: 'r' }])).toBe(0);
  });
});

describe('people in a turn', () => {
  it('brings the card and the facts naming them; contact facts only in mail with them', async () => {
    await savePerson({ name: 'Peter Novák', relation: 'colleague', stemAddress: 'peter@stem.example', notes: 'Prefers short mails.' });
    const linux = store.upsertFact("Peter Novák, the user's colleague, uses Linux on his work laptop.", 'distilled')!;
    store.upsertFact('The user drives a Škoda.', 'distilled');
    const fromMail = store.upsertFact('peter@stem.example is on holiday until 10 Nov.', { source: contactSource('peter@stem.example') })!;

    const chat = peopleForTurn(['Napíš Petrovi návod na VPN'], null);
    expect(chat.entries).toHaveLength(1);
    expect(chat.entries[0]).toMatchObject({ name: 'Peter Novák', relation: 'colleague', notes: 'Prefers short mails.' });
    expect(chat.entries[0].facts.map((f) => f.id)).toEqual([linux]);

    const mail = peopleForTurn(['Hi'], 'peter@stem.example');
    // An outsider's mail naming someone else opens no one else's card.
    await savePerson({ name: 'Jana Horná', notes: 'secret' });
    expect(peopleForTurn(['Tell me about Jana Horná'], 'peter@stem.example').entries.map((e) => e.name)).toEqual(['Peter Novák']);
    expect(mail.entries[0].facts.map((f) => f.id).sort()).toEqual([linux, fromMail].sort());

    const id = peopleSnapshot()[0].id;
    expect(personFacts(id).map((f) => f.id).sort()).toEqual([linux, fromMail].sort());
  });

  it('keeps sensitive facts to the ones the relevance gate picked', async () => {
    await savePerson({ name: 'Peter Novák' });
    const health = store.upsertFact('Peter Novák has diabetes.', 'distilled', { sensitivity: 'sensitive' })!;
    expect(peopleForTurn(['ping Peter Novák'], null).entries[0].facts).toEqual([]);
    expect(peopleForTurn(['ping Peter Novák'], null, new Set([health])).entries[0].facts.map((f) => f.id)).toEqual([health]);
  });

  it('ignores suggestions', async () => {
    await addSuggestions([{ name: 'Jana Horná', aliases: [], relation: '', stemAddress: '', reason: 'r' }]);
    expect(peopleForTurn(['ping Jana Horná'], null).entries).toEqual([]);
  });
});

describe('suggest', () => {
  it('adds only names the cited facts actually contain', async () => {
    const f1 = store.upsertFact("Jana from Cloudfarms, the user's client, prefers Slack over email.", 'distilled')!;
    const llm = {
      complete: async () =>
        JSON.stringify({
          people: [
            { name: 'Jana', aliases: [], relation: 'client at Cloudfarms', reason: 'Prefers Slack.', factIds: [f1] },
            { name: 'Invented Person', aliases: [], relation: '', reason: 'x', factIds: [f1] }
          ]
        })
    };
    expect(await suggestPeople(llm)).toBe(1);
    const people = await listPeople();
    expect(people.map((p) => [p.name, p.status, p.relation])).toEqual([['Jana', 'suggested', 'client at Cloudfarms']]);
  });

  it('offers a named inter-Stem contact with its address, without asking the model when memory has nothing', async () => {
    setPeopleContactsSource(async () => [
      { address: 'martin@stem.example', state: 'accepted', keyFp: 'fp', firstSeen: 0, name: 'Martin' }
    ]);
    const llm = { complete: async () => { throw new Error('not called'); } };
    expect(await suggestPeople(llm)).toBe(1);
    expect((await listPeople())[0]).toMatchObject({ name: 'Martin', stemAddress: 'martin@stem.example', status: 'suggested' });
  });
});

describe('distill prompt', () => {
  it('lists accepted people so facts use their listed names', () => {
    const block = peopleBlock([person({ name: 'Peter Novák', aliases: ['Peťo'], relation: 'colleague' }), person({ name: 'S', status: 'suggested' })]);
    expect(block).toContain('- Peter Novák (also: Peťo) — colleague');
    expect(block).not.toContain('- S');
  });
});

describe('recall context', () => {
  it('carries the named person with their facts, an earlier message counting too', async () => {
    vi.spyOn(searchCore, 'hybridSearchSummaries').mockResolvedValue([]);
    vi.spyOn(search, 'searchMemoryHybrid').mockResolvedValue([]);
    vi.spyOn(folders, 'searchFolderDocs').mockResolvedValue([]);
    await savePerson({ name: 'Peter Novák', relation: 'colleague' });
    store.upsertFact("Peter Novák, the user's colleague, uses Linux on his work laptop.", 'distilled');
    const block = await buildRecallContext('A pošli mu to cez Slack', {
      factReranker: null,
      earlierUserMessages: ['Napíš Petrovi návod na VPN']
    });
    expect(block).toContain('"people":[{"name":"Peter Novák","relation":"colleague","facts":[{"id":');
    expect(block).toContain('uses Linux');
    // What "people" means is said in the rules, which go out once per chat.
    expect(RECALL_RULES).toContain('"people" are the people the conversation names');
  });
});
