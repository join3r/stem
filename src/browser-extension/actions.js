/* global chrome, navigator, setTimeout, clearTimeout */
import * as cdp from './cdp.js';
import { waitForDownload } from './downloads.js';
import { keyPresses, MODIFIER_BITS } from './keys.js';
import { formatConsole, formatNetworkDetail, formatNetworkList } from './logs.js';
import * as page from './page.js';
import { buildOutline } from './snapshot.js';
import { capText, clip, formatBytes, jpegSize, normalizeUrl, restrictedReason, sleep, tabLine, UserError } from './util.js';

// One browser action for one run → an ExtensionResult (src/shared/browser-native.ts).
// The result text is what the model reads, so every sentence here is written
// for it: what happened, in which tab, and what to do next when it failed.
//
// Product rules that live here, by the user's choice (2026-10-05): any ordinary
// tab may be driven (no grants, no origin gates); pages Stem opens are
// background tabs and the user's view never switches; a run may close only
// tabs it opened; file: pages are never opened or read.

const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent || '');

export const STOPPED_ERROR =
  'The user pressed Stop in the browser. Stop using the browser for this turn and tell the user what you did and what is left.';

let runs = null;
const stopWaiters = new Map();

export function initActions(r) {
  runs = r;
}

/** The user stopped this run: wake its in-flight action so it answers at once. */
export function notifyStopped(threadId) {
  for (const fn of [...(stopWaiters.get(threadId) || [])]) fn();
}

function onStop(threadId, fn) {
  let set = stopWaiters.get(threadId);
  if (!set) stopWaiters.set(threadId, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) stopWaiters.delete(threadId);
  };
}

// ---- shared plumbing ----

function deadlineFor(action) {
  switch (action.kind) {
    case 'wait':
      return Math.min(Number(action.ms) || 15_000, 60_000) + 10_000;
    case 'downloads':
      return 95_000;
    case 'open':
    case 'navigate':
      return 45_000;
    default:
      return 30_000;
  }
}

/**
 * Settle on whichever comes first: the action, a JavaScript dialog opening (a
 * dialog blocks every page call until answered, so waiting would hang the
 * tab's queue — and the `dialog` action meant to answer it sits behind that
 * queue), the user pressing Stop, or the deadline.
 */
function race(promise, { s, threadId, ms, kind, watchDialog }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanups = [];
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      fn(v);
    };
    if (watchDialog && s) cleanups.push(s.onDialog((d) => finish(resolve, { dialog: d })));
    cleanups.push(onStop(threadId, () => finish(resolve, { stopped: true })));
    const timer = setTimeout(
      () => finish(reject, new UserError(`The browser did not finish \`${kind}\` within ${Math.round(ms / 1000)} s: the page may be busy or stuck.`)),
      ms
    );
    cleanups.push(() => clearTimeout(timer));
    promise.then(
      (v) => finish(resolve, { value: v }),
      (e) => finish(reject, e)
    );
  });
}

function dialogText(d) {
  return `${d.type} "${clip(d.message, 300)}"`;
}

async function getTab(tabId) {
  return chrome.tabs.get(tabId);
}

async function targetTab(run, action) {
  const explicit = Number.isInteger(action.tab);
  const id = explicit ? action.tab : run.current;
  if (id === null || id === undefined) throw new UserError('No current tab: `open` a page or pick one from `tabs`.');
  try {
    return await getTab(id);
  } catch {
    if (!explicit) run.current = null;
    throw new UserError(
      explicit
        ? `There is no tab ${id}: use \`tabs\` to see the open ones.`
        : `Your current tab (${id}) was closed: \`open\` a page or pick one from \`tabs\`.`
    );
  }
}

function refuseRestricted(tab) {
  if (tab.incognito) throw new UserError(`Tab ${tab.id} is in a private window: Stem does not work there.`);
  // A pending navigation counts too: a tab on its way to a file: page is one.
  const why = restrictedReason(tab.url) || (tab.pendingUrl ? restrictedReason(tab.pendingUrl) : null);
  if (why) throw new UserError(`Stem can't work in tab ${tab.id}: ${why}.`);
}

async function activeTabsByWindow() {
  try {
    const tabs = await chrome.tabs.query({ active: true });
    return new Map(tabs.map((t) => [t.windowId, t.id]));
  } catch {
    return new Map();
  }
}

// A click on a target=_blank link or a window.open() makes Chrome open the new
// tab in FRONT, even from a background tab, which would switch the user's view.
// The new tab is the run's (it may close it); the tab the user had in front
// comes straight back. webNavigation names the tab the navigation came from;
// tabs.onCreated's openerTabId does not (on Chrome 149 it named the user's
// active tab, not the background tab that was clicked).
chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
  const s = cdp.session(details.sourceTabId);
  if (!s || !s.lastThreadId || !(s.busy > 0 || Date.now() - s.lastActionEnd < 3_000)) return;
  if (runs) runs.opened(s.lastThreadId, details.tabId);
  s.spawned = [...(s.spawned || []), details.tabId];
  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  if (tab && tab.active && s.activeBefore) {
    const prev = s.activeBefore.get(tab.windowId);
    if (prev !== undefined && prev !== tab.id) chrome.tabs.update(prev, { active: true }).catch(() => {});
  }
});

const fnCall = (fn, ...args) => `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')})`;

function exceptionText(details) {
  const ex = details.exception;
  return clip((ex && (ex.description || ex.value)) || details.text || 'unknown error', 2000);
}

async function evalMain(s, expression) {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(exceptionText(r.exceptionDetails));
  return r.result.value;
}

async function callOn(s, objectId, fn, args = [], byValue = true) {
  const r = await s.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn.toString(),
    arguments: args.map((value) => ({ value })),
    returnByValue: byValue,
    awaitPromise: true
  });
  if (r.exceptionDetails) throw new Error(exceptionText(r.exceptionDetails));
  return byValue ? r.result.value : r.result;
}

const staleRef = (ref) => new UserError(`Ref ${ref} is stale: take a new snapshot.`);

