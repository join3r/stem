// Where each chat row goes, and whether it is bold — the phone's use of
// @shared/inbox.
//
// Nothing about the Inbox is decided here. `placement`, `isUnread`,
// `snoozedUntil` and `nextWakeAt` are the shared module's, verbatim, because the
// whole point of archive-and-snooze being TIMESTAMPS rather than flags is that
// every client derives the same answer from the same state without anyone
// writing anything. A phone that computed "archived" its own way would show a
// thread the desk had filed, or hide one it had not, and neither is a bug you
// would find by looking at either device alone.
//
// What IS here is the list-shaped part: one pass that turns a ChatListResult
// into the rows a section shows, sorted, plus the two numbers the header needs.
// Pure and `now`-taking, so the wake timer in the screen can re-run it at the
// exact instant a snooze expires instead of polling.

import { isUnread, nextWakeAt, placement, snoozedUntil, type InboxState } from '@shared/inbox';
import type { ChatSummary } from '@shared/types';

/** The three places a thread can be. Same words as InboxPlacement, on purpose. */
export type InboxFilter = 'inbox' | 'snoozed' | 'archived';

export interface InboxRow {
  chat: ChatSummary;
  unread: boolean;
  /** ms the snooze lifts, on snoozed rows only. */
  wakeAt: number | null;
}

/**
 * The rows of one section, newest first. Newest-first rather than
 * oldest-unread-first because the phone is a triage surface: what changed while
 * you were away is what you came to look at.
 */
export function inboxRows(
  chats: ChatSummary[],
  state: InboxState,
  filter: InboxFilter,
  now: number,
  /** Threads with a turn generating right now — their mid-turn mtime bumps don't read as unread. */
  running: ReadonlySet<string> = new Set()
): InboxRow[] {
  return chats
    .filter((chat) => placement(chat, state, now) === filter)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((chat) => ({
      chat,
      unread: isUnread(chat, state, running.has(chat.threadId)),
      wakeAt: snoozedUntil(chat, state, now)
    }));
}

/**
 * How many threads in the Inbox proper are unread — the badge number. Snoozed
 * and archived threads are excluded even when unread, which is the entire
 * promise of snoozing: it stops the thread counting against you until it wakes.
 */
export function inboxUnreadCount(
  chats: ChatSummary[],
  state: InboxState,
  now: number,
  running: ReadonlySet<string> = new Set()
): number {
  return chats.filter(
    (chat) =>
      placement(chat, state, now) === 'inbox' && isUnread(chat, state, running.has(chat.threadId))
  ).length;
}

/**
 * ms until some row moves on its own, or null if none will. The screen sets one
 * timer for this rather than re-rendering on an interval; `nextWakeAt` is the
 * shared module's, so the desk and the phone wake at the same instant.
 */
export function msUntilNextWake(chats: ChatSummary[], state: InboxState, now: number): number | null {
  const at = nextWakeAt(chats, state, now);
  if (at === null) return null;
  // Never zero or negative: a timer of 0 that fires into the same `now` would
  // schedule itself again immediately, forever.
  return Math.max(1, at - now);
}
