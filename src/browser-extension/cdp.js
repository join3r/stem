/* global chrome, setTimeout, clearTimeout, setInterval, document, HTMLIFrameElement, HTMLEmbedElement, HTMLObjectElement */
import { ConsoleLog, NetworkLog } from './logs.js';
import { installMarkerHooks, markerCall, MARKER_BINDING, MARKER_PING_MS } from './marker.js';
import { UserError } from './util.js';

// chrome.debugger, one session per tab: attach on first touch, detach when the
// last run using the tab ends or after IDLE_DETACH_MS without an action.
//
// Attaching does four things beyond the debugger itself:
// - Enables Page/Runtime/Network/Log so console and network history start at
//   attach, and dialogs and navigations are seen.
// - Turns on focus emulation. Besides making the page believe it is focused,
//   this is what makes a BACKGROUND tab render: Chrome counts the emulation as
//   a capturer, so the hidden tab gets visibilityState "visible", animation
//   frames run, and rAF-aligned input (mouse moves, wheel) is delivered instead
//   of waiting forever for a frame (measured on Chrome 149: mouseMoved never
//   acks in a hidden tab without it). The user's view does not change.
// - Intercepts file choosers, so a click on an upload button never opens a
//   native file dialog on the user's screen; `upload` answers it instead.
// - Installs the marker (marker.js).

export const IDLE_DETACH_MS = 3 * 60_000;

const sessions = new Map();
const attaching = new Map();
/**
 * The snapshot of a tab Chrome detached Stem from on its own (another
 * extension's frame appearing — a password manager's fill menu opening on the
 * field Stem just focused), for the re-attach to take back when the document
 * is still the same: node ids outlive the debugger session, so the model's
 * refs keep working.
 */
const orphanSnapshots = new Map();
const ORPHAN_SNAPSHOT_MS = 2 * 60_000;
const queues = new Map();
const handlers = { markerStop: () => {}, detached: () => {}, downloadStart: () => {} };

export function onMarkerStop(fn) {
  handlers.markerStop = fn;
}

/** (tabId, {url, suggestedFilename, guid}) when an attached tab starts a download. */
export function onDownloadStart(fn) {
  handlers.downloadStart = fn;
}

/** (tabId, reason) after any detach, ours or not. */
export function onDetached(fn) {
  handlers.detached = fn;
}

/** A CDP error → its plain message ("No node with given id found"). */
function cdpMessage(err) {
  const raw = (err && err.message) || String(err);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.message) return parsed.message;
  } catch {
    // Not JSON: chrome.debugger's own errors are plain sentences.
  }
  return raw;
}

export class CdpError extends Error {
  constructor(method, message) {
    super(message);
    this.name = 'CdpError';
    this.method = method;
  }
}

export function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params).then(
    (r) => r,
    (err) => {
      throw new CdpError(method, cdpMessage(err));
    }
  );
}

class Session {
  constructor(tabId) {
    this.tabId = tabId;
    this.attachedAt = Date.now();
    this.mainFrameId = null;
    this.loaderId = null;
    this.navSeq = 0;
    this.dialog = null;
    this.dialogWaiters = new Set();
    this.chooser = null;
    this.snapshot = null;
    this.console = new ConsoleLog();
    this.network = new NetworkLog();
    this.busy = 0;
    this.lastActionEnd = 0;
    this.lastThreadId = null;
    this.activeBefore = null;
    this.idleTimer = null;
    this.pillRect = null;
    this.pinging = false;
    /** IDs this tab had before the browser replaced it (see tabReplaced). */
    this.formerIds = new Set();
  }

  send(method, params) {
    return send(this.tabId, method, params);
  }

  /** Call `fn(dialog)` when a JavaScript dialog opens; returns the unsubscribe. */
  onDialog(fn) {
    this.dialogWaiters.add(fn);
    return () => this.dialogWaiters.delete(fn);
  }
}

export function session(tabId) {
  return sessions.get(currentTab(tabId));
}

/**
 * Tab IDs the browser replaced, old to new. jbrow keeps a sleeping tab without
 * its page and gives it a new ID when the debugger wakes it (tabs.onReplaced
 * says so, often before the attach returns). Filed under the old ID, Stem's
 * session missed the next call by the new one, which then tried to attach a
 * second time and was refused by Stem's own debugger (2026-11-03).
 */
const replacedBy = new Map();

function currentTab(tabId) {
  let id = tabId;
  for (let i = 0; i < 8 && replacedBy.has(id); i++) id = replacedBy.get(id);
  return id;
}

/** tabs.onReplaced: the tab's session, if any, goes under its new ID. */
export function tabReplaced(removed, added) {
  replacedBy.set(removed, added);
  if (replacedBy.size > 200) replacedBy.delete(replacedBy.keys().next().value);
  const s = sessions.get(removed);
  if (!s) return;
  sessions.delete(removed);
  s.formerIds.add(removed);
  s.tabId = added;
  if (!sessions.has(added)) sessions.set(added, s);
}

