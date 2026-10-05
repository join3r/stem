// Who is working where. A run is one Stem turn (its threadId): it has a current
// tab, the tabs it opened (the only ones it may close), the tabs it touched and
// when, and the downloads it caused. Several runs can be live at once — two
// chats, or a chat beside a scheduled task — so nothing here is global.
//
// Pure bookkeeping with an injectable clock, so the unit tests can walk it
// through time without a browser.

/** Another run counts as "in" a tab for this long after it last acted there. */
export const SHARED_TAB_WINDOW_MS = 2 * 60_000;

/** How long after a run's action in a tab a download there still counts as the run's. */
export const DOWNLOAD_WINDOW_MS = 60_000;

export class Runs {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.map = new Map();
  }

  get(threadId) {
    return this.map.get(threadId);
  }

  ensure(threadId) {
    let run = this.map.get(threadId);
    if (!run) {
      run = {
        threadId,
        startedAt: this.now(),
        lastActionAt: this.now(),
        current: null,
        opened: new Set(),
        touched: new Map(),
        stopped: false,
        downloads: new Map(),
        unreported: []
      };
      this.map.set(threadId, run);
    }
    return run;
  }

  live() {
    return [...this.map.values()];
  }

  /** The run did something (any action): keeps download attribution honest. */
  noteAction(threadId) {
    this.ensure(threadId).lastActionAt = this.now();
  }

  /** The run acted in `tabId`: it becomes the current tab. */
  touch(threadId, tabId) {
    const run = this.ensure(threadId);
    const t = this.now();
    run.current = tabId;
    run.touched.set(tabId, t);
    run.lastActionAt = t;
    return run;
  }

  opened(threadId, tabId) {
    this.ensure(threadId).opened.add(tabId);
  }

  /** Live runs other than `threadId` that acted in `tabId` within the window. */
  othersRecentlyIn(tabId, threadId, windowMs = SHARED_TAB_WINDOW_MS) {
    const t = this.now();
    return this.live()
      .filter((r) => r.threadId !== threadId && !r.stopped)
      .filter((r) => {
        const at = r.touched.get(tabId);
        return at !== undefined && t - at <= windowMs;
      })
      .map((r) => r.threadId);
  }

  /** Every live run that has worked in `tabId` (the ones a Stop in that tab is for). */
  usingTab(tabId) {
    return this.live()
      .filter((r) => r.touched.has(tabId))
      .map((r) => r.threadId);
  }

  /** Whether any live, unstopped run other than `exceptThreadId` still holds `tabId`. */
  tabHeldByOthers(tabId, exceptThreadId) {
    return this.live().some((r) => r.threadId !== exceptThreadId && !r.stopped && r.touched.has(tabId));
  }

  /** Forget the run; returns it (so the caller can release its tabs) or undefined. */
  end(threadId) {
    const run = this.map.get(threadId);
    this.map.delete(threadId);
    return run;
  }

  /** The tab closed: no run may keep pointing at it. */
  forgetTab(tabId) {
    for (const run of this.map.values()) {
      run.opened.delete(tabId);
      run.touched.delete(tabId);
      if (run.current === tabId) run.current = null;
    }
  }

  /** Chrome swapped a tab's id (prerender, discard): carry the bookkeeping over. */
  replaceTab(oldId, newId) {
    for (const run of this.map.values()) {
      if (run.opened.delete(oldId)) run.opened.add(newId);
      const at = run.touched.get(oldId);
      if (at !== undefined) {
        run.touched.delete(oldId);
        run.touched.set(newId, at);
      }
      if (run.current === oldId) run.current = newId;
    }
  }

  /**
   * The run a download starting in `tabId` belongs to: the live, unstopped run
   * that acted in that tab most recently, and within the last minute — or
   * null. Only a run's own recent action can give it a download; the user's
   * own downloads are never pinned on a run (they would be copied to the
   * server), including one the user starts later in a tab Stem worked in
   * earlier — hence the window, not just "touched at some point".
   */
  ownerOfTab(tabId) {
    const now = this.now();
    let best = null;
    let bestAt = -Infinity;
    for (const run of this.map.values()) {
      if (run.stopped) continue;
      const at = run.touched.get(tabId);
      if (at !== undefined && now - at <= DOWNLOAD_WINDOW_MS && at > bestAt) {
        best = run;
        bestAt = at;
      }
    }
    return best ? best.threadId : null;
  }

  /** Record or update a download for `threadId`; when it completes it queues for reporting. */
  updateDownload(threadId, item) {
    const run = this.map.get(threadId);
    if (!run) return;
    const prev = run.downloads.get(item.id);
    const next = { ...prev, ...item };
    run.downloads.set(item.id, next);
    if (next.state === 'complete' && !(prev && prev.state === 'complete') && !next.reported) {
      run.unreported.push(item.id);
    }
  }

  /** Completed downloads the run has not been told about yet — each handed out once. */
  takeFinished(threadId) {
    const run = this.map.get(threadId);
    if (!run || !run.unreported.length) return [];
    const out = [];
    for (const id of run.unreported) {
      const d = run.downloads.get(id);
      if (!d || d.reported) continue;
      d.reported = true;
      out.push({ path: d.path, name: d.name, size: d.size, ...(d.mime ? { mime: d.mime } : {}) });
    }
    run.unreported = [];
    return out;
  }
}
