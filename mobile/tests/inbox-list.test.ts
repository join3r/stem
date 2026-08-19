import { describe, expect, it } from 'vitest';
import type { InboxState } from '@shared/inbox';
import type { ChatSummary } from '@shared/types';
import { inboxRows, inboxUnreadCount, msUntilNextWake } from '../src/inbox/list';

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);

/** ChatSummary carries Unix SECONDS; the inbox module normalizes. */
const chat = (threadId: string, agoMinutes: number): ChatSummary =>
  ({
    threadId,
    title: threadId,
    updatedAt: Math.floor(NOW / 1000) - agoMinutes * 60
  }) as ChatSummary;

const state = (entries: InboxState['entries'], baseline = 0): InboxState => ({ baseline, entries });

describe('inboxRows', () => {
  const chats = [chat('a', 5), chat('b', 60), chat('c', 120)];

  it('puts untouched threads in the Inbox, newest first', () => {
    const rows = inboxRows(chats, state({}), 'inbox', NOW);
    expect(rows.map((r) => r.chat.threadId)).toEqual(['a', 'b', 'c']);
    expect(rows.every((r) => r.unread)).toBe(true);
  });

  it('files an archived thread out of the Inbox — until it moves again', () => {
    // Archived after its last activity: it stays filed.
    const filed = state({ b: { archivedAt: NOW } });
    expect(inboxRows(chats, filed, 'inbox', NOW).map((r) => r.chat.threadId)).toEqual(['a', 'c']);
    expect(inboxRows(chats, filed, 'archived', NOW).map((r) => r.chat.threadId)).toEqual(['b']);

    // Archived BEFORE its last activity — i.e. a new turn landed since — and the
    // thread lifts itself out with nobody writing anything.
    const stale = state({ b: { archivedAt: NOW - 120 * 60_000 } });
    expect(inboxRows(chats, stale, 'inbox', NOW).map((r) => r.chat.threadId)).toEqual(['a', 'b', 'c']);
  });

  it('reports the wake time on a snoozed row and moves it back when the time passes', () => {
    const until = NOW + 30 * 60_000;
    const snoozed = state({ a: { snoozedAt: NOW, snoozedUntil: until } });

    const before = inboxRows(chats, snoozed, 'snoozed', NOW);
    expect(before.map((r) => r.chat.threadId)).toEqual(['a']);
    expect(before[0].wakeAt).toBe(until);
    expect(inboxRows(chats, snoozed, 'inbox', NOW).map((r) => r.chat.threadId)).toEqual(['b', 'c']);

    const after = inboxRows(chats, snoozed, 'inbox', until + 1);
    expect(after.map((r) => r.chat.threadId)).toEqual(['a', 'b', 'c']);
    expect(inboxRows(chats, snoozed, 'snoozed', until + 1)).toEqual([]);
  });

  it('marks a read thread read, and a forced-unread one unread regardless', () => {
    const read = state({ a: { readAt: NOW }, b: { readAt: NOW, forcedUnread: true } });
    const rows = inboxRows(chats, read, 'inbox', NOW);
    expect(rows.map((r) => [r.chat.threadId, r.unread])).toEqual([
      ['a', false],
      ['b', true],
      ['c', true]
    ]);
  });

  it('keeps a working thread quiet — bold waits for the turn to settle', () => {
    // 'a' was read an hour ago and a turn is generating into it now: its mtime
    // has moved, but the row stays read while the green dot does the talking.
    const read = state({ a: { readAt: NOW - 3600_000 } });
    const rows = inboxRows(chats, read, 'inbox', NOW, new Set(['a']));
    expect(rows.find((r) => r.chat.threadId === 'a')?.unread).toBe(false);
    // The same state with the turn settled reads as unread.
    const settled = inboxRows(chats, read, 'inbox', NOW);
    expect(settled.find((r) => r.chat.threadId === 'a')?.unread).toBe(true);
  });
});

describe('inboxUnreadCount', () => {
  it('counts only the Inbox — snoozing a thread stops it counting against you', () => {
    const chats = [chat('a', 5), chat('b', 60), chat('c', 120)];
    const filed = state({
      b: { snoozedAt: NOW, snoozedUntil: NOW + 3600_000 },
      c: { archivedAt: NOW }
    });
    expect(inboxUnreadCount(chats, filed, NOW)).toBe(1);
  });

  it('is zero on a fresh store, because the baseline predates every thread', () => {
    const chats = [chat('a', 5), chat('b', 60)];
    expect(inboxUnreadCount(chats, state({}, NOW), NOW)).toBe(0);
  });

  it('leaves working threads out of the badge until their turn settles', () => {
    const chats = [chat('a', 5), chat('b', 60)];
    const read = state({ a: { readAt: NOW - 3600_000 } });
    expect(inboxUnreadCount(chats, read, NOW, new Set(['a']))).toBe(1); // just b
    expect(inboxUnreadCount(chats, read, NOW)).toBe(2);
  });
});

describe('msUntilNextWake', () => {
  const chats = [chat('a', 5), chat('b', 60)];

  it('is null when nothing is snoozed', () => {
    expect(msUntilNextWake(chats, state({}), NOW)).toBeNull();
  });

  it('answers with the soonest wake, so one timer covers every row', () => {
    const snoozed = state({
      a: { snoozedAt: NOW, snoozedUntil: NOW + 90 * 60_000 },
      b: { snoozedAt: NOW, snoozedUntil: NOW + 20 * 60_000 }
    });
    expect(msUntilNextWake(chats, snoozed, NOW)).toBe(20 * 60_000);
  });

  it('never schedules a zero-delay timer that would re-arm itself forever', () => {
    const until = NOW + 1;
    const snoozed = state({ a: { snoozedAt: NOW, snoozedUntil: until } });
    expect(msUntilNextWake(chats, snoozed, until - 1)).toBe(1);
  });
});