export function attachedTabs() {
  return [...sessions.keys()];
}

/** chrome.debugger's refusal when a page holds another extension's frame. */
const FOREIGN_FRAME = /chrome-extension:\/\/ URL of different extension/i;

function attachError(tabId, message) {
  if (/another debugger/i.test(message)) {
    return new UserError(
      `Something else is already debugging tab ${tabId} (another extension, or remote debugging): Stem can't work in it until that lets go.`
    );
  }
  // A normal page that holds another extension's frame — a password manager's
  // fill menu, say — refuses the debugger as a whole (2026-10-19: Bitwarden in
  // a Cloudflare billing tab).
  if (FOREIGN_FRAME.test(message)) {
    return new UserError(
      `Another extension has a frame inside tab ${tabId} (often a password manager's fill menu), and the browser then lets no other extension control the tab. ` +
        'Open the same address in a new tab and work there, and tell the user that is where the result is; or ask them to close that menu and try again.'
    );
  }
  if (/cannot (access|attach)|chrome:\/\/|chrome-extension|webstore|not allowed/i.test(message)) {
    return new UserError(`The browser does not let extensions control tab ${tabId} (${message}).`);
  }
  if (/no tab with/i.test(message)) return new UserError(`Tab ${tabId} is not open any more: use \`tabs\`.`);
  return new UserError(`Stem could not start working in tab ${tabId}: ${message}`);
}

/** The tab's session, attaching first if needed. Concurrent callers share one attach. */
export function attach(requested) {
  const tabId = currentTab(requested);
  const existing = sessions.get(tabId);
  if (existing) return Promise.resolve(existing);
  if (attaching.has(tabId)) return attaching.get(tabId);
  const p = doAttach(tabId).finally(() => attaching.delete(tabId));
  attaching.set(tabId, p);
  return p;
}

/**
 * Take out the frames other extensions put in a page (in every frame of the
 * tab, closed shadow roots included), so the debugger may attach. Answers how
 * many went; 0 when none were found or scripting is not allowed there.
 */
async function removeForeignFrames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [chrome.runtime.id],
      func: (ownId) => {
        const own = `chrome-extension://${ownId}/`;
        let removed = 0;
        const visit = (root) => {
          for (const el of root.querySelectorAll('*')) {
            const src = el instanceof HTMLIFrameElement || el instanceof HTMLEmbedElement ? el.src : el instanceof HTMLObjectElement ? el.data : '';
            if (/^chrome-extension:\/\//i.test(src || '') && !src.startsWith(own)) {
              el.remove();
              removed++;
              continue;
            }
            const shadow = chrome.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot;
            if (shadow) visit(shadow);
          }
        };
        visit(document);
        return removed;
      }
    });
    return results.reduce((n, r) => n + (typeof r.result === 'number' ? r.result : 0), 0);
  } catch {
    return 0;
  }
}

async function doAttach(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    const message = cdpMessage(err);
    // The debugger that holds the tab can be Stem's own, from before its
    // service worker stopped: the attachment belongs to the extension and
    // stays, but the new worker has no session for it (jbrow, 2026-11-09:
    // after each worker crash every action in the tab was refused). The
    // browser lets an extension detach only its own attachment, so a detach
    // that works proves the tab was Stem's.
    if (/another debugger/i.test(message) && (await releaseOwnStale(tabId))) {
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
      } catch (again) {
        throw attachError(tabId, cdpMessage(again));
      }
      return startSession(tabId);
    }
    // Another extension's frame (a password manager's fill menu) blocks the
    // debugger for the whole tab. It is that extension's overlay, not the
    // page: remove it and try once more.
    if (!FOREIGN_FRAME.test(message) || !(await removeForeignFrames(tabId))) throw attachError(tabId, message);
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (again) {
      throw attachError(tabId, cdpMessage(again));
    }
  }
  return startSession(tabId);
}

/** Detach a debugger this worker has no session for; true when it was Stem's own. */
async function releaseOwnStale(tabId) {
  if (sessions.has(tabId)) return false;
  try {
    await chrome.debugger.detach({ tabId });
    return true;
  } catch {
    return false;
  }
}

/** Set up the session for a tab the debugger was just attached to. */
async function startSession(tabId) {
  // The attach may have woken the tab under a new ID.
  const now = currentTab(tabId);
  const s = new Session(now);
  if (now !== tabId) s.formerIds.add(tabId);
  sessions.set(now, s);
  try {
    await Promise.all([
      s.send('Page.enable'),
      s.send('Runtime.enable'),
      s.send('Network.enable', { maxPostDataSize: 65_536 }),
      s.send('Log.enable')
    ]);
    await s.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
    await s.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    const { frameTree } = await s.send('Page.getFrameTree');
    s.mainFrameId = frameTree.frame.id;
    s.loaderId = frameTree.frame.loaderId;
    const orphan = orphanSnapshots.get(s.tabId);
    orphanSnapshots.delete(s.tabId);
    if (orphan && orphan.snapshot.loaderId === s.loaderId && Date.now() - orphan.at < ORPHAN_SNAPSHOT_MS) s.snapshot = orphan.snapshot;
    await installMarkerHooks((m, p) => s.send(m, p));
    await ping(s);
  } catch (err) {
    if (sessions.get(s.tabId) === s) sessions.delete(s.tabId);
    await chrome.debugger.detach({ tabId: s.tabId }).catch(() => {});
    throw err instanceof UserError ? err : attachError(tabId, err.message);
  }
  touchIdle(s);
  return s;
}

