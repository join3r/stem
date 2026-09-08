// The inbox store — exercises the REAL file at the throwaway STEM_INBOX_STORE
// path from tests/setup-unit.ts. Covers the clean-slate baseline, the mutators,
// pruning, corrupt-file degradation, and that concurrent writes don't clobber.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  markAllRead,
  noteSilentRun,
  readInbox,
  removeInboxEntry,
  setArchived,
  setRead,
  setSnooze
} from '../../src/server/workspace/inbox';
import { inboxStorePath } from '../../src/server/workspace/paths';
import { isUnread, listedUpdatedAt, placement } from '../../src/shared/inbox';

const path = inboxStorePath();
const HOUR = 3600_000;

beforeEach(() => {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
});
afterEach(() => {
  rmSync(path, { force: true });
});

const onDisk = () => JSON.parse(readFileSync(path, 'utf8'));

describe('first read', () => {
  it('creates the file and stamps a baseline at roughly now', async () => {
    const before = Date.now();
    const state = await readInbox();
    expect(state.entries).toEqual({});
    expect(state.baseline).toBeGreaterThanOrEqual(before);
    expect(state.baseline).toBeLessThanOrEqual(Date.now());
    expect(onDisk().version).toBe(1);
  });

  it('keeps the same baseline on later reads, so old threads stay read', async () => {
    const first = await readInbox();
    const second = await readInbox();
    expect(second.baseline).toBe(first.baseline);
    // The clean slate this buys: a thread that last changed before the upgrade.
    expect(isUnread({ threadId: 'a', updatedAt: first.baseline - HOUR }, second)).toBe(false);
  });

  it('degrades a corrupt file to a clean slate rather than throwing', async () => {
    writeFileSync(path, '{ not json', 'utf8');
    const state = await readInbox();
    expect(state.entries).toEqual({});
    // Baseline 0 would flag every thread unread; a corrupt file must not do that.
    expect(state.baseline).toBeGreaterThan(0);
  });

  it('drops entries that aren’t shaped like entries', async () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, baseline: 5, entries: { a: { archivedAt: 'soon' }, b: 7, c: { readAt: 9 } } }),
      'utf8'
    );
    const state = await readInbox();
    expect(Object.keys(state.entries)).toEqual(['c']);
    expect(state.baseline).toBe(5);
  });
});

describe('archive', () => {
  it('round-trips through the file and places the thread', async () => {
    await readInbox();
    const state = await setArchived(['a'], true);
    expect(state.entries.a.archivedAt).toBeGreaterThan(0);
    expect(placement({ threadId: 'a', updatedAt: Date.now() - HOUR }, state, Date.now())).toBe('archived');
    expect(onDisk().entries.a.archivedAt).toBe(state.entries.a.archivedAt);
  });

  it('un-archiving removes the entry entirely rather than leaving a husk', async () => {
    await setArchived(['a'], true);
    const state = await setArchived(['a'], false);
    expect(state.entries.a).toBeUndefined();
  });

  it('applies to a whole selection in one write', async () => {
    const state = await setArchived(['a', 'b', 'c'], true);
    expect(Object.keys(state.entries).sort()).toEqual(['a', 'b', 'c']);
  });

  it('clears a pending snooze — archiving is a decision about the thread', async () => {
    await setSnooze(['a'], Date.now() + HOUR);
    const state = await setArchived(['a'], true);
    expect(state.entries.a.snoozedUntil).toBeUndefined();
    expect(state.entries.a.archivedAt).toBeGreaterThan(0);
  });
});

describe('snooze', () => {
  it('stores the wake time and the instant it was set', async () => {
    const until = Date.now() + 2 * HOUR;
    const state = await setSnooze(['a'], until);
    expect(state.entries.a.snoozedUntil).toBe(until);
    expect(state.entries.a.snoozedAt).toBeGreaterThan(0);
    expect(placement({ threadId: 'a', updatedAt: Date.now() - HOUR }, state, Date.now())).toBe('snoozed');
  });

  it('null wakes the thread now', async () => {
    await setSnooze(['a'], Date.now() + HOUR);
    const state = await setSnooze(['a'], null);
    expect(state.entries.a).toBeUndefined();
  });

  it('refuses a wake time already in the past instead of hiding the thread forever', async () => {
    const state = await setSnooze(['a'], Date.now() - HOUR);
    expect(state.entries.a).toBeUndefined();
  });

  it('lifts an existing archive — a snoozed thread is back in play at its wake time', async () => {
    await setArchived(['a'], true);
    const state = await setSnooze(['a'], Date.now() + HOUR);
    expect(state.entries.a.archivedAt).toBeUndefined();
  });
});

