import type { ChatSearchHit } from '../../shared/types';
import { degrade } from '../degrade';
import type { LlmClient } from '../recall/llm';
import { buildMatchQuery } from '../recall/search';
import { searchChatDocs } from './store';
import { expandQuery } from './expand';

// Orchestrates a sidebar chat search: expand the raw query across Slovak+English,
// run it against the FTS5 chat index, group hits by chat, and label each with its
// current title. Kept backend-agnostic — it depends only on the LlmClient seam plus
// a title lookup passed in by the caller.

export interface ChatSearchDeps {
  /** For cross-language expansion; null (or a failing client) → same-language search. */
  llm: LlmClient | null;
  /** Current threads, for titles (results reference live titles, not indexed ones). */
  listChats: () => Promise<Array<{ threadId: string; title: string }>>;
}

/** Run an already-chosen term set against the index and shape the hits. */
async function runMatch(terms: string[], deps: ChatSearchDeps, limit: number): Promise<ChatSearchHit[]> {
  const match = buildMatchQuery(terms.join(' '));
  const requestedLimit = Math.floor(limit);
  if (!match || requestedLimit <= 0) return [];

  const titles = new Map((await deps.listChats()).map((c) => [c.threadId, c.title]));
  const hits: ChatSearchHit[] = [];
  const seen = new Set<string>();
  const pageSize = Math.max(requestedLimit, 64);
  let offset = 0;

  while (hits.length < requestedLimit) {
    let rows;
    try {
      rows = searchChatDocs(match, pageSize, offset);
    } catch (error) {
      // A malformed index / unexpected SQL error must never surface as a broken
      // search. But "nothing matched" is also what a healthy index says about a
      // word nobody used, so the difference has to be recorded somewhere.
      degrade('chatsearch.search', 'returned the chats found so far', error);
      return hits;
    }
    if (rows.length === 0) break;

    for (const r of rows) {
      if (seen.has(r.threadId)) continue;
      seen.add(r.threadId);

      // Drop threads that vanished between indexing and now (deleted chat) — no title.
      const title = titles.get(r.threadId);
      if (title === undefined) continue;
      hits.push({ threadId: r.threadId, title, snippet: r.snippet, score: r.score, ts: r.ts });
      if (hits.length >= requestedLimit) break;
    }

    if (rows.length < pageSize) break;
    offset += rows.length;
  }
  return hits;
}

/**
 * Fast, same-language search: the raw query straight against the index with NO LLM
 * round-trip. The renderer shows this immediately, then replaces it with searchChats'
 * cross-language superset — so perceived latency is a sub-millisecond FTS lookup, not
 * the pi process spawn that query expansion costs.
 */
export async function searchChatsLexical(rawQuery: string, deps: ChatSearchDeps, limit = 30): Promise<ChatSearchHit[]> {
  return runMatch([rawQuery], deps, limit);
}

/**
 * Cross-language search: expand `rawQuery` across Slovak+English, then match. Returns a
 * superset of searchChatsLexical (it always includes the raw query's own terms), so it
 * safely replaces the fast results. Up to `limit` chats, best match first.
 */
export async function searchChats(rawQuery: string, deps: ChatSearchDeps, limit = 30): Promise<ChatSearchHit[]> {
  const terms = await expandQuery(rawQuery, deps.llm);
  return runMatch(terms, deps, limit);
}