/** Take the marker down and let go of the tab. Safe to call for a tab Stem is not in. */
export async function detach(requested) {
  const tabId = currentTab(requested);
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  clearTimeout(s.idleTimer);
  // With a dialog open every page call blocks until it is answered; the marker
  // then times itself out instead.
  if (!s.dialog && s.mainFrameId) {
    await withTimeout(markerCall((m, p) => s.send(m, p), s.mainFrameId, 'remove()'), 1500).catch(() => {});
  }
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms)))]).finally(() =>
    clearTimeout(timer)
  );
}

function touchIdle(s) {
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (sessions.get(s.tabId) === s && s.busy === 0) void detach(s.tabId);
    else if (sessions.get(s.tabId) === s) touchIdle(s);
  }, IDLE_DETACH_MS);
}

/** Mark an action running in the tab (keeps idle detach and the marker away). */
export function beginAction(s, threadId) {
  s.busy++;
  s.lastThreadId = threadId;
  touchIdle(s);
}

export function endAction(s) {
  s.busy = Math.max(0, s.busy - 1);
  s.lastActionEnd = Date.now();
  touchIdle(s);
}

/**
 * Run `fn` after every earlier action queued for this tab. Two runs (or two
 * parallel calls from one) acting in one tab at once would interleave their
 * mouse and key events; one queue per tab keeps each action whole.
 */
export function enqueue(tabId, fn) {
  const prev = queues.get(tabId) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const tail = prev.then(() => gate);
  queues.set(tabId, tail);
  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release();
      if (queues.get(tabId) === tail) queues.delete(tabId);
    }
  });
}

async function ping(s) {
  if (s.pinging || s.dialog || !s.mainFrameId) return;
  s.pinging = true;
  try {
    const rect = await withTimeout(markerCall((m, p) => s.send(m, p), s.mainFrameId, 'ping()', { install: true }), 3000);
    s.pillRect = rect || null;
  } catch {
    // A page mid-navigation has no world to ping; the next round catches up.
  } finally {
    s.pinging = false;
  }
}

/** Marker calls an action makes (hide for a screenshot, let a click through). */
export async function marker(s, call) {
  if (s.dialog || !s.mainFrameId) return null;
  try {
    return await withTimeout(markerCall((m, p) => s.send(m, p), s.mainFrameId, call), 2000);
  } catch {
    return null;
  }
}

setInterval(() => {
  for (const s of sessions.values()) void ping(s);
}, MARKER_PING_MS);

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.sessionId) return;
  const s = sessions.get(source.tabId);
  if (!s) return;
  switch (method) {
    case 'Page.javascriptDialogOpening':
      s.dialog = { type: params.type, message: params.message || '', defaultPrompt: params.defaultPrompt || '', at: Date.now() };
      for (const fn of [...s.dialogWaiters]) fn(s.dialog);
      return;
    case 'Page.javascriptDialogClosed':
      s.dialog = null;
      return;
    case 'Page.frameNavigated':
      if (!params.frame.parentId) {
        s.mainFrameId = params.frame.id;
        if (params.frame.loaderId !== s.loaderId) {
          // A new document: the old snapshot's refs point at nodes that are gone.
          s.loaderId = params.frame.loaderId;
          s.snapshot = null;
          s.chooser = null;
          s.pillRect = null;
        }
        s.navSeq++;
      }
      return;
    case 'Page.navigatedWithinDocument':
      if (params.frameId === s.mainFrameId) s.navSeq++;
      return;
    case 'Page.downloadWillBegin':
      handlers.downloadStart(s.tabId, params);
      return;
    case 'Page.fileChooserOpened':
      s.chooser = { backendNodeId: params.backendNodeId, mode: params.mode, at: Date.now() };
      return;
    case 'Runtime.bindingCalled':
      if (params.name === MARKER_BINDING) handlers.markerStop(s.tabId, params.payload);
      return;
    default:
      if (!s.console.handle(method, params)) s.network.handle(method, params);
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  // A browser may report the detach by the tab's old ID.
  const s = sessions.get(tabId) ?? [...sessions.values()].find((x) => x.formerIds.has(tabId));
  if (s) {
    sessions.delete(s.tabId);
    clearTimeout(s.idleTimer);
    if (s.snapshot && reason !== 'canceled_by_user') orphanSnapshots.set(s.tabId, { snapshot: s.snapshot, at: Date.now() });
  }
  handlers.detached(s ? s.tabId : tabId, reason);
});
