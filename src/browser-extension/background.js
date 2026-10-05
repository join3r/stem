/* global chrome, navigator, setTimeout, clearTimeout */
import { initActions, notifyStopped, perform } from './actions.js';
import * as cdp from './cdp.js';
import { noteDownloadStart, trackDownloads } from './downloads.js';
import { Runs } from './runs.js';
import { capText, clip, UserError } from './util.js';

// The extension's service worker: the native-messaging link to Stem, request
// dispatch, run lifecycle and Stop.
//
// The wire is src/shared/browser-native.ts; this file is plain JS and cannot
// import it, so the constants below are kept in step by hand.
//
// An open native port keeps an MV3 worker alive, so while Stem's native host is
// running the worker stays up and keeps its in-memory state (runs, debugger
// sessions). When the port drops, every run is ended — nobody is left to send
// their `end` — and the worker reconnects with backoff, then every 30 s from a
// chrome.alarms tick that also revives a worker Chrome has put to sleep.

const PROTOCOL = 1;
const NATIVE_HOST = 'com.stem.browser';
const RECONNECT_STEPS_MS = [1_000, 2_000, 5_000];
const ALARM = 'stem-reconnect';
/** A run nobody has used for this long is dropped (its turn ended without an `end`). */
const RUN_IDLE_MS = 30 * 60_000;

const runs = new Runs();
initActions(runs);
trackDownloads(runs);

let port = null;
let attempt = 0;
let reconnectTimer = null;
let hostConnected = null;
let lastError = '';

// ---- native port ----

function post(message) {
  if (!port) return false;
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function connect() {
  if (port) return;
  clearTimeout(reconnectTimer);
  let p;
  try {
    p = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    lastError = String((e && e.message) || e);
    scheduleReconnect();
    return;
  }
  port = p;
  p.onMessage.addListener((msg) => {
    attempt = 0;
    void onNativeMessage(msg);
  });
  p.onDisconnect.addListener(() => {
    lastError = (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'disconnected';
    if (port !== p) return;
    port = null;
    hostConnected = null;
    void endAllRuns();
    refreshBadge();
    scheduleReconnect();
  });
  post({
    type: 'hello',
    protocol: PROTOCOL,
    extensionId: chrome.runtime.id,
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent
  });
  refreshBadge();
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (attempt < RECONNECT_STEPS_MS.length) {
    reconnectTimer = setTimeout(connect, RECONNECT_STEPS_MS[attempt++]);
  }
  // Past the quick steps, the 30-second alarm keeps trying.
}

// ---- requests ----

/** Any error → a sentence the model can act on. */
function errorSentence(err, action) {
  if (err instanceof UserError) return err.message;
  const msg = String((err && err.message) || err || 'unknown error');
  if (/no node with given id|could not find node|node is detached|node with given id does not belong/i.test(msg)) {
    return 'That element is gone from the page (it changed): take a new snapshot.';
  }
  if (/context with specified id|execution context was destroyed|inspected target navigated|cannot find default execution context/i.test(msg)) {
    return 'The page navigated away while Stem was acting: take a new snapshot.';
  }
  if (/debugger is not attached|detached while handling|target closed|no tab with id/i.test(msg)) {
    return 'Stem lost the tab (it closed, crashed, or the user stopped Stem from debugging it). Use `tabs` to see what is open.';
  }
  const method = err && err.method ? ` (${err.method})` : '';
  return `The browser could not do \`${action && action.kind ? action.kind : 'that'}\`${method}: ${clip(msg, 300)}`;
}

async function handleRequest(msg) {
  const { id, threadId, action } = msg;
  let result;
  try {
    if (typeof threadId !== 'string' || !threadId) result = { ok: false, error: 'The request had no threadId.' };
    else result = await perform(threadId, action);
  } catch (err) {
    result = { ok: false, error: errorSentence(err, action) };
  }
  if (result.ok) {
    // Finished downloads ride on the run's next successful result, once each.
    const done = runs.takeFinished(threadId);
    if (done.length) result.downloads = done;
    if (typeof result.text === 'string') result.text = capText(result.text);
  }
  refreshBadge();
  post({ type: 'result', id, result });
}

async function onNativeMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'request':
      return handleRequest(msg);
    case 'end':
      if (typeof msg.threadId === 'string') await endRun(msg.threadId);
      return;
    case 'reload':
      await endAllRuns();
      chrome.runtime.reload();
      return;
    case 'host':
      hostConnected = !!msg.connected;
      refreshBadge();
      return;
    default:
  }
}

