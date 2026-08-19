import * as activity from '../activity';
import type { ActivityHandle } from '../activity';

// The activity-indicator face of a mirror sync. The server never initiates a
// round — it learns one is happening from the RPCs the owning device sends —
// so the entry is opened by the diff that names work, advanced by each apply
// batch, and closed by the round's report. A first sync of a big folder is the
// motivating case: tens of thousands of uploads look exactly like "stuck"
// without a progress row (the card says only "Waiting for first sync").
//
// One entry per folder, held here by id rather than via the registry's
// stepped-by-kind correlation: two devices can sync two folders at once, and
// stepped correlation would fold them into one row.

/** A round whose device went silent this long is closed, not left running forever. */
const STALL_MS = 10 * 60_000;

interface OpenSync {
  handle: ActivityHandle;
  done: number;
  total: number;
  timer: NodeJS.Timeout | null;
}

const open = new Map<string, OpenSync>();

function close(folderId: string, sync: OpenSync, detail?: string): void {
  if (sync.timer) clearTimeout(sync.timer);
  open.delete(folderId);
  activity.end(sync.handle, {
    worked: sync.done > 0,
    detail: detail ?? `${sync.done.toLocaleString()} file${sync.done === 1 ? '' : 's'}`
  });
}

/** Re-arm the stall clock: the device just spoke, the round is alive. */
function arm(folderId: string, sync: OpenSync): void {
  if (sync.timer) clearTimeout(sync.timer);
  sync.timer = setTimeout(() => {
    const current = open.get(folderId);
    // The device stopped mid-round (app quit, laptop lid). The next round
    // re-diffs and opens a fresh entry for whatever is left.
    if (current === sync) close(folderId, sync, `interrupted after ${sync.done.toLocaleString()} files`);
  }, STALL_MS);
  sync.timer.unref?.();
}

/**
 * A diff told the device what to move. Zero work closes any entry a dead
 * round left behind; otherwise open (or retarget) this folder's entry.
 */
export function mirrorSyncPlanned(folderId: string, label: string, plannedFiles: number): void {
  const existing = open.get(folderId);
  if (plannedFiles === 0) {
    if (existing) close(folderId, existing);
    return;
  }
  if (existing) {
    // A re-diff mid-entry is a resumed round: what is already done stands,
    // and the new plan is what remains.
    existing.total = existing.done + plannedFiles;
    activity.progress(existing.handle, { done: existing.done, total: existing.total });
    arm(folderId, existing);
    return;
  }
  const handle = activity.begin('mirror.sync', `Syncing ${label}`, { detail: label });
  const sync: OpenSync = { handle, done: 0, total: plannedFiles, timer: null };
  activity.progress(handle, { done: 0, total: plannedFiles });
  open.set(folderId, sync);
  arm(folderId, sync);
}

/** An apply batch landed: move the bar. */
export function mirrorSyncApplied(folderId: string, files: number): void {
  const sync = open.get(folderId);
  if (!sync) return;
  sync.done = Math.min(sync.done + files, sync.total);
  activity.progress(sync.handle, { done: sync.done, total: sync.total });
  arm(folderId, sync);
}

/** The round reported (ok or root-missing) or the folder was disconnected. */
export function mirrorSyncEnded(folderId: string): void {
  const sync = open.get(folderId);
  if (sync) close(folderId, sync);
}
