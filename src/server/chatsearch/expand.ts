import type { LlmClient } from '../recall/llm';

// Cross-language query expansion — the whole point of chat search. The user's chats
// are a Slovak/English mix, so a lexical FTS5 query for "deployment" can't find a chat
// that said "nasadenie" (and vice-versa). Instead of forcing the user to type both
// languages, we ask the backend once to expand the raw query into an equivalent term
// set spanning BOTH languages, then OR those terms into a single MATCH.

const EXPAND_PROMPT = `You expand a search query into equivalent search terms spanning BOTH Slovak and English.

Given the user's query, output the key content words plus their translations and close synonyms in the OTHER language, so a keyword search finds matching chats regardless of which language they were written in.

Rules:
- Include the original query's content words AND their Slovak/English counterparts.
- Prefer base/lemma forms; add an obvious alternate form only when clearly useful.
- Content words only — drop stopwords, questions words, and filler.
- Output ONLY a JSON array of short strings (single words or 2-word phrases). No prose, no markdown fences.

Query: `;

// Keep expansion snappy — this runs synchronously in front of a user hitting Enter.
// On timeout/failure the caller falls back to the raw query, so a slow/offline backend
// degrades to same-language search instead of hanging.
const EXPAND_TIMEOUT_MS = 4000;

/** Parse the model's reply into clean term strings (JSON array, comma/line fallback). */
export function parseTerms(output: string): string[] {
  const raw: string[] = [];
  const trimmed = output.trim();

  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const arr = JSON.parse(trimmed.slice(start, end + 1));
      if (Array.isArray(arr)) for (const v of arr) if (typeof v === 'string') raw.push(v);
    } catch {
      // quiet: the model is asked for JSON and mostly obliges; when it doesn't,
      // the line/comma parse below reads the same reply just as well.
    }
  }
  if (raw.length === 0) {
    for (const part of trimmed.split(/[\n,]/)) raw.push(part.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ''));
  }

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const r of raw) {
    const t = r.replace(/["`]/g, '').replace(/\s+/g, ' ').trim();
    const key = t.toLowerCase();
    if (t.length < 2 || t.length > 40 || seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
  }
  return terms;
}

// Successful expansions are cached for the process lifetime — the term set for a query
// doesn't change, so a repeat search skips the pi round-trip entirely. Only successful
// expansions are cached; a fallback (timeout/error) is not, so it's retried next time.
const cache = new Map<string, string[]>();

/**
 * Expand `raw` into a Slovak+English term set. Always includes the raw query itself so
 * an exact-language match is never lost. Returns just `[raw]` when the backend errors,
 * times out, or the toggle-off case where `llm` is null — search still works, only the
 * cross-language reach is dropped.
 */
export async function expandQuery(raw: string, llm: LlmClient | null): Promise<string[]> {
  const base = raw.trim();
  if (!base) return [];
  const key = base.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const out = new Set<string>([base]);
  if (!llm) return [...out];
  try {
    const reply = await withTimeout(llm.complete(EXPAND_PROMPT + base), EXPAND_TIMEOUT_MS);
    for (const t of parseTerms(reply)) out.add(t);
    const result = [...out];
    cache.set(key, result); // cache only a real expansion
    return result;
  } catch {
    // Timeout / backend error → same-language search on the raw query (not cached).
    return [...out];
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('query expansion timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
