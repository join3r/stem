// Which threads are currently "quick chats" — threads whose latest turn came in
// with `surface: 'quickChat'`. The surface tag is otherwise consumed and dropped
// by backend:startTurn; this set is the one thing that outlives it, and it exists
// for a single feature: the skip-Inbox setting archives these threads as their
// turns settle (see the terminal-event and chats:changed hooks in server/index.ts).
//
// Deliberately in-memory. A finished quick chat was archived when its turn
// settled, so a restart forgetting the set loses nothing; a conversation still
// going re-enters it on its next turn.

const quickChatThreads = new Set<string>();

/** Record which surface a thread's latest turn came from. A main-window (or
 * scheduled) turn on a former quick chat reclassifies it — the user picked the
 * conversation back up, so it stops being auto-archived. */
export function noteTurnSurface(threadId: string, quickChat: boolean): void {
  if (quickChat) quickChatThreads.add(threadId);
  else quickChatThreads.delete(threadId);
}

export function isQuickChatThread(threadId: string): boolean {
  return quickChatThreads.has(threadId);
}

/** Stop auto-archiving this thread — an explicit un-archive (the user, or a
 * Quick Chat hand-off) pulled it back into play, and the auto-archiver must not
 * fight that on the thread's next settled turn or subject write. */
export function forgetQuickChatThread(threadId: string): void {
  quickChatThreads.delete(threadId);
}
