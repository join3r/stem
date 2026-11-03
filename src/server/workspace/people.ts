import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Person } from '../../shared/types';
import { degrade } from '../degrade';
import { replaceFile } from '../replace-file';
import { peopleStorePath } from './paths';
import { foldText } from '../recall/people-match';

// The people in the user's life (Manage → People): a name, aliases, how they
// relate to the user, where to reach them, and the user's notes. Facts are not
// stored here — a fact belongs to a person because its text names them (see
// recall/people-match.ts). Suggestions (status 'suggested') come from the model
// reading memory; they are inert until the user accepts one. A deleted
// suggestion's name is remembered so the next pass does not offer it again.
//
// Contact details here are only ever typed by the user (or carried over from an
// inter-Stem contact the user already accepted): suggestions carry names and a
// relation, never an address — retrieved mail can be forged.

interface PeopleFile {
  version: 1;
  people: Person[];
  /** Folded names of suggestions the user deleted. */
  dismissed: string[];
}

const MAX = { name: 120, alias: 80, aliases: 20, relation: 200, address: 200, list: 20, handle: 200, notes: 4000, reason: 300 };

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function strList(v: unknown, maxItems: number, maxLen: number, keep: (s: string) => boolean = () => true): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    const s = str(item, maxLen);
    const key = foldText(s);
    if (!s || seen.has(key) || !keep(s)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

const looksLikeAddress = (s: string): boolean => /^[^\s@]+@[^\s@]+$/.test(s);

/** Reshape untrusted input into a Person; null when it has no name. */
export function coercePerson(raw: unknown, now = Date.now()): Person | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = str(r.name, MAX.name).replace(/\s+/g, ' ');
  if (!name) return null;
  const stemAddress = str(r.stemAddress, MAX.address);
  const person: Person = {
    id: str(r.id, 80) || randomUUID(),
    name,
    aliases: strList(r.aliases, MAX.aliases, MAX.alias, (a) => foldText(a) !== foldText(name)),
    relation: str(r.relation, MAX.relation),
    stemAddress: looksLikeAddress(stemAddress) ? stemAddress : '',
    emails: strList(r.emails, MAX.list, MAX.address, looksLikeAddress),
    handles: strList(r.handles, MAX.list, MAX.handle),
    notes: str(r.notes, MAX.notes),
    status: r.status === 'suggested' ? 'suggested' : 'active',
    createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : now,
    updatedAt: now
  };
  const reason = str(r.reason, MAX.reason);
  if (person.status === 'suggested' && reason) person.reason = reason;
  return person;
}

function coerce(parsed: unknown): PeopleFile {
  const r = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const people: Person[] = [];
  for (const raw of Array.isArray(r.people) ? r.people : []) {
    const updatedAt = (raw as { updatedAt?: unknown })?.updatedAt;
    const p = coercePerson(raw, typeof updatedAt === 'number' ? updatedAt : Date.now());
    if (p && !people.some((q) => q.id === p.id)) people.push(p);
  }
  return { version: 1, people, dismissed: strList(r.dismissed, 2000, MAX.name).map(foldText) };
}

let changed: (() => void) | null = null;

/** Register the (single) listener told after every successful write. */
export function onPeopleChanged(cb: (() => void) | null): void {
  changed = cb;
}

// The last list read or written, for the per-turn lookup (recall/inject.ts),
// which must not touch the disk on every turn.
let snapshot: Person[] = [];

/** The people as of the last read or write. Call listPeople once at startup to fill it. */
export function peopleSnapshot(): readonly Person[] {
  return snapshot;
}

let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function readStore(): Promise<PeopleFile> {
  try {
    return coerce(JSON.parse(await readFile(peopleStorePath(), 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return coerce({});
    throw err;
  }
}

async function writeStore(store: PeopleFile): Promise<void> {
  const path = peopleStorePath();
  // quiet: the write below rejects to the caller if the directory really is missing.
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await replaceFile(tmp, path);
}

export function listPeople(): Promise<Person[]> {
  return enqueue(async () => {
    try {
      snapshot = (await readStore()).people;
    } catch (err) {
      degrade('people', 'showed no people (the file could not be read)', err);
      snapshot = [];
    }
    return snapshot;
  });
}

/** Folded names already taken (people + dismissed suggestions), for the suggest pass. */
export async function knownPeopleNames(): Promise<Set<string>> {
  const store = await enqueue(readStore);
  return new Set([...store.people.flatMap((p) => [p.name, ...p.aliases]).map(foldText), ...store.dismissed]);
}

function update(mutate: (store: PeopleFile) => void): Promise<Person[]> {
  return enqueue(async () => {
    // A file that exists but can't be read is never written over (readStore
    // rethrows anything but ENOENT): one failed save beats losing the list.
    const store = await readStore();
    mutate(store);
    await writeStore(store);
    snapshot = store.people;
    changed?.();
    return store.people;
  });
}

/** Create or update a person (upsert by id). Full names are unique among people. */
export function savePerson(input: unknown): Promise<Person[]> {
  return update((store) => {
    const person = coercePerson(input);
    if (!person) throw new Error('A person needs a name.');
    const clash = store.people.find((p) => p.id !== person.id && foldText(p.name) === foldText(person.name));
    if (clash) throw new Error(`"${clash.name}" is already in People. Add a surname to tell them apart.`);
    const at = store.people.findIndex((p) => p.id === person.id);
    if (at >= 0) {
      person.createdAt = store.people[at].createdAt;
      store.people[at] = person;
    } else store.people.push(person);
  });
}

export function deletePerson(id: string): Promise<Person[]> {
  return update((store) => {
    const person = store.people.find((p) => p.id === id);
    if (!person) return;
    if (person.status === 'suggested') store.dismissed.push(foldText(person.name));
    store.people = store.people.filter((p) => p.id !== id);
  });
}

/** Add suggestions, skipping any name already taken or dismissed. Returns how many were added. */
export async function addSuggestions(suggestions: Array<Pick<Person, 'name' | 'aliases' | 'relation' | 'stemAddress'> & { reason: string }>): Promise<number> {
  let added = 0;
  await update((store) => {
    const taken = new Set([...store.people.flatMap((p) => [p.name, ...p.aliases]).map(foldText), ...store.dismissed]);
    const takenAddresses = new Set(store.people.map((p) => p.stemAddress).filter(Boolean));
    for (const s of suggestions) {
      const person = coercePerson({ ...s, status: 'suggested' });
      if (!person || taken.has(foldText(person.name))) continue;
      if (person.stemAddress && takenAddresses.has(person.stemAddress)) continue;
      taken.add(foldText(person.name));
      store.people.push(person);
      added++;
    }
  });
  return added;
}
