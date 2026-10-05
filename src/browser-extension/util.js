/* global URL, atob, setTimeout */
// Small pure helpers shared by the extension's modules. Nothing here touches
// `chrome`, so the unit tests can load it under Node.

/** Text results are capped so one busy page cannot flood the model's context. */
export const TEXT_CAP = 60_000;

export function capText(text, cap = TEXT_CAP) {
  if (typeof text !== 'string' || text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… (cut at ${cap} characters)`;
}

/** One line, at most `max` characters — for titles, names and URLs inside a longer text. */
export function clip(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The first line of most results: which tab the model is looking at. */
export function tabLine(tab) {
  const title = clip(tab.title || '(untitled)', 120);
  const url = clip(tab.url || tab.pendingUrl || '', 300);
  return `Tab ${tab.id} · ${title} — ${url}`;
}

const WEB_STORE = [
  /^https?:\/\/chromewebstore\.google\.com(\/|$)/i,
  /^https?:\/\/chrome\.google\.com\/webstore(\/|$)/i,
  /^https?:\/\/microsoftedge\.microsoft\.com\/addons(\/|$)/i
];

/**
 * Why Stem may not work in a page at `url`, as a sentence for the model — or
 * null for an ordinary page (http, https, or a fresh about:blank). Browsers
 * refuse extension debugging on their own pages and the Web Store anyway;
 * saying so up front beats a CDP error.
 */
export function restrictedReason(url) {
  const u = String(url || '');
  if (!u) return null;
  if (WEB_STORE.some((re) => re.test(u))) {
    return 'it is the browser’s extension store, which extensions are not allowed to control';
  }
  // file: is refused outright, open or already showing. The model only ever
  // hands the browser files Stem holds (`upload`); a file:// tab would be a way
  // round that to any path on this Mac.
  if (/^file:/i.test(u)) {
    return 'it is a file on this Mac, which Stem never opens — uploads go through `upload` with files Stem holds';
  }
  if (/^https?:/i.test(u) || u === 'about:blank') return null;
  const scheme = u.split(':')[0].toLowerCase();
  return `it shows a browser page (${clip(u, 80)}), which extensions are not allowed to control (${scheme}: pages)`;
}

/**
 * What the model typed as a URL → something `open`/`navigate` can load, or an
 * error sentence. A bare host ("example.com/x") gets https://; script and
 * browser-internal schemes are refused rather than guessed at.
 */
export function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return { error: 'The URL is empty.' };
  if (/^javascript:/i.test(raw)) return { error: 'javascript: URLs are not opened: use `evaluate` to run script in a page.' };
  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) || /^localhost:\d/i.test(raw)) {
    if (/^[\w.-]+(:\d+)?(\/|$|\?|#)/.test(raw)) candidate = `${/^(localhost|127\.|\[::1\])/i.test(raw) ? 'http' : 'https'}://${raw}`;
    else return { error: `"${clip(raw, 80)}" is not a URL. Give a full address like https://example.com.` };
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return { error: `"${clip(raw, 80)}" is not a valid URL.` };
  }
  const why = restrictedReason(url.href);
  if (why) return { error: `Stem can't open that: ${why}.` };
  return { url: url.href };
}

/** A stored network/console time (ms since epoch) as local HH:MM:SS. */
export function clockTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pixel size of a baseline/progressive JPEG from its base64 body, read off the
 * SOF marker. The screenshot result reports the picture's real size rather
 * than the size we asked for: browser zoom can make the two differ, and the
 * model's `coordinate` clicks are only right if it knows which one it got.
 */
export function jpegSize(base64) {
  let bytes;
  try {
    bytes = Uint8Array.from(atob(base64.slice(0, 200_000)), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + len;
  }
  return null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An error whose message is already a sentence the model can act on. */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}
