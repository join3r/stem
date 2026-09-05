import type { ChatHistory } from '../../shared/types';
import { mergeHydratedThread, type ThreadState } from '../chatState';
import type { SessionStore } from './store';

/** Server history cannot contain a rejected local send or its retry affordance. */
export function mergeRefreshedThread(
  history: ChatHistory,
  live: ThreadState | undefined,
  stateAtRequest: ThreadState | undefined
): ThreadState {
  if (history.offline && live?.hydrated) return live;
  const merged = mergeHydratedThread(history.messages, live, stateAtRequest);
  let failedSend = false;
  const localOnly = (live?.messages ?? []).filter((message) => {
    if (message.role === 'user') failedSend = !!message.sendFailed;
    else if (message.role !== 'system' || message.turnId) failedSend = false;
    return failedSend && !merged.messages.some((candidate) => candidate.id === message.id);
  });
  return localOnly.length ? { ...merged, messages: [...merged.messages, ...localOnly] } : merged;
}

/** Refresh loaded transcripts without navigating, marking read, or opening a
 * backend session. The event stream does not include other devices' user
 * messages, so even an already hydrated slice needs another history read. */
export function createHistoryRefresher(
  store: SessionStore,
  read: (threadId: string) => Promise<ChatHistory>,
  isDeleted: (threadId: string) => boolean
): (threadId: string) => Promise<void> {
  const requests = new Map<string, object>();
  return async (threadId) => {
    const existing = store.getThread(threadId);
    // A settled event will refresh a live thread once its full answer is saved.
    if (!existing || existing.running || isDeleted(threadId)) return;
    const request = {};
    requests.set(threadId, request);
    try {
      const history = await read(threadId);
      if (
        requests.get(threadId) !== request ||
        history.threadId !== threadId ||
        history.offline ||
        isDeleted(threadId)
      ) return;
      store.update((prev) => {
        const live = prev[threadId];
        if (!live) return prev;
        // Rollback/retry/delete can shorten the transcript while the read is in
        // flight. Its older snapshot must not resurrect what the user removed.
        const liveIds = new Set(live.messages.map((message) => message.id));
        if (existing.messages.some((message) => !liveIds.has(message.id))) return prev;
        return {
          ...prev,
          [threadId]: {
            ...mergeRefreshedThread(history, live, existing),
            // A background read must not consume an unread completion dot.
            status: live.status
          }
        };
      });
    } catch {
      // Keep the transcript while offline; focus/reconnect/open retries the read.
    } finally {
      if (requests.get(threadId) === request) requests.delete(threadId);
    }
  };
}
