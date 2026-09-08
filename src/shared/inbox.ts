// The Inbox: an email-style triage layer over chat threads. Deliberately a pure
// module — the server persists the state, the renderer decides where each row
// goes, and both agree because they call the same three functions.
//
// The load-bearing idea is that archive and snooze are *timestamps*, not flags.
// A thread is archived only while its last activity is older than the moment you
// archived it, so any new turn — a scheduled run, a reply from the phone, or you
// picking it back up — lifts it out of the archive on its own. That's the email
// behaviour ("a new reply un-archives the conversation") with no background job,
// no push channel, and no write to make it happen.

/** Per-thread inbox state. Every field is absent until the user acts on the thread. */
export interface InboxEntry {
  /** ms — last time the user had this thread open. */
  readAt?: number;
  /** "Mark as unread": forces unread regardless of `readAt`, cleared on next open. */
  forcedUnread?: true;
  /** ms — archived, but only while the thread's last activity is at/below this. */
  archivedAt?: number;
  /** ms — when the snooze was set (same resurrection rule as `archivedAt`). */
  snoozedAt?: number;
  /** ms — the wake time. */
  snoozedUntil?: number;
  /**
   * A quiet window: writes to the session file between `quietFrom` and
   * `quietUntil` (ms, both or neither) were non-events — a scheduled run that
   * found nothing, a rename to the name the chat already had. While the file's
   * mtime is still inside the window the chat is listed as of `quietFrom`, so
   * it neither jumps to the top nor changes its read/archive/snooze standing.
   * The next real write lands past `quietUntil` and the mtime speaks again.
   */
  quietFrom?: number;
  quietUntil?: number;
}

export interface InboxState {
  /**
   * ms, stamped once when the store is first created. Threads whose last activity
   * predates it count as read, so upgrading to the Inbox doesn't present a wall of
   * bold rows and a badge count nobody can burn down.
   */
  baseline: number;
  entries: Record<string, InboxEntry>;
}

/** Where a thread belongs right now. */
export type InboxPlacement = 'inbox' | 'snoozed' | 'archived';

export function emptyInboxState(): InboxState {
  return { baseline: 0, entries: {} };
}

/**
 * Normalize a chat's `updatedAt` to ms. Real rows carry Unix seconds (the backend
 * session file's mtime); optimistic rows created this session carry ms.
 */
export function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

/** Minimal shape needed to place a row — anything with a thread id and a mtime. */
export interface InboxSubject {
  threadId: string;
  updatedAt: number;
}

/**
 * The last-activity time a chat should be listed with: its real mtime, unless
 * that mtime still sits inside the entry's quiet window, in which case the time
 * the window opened on. Same unit as `chat.updatedAt` (backend seconds or ms).
 * The server applies this to every ChatSummary it lists, so clients never see
 * the quiet mtime at all — see server/ipc/chats.ts.
 */
export function listedUpdatedAt(chat: InboxSubject, state: InboxState): number {
  const entry = state.entries[chat.threadId];
  if (entry?.quietFrom == null || entry.quietUntil == null) return chat.updatedAt;
  const updated = toMs(chat.updatedAt);
  if (updated > entry.quietUntil || updated <= entry.quietFrom) return chat.updatedAt;
  return chat.updatedAt < 1e12 ? Math.floor(entry.quietFrom / 1000) : entry.quietFrom;
}

export function placement(chat: InboxSubject, state: InboxState, now: number): InboxPlacement {
  const entry = state.entries[chat.threadId];
  if (!entry) return 'inbox';
  const updated = toMs(chat.updatedAt);
  if (
    entry.snoozedUntil != null &&
    entry.snoozedAt != null &&
    now < entry.snoozedUntil &&
    updated <= entry.snoozedAt
  )
    return 'snoozed';
  if (entry.archivedAt != null && updated <= entry.archivedAt) return 'archived';
  return 'inbox';
}

/**
 * `turnRunning` = a turn is generating into this thread right now. A running
 * turn appends to the session file as it works — every tool call bumps the mtime
 * long before there is an answer to read — so while it runs, the mtime says
 * nothing about unread mail and the row stays quiet. It goes bold when the turn
 * settles (the status dot covers the meantime). A thread the user explicitly
 * marked unread stays bold regardless: that was a decision, not an mtime.
 */
export function isUnread(chat: InboxSubject, state: InboxState, turnRunning = false): boolean {
  const entry = state.entries[chat.threadId];
  if (entry?.forcedUnread) return true;
  if (turnRunning) return false;
  return toMs(chat.updatedAt) > Math.max(entry?.readAt ?? 0, state.baseline);
}

/** The wake time of a snoozed thread, or null if it isn't snoozed. */
export function snoozedUntil(chat: InboxSubject, state: InboxState, now: number): number | null {
  if (placement(chat, state, now) !== 'snoozed') return null;
  return state.entries[chat.threadId]?.snoozedUntil ?? null;
}

/**
 * The next instant at which some thread's placement changes on its own — i.e. the
 * earliest future wake time. The list schedules a single timer for it rather than
 * polling on an interval.
 */