function resolveRef(s, rawRef) {
  const ref = String(rawRef || '')
    .trim()
    .replace(/^\[?(ref=)?/i, '')
    .replace(/\]$/, '');
  if (!s.snapshot || s.snapshot.loaderId !== s.loaderId) throw staleRef(ref);
  const hit = s.snapshot.refs.get(ref);
  if (!hit) throw staleRef(ref);
  return { ...hit, ref };
}

async function objectFor(s, r) {
  try {
    const { object } = await s.send('DOM.resolveNode', { backendNodeId: r.backendNodeId });
    return object.objectId;
  } catch {
    throw staleRef(r.ref);
  }
}

function label(r) {
  return `${r.role}${r.name ? ` "${clip(r.name, 80)}"` : ''} (${r.ref})`;
}

async function viewport(s) {
  const m = await s.send('Page.getLayoutMetrics');
  return { vw: m.cssVisualViewport.clientWidth, vh: m.cssVisualViewport.clientHeight, metrics: m };
}

/** Scroll the ref's element into view and return the middle of its visible box. */
async function pointFor(s, r) {
  try {
    await s.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: r.backendNodeId });
  } catch (e) {
    // "No layout object" and the like fall through to the box check below.
    if (/no node|not found|detached/i.test(e.message)) throw staleRef(r.ref);
  }
  let quads = [];
  try {
    ({ quads } = await s.send('DOM.getContentQuads', { backendNodeId: r.backendNodeId }));
  } catch (e) {
    if (/no node|not found|detached/i.test(e.message)) throw staleRef(r.ref);
  }
  const { vw, vh } = await viewport(s);
  for (const q of quads || []) {
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const left = Math.max(0, Math.min(...xs));
    const right = Math.min(vw, Math.max(...xs));
    const top = Math.max(0, Math.min(...ys));
    const bottom = Math.min(vh, Math.max(...ys));
    if (right - left >= 1 && bottom - top >= 1) return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
  }
  throw new UserError(
    `${label(r)} has no visible box on the page (hidden, collapsed or zero-size): take a new snapshot, or click a coordinate from a screenshot.`
  );
}

/** Whether (x, y) is on or near the marker's pill — Stem's own clicks must pass through it. */
function overPill(s, x, y) {
  const p = s.pillRect;
  if (!p) return true;
  const m = 8;
  return x >= p.x - m && x <= p.x + p.w + m && y >= p.y - m && y <= p.y + p.h + m;
}

async function mouseClick(s, x, y, { button = 'left', count = 1 } = {}) {
  const pass = overPill(s, x, y);
  if (pass) await cdp.marker(s, 'passthrough(true)');
  if (button === 'right') await cdp.marker(s, 'armContextMenu(true)');
  try {
    // Not awaited: a mouse move is delivered with the page's next frame, and
    // while the browser isn't drawing (display asleep, screen locked) it acks
    // late or never. The press right behind it flushes it first, so order holds.
    const moved = s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }).catch(() => {});
    const mask = { left: 1, right: 2, middle: 4 }[button] || 1;
    for (let i = 1; i <= count; i++) {
      await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: mask, clickCount: i });
      await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i });
    }
    await Promise.race([moved, sleep(500)]);
  } finally {
    if (button === 'right') void cdp.marker(s, 'armContextMenu(false)');
    if (pass) void cdp.marker(s, 'passthrough(false)');
  }
}

async function pressKeys(s, spec) {
  const parsed = keyPresses(spec, { mac: IS_MAC });
  if (parsed.error) throw new UserError(parsed.error);
  for (const ev of parsed.events) await s.send('Input.dispatchKeyEvent', ev);
  return parsed;
}

/** Poll until the tab has navigated (when required) and finished loading. */
async function waitForLoad(ctx, sinceSeq, ms, requireNav) {
  const deadline = Date.now() + ms;
  let navigated = !requireNav;
  for (;;) {
    if (ctx.s && ctx.s.navSeq > sinceSeq) navigated = true;
    const t = await getTab(ctx.tabId).catch(() => null);
    if (!t) return { done: true, url: '', gone: true };
    if (navigated && t.status === 'complete') return { done: true, url: t.url };
    if (Date.now() >= deadline) return { done: false, url: t.url };
    await sleep(100);
  }
}

/**
 * After an input action: give the page a moment, and if that started a
 * navigation, wait (bounded) for it to load so the next snapshot sees it.
 */
async function settle(ctx, sinceSeq, ms = 10_000, pause = 300) {
  await sleep(pause);
  const t = await getTab(ctx.tabId).catch(() => null);
  if (!t) return { url: '', loading: false };
  if (ctx.s.navSeq !== sinceSeq || t.status === 'loading') {
    const r = await waitForLoad(ctx, sinceSeq, ms, false);
    return { url: r.url, loading: !r.done };
  }
  return { url: t.url, loading: false };
}

function navNote(before, nav) {
  if (!nav.url || nav.url === before) return '';
  return ` The tab went to ${clip(nav.url, 300)}${nav.loading ? ' (still loading)' : ''}.`;
}

// ---- tab actions ----

const TAB_ACTIONS = {
  navigate: { fn: navigate },
  snapshot: { fn: snapshot },
  screenshot: { fn: screenshot },
  click: { fn: click },
  hover: { fn: hover },
  type: { fn: typeText },
  fill: { fn: fill },
  press: { fn: press },
  scroll: { fn: scroll },
  wait: { fn: waitFor },
  dialog: { fn: dialog, dialogOk: true },
  evaluate: { fn: evaluate },
  console: { fn: consoleLog, dialogOk: true },
  network: { fn: network, dialogOk: true },
  upload: { fn: upload }
};

