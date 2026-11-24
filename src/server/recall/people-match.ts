import type { Person } from '../../shared/types';

// Which people a piece of text is about. Used twice: to find the facts that
// belong to a person (fact text is English, names as the distiller wrote them)
// and to notice a person in the user's message (any language, often inflected:
// "napíš Petrovi Novákovi"). There is no subject column on facts on purpose —
// a fact is someone's because it names them, so merges, rewrites and contact
// facts (which carry the address) stay linked without bookkeeping.
//
// Matching is per word, accent- and case-blind, and tolerant of declension
// endings: Slovak drops a vowel ("Peter" → "Petra", "Marek" → "Marka") and adds
// up to a few letters ("Novák" → "Novákovi"). Short names match whole words
// only, so "Jan" never fires on "január".

/** Lower-case, accents stripped. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

function words(text: string): string[] {
  return foldText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

/**
 * Does `word` (from the text) read as an inflected form of the name token?
 * Three shapes, each with a short ending: the whole name plus an ending
 * ("Novák" → "Novákovi"), the last letter swapped ("Jana" → "Janou"), or the
 * vowel before the last consonant dropped ("Peter" → "Petrovi", "Marek" → "Marka").
 */
export function nameTokenMatches(word: string, token: string): boolean {
  if (word === token) return true;
  if (token.length <= 3) return false;
  const cp = commonPrefix(word, token);
  const rest = word.length - cp;
  if (cp === token.length) return rest <= 4;
  if (cp === token.length - 1) return rest <= 3;
  if (cp === token.length - 2 && token.length >= 5) {
    return VOWELS.has(token[cp]) && word[cp] === token[cp + 1] && rest <= 4;
  }
  return false;
}

/**
 * The words of the text a key's tokens match, or null when one token matches
 * none. `free` limits it to words no full name has claimed.
 */
function keyHits(textWords: readonly string[], key: readonly string[], free?: ReadonlySet<number>): number[] | null {
  if (key.length === 0) return null;
  const hits: number[] = [];
  for (const t of key) {
    const at = textWords.flatMap((w, i) => ((!free || free.has(i)) && nameTokenMatches(w, t) ? [i] : []));
    if (!at.length) return null;
    hits.push(...at);
  }
  return hits;
}

/**
 * One way a person is named. A full name or alias is strong; a lone surname
 * or first name is weak: it counts only on words no one's full name took.
 */
export interface NameKey {
  tokens: string[];
  weak: boolean;
}

/** The literal identifiers (addresses) a person is reachable at, folded. */
function addresses(p: Person): string[] {
  return [p.stemAddress, ...p.emails].map((a) => foldText(a.trim())).filter((a) => a.includes('@'));
}

/**
 * The word-sets that name each person. Full name and every alias always; a
 * lone surname or first name only when no one else in the list has that word
 * as a first name or surname (Alice Smith and Bob Smith both need their first
 * names, two Peters their surnames).
 */
export function nameKeys(people: readonly Person[]): Map<string, NameKey[]> {
  const lone = (name: string[]) => (name.length >= 2 ? [...new Set([name[0], name[name.length - 1]])] : []);
  const loneCount = new Map<string, number>();
  for (const p of people) for (const w of lone(words(p.name))) loneCount.set(w, (loneCount.get(w) ?? 0) + 1);
  const keys = new Map<string, NameKey[]>();
  for (const p of people) {
    const name = words(p.name);
    const list: NameKey[] = [];
    if (name.length) list.push({ tokens: name, weak: false });
    for (const alias of p.aliases) {
      const a = words(alias);
      if (a.length) list.push({ tokens: a, weak: false });
    }
    if (name.length >= 2) {
      const last = name[name.length - 1];
      if (last.length >= 3 && loneCount.get(last) === 1) list.push({ tokens: [last], weak: true });
      if (loneCount.get(name[0]) === 1) list.push({ tokens: [name[0]], weak: true });
    }
    keys.set(p.id, list);
  }
  return keys;
}

/**
 * The people `text` names, in list order. Full names and addresses go first;
 * a lone surname or first name then counts only on the words they left, so
 * "Alice Smith uses Linux" is Alice's even when Bob is a Smith too.
 */
export function peopleIn(text: string, people: readonly Person[], keys = nameKeys(people)): Person[] {
  if (!text.trim() || people.length === 0) return [];
  const folded = foldText(text);
  const textWords = words(text);
  const byAddress = new Set<string>();
  const strong = new Map<string, Set<number>>();
  for (const p of people) {
    if (addresses(p).some((a) => folded.includes(a))) byAddress.add(p.id);
    for (const k of keys.get(p.id) ?? []) {
      if (k.weak) continue;
      const hits = keyHits(textWords, k.tokens);
      if (!hits) continue;
      const own = strong.get(p.id) ?? new Set<number>();
      for (const i of hits) own.add(i);
      strong.set(p.id, own);
    }
  }
  // A name that is only part of a longer one found in the text yields to it:
  // a contact called just "Martin" is not named by "Martin Kováč".
  const inside = (a: Set<number>, b: Set<number>) => a.size < b.size && [...a].every((i) => b.has(i));
  for (const [id, hits] of [...strong]) {
    if ([...strong].some(([other, more]) => other !== id && inside(hits, more))) strong.delete(id);
  }
  const taken = new Set([...strong.values()].flatMap((h) => [...h]));
  const free = new Set(textWords.flatMap((_, i) => (taken.has(i) ? [] : [i])));
  return people.filter(
    (p) =>
      byAddress.has(p.id) ||
      strong.has(p.id) ||
      (keys.get(p.id) ?? []).some((k) => k.weak && keyHits(textWords, k.tokens, free) !== null)
  );
}

/** Does `text` name `person`, judged against the whole list (name uniqueness, full names first)? */
export function namesPerson(text: string, person: Person, people: readonly Person[], keys = nameKeys(people)): boolean {
  return peopleIn(text, people, keys).some((p) => p.id === person.id);
}
