/* global chrome, setTimeout, clearTimeout, setInterval */
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
  return sessions.get(tabId);
}

export function attachedTabs() {
  return [...sessions.keys()];
}

function attachError(tabId, message) {
  if (/another debugger/i.test(message)) {
    return new UserError(
      `Something else is already debugging tab ${tabId} (another extension, or remote debugging): Stem can't work in it until that lets go.`
    );
  }
  if (/cannot (access|attach)|chrome:\/\/|chrome-extension|webstore|not allowed/i.test(message)) {
    return new UserError(`The browser does not let extensions control tab ${tabId} (${message}).`);
  }
  if (/no tab with/i.test(message)) return new UserError(`Tab ${tabId} is not open any more: use \`tabs\`.`);
  return new UserError(`Stem could not start working in tab ${tabId}: ${message}`);
}

/** The tab's session, attaching first if needed. Concurrent callers share one attach. */
export function attach(tabId) {
  const existing = sessions.get(tabId);
  if (existing) return Promise.resolve(existing);
  if (attaching.has(tabId)) return attaching.get(tabId);
  const p = doAttach(tabId).finally(() => attaching.delete(tabId));
  attaching.set(tabId, p);
  return p;
}

async function doAttach(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    throw attachError(tabId, cdpMessage(err));
  }
  const s = new Session(tabId);
  sessions.set(tabId, s);
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
    await installMarkerHooks((m, p) => s.send(m, p));
    await ping(s);
  } catch (err) {
    sessions.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    throw err instanceof UserError ? err : attachError(tabId, err.message);
  }
  touchIdle(s);
  return s;
}

/** Take the marker down and let go of the tab. Safe to call for a tab Stem is not in. */
export async function detach(tabId) {
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
  const s = sessions.get(tabId);
  if (s) {
    sessions.delete(tabId);
    clearTimeout(s.idleTimer);
  }
  handlers.detached(tabId, reason);
});