async function navigate(ctx, a) {
  const { s } = ctx;
  const seq = s.navSeq;
  let verb;
  if (a.url) {
    const n = normalizeUrl(a.url);
    if (n.error) throw new UserError(n.error);
    ctx.note = `Went to ${clip(n.url, 300)}.`;
    const r = await s.send('Page.navigate', { url: n.url });
    if (r.isDownload) return { text: 'That address is a download, not a page: the browser is saving it (see `downloads`).' };
    if (r.errorText) throw new UserError(`The page did not load: ${r.errorText}. Check the address.`);
    verb = 'Loaded the page';
  } else if (a.to === 'reload') {
    ctx.note = 'Reloaded the page.';
    await s.send('Page.reload', {});
    verb = 'Reloaded the page';
  } else if (a.to === 'back' || a.to === 'forward') {
    const h = await s.send('Page.getNavigationHistory');
    const i = h.currentIndex + (a.to === 'back' ? -1 : 1);
    if (i < 0 || i >= h.entries.length) {
      throw new UserError(a.to === 'back' ? 'There is no earlier page in this tab to go back to.' : 'There is no later page in this tab to go forward to.');
    }
    ctx.note = `Went ${a.to}.`;
    await s.send('Page.navigateToHistoryEntry', { entryId: h.entries[i].id });
    verb = `Went ${a.to}`;
  } else {
    throw new UserError('navigate needs `url`, or `to`: back | forward | reload.');
  }
  const load = await waitForLoad(ctx, seq, 20_000, true);
  return { text: `${verb}${load.done ? '' : ' (still loading after 20 s: `wait` for what you need)'}.` };
}

async function frameOutlines(s, frameTree) {
  const frames = [];
  const walk = async (ft) => {
    for (const child of ft.childFrames || []) {
      if (frames.length >= 10) return;
      try {
        const [{ nodes }, owner] = await Promise.all([
          s.send('Accessibility.getFullAXTree', { frameId: child.frame.id }),
          s.send('DOM.getFrameOwner', { frameId: child.frame.id })
        ]);
        frames.push({ ownerBackendNodeId: owner.backendNodeId, nodes });
        await walk(child);
      } catch {
        // A cross-origin frame lives in another renderer this session can't
        // read; buildOutline marks its <iframe> as not included.
      }
    }
  };
  await walk(frameTree);
  return frames;
}

async function snapshot(ctx) {
  const { s } = ctx;
  const loaderId = s.loaderId;
  const [{ nodes }, { frameTree }] = await Promise.all([s.send('Accessibility.getFullAXTree', {}), s.send('Page.getFrameTree')]);
  const frames = await frameOutlines(s, frameTree);
  const tab = await getTab(ctx.tabId);
  const outline = buildOutline(nodes, { frames, pageUrl: tab.url });
  s.snapshot = { loaderId, refs: outline.refs, at: Date.now() };
  const notes = [];
  if (outline.truncated) {
    notes.push('(Outline cut at 40000 characters: the page has more. Read a specific part with `evaluate`, or `scroll` + `screenshot`.)');
  }
  if (outline.iframes.missing) {
    notes.push(
      `(${outline.iframes.missing} embedded frame${outline.iframes.missing === 1 ? '' : 's'} from other sites ${outline.iframes.missing === 1 ? 'is' : 'are'} not included: what is inside only shows in a screenshot.)`
    );
  }
  const body =
    outline.text ||
    '(Nothing readable on the page yet. If it is still loading, `wait` and snapshot again; if it draws into a canvas, use `screenshot`.)';
  return { text: [body, ...notes].join('\n') };
}

async function screenshot(ctx, a) {
  const { s } = ctx;
  const { vw, vh, metrics } = await viewport(s);
  const vv = metrics.cssVisualViewport;
  const contentH = Math.ceil(metrics.cssContentSize.height);
  const dpr = (await evalMain(s, 'window.devicePixelRatio').catch(() => 1)) || 1;
  const params = { format: 'jpeg', quality: 70 };
  let cut = false;
  if (a.fullPage) {
    const h = Math.max(1, Math.min(contentH, Math.ceil(vh * 4)));
    cut = contentH > h;
    params.captureBeyondViewport = true;
    params.clip = { x: 0, y: 0, width: vw, height: h, scale: 1 / dpr };
  } else {
    params.clip = { x: vv.pageX, y: vv.pageY, width: vw, height: vh, scale: 1 / dpr };
  }
  // The marker is for the user, not the model: keep it out of the picture.
  await cdp.marker(s, 'hide()');
  let shot;
  try {
    // Chrome only captures what it draws, and it stops drawing every tab while
    // the Mac's display sleeps or the screen is locked (measured on 149: no
    // capture of any tab, the user's active one included). Say so rather than hang.
    shot = await Promise.race([s.send('Page.captureScreenshot', params), sleep(10_000).then(() => null)]);
  } finally {
    await cdp.marker(s, 'show()');
  }
  if (!shot) {
    throw new UserError(
      "The browser isn't drawing right now — the Mac's display is probably asleep or the screen locked — so there is no picture to take. `snapshot`, clicks and typing still work."
    );
  }
  const size = jpegSize(shot.data) || { width: Math.round(params.clip.width), height: Math.round(params.clip.height) };
  let text = a.fullPage
    ? `Full-page screenshot, ${size.width}×${size.height}${cut ? ` (the top ${params.clip.height} px of a ${contentH} px page)` : ''}. Its coordinates are page coordinates; \`coordinate\` clicks use the visible part of the page, so scroll first or use a ref.`
    : `Screenshot of the visible part of the page, ${size.width}×${size.height}; coordinates are CSS pixels of this picture.`;
  if (!a.fullPage && (Math.abs(size.width - vw) > 2 || Math.abs(size.height - vh) > 2)) {
    text += ` (The view is ${Math.round(vw)}×${Math.round(vh)} CSS pixels, probably because of browser zoom: multiply picture coordinates by ${(vw / size.width).toFixed(3)} before clicking.)`;
  }
  return { text, screenshot: { jpegBase64: shot.data, width: size.width, height: size.height } };
}

function pointFromAction(a) {
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || a.x < 0 || a.y < 0) {
    throw new UserError('Give `ref` (from the last snapshot) or `coordinate` [x, y].');
  }
  return { x: Math.round(a.x), y: Math.round(a.y) };
}