describe('read state', () => {
  it('marks read, then explicitly unread, then read again', async () => {
    const chat = { threadId: 'a', updatedAt: Date.now() };
    let state = await readInbox();
    // Baseline was just stamped, so a thread touched a moment ago is still read;
    // push its mtime past the baseline to make the transitions observable.
    const fresh = { threadId: 'a', updatedAt: state.baseline + HOUR };
    expect(isUnread(fresh, state)).toBe(true);

    state = await setRead(['a'], true);
    expect(isUnread(chat, state)).toBe(false);

    state = await setRead(['a'], false);
    expect(state.entries.a.forcedUnread).toBe(true);
    expect(isUnread(chat, state)).toBe(true);

    // Reading again must clear the forced flag, not just move the timestamp.
    state = await setRead(['a'], true);
    expect(state.entries.a?.forcedUnread).toBeUndefined();
    expect(isUnread(chat, state)).toBe(false);
  });

  it('setRead with the thread’s mtime clears a row dated in the future', async () => {
    // Same clock-skew guard markAllRead has, but per-thread: the IPC handler
    // passes each thread's own mtime so the stamp lands at least on it.
    const chat = { threadId: 'a', updatedAt: Date.now() + 10 * HOUR };
    const state = await setRead(['a'], true, new Map([['a', chat.updatedAt]]));
    expect(isUnread(chat, state)).toBe(false);
  });

  it('markAllRead clears every listed thread, including one dated in the future', async () => {
    const base = await readInbox();
    const chats = [
      { threadId: 'a', updatedAt: base.baseline + HOUR },
      // Clock skew on a networked home dir: an mtime ahead of us must still clear.
      { threadId: 'b', updatedAt: Date.now() + 10 * HOUR }
    ];
    const state = await markAllRead(chats);
    for (const c of chats) expect(isUnread(c, state)).toBe(false);
  });

  it('markAllRead leaves a thread it was not given alone', async () => {
    const base = await readInbox();
    const missing = { threadId: 'z', updatedAt: base.baseline + HOUR };
    const state = await markAllRead([{ threadId: 'a', updatedAt: base.baseline + HOUR }]);
    expect(isUnread(missing, state)).toBe(true);
  });
});

