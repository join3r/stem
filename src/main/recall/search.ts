import { search as storeSearch, type SearchHit, type SearchOptions } from './store';

// The stable retrieval interface. Everything that recalls past conversation goes
// through here, so a future semantic/embeddings layer can slot in behind
// `searchMemory` without touching callers (auto-inject + the MCP tool).

// Very common words carry no signal and only dilute bm25 ranking. Kept small and
// multilingual-ish (EN/SK/DE) since the user mixes languages.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'are', 'was', 'were', 'be', 'for',
  'with', 'that', 'this', 'it', 'i', 'you', 'we', 'my', 'me', 'do', 'does', 'did', 'what', 'who',
  'when', 'where', 'why', 'how', 'about',
  'a', 'aby', 'ako', 'ale', 'som', 'si', 'sa', 'na', 'je', 'to', 'co', 'čo', 'ktorý', 'kde',
  'der', 'die', 'das', 'und', 'ich', 'ist', 'für', 'mit', 'was', 'wie'
]);

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression. Each word becomes a
 * quoted term (so punctuation/operators can never break MATCH syntax) and the
 * terms are OR-ed, which is the right recall-oriented default. Returns null when
 * there's nothing searchable.
 */
export function buildMatchQuery(raw: string): string | null {
  const tokens = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  // Dedup while preserving order.
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    // Double-quote and escape embedded quotes per FTS5 string rules.
    terms.push(`"${t.replace(/"/g, '""')}"`);
  }
  if (terms.length === 0) return null;
  return terms.join(' OR ');
}

/**
 * Search past conversations for text relevant to `rawQuery`. Returns [] when the
 * query has no searchable terms or nothing matches — callers degrade silently.
 */
export function searchMemory(rawQuery: string, options: SearchOptions = {}): SearchHit[] {
  const match = buildMatchQuery(rawQuery);
  if (!match) return [];
  try {
    return storeSearch(match, options);
  } catch {
    // A malformed index / unexpected SQL error must never break a turn.
    return [];
  }
}

export type { SearchHit } from './store';