async function click(ctx, a) {
  const { s } = ctx;
  let point;
  let what;
  let cover = '';
  if (a.ref) {
    const r = resolveRef(s, a.ref);
    point = await pointFor(s, r);
    what = label(r);
    const obj = await objectFor(s, r);
    const hit = await callOn(s, obj, page.hitCheck, [point.x, point.y]).catch(() => 'ok');
    if (hit !== 'ok' && hit !== 'nothing') cover = ` Note: ${hit} was on top of it at that spot, so the click landed there instead.`;
  } else {
    point = pointFromAction(a);
    what = `the point (${point.x}, ${point.y})`;
  }
  const button = ['left', 'right', 'middle'].includes(a.button) ? a.button : 'left';
  const count = a.count === 2 ? 2 : 1;
  const before = ctx.tab.url;
  const seq = s.navSeq;
  const chooser = s.chooser;
  const verb = count === 2 ? 'Double-clicked' : button === 'right' ? 'Right-clicked' : button === 'middle' ? 'Middle-clicked' : 'Clicked';
  ctx.note = `${verb} ${what}.`;
  await mouseClick(s, point.x, point.y, { button, count });
  const nav = await settle(ctx, seq);
  let text = `${ctx.note}${cover}${navNote(before, nav)}`;
  if (button === 'right') text += ' (The browser’s own context menu is suppressed; a page’s custom menu still opens.)';
  if (s.chooser && s.chooser !== chooser) text += ' It opened a file chooser: answer it with `upload` (same ref, and the files).';
  return { text };
}

async function hover(ctx, a) {
  const { s } = ctx;
  let point;
  let what;
  if (a.ref) {
    const r = resolveRef(s, a.ref);
    point = await pointFor(s, r);
    what = label(r);
  } else {
    point = pointFromAction(a);
    what = `the point (${point.x}, ${point.y})`;
  }
  const pass = overPill(s, point.x, point.y);
  if (pass) await cdp.marker(s, 'passthrough(true)');
  let delivered;
  try {
    delivered = await Promise.race([
      s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }).then(() => true),
      sleep(3_000).then(() => false)
    ]);
  } finally {
    if (pass) void cdp.marker(s, 'passthrough(false)');
  }
  await sleep(200);
  return {
    text: delivered
      ? `Moved the mouse over ${what}.`
      : `Moved the mouse over ${what}, but the browser isn't drawing right now (the Mac's display may be asleep or the screen locked), so hover effects only show once it draws again.`
  };
}

async function typeText(ctx, a) {
  const { s } = ctx;
  if (typeof a.text !== 'string' || !a.text) throw new UserError('type needs `text`.');
  let what = 'the focused element';
  let obj = null;
  let r = null;
  if (a.ref) {
    r = resolveRef(s, a.ref);
    await s.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: r.backendNodeId }).catch(() => {});
    try {
      await s.send('DOM.focus', { backendNodeId: r.backendNodeId });
    } catch (e) {
      if (/no node|not found/i.test(e.message)) throw staleRef(r.ref);
      throw new UserError(`${label(r)} can't take keyboard focus: pick the text field itself (or click it first).`);
    }
    what = label(r);
    obj = await objectFor(s, r);
    // DOM.focus leaves the caret at the start; typing goes after what is there.
    await callOn(s, obj, page.caretToEnd).catch(() => {});
  } else if (await evalMain(s, fnCall(page.nothingFocused)).catch(() => false)) {
    throw new UserError("Nothing in the page has focus, so the text would go nowhere: pass the field's `ref` from `snapshot`.");
  }
  const seq = s.navSeq;
  const before = ctx.tab.url;
  ctx.note = `Typed ${a.text.length} characters into ${what}.`;
  await s.send('Input.insertText', { text: a.text });
  let text = `Typed ${a.text.length} characters into ${what}`;
  if (a.submit) {
    ctx.note = `${text} and pressed Enter.`;
    await pressKeys(s, 'Enter');
    const nav = await settle(ctx, seq);
    text += ` and pressed Enter.${navNote(before, nav)}`;
  } else {
    text += '.';
  }
  if (obj && !a.submit) {
    const info = await callOn(s, obj, page.describeElement).catch(() => null);
    if (info && info.type !== 'password') {
      const now = await callOn(s, obj, page.readValue).catch(() => null);
      if (typeof now === 'string') text += ` It now reads: "${clip(now, 300)}".`;
    }
  }
  return { text };
}

const TRUE_WORDS = new Set(['true', 'yes', 'on', 'checked', '1', 'check']);
const FALSE_WORDS = new Set(['false', 'no', 'off', 'unchecked', '0', 'uncheck']);

