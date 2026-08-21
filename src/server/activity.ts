import type { ActivityEntry, ActivityKind, ActivitySnapshot } from '../shared/types';

// App-global registry for background work, mirroring the seam pattern in
// recall/retrieval.ts and recall/scan.ts: a module with a settable emitter that
// defaults to a no-op, so every pass can report unconditionally and unit tests
// (and the utility-process workers) import it without wiring anything.
//
// Two shapes of job:
//   oneshot — begins and ends inside one call (a distill batch, a folder scan)
//   stepped — yields to interactive work and resumes minutes later across many
//             timer ticks (the memory rebuild, folder learn, a model download)
// A stepped job is correlated by kind, so each resumption re-opens the SAME
// entry instead of stacking two hundred rows for one rebuild, and accumulates
// only the time it was actually working — wall-clock start→finish would report
// a rebuild that yielded overnight as "8h".

/** History rows kept; the popover shows the first ten and reveals the rest on demand. */
export const ACTIVITY_HISTORY_LIMIT = 30;

/** Coalesce bursts (five sub-passes finishing back to back) into one push. */
const EMIT_DEBOUNCE_MS = 150;

export interface ActivityHandle {
  readonly id: string;
  readonly kind: ActivityKind;
}

interface OpenEntry extends ActivityEntry {
  stepped: boolean;
  /** When the current step started; null while a stepped job sits between steps. */
  stepStartedAt: number | null;
}

let emit: ((snapshot: ActivitySnapshot) => void) | null = null;
let emitTimer: NodeJS.Timeout | null = null;
let seq = 0;

const open = new Map<string, OpenEntry>();
/** Kind → open entry id, so a stepped job's next step finds its existing entry. */
const steppedByKind = new Map<ActivityKind, string>();
const history: ActivityEntry[] = [];
let unseenFailure = false;

export function setActivityEmitter(fn: ((snapshot: ActivitySnapshot) => void) | null): void {
  emit = fn;
}

function publicEntry(e: OpenEntry | ActivityEntry): ActivityEntry {
  const { id, kind, label, detail, startedAt, activeMs, state, progress, error } = e;
  return { id, kind, label, detail, startedAt, activeMs, state, progress, error };
}

export function snapshot(): ActivitySnapshot {
  const now = Date.now();
  return {
    // A running entry's activeMs is banked at step boundaries, so add the time
    // spent in the current step or the popover would show a frozen counter.
    running: [...open.values()].map((e) => ({
      ...publicEntry(e),
      activeMs: e.activeMs + (e.stepStartedAt === null ? 0 : now - e.stepStartedAt)
    })),
    history: [...history],
    unseenFailure
  };
}

function scheduleEmit(): void {
  if (!emit || emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    emit?.(snapshot());
  }, EMIT_DEBOUNCE_MS);
  // A pending emit must never hold the app open at quit.
  emitTimer.unref?.();
}

function remember(entry: ActivityEntry): void {
  history.unshift(entry);
  if (history.length > ACTIVITY_HISTORY_LIMIT) history.length = ACTIVITY_HISTORY_LIMIT;
}

/**
 * Open a run (or resume the open stepped run for this kind). Pass `stepped: true`
 * for passes that yield and resume; the returned handle is stable across steps.
 */
export function begin(
  kind: ActivityKind,
  label: string,
  opts: { stepped?: boolean; detail?: string } = {}
): ActivityHandle {
  const now = Date.now();
  if (opts.stepped) {
    const existingId = steppedByKind.get(kind);
    const existing = existingId ? open.get(existingId) : undefined;
    if (existing) {
      // Resuming: restart the step clock, refresh the caller's detail.
      existing.stepStartedAt = now;
      if (opts.detail !== undefined) existing.detail = opts.detail;
      scheduleEmit();
      return { id: existing.id, kind };
    }
  }
  const id = `act-${++seq}`;
  const entry: OpenEntry = {
    id,
    kind,
    label,
    detail: opts.detail,
    startedAt: now,
    activeMs: 0,
    state: 'running',
    stepped: !!opts.stepped,
    stepStartedAt: now
  };
  open.set(id, entry);
  if (opts.stepped) steppedByKind.set(kind, id);
  scheduleEmit();
  return { id, kind };
}

/** Refresh an open run's detail line (ignored for runs already closed). */
export function setDetail(handle: ActivityHandle, detail: string): void {
  const entry = open.get(handle.id);
  if (!entry) return;
  entry.detail = detail;
  scheduleEmit();
}