describe('silent scheduled run', () => {
  // A run that found nothing still bumps the thread's mtime. These cover the deal:
  // it may keep a settled thread settled, and may not settle anything new. `at` is
  // the run's end, which the scheduler guarantees is at or past the thread's mtime
  // — so `at` is also what the row carries as `updatedAt` once the run is over.
  const runEnd = () => Date.now() + 1000;

  it('leaves an archived thread archived', async () => {
    await setArchived(['a'], true);
    const at = runEnd();
    const state = await noteSilentRun('a', at - HOUR, at);
    expect(placement({ threadId: 'a', updatedAt: at }, state, at)).toBe('archived');
  });

  it('leaves a snoozed thread asleep, keeping its original wake time', async () => {
    const until = Date.now() + 2 * HOUR;
    await setSnooze(['a'], until);
    const at = runEnd();
    const state = await noteSilentRun('a', at - HOUR, at);
    expect(state.entries.a.snoozedUntil).toBe(until);
    expect(placement({ threadId: 'a', updatedAt: at }, state, at)).toBe('snoozed');
  });

  it('does not re-arm a snooze that has already expired', async () => {
    const base = await readInbox();
    await setSnooze(['a'], Date.now() + 50);
    await new Promise((r) => setTimeout(r, 60));
    const at = runEnd();
    const state = await noteSilentRun('a', base.baseline, at);
    expect(placement({ threadId: 'a', updatedAt: at }, state, at)).toBe('inbox');
  });

  it('leaves a read thread read, so a silent poll never bolds the row', async () => {
    const base = await readInbox();
    const at = runEnd();
    const state = await noteSilentRun('a', base.baseline, at);
    expect(isUnread({ threadId: 'a', updatedAt: at }, state)).toBe(false);
  });

  it('leaves a thread you had left unread bold', async () => {
    const base = await readInbox();
    const at = runEnd();
    // Real activity arrived and was never opened: the run must not swallow it.
    const state = await noteSilentRun('a', base.baseline + HOUR, at);
    expect(isUnread({ threadId: 'a', updatedAt: at }, state)).toBe(true);
  });

  it('respects an explicit mark-as-unread', async () => {
    const base = await readInbox();
    await setRead(['a'], false);
    const at = runEnd();
    const state = await noteSilentRun('a', base.baseline, at);
    expect(isUnread({ threadId: 'a', updatedAt: at }, state)).toBe(true);
  });

  it('settles nothing new for a thread that was already unread and in the Inbox', async () => {
    await readInbox();
    const at = runEnd();
    const before = at - 500; // real activity after the baseline, never opened
    const state = await noteSilentRun('a', before, at);
    expect(state.entries.a.readAt).toBeUndefined();
    expect(state.entries.a.archivedAt).toBeUndefined();
    expect(isUnread({ threadId: 'a', updatedAt: at }, state)).toBe(true);
    // …but the run still may not move the row: it is listed as of the real activity.
    expect(listedUpdatedAt({ threadId: 'a', updatedAt: at }, state)).toBe(before);
  });

  it('lists the thread as of the moment before the run, so it does not jump to the top', async () => {
    const at = runEnd();
    const before = at - HOUR;
    const state = await noteSilentRun('a', before, at);
    expect(state.entries.a).toMatchObject({ quietFrom: before, quietUntil: at });
    // The row's mtime is the run's write, inside the window: listed as `before`.
    expect(listedUpdatedAt({ threadId: 'a', updatedAt: at - 1 }, state)).toBe(before);
    // In the backend's seconds too, answered in seconds.
    expect(listedUpdatedAt({ threadId: 'a', updatedAt: Math.floor((at - 1) / 1000) }, state)).toBe(
      Math.floor(before / 1000)
    );
    // A real message after the run speaks for itself again.
    expect(listedUpdatedAt({ threadId: 'a', updatedAt: at + 1 }, state)).toBe(at + 1);
  });

  it('a second silent run extends the window instead of moving the thread to the first run', async () => {
    const first = runEnd();
    const origin = first - HOUR;
    await noteSilentRun('a', origin, first);
    // The scheduler reads the raw mtime, which the first run's write left inside the window.
    const second = first + 24 * HOUR;
    const state = await noteSilentRun('a', first - 500, second);
    expect(state.entries.a).toMatchObject({ quietFrom: origin, quietUntil: second });
    expect(listedUpdatedAt({ threadId: 'a', updatedAt: second - 1 }, state)).toBe(origin);
  });

  it('a real message between two silent runs opens a fresh window from that message', async () => {
    const first = runEnd();
    await noteSilentRun('a', first - HOUR, first);
    const message = first + HOUR;
    const second = message + HOUR;
    const state = await noteSilentRun('a', message, second);
    expect(state.entries.a).toMatchObject({ quietFrom: message, quietUntil: second });
  });

  it('round-trips the window through the file and drops a half-written one', async () => {
    const at = runEnd();
    await noteSilentRun('a', at - HOUR, at);
    expect(onDisk().entries.a).toMatchObject({ quietFrom: at - HOUR, quietUntil: at });
    writeFileSync(
      path,
      JSON.stringify({ version: 1, baseline: 0, entries: { b: { quietFrom: 5 }, c: { quietFrom: 9, quietUntil: 5 } } })
    );
    const state = await readInbox();
    expect(state.entries.b).toBeUndefined();
    expect(state.entries.c).toBeUndefined();
  });
});

describe('cleanup and concurrency', () => {
  it('removeInboxEntry drops a deleted chat’s state', async () => {
    await setArchived(['a', 'b'], true);
    const state = await removeInboxEntry('a');
    expect(state.entries.a).toBeUndefined();
    expect(state.entries.b).toBeDefined();
  });

  it('serializes concurrent mutators so none is lost', async () => {
    await readInbox();
    await Promise.all([
      setArchived(['a'], true),
      setSnooze(['b'], Date.now() + HOUR),
      setRead(['c'], false),
      setArchived(['d'], true)
    ]);
    const state = await readInbox();
    expect(Object.keys(state.entries).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