async function fill(ctx, a) {
  const { s } = ctx;
  if (typeof a.value !== 'string') throw new UserError('fill needs `value` (for a checkbox: "true" or "false").');
  const r = resolveRef(s, a.ref);
  const obj = await objectFor(s, r);
  const info = await callOn(s, obj, page.describeElement);
  const what = label(r);
  if (info.disabled) throw new UserError(`${what} is disabled: the page won't take a value there yet.`);

  if (info.tag === 'select') {
    const res = await callOn(s, obj, page.selectOption, [a.value]);
    if (res.disabled) throw new UserError(`The option "${res.disabled}" in ${what} is disabled.`);
    if (!res.ok) {
      throw new UserError(
        `${what} has no option "${clip(a.value, 80)}". Its options: ${res.options.map((o) => `"${clip(o, 60)}"`).join(', ')}${res.total > res.options.length ? `, … (${res.total} in all)` : ''}.`
      );
    }
    return { text: `Selected "${res.chosen}" in ${what}.` };
  }

  const toggle =
    (info.tag === 'input' && (info.type === 'checkbox' || info.type === 'radio')) ||
    (info.tag !== 'input' && ['checkbox', 'switch', 'radio', 'menuitemcheckbox'].includes(info.role) && info.ariaChecked !== null);
  if (toggle) {
    const v = a.value.trim().toLowerCase();
    if (!TRUE_WORDS.has(v) && !FALSE_WORDS.has(v)) throw new UserError(`${what} is a checkbox: fill it with "true" or "false".`);
    const want = TRUE_WORDS.has(v);
    const now = info.checked !== null ? info.checked : info.ariaChecked === 'true';
    if (now === want) return { text: `${what} was already ${want ? 'checked' : 'unchecked'}.` };
    if (!want && info.type === 'radio') throw new UserError(`${what} is a radio button: uncheck it by choosing another option in its group.`);
    try {
      const p = await pointFor(s, r);
      await mouseClick(s, p.x, p.y);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      // Styled checkboxes often hide the real input (zero size, opacity 0):
      // there is nothing to put the mouse on, but the element can still be clicked.
      await callOn(s, obj, function () {
        this.click();
        return true;
      });
    }
    const after = await callOn(s, obj, page.readValue);
    return { text: `${after === (want ? 'checked' : 'unchecked') ? (want ? 'Checked' : 'Unchecked') : 'Clicked'} ${what}; it is now ${after}.` };
  }

  const NOT_TEXT = { file: 'a file input: use `upload`', button: 'a button: use `click`', submit: 'a button: use `click`', reset: 'a button: use `click`', image: 'a button: use `click`', hidden: 'a hidden input the page manages itself' };
  if (info.tag === 'input' && NOT_TEXT[info.type]) throw new UserError(`${what} is ${NOT_TEXT[info.type]}.`);
  const textual = info.tag === 'input' || info.tag === 'textarea' || info.editable;
  if (!textual) throw new UserError(`${what} is not a field \`fill\` can set: use \`click\`, or \`type\` after focusing it.`);
  if (info.readOnly) throw new UserError(`${what} is read-only.`);

  await s.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: r.backendNodeId }).catch(() => {});
  await s.send('DOM.focus', { backendNodeId: r.backendNodeId }).catch(() => {});
  await callOn(s, obj, page.selectAllIn);
  if (a.value === '') await pressKeys(s, 'Backspace');
  else await s.send('Input.insertText', { text: a.value });
  let now = await callOn(s, obj, page.readValue);
  if (!info.editable && now !== a.value) {
    // Date, time, color, range, number with a locale format…: typing does not
    // land as the plain value. Set it the way a framework would notice.
    now = await callOn(s, obj, page.setNativeValue, [a.value]);
  }
  if (info.type === 'password') return { text: `Filled the password field ${what} (${a.value.length} characters).` };
  const shown = clip(now, 300);
  const matches = info.editable ? now.trim() === a.value.trim() : now === a.value;
  return {
    text: matches
      ? `Set ${what} to "${shown}".`
      : `Typed into ${what}, but it now reads "${shown}" — the page reformatted or rejected part of "${clip(a.value, 120)}".`
  };
}

async function press(ctx, a) {
  const { s } = ctx;
  const seq = s.navSeq;
  const before = ctx.tab.url;
  ctx.note = `Pressed ${a.key}.`;
  const parsed = await pressKeys(s, a.key);
  const nav = await settle(ctx, seq, 10_000, 200);
  let text = `Pressed ${a.key}.${navNote(before, nav)}`;
  const chordBits = parsed.modifiers.reduce((acc, m) => acc | MODIFIER_BITS[m], 0);
  if (chordBits & (MODIFIER_BITS.Meta | MODIFIER_BITS.Control) && !parsed.commands.length) {
    text += ' Only the page saw it: browser shortcuts (new tab, close tab, address bar) do not run from here.';
  }
  return { text };
}

async function scroll(ctx, a) {
  const { s } = ctx;
  if (a.ref) {
    const r = resolveRef(s, a.ref);
    try {
      await s.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: r.backendNodeId });
    } catch {
      throw staleRef(r.ref);
    }
    const obj = await objectFor(s, r);
    const box = await callOn(s, obj, page.viewportBox);
    return { text: `Scrolled ${label(r)} into view: its top is ${box.top} px from the top of the ${box.vh} px high view.` };
  }
  const { vw, vh } = await viewport(s);
  const dir = ['up', 'down', 'left', 'right'].includes(a.dir) ? a.dir : 'down';
  const vertical = dir === 'up' || dir === 'down';
  const amount = Number.isFinite(a.amount) && a.amount > 0 ? Math.round(a.amount) : Math.round((vertical ? vh : vw) * 0.8);
  const cx = Math.round(vw / 2);
  const cy = Math.round(vh / 2);
  const before = await evalMain(s, fnCall(page.scrollState, cx, cy));
  const sign = dir === 'up' || dir === 'left' ? -1 : 1;
  const dx = vertical ? 0 : sign * amount;
  const dy = vertical ? sign * amount : 0;
  const wheeled = await Promise.race([
    s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: dx, deltaY: dy }).then(() => true),
    sleep(2_000).then(() => false)
  ]);
  let scripted = false;
  if (wheeled) {
    // Wheel scrolling animates; let it land before reading where it ended up.
    await sleep(450);
  } else {
    // The wheel waits on the compositor, which is idle while the browser isn't
    // drawing (display asleep, screen locked). Scroll by script instead.
    scripted = true;
    await evalMain(s, fnCall(page.scrollByScript, cx, cy, dx, dy));
  }
  const after = await evalMain(s, fnCall(page.scrollState, cx, cy));
  const how = scripted ? " (by script: the browser isn't drawing right now, so the mouse wheel stalled)" : '';
  const axis = vertical ? 'y' : 'x';
  if (before.inner && after.inner && before.inner.desc === after.inner.desc) {
    const k = vertical ? 'top' : 'left';
    const max = vertical ? after.inner.maxTop : after.inner.maxLeft;
    if (after.inner[k] !== before.inner[k]) {
      return { text: `Scrolled the scrolling panel under the middle of the view (${after.inner.desc}) ${dir}${how}: it is now at ${axis}=${after.inner[k]} of ${max}.` };
    }
  }
  const pos = after[axis];
  const max = vertical ? after.maxY : after.maxX;
  if (pos !== before[axis]) {
    return { text: `Scrolled the page ${dir}${how}: it is now at ${axis}=${pos} of ${max} (the view is ${vertical ? after.vh : after.vw} px ${vertical ? 'high' : 'wide'}).` };
  }
  return {
    text: `Nothing scrolled: the page is at ${axis}=${pos} of ${max}${(sign > 0 ? pos >= max : pos <= 0) ? `, already at the ${vertical ? (sign > 0 ? 'bottom' : 'top') : sign > 0 ? 'right edge' : 'left edge'}` : ''}, and what is under the middle of the view does not scroll that way. Scroll a \`ref\` into view instead.`
  };
}