/** Update a stepped run's progress counter (ignored for runs already closed). */
export function progress(handle: ActivityHandle, next: { done: number; total: number }): void {
  const entry = open.get(handle.id);
  if (!entry) return;
  entry.progress = next;
  scheduleEmit();
}

/**
 * Bank the current step's time without closing the run — for a stepped pass that
 * yielded and will resume on a later tick.
 */
export function yieldStep(handle: ActivityHandle): void {
  const entry = open.get(handle.id);
  if (!entry || entry.stepStartedAt === null) return;
  entry.activeMs += Date.now() - entry.stepStartedAt;
  entry.stepStartedAt = null;
  scheduleEmit();
}

/**
 * Close a run. `worked: false` discards it entirely — most passes no-op on an
 * unchanged watermark, and a history of "Summaries · 0 ms" would bury the rows
 * that matter. The run is still closed and its icon contribution removed.
 */
export function end(handle: ActivityHandle, result: { worked: boolean; detail?: string }): void {
  const entry = open.get(handle.id);
  if (!entry) return;
  open.delete(handle.id);
  if (entry.stepped) steppedByKind.delete(entry.kind);
  if (entry.stepStartedAt !== null) entry.activeMs += Date.now() - entry.stepStartedAt;
  entry.stepStartedAt = null;
  if (result.worked) {
    entry.state = 'done';
    if (result.detail !== undefined) entry.detail = result.detail;
    entry.progress = undefined;
    remember(publicEntry(entry));
  }
  scheduleEmit();
}

/** Detach the open run for `kind` (if any) and bank its in-flight step time. */
function takeOpenByKind(kind: ActivityKind): OpenEntry | undefined {
  const entry = [...open.values()].find((e) => e.kind === kind);
  if (!entry) return undefined;
  open.delete(entry.id);
  if (entry.stepped) steppedByKind.delete(entry.kind);
  if (entry.stepStartedAt !== null) entry.activeMs += Date.now() - entry.stepStartedAt;
  entry.stepStartedAt = null;
  return entry;
}

/**
 * Close the open run for `kind` without holding its handle — for event-driven
 * jobs whose start and finish arrive as separate status callbacks (the model
 * download/load transitions). A no-op when nothing is open, which is exactly
 * what an already-cached model reporting straight to 'ready' should record.
 */
export function endByKind(kind: ActivityKind, result: { worked: boolean; detail?: string }): void {
  const entry = takeOpenByKind(kind);
  if (!entry) return;
  if (result.worked) {
    entry.state = 'done';
    if (result.detail !== undefined) entry.detail = result.detail;
    entry.progress = undefined;
    remember(publicEntry(entry));
  }
  scheduleEmit();
}

/**
 * Record a failure. Callable without a handle because several passes catch
 * internally and return a zero count (distill.ts is the notable one), so the
 * only place that knows a run failed is inside the function. Closes the open
 * run for this kind when there is one.
 */
export function fail(kind: ActivityKind, error: unknown, label?: string): void {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const entry = takeOpenByKind(kind);
  if (entry) {
    entry.state = 'failed';
    entry.error = message;
    entry.progress = undefined;
    remember(publicEntry(entry));
  } else {
    remember({
      id: `act-${++seq}`,
      kind,
      label: label ?? kind,
      startedAt: Date.now(),
      activeMs: 0,
      state: 'failed',
      error: message
    });
  }
  unseenFailure = true;
  scheduleEmit();
}

/** The user opened the panel — the sticky failure marker has served its purpose. */
export function markSeen(): void {
  if (!unseenFailure) return;
  unseenFailure = false;
  scheduleEmit();
}

/** Test seam: drop all state (module-level registry outlives individual tests). */
export function resetActivity(): void {
  if (emitTimer) clearTimeout(emitTimer);
  emitTimer = null;
  open.clear();
  steppedByKind.clear();
  history.length = 0;
  unseenFailure = false;
  seq = 0;
}

/**
 * Run `fn` as a oneshot activity. `worked` decides whether it earns a history
 * row; throwing is reported and rethrown, so callers keep their own semantics.
 */
export async function track<T>(
  kind: ActivityKind,
  label: string,
  fn: () => Promise<T>,
  describe: (result: T) => { worked: boolean; detail?: string }
): Promise<T> {
  const handle = begin(kind, label);
  try {
    const result = await fn();
    end(handle, describe(result));
    return result;
  } catch (error) {
    fail(kind, error, label);
    throw error;
  }
}
