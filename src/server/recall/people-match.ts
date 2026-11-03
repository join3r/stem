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

/** A key matches when every one of its tokens matches some word of the text. */
function keyMatches(textWords: readonly string[], key: readonly string[]): boolean {
  return key.length > 0 && key.every((t) => textWords.some((w) => nameTokenMatches(w, t)));
}

/** The literal identifiers (addresses) a person is reachable at, folded. */
function addresses(p: Person): string[] {
  return [p.stemAddress, ...p.emails].map((a) => foldText(a.trim())).filter((a) => a.includes('@'));
}

/**
 * The word-sets that name each person. Full name and every alias always; the
 * surname alone when the name has one; the first name alone only when no one
 * else in the list shares it (two Peters need their surnames).
 */
export function nameKeys(people: readonly Person[]): Map<string, string[][]> {
  const firstCount = new Map<string, number>();
  for (const p of people) {
    const first = words(p.name)[0];
    if (first) firstCount.set(first, (firstCount.get(first) ?? 0) + 1);
  }
  const keys = new Map<string, string[][]>();
  for (const p of people) {
    const name = words(p.name);
    const list: string[][] = [];
    if (name.length) list.push(name);
    for (const alias of p.aliases) {
      const a = words(alias);
      if (a.length) list.push(a);
    }
    if (name.length >= 2 && name[name.length - 1].length >= 3) list.push([name[name.length - 1]]);
    if (name.length >= 2 && firstCount.get(name[0]) === 1) list.push([name[0]]);
    keys.set(p.id, list);
  }
  return keys;
}

/** The people `text` names, in list order. */
export function peopleIn(text: string, people: readonly Person[], keys = nameKeys(people)): Person[] {
  if (!text.trim() || people.length === 0) return [];
  const folded = foldText(text);
  const textWords = words(text);
  return people.filter((p) =>
    addresses(p).some((a) => folded.includes(a)) || (keys.get(p.id) ?? []).some((k) => keyMatches(textWords, k))
  );
}

/** Does `text` name `person` (against the whole list, so first-name uniqueness holds)? */
export function namesPerson(text: string, person: Person, people: readonly Person[], keys = nameKeys(people)): boolean {
  return peopleIn(text, [person], new Map([[person.id, keys.get(person.id) ?? []]])).length > 0;
}