async function waitFor(ctx, a) {
  const { s } = ctx;
  const ms = Math.max(0, Math.min(Number.isFinite(a.ms) ? a.ms : 15_000, 60_000));
  if (!a.text && !a.url) {
    await sleep(ms);
    return { text: `Waited ${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s.` };
  }
  const want = a.text ? String(a.text).replace(/\s+/g, ' ').trim().toLowerCase() : '';
  const what = [a.text ? `the text "${clip(a.text, 100)}"` : '', a.url ? `a URL containing "${clip(a.url, 100)}"` : ''].filter(Boolean).join(' and ');
  const started = Date.now();
  const probe = `(() => { const b = document.body; return !!b && b.innerText.replace(/\\s+/g, ' ').toLowerCase().includes(${JSON.stringify(want)}); })()`;
  for (;;) {
    let url = '';
    let okUrl = true;
    let okText = true;
    if (a.url) {
      const t = await getTab(ctx.tabId);
      url = t.url;
      okUrl = t.url.includes(a.url);
    }
    if (want && okUrl) okText = await evalMain(s, probe).catch(() => false);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (okUrl && okText) return { text: `${what[0].toUpperCase()}${what.slice(1)} appeared after ${secs} s.` };
    if (Date.now() - started >= ms) {
      return { text: `${what[0].toUpperCase()}${what.slice(1)} did not appear within ${(ms / 1000).toFixed(0)} s.${a.url ? ` The tab is at ${clip(url, 300)}.` : ''}` };
    }
    await sleep(250);
  }
}

async function dialog(ctx, a) {
  const { s } = ctx;
  const d = s.dialog;
  if (!d) throw new UserError('No dialog is open in this tab.');
  const params = { accept: !!a.accept };
  if (d.type === 'prompt' && typeof a.text === 'string') params.promptText = a.text;
  const seq = s.navSeq;
  const before = ctx.tab.url;
  await s.send('Page.handleJavaScriptDialog', params);
  s.dialog = null;
  const nav = await settle(ctx, seq);
  const answered = params.promptText !== undefined && a.accept ? ` with "${clip(params.promptText, 100)}"` : '';
  return { text: `${a.accept ? 'Accepted' : 'Dismissed'} the ${dialogText(d)}${answered}.${navNote(before, nav)}` };
}

function formatValue(result) {
  if (!result || result.type === 'undefined') return 'undefined';
  if (result.unserializableValue) return result.unserializableValue;
  if ('value' in result) {
    try {
      const json = JSON.stringify(result.value, null, 2);
      return json === undefined ? String(result.value) : json;
    } catch {
      return String(result.value);
    }
  }
  return result.description || result.type;
}

async function evaluate(ctx, a) {
  const { s } = ctx;
  if (typeof a.script !== 'string' || !a.script.trim()) throw new UserError('evaluate needs `script`: a JavaScript expression.');
  ctx.note = 'The script started.';
  const base = { expression: a.script, awaitPromise: true, userGesture: true, replMode: true, allowUnsafeEvalBlockedByCSP: true };
  let r;
  try {
    r = await s.send('Runtime.evaluate', { ...base, returnByValue: true });
  } catch (e) {
    if (!/by value|cloned|reference chain|serializ/i.test(e.message)) throw e;
    // A DOM node or a cyclic object can't come back as JSON: describe it.
    r = await s.send('Runtime.evaluate', { ...base, returnByValue: false });
  }
  if (r.exceptionDetails) throw new UserError(`The script threw: ${exceptionText(r.exceptionDetails)}`);
  return { text: formatValue(r.result) };
}

async function consoleLog(ctx, a) {
  const { s } = ctx;
  const entries = s.console.entries({ errorsOnly: !!a.errorsOnly });
  return { text: formatConsole(entries, { since: s.attachedAt, errorsOnly: !!a.errorsOnly }) };
}

async function network(ctx, a) {
  const { s } = ctx;
  if (!a.request) return { text: formatNetworkList(s.network.entries(a.filter), { since: s.attachedAt, filter: a.filter }) };
  const e = s.network.get(a.request);
  if (!e) throw new UserError(`There is no request "${clip(a.request, 40)}" in this tab's list: call \`network\` for the ids.`);
  let postData;
  if (e.hasPostData && !e.postData) {
    postData = await s
      .send('Network.getRequestPostData', { requestId: e.requestId })
      .then((r) => r.postData)
      .catch(() => undefined);
  }
  let body;
  let bodyError;
  if (e.failed) bodyError = 'none (the request failed).';
  else if (!e.done) bodyError = 'not available yet (still loading).';
  else if (e.bodyGone) bodyError = 'none (a redirect).';
  else {
    body = await s.send('Network.getResponseBody', { requestId: e.requestId }).catch((err) => {
      bodyError = `not available (${clip(err.message, 120)}).`;
      return undefined;
    });
  }
  return { text: formatNetworkDetail(e, { postData, body, bodyError }) };
}