export function nextWakeAt(chats: InboxSubject[], state: InboxState, now: number): number | null {
  let soonest: number | null = null;
  for (const chat of chats) {
    const at = snoozedUntil(chat, state, now);
    if (at != null && (soonest === null || at < soonest)) soonest = at;
  }
  return soonest;
}

// ---- optimistic mirrors of the server's mutators ----
//
// The renderer applies these to its own copy of the state the instant the user
// acts, then reconciles with the list the server's mutator returns. They must
// stamp exactly the fields server/workspace/inbox.ts stamps, the same way, or
// rows would jump when the authoritative answer lands. Pure — a patch built from
// one of these can be re-applied to a fresher state and mean the same thing.

/** Copy-and-mutate the entries for `threadIds`, pruning any left empty. */
function patchEntries(
  state: InboxState,
  threadIds: readonly string[],
  mutate: (entry: InboxEntry, threadId: string) => void
): InboxState {
  const entries = { ...state.entries };
  for (const threadId of threadIds) {
    const entry: InboxEntry = { ...entries[threadId] };
    mutate(entry, threadId);
    if (Object.keys(entry).length) entries[threadId] = entry;
    else delete entries[threadId];
  }
  return { ...state, entries };
}

/**
 * Mirror of the server's `setRead`. `updatedAt` (per thread, ms or backend
 * seconds) lets the stamp cover a thread mtime sitting in the future relative
 * to `now` — the same clock-skew guard the server applies.
 */
export function withRead(
  state: InboxState,
  threadIds: readonly string[],
  read: boolean,
  updatedAt: ReadonlyMap<string, number>,
  now: number
): InboxState {
  return patchEntries(state, threadIds, (entry, threadId) => {
    if (read) {
      entry.readAt = Math.max(now, toMs(updatedAt.get(threadId) ?? 0));
      delete entry.forcedUnread;
    } else {
      entry.forcedUnread = true;
    }
  });
}

/** Mirror of the server's `setArchived`. */
export function withArchived(
  state: InboxState,
  threadIds: readonly string[],
  archived: boolean,
  now: number
): InboxState {
  return patchEntries(state, threadIds, (entry) => {
    if (archived) {
      entry.archivedAt = now;
      delete entry.snoozedAt;
      delete entry.snoozedUntil;
    } else {
      delete entry.archivedAt;
    }
  });
}

/** Mirror of the server's `setSnooze` (`until` null or past = wake now). */
export function withSnooze(
  state: InboxState,
  threadIds: readonly string[],
  until: number | null,
  now: number
): InboxState {
  return patchEntries(state, threadIds, (entry) => {
    if (until != null && until > now) {
      entry.snoozedAt = now;
      entry.snoozedUntil = until;
      delete entry.archivedAt;
    } else {
      delete entry.snoozedAt;
      delete entry.snoozedUntil;
    }
  });
}

/** Mirror of the server's `markAllRead`: stamp every listed thread in one pass. */
export function withAllRead(state: InboxState, chats: readonly InboxSubject[], now: number): InboxState {
  const updatedAt = new Map(chats.map((c) => [c.threadId, c.updatedAt]));
  return withRead(state, [...updatedAt.keys()], true, updatedAt, now);
}

// ---- snooze presets ----

export interface SnoozePreset {
  id: string;
  label: string;
  /** Resolve against a given "now" so the popover can show the real time it lands on. */
  at: (now: Date) => Date;
}

/** 9am is the conventional "start of a workday" wake hour; Gmail uses the same. */
export const MORNING_HOUR = 9;

function atHour(base: Date, addDays: number, hour: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + addDays);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** Days until the coming Saturday; 7 if today already is Saturday (never "in 0 days"). */
function daysUntilSaturday(base: Date): number {
  const delta = (6 - base.getDay() + 7) % 7;
  return delta === 0 ? 7 : delta;
}

/** Days until the coming Monday; 7 if today already is Monday. */
function daysUntilMonday(base: Date): number {
  const delta = (1 - base.getDay() + 7) % 7;
  return delta === 0 ? 7 : delta;
}

export const SNOOZE_PRESETS: SnoozePreset[] = [
  { id: 'later', label: 'Later today', at: (now) => new Date(now.getTime() + 3 * 3600_000) },
  { id: 'tomorrow', label: 'Tomorrow', at: (now) => atHour(now, 1, MORNING_HOUR) },
  { id: 'weekend', label: 'This weekend', at: (now) => atHour(now, daysUntilSaturday(now), MORNING_HOUR) },
  { id: 'nextweek', label: 'Next week', at: (now) => atHour(now, daysUntilMonday(now), MORNING_HOUR) }
];

/** "Fri 09:00" / "15:40" — the resolved time shown beside a preset and on a snoozed row. */
export function formatWake(at: number, now: number): string {
  const d = new Date(at);
  const sameDay = new Date(now);
  sameDay.setHours(0, 0, 0, 0);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (at < sameDay.getTime() + 86400_000) return time;
  const withinWeek = at < sameDay.getTime() + 7 * 86400_000;
  return withinWeek
    ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}
