/* global chrome, URL, setTimeout, clearTimeout */

// Downloads, pinned on the run that caused them — and only those. A finished
// download a run is told about gets copied to the server, so attribution must
// never catch the user's own: a file the user downloads while a run is busy is
// theirs, not the run's.
//
// chrome.downloads says nothing about which tab a download came from, so the
// tab comes from CDP: a tab Stem is attached to reports Page.downloadWillBegin
// (url, suggested name). background.js hands those to noteDownloadStart with
// the tab's owning run (Runs.ownerOfTab). chrome.downloads.onCreated items are
// then matched to a recorded start by URL within a short window. The two
// events arrive on different channels in either order, so whichever comes
// first waits briefly for the other. A download that matches no start is
// dropped: never recorded, never reported.

/** A start and its DownloadItem must arrive within this of each other. */
export const DOWNLOAD_MATCH_MS = 30_000;

const starts = [];
const orphans = [];
const owners = new Map();
const waiters = new Set();
let runsRef = null;

function withoutHash(url) {
  const s = String(url || '');
  const i = s.indexOf('#');
  return i < 0 ? s : s.slice(0, i);
}

/** Whether a CDP download start (by its url) and a DownloadItem are the same download. */
export function sameDownload(startUrl, item) {
  const want = withoutHash(startUrl);
  if (!want) return false;
  return [item.url, item.finalUrl].some((u) => u && withoutHash(u) === want);
}

/**
 * Pick the recorded start a new DownloadItem belongs to: same URL, within
 * `windowMs` of `now`, the most recent if several. Returns its index in
 * `list`, or -1 — and -1 means the download is not Stem's.
 */
export function matchDownload(list, item, now, windowMs = DOWNLOAD_MATCH_MS) {
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (Math.abs(now - s.at) > windowMs) continue;
    if (!sameDownload(s.url, item)) continue;
    if (best < 0 || s.at >= list[best].at) best = i;
  }
  return best;
}

function prune(list, now) {
  for (let i = list.length - 1; i >= 0; i--) if (now - list[i].at > DOWNLOAD_MATCH_MS) list.splice(i, 1);
}

function basename(path) {
  return String(path || '').split(/[\\/]/).pop() || '';
}

function fromItem(item) {
  let fromUrl = '';
  try {
    fromUrl = basename(new URL(item.finalUrl || item.url).pathname);
  } catch {
    // blob:/data: URLs have no useful path.
  }
  return {
    id: item.id,
    name: basename(item.filename) || fromUrl || 'download',
    path: item.filename || '',
    size: item.fileSize > 0 ? item.fileSize : item.bytesReceived || item.totalBytes || 0,
    mime: item.mime || undefined,
    state: item.state,
    error: item.error || undefined,
    danger: item.danger && item.danger !== 'safe' && item.danger !== 'accepted' ? item.danger : undefined
  };
}

function update(threadId, item) {
  runsRef.updateDownload(threadId, fromItem(item));
  if (item.state === 'complete' || item.state === 'interrupted') {
    for (const fn of [...waiters]) fn(threadId, item.id);
  }
}

function claim(item, threadId) {
  owners.set(item.id, threadId);
  update(threadId, item);
}

/** Page.downloadWillBegin in an attached tab, already resolved to its run. */
export function noteDownloadStart(threadId, params) {
  if (!threadId || !params || !params.url) return;
  const now = Date.now();
  prune(starts, now);
  prune(orphans, now);
  const i = orphans.findIndex((o) => sameDownload(params.url, o.item));
  if (i >= 0) {
    const [o] = orphans.splice(i, 1);
    // It may have moved on (even finished) while unclaimed: take its state now.
    chrome.downloads
      .search({ id: o.item.id })
      .then(([current]) => claim(current || o.item, threadId))
      .catch(() => claim(o.item, threadId));
    return;
  }
  starts.push({ threadId, url: params.url, name: params.suggestedFilename, at: now });
}

export function trackDownloads(runs) {
  runsRef = runs;
  chrome.downloads.onCreated.addListener((item) => {
    const now = Date.now();
    prune(starts, now);
    prune(orphans, now);
    const i = matchDownload(starts, item, now);
    if (i >= 0) {
      const [s] = starts.splice(i, 1);
      claim(item, s.threadId);
    } else {
      orphans.push({ item, at: now });
    }
  });
  chrome.downloads.onChanged.addListener(async (delta) => {
    const threadId = owners.get(delta.id);
    if (!threadId) return;
    const [item] = await chrome.downloads.search({ id: delta.id });
    if (item) update(threadId, item);
  });
}

/** Resolve when one of `threadId`'s downloads finishes (or fails), or after `ms`. */
export function waitForDownload(threadId, ms) {
  return new Promise((resolve) => {
    const done = (value) => {
      waiters.delete(fn);
      clearTimeout(timer);
      resolve(value);
    };
    const fn = (owner, id) => {
      if (owner === threadId) done(id);
    };
    const timer = setTimeout(() => done(null), ms);
    waiters.add(fn);
  });
}