async function upload(ctx, a) {
  const { s } = ctx;
  const paths = Array.isArray(a.paths) ? a.paths.filter((p) => typeof p === 'string' && p) : [];
  if (!paths.length) throw new UserError('upload needs files.');
  const r = resolveRef(s, a.ref);
  let target = null;
  let why = '';
  let via = '';
  const obj = await objectFor(s, r);
  try {
    const res = await callOn(s, obj, page.findFileInput, [], false);
    if (res.subtype === 'node') target = res.objectId;
    else why = res.value;
  } catch (e) {
    why = e.message;
  }
  if (!target && s.chooser && Date.now() - s.chooser.at < 5 * 60_000) {
    // A click already opened the page's file chooser (intercepted): answer that.
    const resolved = await s.send('DOM.resolveNode', { backendNodeId: s.chooser.backendNodeId }).catch(() => null);
    if (resolved) {
      target = resolved.object.objectId;
      via = ' that the page asked for';
    }
  }
  if (!target) throw new UserError(why || 'No file input found for that element.');
  const multiple = await callOn(s, target, page.isMultipleFileInput);
  if (paths.length > 1 && !multiple) {
    throw new UserError(`That file input takes one file and you gave ${paths.length}: upload them one at a time, or use a field that takes several.`);
  }
  await s.send('DOM.setFileInputFiles', { files: paths, objectId: target });
  s.chooser = null;
  const files = await callOn(s, target, page.fileSummary);
  const list = files.map((f) => `${f.name} (${formatBytes(f.size)})`).join(', ') || '(nothing)';
  return {
    text: `Attached ${list} to the file input${via} (from ${label(r)}). Many sites upload as soon as a file is chosen; if this one has a send or upload button, click it.`
  };
}

/** Run a tab-targeted action through the tab's queue, with the dialog/stop/deadline race. */
async function onTab(run, action) {
  const impl = TAB_ACTIONS[action.kind];
  const tab = await targetTab(run, action);
  refuseRestricted(tab);
  const others = runs.othersRecentlyIn(tab.id, run.threadId);
  return cdp.enqueue(tab.id, async () => {
    // Re-read: the tab may have navigated (or closed) while queued.
    const current = await getTab(tab.id).catch(() => null);
    if (!current) throw new UserError(`Tab ${tab.id} closed before Stem got to it.`);
    refuseRestricted(current);
    const s = await cdp.attach(tab.id);
    if (s.dialog && !impl.dialogOk) {
      throw new UserError(`A dialog is open in tab ${tab.id}: ${dialogText(s.dialog)}. Answer it with \`dialog\` (accept: true or false) first.`);
    }
    cdp.beginAction(s, run.threadId);
    s.activeBefore = await activeTabsByWindow();
    const spawnedBefore = (s.spawned || []).length;
    const ctx = { run, s, tab: current, tabId: tab.id, note: '' };
    let out;
    try {
      out = await race(impl.fn(ctx, action), {
        s,
        threadId: run.threadId,
        ms: deadlineFor(action),
        kind: action.kind,
        watchDialog: !impl.dialogOk
      });
    } finally {
      cdp.endAction(s);
    }
    runs.touch(run.threadId, tab.id);
    if (out.stopped) return { ok: false, stopped: true, error: STOPPED_ERROR };
    const after = await getTab(tab.id).catch(() => null);
    if (after && restrictedReason(after.url)) {
      await cdp.detach(tab.id);
      return {
        ok: false,
        error: `Stem let go of tab ${tab.id}: it now shows something Stem doesn't work in (${restrictedReason(after.url)}).`
      };
    }
    let text;
    if (out.dialog) {
      text = `${ctx.note ? `${ctx.note} ` : ''}The page opened a dialog: ${dialogText(out.dialog)}. Answer it with \`dialog\` (accept: true or false) before doing anything else in this tab.`;
    } else {
      text = out.value.text;
    }
    const spawned = (s.spawned || []).slice(spawnedBefore);
    for (const id of spawned) {
      const t = await getTab(id).catch(() => null);
      if (t) text += `\nIt opened tab ${id} in the background (yours to use or close): ${clip(t.pendingUrl || t.url, 300)}`;
    }
    const warn = others.length ? 'Note: another Stem run also worked in this tab in the last 2 minutes, so the page may have changed under you.\n' : '';
    const header = after ? tabLine(after) : `Tab ${tab.id}`;
    const result = { ok: true, text: capText(`${warn}${header}\n${text}`), tab: tab.id };
    if (out.value && out.value.screenshot) result.screenshot = out.value.screenshot;
    return result;
  });
}

// ---- run-level actions ----

async function listTabs(run) {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  let focusedId = null;
  try {
    focusedId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
  } catch {
    // No window has had focus yet (a browser started in the background).
  }
  const lines = [];
  let hidden = 0;
  let n = 0;
  let count = 0;
  for (const w of windows) {
    if (w.incognito) continue;
    n++;
    const tabLines = [];
    for (const t of w.tabs || []) {
      if (restrictedReason(t.url || t.pendingUrl)) {
        hidden++;
        continue;
      }
      const marks = [];
      if (t.active) marks.push('active');
      if (run.opened.has(t.id)) marks.push('yours');
      if (run.current === t.id) marks.push('your current tab');
      if (runs.othersRecentlyIn(t.id, run.threadId).length) marks.push('in use by another Stem run');
      if (t.status === 'loading') marks.push('loading');
      if (t.discarded) marks.push('asleep');
      tabLines.push(`- ${t.id} · ${clip(t.title || '(untitled)', 120)} — ${clip(t.url || t.pendingUrl, 300)}${marks.length ? ` (${marks.join(', ')})` : ''}`);
      count++;
    }
    lines.push(`Window ${n}${w.id === focusedId ? ' (last focused: new tabs open here)' : ''}${w.state === 'minimized' ? ' (minimized)' : ''}:`);
    lines.push(...(tabLines.length ? tabLines : ['- (no web pages)']));
  }
  const head =
    `${count} open tab${count === 1 ? '' : 's'}. "active" is the tab showing in its window — the user may be looking at it; the rest are in the background. ` +
    'Pass an id as `tab` to work in it.';
  const tail = hidden ? `\n(${hidden} browser page${hidden === 1 ? '' : 's'} and local files not listed: Stem doesn't work in them.)` : '';
  return { ok: true, text: capText(`${head}\n${lines.join('\n')}${tail}`) };
}

