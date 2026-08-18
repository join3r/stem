import { getIndexedWatermark, reindexThread, dropThread, type IndexDoc } from './store';
import * as activity from '../activity';
import { degrade } from '../degrade';

// Keeps the chat-search index in step with the JSONL sessions:
//   - backfillChatIndex: a background sweep on launch that indexes every chat whose
//     on-disk updatedAt is newer than what we last indexed (so it's a near no-op on
//     relaunch, and catches externally-edited sessions).
//   - reindexChatThread: re-index one chat right after a turn completes or a rename.
//   - dropChatThread: forget a chat on delete.
//
// Deliberately independent of Stem Recall's capture path: chat search indexes the
// user's own chats in full, with no memorize:false / connected-folder taint gating.

/** The slice of the backend runtime the indexer needs — kept minimal for decoupling. */
export interface IndexRuntime {
  listThreads(): Promise<Array<{ threadId: string; updatedAt: number }>>;
  readThread(threadId: string): Promise<{
    title: string;
    messages: Array<{ role: string; content: string; createdAt?: string }>;
  }>;
}

/** ISO timestamp → Unix seconds, or null when absent/unparseable. */
function toSeconds(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Read a thread and (re)build its index rows. `updatedAt` becomes its new watermark. */
async function reindexOne(rt: IndexRuntime, threadId: string, updatedAt: number): Promise<void> {
  const { title, messages } = await rt.readThread(threadId);
  const docs: IndexDoc[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (!m.content || !m.content.trim()) continue;
    docs.push({ role: m.role, text: m.content, ts: toSeconds(m.createdAt) ?? Math.floor(updatedAt / 1000) });
  }
  reindexThread(threadId, title, docs, updatedAt);
}

/** Re-index one chat now (after a turn completes or a rename). Best-effort. */
export async function reindexChatThread(rt: IndexRuntime, threadId: string): Promise<void> {
  try {
    // listThreads.updatedAt is milliseconds. Store the live watermark in the
    // same unit so launch backfill does not re-read every just-indexed thread.
    await reindexOne(rt, threadId, Date.now());
  } catch (error) {
    // A single failed reindex must never break the turn/rename that triggered it —
    // but until the next launch's backfill picks the thread up, searching for what
    // was just said in it finds nothing.
    degrade('chatsearch.index', 'left one chat out of the search index', error);
  }
}

/** Forget a chat on delete. Best-effort. */
export function dropChatThread(threadId: string): void {
  try {
    dropThread(threadId);
  } catch (error) {
    // Nothing retries this: the backfill only visits chats that still exist, so a
    // failed drop leaves the deleted chat's text in the index for good.
    degrade('chatsearch.index', 'kept a deleted chat in the search index', error);
  }
}

let backfilling = false;

/**
 * Index every chat whose on-disk updatedAt is newer than its stored watermark. Runs
 * sequentially in the background so it never blocks startup, and is guarded so a
 * second launch-time call can't run it twice concurrently.
 */
export async function backfillChatIndex(rt: IndexRuntime): Promise<void> {
  if (backfilling) return;
  backfilling = true;
  const handle = activity.begin('chatIndex.backfill', 'Indexing chats');
  let indexed = 0;
  try {
    const chats = await rt.listThreads();
    for (const c of chats) {
      const wm = getIndexedWatermark(c.threadId);
      if (wm !== null && wm >= c.updatedAt) continue;
      try {
        await reindexOne(rt, c.threadId, c.updatedAt);
        indexed += 1;
      } catch (error) {
        // Skip a chat that fails to read/index; the next launch retries it (watermark
        // wasn't advanced), and the rest of the backfill still proceeds. A chat that
        // fails every launch is missing from search for good, and the "Indexed n
        // chats" row it is absent from cannot say so.
        degrade('chatsearch.index', 'skipped one chat', error);
      }
    }
    activity.end(handle, {
      worked: indexed > 0,
      detail: `Indexed ${indexed.toLocaleString()} chat${indexed === 1 ? '' : 's'}`
    });
  } catch (error) {
    // listThreads failed — nothing to do; a later launch retries.
    activity.fail('chatIndex.backfill', error, 'Indexing chats');
  } finally {
    backfilling = false;
  }
}
