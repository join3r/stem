import type { Person, PersonFact } from '../../shared/types';
import { recallStore, contactSource, type Fact } from './store';
import { peopleSnapshot } from '../workspace/people';
import { foldText, nameKeys, peopleIn } from './people-match';

// The people a turn is about, with everything Stem knows about them. Similarity
// recall alone misses "napíš Petrovi, ako si nainštalovať VPN" → "Peter uses
// Linux": a person named in the conversation (or the inter-Stem contact the
// mail is with) brings their card and every live fact that names them.

const MAX_PEOPLE = 3;
const MAX_FACTS_PER_PERSON = 15;

/**
 * Live facts naming `person`, pinned and most-used first. What Stem learned from
 * mail with another Stem (source contact:<address>) joins only when `contact`
 * is that address — the same scope as all recall (store getInjectableFacts):
 * the model sees an outsider's words only in mail with that outsider.
 */
export function factsNaming(person: Person, people: readonly Person[], contact: string | null = null): Fact[] {
  const keys = nameKeys(people);
  return recallStore
    .getInjectableFacts(contact)
    .filter((f) => peopleIn(f.text, people, keys).some((p) => p.id === person.id) ||
      (!!person.stemAddress && f.source === contactSource(person.stemAddress)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.timesUsed - a.timesUsed || b.updatedAt - a.updatedAt);
}

/** The People editor's fact list for one person. */
export function personFacts(id: string): PersonFact[] {
  const people = peopleSnapshot().filter((p) => p.status === 'active' || p.id === id);
  const person = people.find((p) => p.id === id);
  if (!person) return [];
  // The editor is the user's own view: it lists contact facts too.
  return factsNaming(person, people, person.stemAddress || null).map((f) => ({ id: f.id, text: f.text, source: f.source, sensitivity: f.sensitivity, pinned: f.pinned }));
}

export interface PeopleBlockEntry {
  name: string;
  aliases?: string[];
  relation?: string;
  stemAddress?: string;
  emails?: string[];
  handles?: string[];
  notes?: string;
  facts: Array<{ id: number; text: string }>;
}

/**
 * The people named in `texts` (the current message first, then earlier ones)
 * or reached at `contact`, with their facts. Accepted people only.
 *
 * Two gates the ordinary fact selection already applies:
 * - In mail with another person (`contact` set) the text is THEIR words, so a
 *   name in it never opens anyone's card — an outsider could otherwise ask
 *   about Peter and have his notes and facts in the reply's context. Only the
 *   person reached at that address comes.
 * - Sensitive facts come only when the relevance gate picked them this turn
 *   (`gatedIds`), as they would without People.
 */
export function peopleForTurn(
  texts: readonly string[],
  contact: string | null,
  gatedIds: ReadonlySet<number> = new Set()
): { entries: PeopleBlockEntry[]; factIds: Set<number> } {
  const people = peopleSnapshot().filter((p) => p.status === 'active');
  const factIds = new Set<number>();
  if (people.length === 0) return { entries: [], factIds };
  const keys = nameKeys(people);
  const found: Person[] = [];
  const add = (p: Person) => {
    if (!found.some((q) => q.id === p.id)) found.push(p);
  };
  if (contact) {
    const c = foldText(contact);
    for (const p of people) if (foldText(p.stemAddress) === c || p.emails.some((e) => foldText(e) === c)) add(p);
  }
  if (!contact) for (const text of texts) for (const p of peopleIn(text, people, keys)) add(p);

  const entries = found.slice(0, MAX_PEOPLE).map((p): PeopleBlockEntry => {
    const facts = factsNaming(p, people, contact)
      .filter((f) => f.sensitivity !== 'sensitive' || gatedIds.has(f.id))
      .slice(0, MAX_FACTS_PER_PERSON);
    for (const f of facts) factIds.add(f.id);
    return {
      name: p.name,
      ...(p.aliases.length ? { aliases: p.aliases } : {}),
      ...(p.relation ? { relation: p.relation } : {}),
      ...(p.stemAddress ? { stemAddress: p.stemAddress } : {}),
      ...(p.emails.length ? { emails: p.emails } : {}),
      ...(p.handles.length ? { handles: p.handles } : {}),
      ...(p.notes ? { notes: p.notes } : {}),
      facts: facts.map((f) => ({ id: f.id, text: f.text }))
    };
  });
  return { entries, factIds };
}