// ---- runs, Stop ----

/** Detach from the tabs `run` touched that no other live run still holds. */
async function releaseTabs(run) {
  const tabs = [...run.touched.keys()];
  await Promise.all(tabs.filter((t) => !runs.tabHeldByOthers(t, run.threadId)).map((t) => cdp.detach(t)));
}

async function endRun(threadId) {
  const run = runs.get(threadId);
  if (!run) return;
  runs.end(threadId);
  await releaseTabs(run);
  refreshBadge();
}

async function endAllRuns() {
  const all = runs.live();
  for (const r of all) {
    notifyStopped(r.threadId);
    runs.end(r.threadId);
  }
  await Promise.all(cdp.attachedTabs().map((t) => cdp.detach(t)));
  refreshBadge();
}

/**
 * The user pressed Stop (marker, popup, or the debugging bar): the runs stop
 * for good this turn. In-flight actions answer `stopped` at once, later ones
 * are refused, and Stem lets go of their tabs. The bookkeeping stays until the
 * desktop's `end`, so a late request still hears that the user stopped it.
 */
async function stopRuns(threadIds) {
  const stopping = [];
  for (const threadId of threadIds) {
    const run = runs.get(threadId);
    if (!run || run.stopped) continue;
    run.stopped = true;
    stopping.push(run);
    notifyStopped(threadId);
    post({ type: 'stopped', threadId });
  }
  for (const run of stopping) await releaseTabs(run);
  refreshBadge();
}

cdp.onMarkerStop((tabId) => {
  void stopRuns(runs.usingTab(tabId));
});

// Only a download that starts in a tab a run is working in is that run's.
cdp.onDownloadStart((tabId, params) => {
  noteDownloadStart(runs.ownerOfTab(tabId), params);
});

cdp.onDetached((tabId, reason) => {
  // Chrome's "Stem started debugging this browser" bar: Cancel detaches every
  // tab at once. That is the user saying stop.
  if (reason === 'canceled_by_user') void stopRuns(runs.usingTab(tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  runs.forgetTab(tabId);
  refreshBadge();
});

chrome.tabs.onReplaced.addListener((added, removed) => {
  runs.replaceTab(removed, added);
});

// ---- popup, badge ----

function liveRuns() {
  return runs.live().filter((r) => !r.stopped);
}

function refreshBadge() {
  const n = liveRuns().length;
  chrome.action.setBadgeText({ text: n ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#9a6230' }).catch(() => {});
  const status = !port ? 'not connected to Stem' : hostConnected === false ? 'Stem app not running' : 'connected to Stem';
  chrome.action.setTitle({ title: n ? `Stem — working (${n})` : `Stem — ${status}` }).catch(() => {});
}

async function popupState() {
  const list = [];
  for (const r of liveRuns()) {
    const tabs = [];
    for (const tabId of r.touched.keys()) {
      try {
        const t = await chrome.tabs.get(tabId);
        tabs.push({ id: tabId, title: clip(t.title || t.url || `Tab ${tabId}`, 80) });
      } catch {
        // Closed since; the onRemoved bookkeeping will catch up.
      }
    }
    list.push({ tabs });
  }
  return {
    port: !!port,
    host: hostConnected,
    lastError: port ? '' : lastError,
    runs: list,
    version: chrome.runtime.getManifest().version
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return false;
  if (msg.type === 'stem:state') {
    void popupState().then(sendResponse);
    return true;
  }
  if (msg.type === 'stem:stop-all') {
    void stopRuns(liveRuns().map((r) => r.threadId))
      .then(() => Promise.all(cdp.attachedTabs().map((t) => cdp.detach(t))))
      .then(() => popupState())
      .then(sendResponse);
    return true;
  }
  if (msg.type === 'stem:reconnect') {
    attempt = 0;
    connect();
    void popupState().then(sendResponse);
    return true;
  }
  return false;
});

// ---- startup ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  if (!port) connect();
  const now = Date.now();
  for (const r of runs.live()) {
    if (now - r.lastActionAt > RUN_IDLE_MS) void endRun(r.threadId);
  }
});

function start() {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }).catch(() => {});
  connect();
}

chrome.runtime.onStartup.addListener(start);
chrome.runtime.onInstalled.addListener(start);
start();