async function openTab(run, a) {
  const n = normalizeUrl(a.url);
  if (n.error) throw new UserError(n.error);
  let windowId;
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (w && !w.incognito) windowId = w.id;
  } catch {
    // Fall through to any normal window.
  }
  if (windowId === undefined) {
    const w = (await chrome.windows.getAll({ windowTypes: ['normal'] })).find((x) => !x.incognito);
    if (w) windowId = w.id;
  }
  let tab;
  // about:blank first, then attach, then load: console and network history
  // then cover the page's own load, which is when most errors happen.
  if (windowId === undefined) tab = (await chrome.windows.create({ url: 'about:blank', focused: false })).tabs[0];
  else tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: false });
  runs.opened(run.threadId, tab.id);
  runs.touch(run.threadId, tab.id);
  return cdp.enqueue(tab.id, async () => {
    const ctx = { run, s: null, tab, tabId: tab.id, note: `Opened tab ${tab.id} in the background.` };
    let s = null;
    try {
      s = await cdp.attach(tab.id);
    } catch {
      s = null;
    }
    ctx.s = s;
    const work = async () => {
      if (!s) {
        await chrome.tabs.update(tab.id, { url: n.url });
        return waitForLoad(ctx, 0, 20_000, false);
      }
      const seq = s.navSeq;
      const r = await s.send('Page.navigate', { url: n.url });
      if (r.isDownload) return { download: true };
      if (r.errorText) {
        throw new UserError(`Tab ${tab.id} opened but the page did not load: ${r.errorText}. Check the address; \`close\` the tab if you don't need it.`);
      }
      const load = await waitForLoad(ctx, seq, 20_000, true);
      // The about:blank step is ours, not the user's: keep it out of Back.
      await s.send('Page.resetNavigationHistory').catch(() => {});
      return load;
    };
    if (s) cdp.beginAction(s, run.threadId);
    let out;
    try {
      out = await race(work(), { s, threadId: run.threadId, ms: deadlineFor(a), kind: 'open', watchDialog: !!s });
    } finally {
      if (s) cdp.endAction(s);
    }
    if (out.stopped) return { ok: false, stopped: true, error: STOPPED_ERROR };
    const t = await getTab(tab.id).catch(() => tab);
    if (restrictedReason(t.url)) {
      await cdp.detach(tab.id);
      return { ok: false, error: `Tab ${tab.id} opened, but it ended up somewhere Stem doesn't work: ${restrictedReason(t.url)}.` };
    }
    if (out.dialog) {
      return { ok: true, tab: tab.id, text: `${ctx.note} The page opened a dialog while loading: ${dialogText(out.dialog)}. Answer it with \`dialog\`.` };
    }
    if (out.value.download) {
      return { ok: true, tab: tab.id, text: `Opened tab ${tab.id}, but that address is a download, not a page: the browser is saving it (see \`downloads\`).` };
    }
    const still = out.value.done ? '' : ' (still loading after 20 s: `wait` for what you need)';
    return { ok: true, tab: tab.id, text: `Opened tab ${tab.id} in the background: ${clip(t.title || '(untitled)', 120)} — ${clip(t.url || n.url, 300)}${still}` };
  });
}

function describeDownload(d) {
  const size = d.size ? formatBytes(d.size) : '';
  if (d.state === 'complete') return `${d.name} — done${size ? `, ${size}` : ''}`;
  if (d.state === 'interrupted') return `${d.name} — failed (${d.error || 'interrupted'})`;
  if (d.danger) return `${d.name} — held by the browser as ${d.danger}: the user has to keep it in the browser's downloads list`;
  return `${d.name} — downloading${size ? `, ${size} so far` : ''}`;
}

async function downloads(run, a) {
  let waited = '';
  if (a.wait && !run.unreported.length) {
    const ms = Math.max(1_000, Math.min(Number.isFinite(a.ms) ? a.ms : 30_000, 90_000));
    const out = await race(waitForDownload(run.threadId, ms), { s: null, threadId: run.threadId, ms: ms + 5_000, kind: 'downloads', watchDialog: false });
    if (out.stopped) return { ok: false, stopped: true, error: STOPPED_ERROR };
    if (out.value === null) waited = `No download finished within ${Math.round(ms / 1000)} s.\n`;
  }
  const items = [...run.downloads.values()];
  const body = items.length
    ? `Downloads from this run:\n${items.map((d) => `- ${describeDownload(d)}`).join('\n')}`
    : 'No downloads from this run yet. A download counts as yours when it starts in a tab you are working in.';
  return { ok: true, text: `${waited}${body}` };
}

async function closeTab(run, a) {
  const id = Number.isInteger(a.tab) ? a.tab : run.current;
  if (id === null || id === undefined) throw new UserError('No current tab to close: pass `tab`.');
  if (!run.opened.has(id)) throw new UserError('You can only close tabs you opened.');
  let title = '';
  try {
    title = (await getTab(id)).title || '';
  } catch {
    runs.forgetTab(id);
    return { ok: true, text: `Tab ${id} was already closed.` };
  }
  await cdp.enqueue(id, async () => {
    await cdp.detach(id);
    await chrome.tabs.remove(id);
  });
  runs.forgetTab(id);
  return { ok: true, text: `Closed tab ${id} (${clip(title || 'untitled', 120)}).` };
}

/** One action for one run → ExtensionResult. Throws only for bugs; background turns those into sentences. */
export async function perform(threadId, action) {
  if (!action || typeof action !== 'object' || typeof action.kind !== 'string') {
    return { ok: false, error: 'The request carried no action.' };
  }
  const run = runs.ensure(threadId);
  if (run.stopped) return { ok: false, stopped: true, error: STOPPED_ERROR };
  runs.noteAction(threadId);
  try {
    switch (action.kind) {
      case 'tabs':
        return await listTabs(run);
      case 'open':
        return await openTab(run, action);
      case 'downloads':
        return await downloads(run, action);
      case 'close':
        return await closeTab(run, action);
      default:
        if (!TAB_ACTIONS[action.kind]) return { ok: false, error: `Unknown action "${clip(action.kind, 40)}".` };
        return await onTab(run, action);
    }
  } finally {
    if (runs.get(threadId)) runs.noteAction(threadId);
  }
}
