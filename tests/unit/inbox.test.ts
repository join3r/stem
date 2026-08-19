// The Inbox's placement/unread derivation — the pure half, shared by the renderer
// and (for the read stamp) the store. These rules are what make archive and snooze
// behave like mail without any background job, so they're worth pinning precisely.
import { describe, expect, it } from 'vitest';
import {
  emptyInboxState,
  formatWake,
  isUnread,
  nextWakeAt,
  placement,
  snoozedUntil,
  toMs,
  SNOOZE_PRESETS,
  type InboxState
} from '../../src/shared/inbox';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** A chat row as the sidebar sees it: an id and a last-activity time. */
const chat = (threadId: string, updatedAtMs: number) => ({ threadId, updatedAt: updatedAtMs });

function state(entries: InboxState['entries'], baseline = 0): InboxState {
  return { baseline, entries };
}

describe('toMs', () => {
  it('promotes Unix seconds (real chats) to ms and leaves ms alone', () => {
    // A backend ChatSummary carries the session file's mtime in seconds.
    expect(toMs(1_700_000_000)).toBe(1_700_000_000_000);
    // An optimistic row created this session already carries ms.
    expect(toMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('places a seconds-valued row into the same bucket as its ms twin', () => {
    const now = 1_700_000_000_000;
    const s = state({ a: { archivedAt: now } });
    expect(placement(chat('a', now / 1000), s, now)).toBe('archived');
  });
});

describe('placement', () => {
  const now = 1_700_000_000_000;

  it('puts an untouched thread in the Inbox', () => {
    expect(placement(chat('a', now - DAY), emptyInboxState(), now)).toBe('inbox');
  });

  it('archives a thread whose last activity predates the archive stamp', () => {
    const s = state({ a: { archivedAt: now - HOUR } });
    expect(placement(chat('a', now - 2 * HOUR), s, now)).toBe('archived');
  });

  it('resurrects an archived thread the moment new activity lands', () => {
    // A scheduled run (or a reply from the phone) bumps the session file's mtime
    // past the archive stamp — the thread returns to the Inbox with no background
    // job and no extra write. This is the whole reason these are timestamps.
    const s = state({ a: { archivedAt: now - HOUR } });
    expect(placement(chat('a', now - HOUR + 1), s, now)).toBe('inbox');
  });

  it('treats activity exactly at the archive stamp as still archived', () => {
    const s = state({ a: { archivedAt: now } });
    expect(placement(chat('a', now), s, now)).toBe('archived');
  });

  it('snoozes until the wake time and returns the thread after it', () => {
    const s = state({ a: { snoozedAt: now - HOUR, snoozedUntil: now + HOUR } });
    expect(placement(chat('a', now - 2 * HOUR), s, now)).toBe('snoozed');
    // One ms past the wake time it is back, with no state change at all.
    expect(placement(chat('a', now - 2 * HOUR), s, now + HOUR + 1)).toBe('inbox');
  });

  it('treats the wake instant itself as awake', () => {
    const s = state({ a: { snoozedAt: now - HOUR, snoozedUntil: now + HOUR } });
    expect(placement(chat('a', now - 2 * HOUR), s, now + HOUR)).toBe('inbox');
  });

  it('wakes a snoozed thread early when new activity lands', () => {
    const s = state({ a: { snoozedAt: now - HOUR, snoozedUntil: now + DAY } });
    expect(placement(chat('a', now), s, now)).toBe('inbox');
  });

  it('lets snooze win over a stale archive stamp on the same thread', () => {
    // The store clears the other field on each action, but a hand-edited file
    // could carry both; snoozed is the more specific ("come back at") answer.
    const s = state({ a: { archivedAt: now, snoozedAt: now, snoozedUntil: now + HOUR } });
    expect(placement(chat('a', now - HOUR), s, now)).toBe('snoozed');
  });

  it('ignores a half-written snooze (a wake time with no set-at stamp)', () => {
    const s = state({ a: { snoozedUntil: now + HOUR } });
    expect(placement(chat('a', now - HOUR), s, now)).toBe('inbox');
  });
});

describe('isUnread', () => {
  const now = 1_700_000_000_000;

  it('counts every pre-existing thread as read on a fresh store', () => {
    // The clean-slate rule: upgrading must not present a wall of bold rows.
    const s = state({}, now);
    expect(isUnread(chat('a', now - 30 * DAY), s)).toBe(false);
  });

  it('marks a thread unread once activity passes the baseline', () => {
    const s = state({}, now - DAY);
    expect(isUnread(chat('a', now), s)).toBe(true);
  });

  it('clears once the thread is opened, and returns on the next turn', () => {
    const opened = state({ a: { readAt: now } }, now - DAY);
    expect(isUnread(chat('a', now - HOUR), opened)).toBe(false);
    expect(isUnread(chat('a', now + 1), opened)).toBe(true);
  });

  it('honours an explicit mark-as-unread over a newer read stamp', () => {
    const s = state({ a: { readAt: now, forcedUnread: true } }, 0);
    expect(isUnread(chat('a', now - DAY), s)).toBe(true);
  });

  it('stays read while a turn is generating — mid-turn writes are not an answer', () => {
    // Every tool call appends to the session file, so the mtime runs ahead of
    // readAt long before there is anything new to read.
    const s = state({ a: { readAt: now - HOUR } }, 0);
    expect(isUnread(chat('a', now), s, true)).toBe(false);
    // The same mtime goes bold the moment the turn settles.
    expect(isUnread(chat('a', now), s, false)).toBe(true);
  });

  it('keeps an explicit mark-as-unread bold even while a turn runs', () => {
    const s = state({ a: { forcedUnread: true } }, 0);
    expect(isUnread(chat('a', now), s, true)).toBe(true);
  });
});

describe('nextWakeAt', () => {
  const now = 1_700_000_000_000;

  it('is null when nothing is snoozed', () => {
    expect(nextWakeAt([chat('a', now)], emptyInboxState(), now)).toBeNull();
  });

  it('returns the earliest future wake time so the list can schedule one timer', () => {
    const s = state({
      a: { snoozedAt: now - HOUR, snoozedUntil: now + 2 * HOUR },
      b: { snoozedAt: now - HOUR, snoozedUntil: now + HOUR }
    });
    const chats = [chat('a', now - DAY), chat('b', now - DAY)];
    expect(nextWakeAt(chats, s, now)).toBe(now + HOUR);
    expect(snoozedUntil(chats[1], s, now)).toBe(now + HOUR);
  });

  it('skips a thread whose snooze has already been broken by new activity', () => {
    const s = state({ a: { snoozedAt: now - HOUR, snoozedUntil: now + HOUR } });
    expect(nextWakeAt([chat('a', now)], s, now)).toBeNull();
  });
});

describe('snooze presets', () => {
  // A Wednesday, 14:40 local.
  const base = new Date(2026, 7, 5, 14, 40, 0, 0);
  const at = (id: string) => SNOOZE_PRESETS.find((p) => p.id === id)!.at(base);

  it('offers later today three hours out', () => {
    expect(at('later').getTime() - base.getTime()).toBe(3 * HOUR);
  });

  it('lands tomorrow, this weekend and next week on a 9am', () => {
    for (const id of ['tomorrow', 'weekend', 'nextweek']) {
      const d = at(id);
      expect(d.getHours()).toBe(9);
      expect(d.getMinutes()).toBe(0);
      expect(d.getTime()).toBeGreaterThan(base.getTime());
    }
    expect(at('tomorrow').getDate()).toBe(6);
    expect(at('weekend').getDay()).toBe(6); // Saturday
    expect(at('nextweek').getDay()).toBe(1); // Monday
  });

  it('never resolves "this weekend" or "next week" to today', () => {
    const saturday = new Date(2026, 7, 8, 10, 0, 0, 0);
    const weekend = SNOOZE_PRESETS.find((p) => p.id === 'weekend')!.at(saturday);
    expect(weekend.getTime()).toBeGreaterThan(saturday.getTime());
    expect(weekend.getDate()).toBe(15);

    const monday = new Date(2026, 7, 3, 10, 0, 0, 0);
    const nextWeek = SNOOZE_PRESETS.find((p) => p.id === 'nextweek')!.at(monday);
    expect(nextWeek.getDate()).toBe(10);
  });
});

describe('formatWake', () => {
  const now = new Date(2026, 7, 5, 14, 40).getTime();

  it('shows only a time for today, a weekday within the week, a date beyond it', () => {
    expect(formatWake(new Date(2026, 7, 5, 17, 40).getTime(), now)).not.toMatch(/\d{1,2}\//);
    expect(formatWake(new Date(2026, 7, 7, 9, 0).getTime(), now)).toMatch(/\w/);
    // Two weeks out must not read as a bare weekday — that would be ambiguous.
    const far = formatWake(new Date(2026, 7, 19, 9, 0).getTime(), now);
    expect(far).toContain('19');
  });
});
