/* global TextDecoder, atob */
import { clip, clockTime, formatBytes } from './util.js';

// Per-tab console and network history, fed from CDP events while Stem is
// attached. Bounded rings: a chatty page must not grow the service worker
// without limit, and the model only ever wants the recent end anyway.

export class Ring {
  constructor(cap) {
    this.cap = cap;
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
    return item;
  }

  toArray() {
    return this.items.slice();
  }

  get size() {
    return this.items.length;
  }
}

const CONSOLE_CAP = 200;
const NETWORK_CAP = 300;

function remoteObjectText(arg) {
  if (!arg) return '';
  if (arg.type === 'string') return arg.value;
  if (arg.value !== undefined) {
    try {
      return typeof arg.value === 'object' ? JSON.stringify(arg.value) : String(arg.value);
    } catch {
      return String(arg.value);
    }
  }
  if (arg.unserializableValue) return arg.unserializableValue;
  if (arg.preview && Array.isArray(arg.preview.properties)) {
    const body = arg.preview.properties.map((p) => `${p.name}: ${p.value ?? p.type}`).join(', ');
    return arg.preview.subtype === 'array' ? `[${body}]` : `{${body}${arg.preview.overflow ? ', …' : ''}}`;
  }
  return arg.description || arg.type || '';
}

function where(url, line) {
  if (!url) return '';
  const file = String(url).split(/[?#]/)[0].split('/').pop() || url;
  return ` (${clip(file, 60)}${Number.isInteger(line) ? `:${line + 1}` : ''})`;
}

const ERRORISH = new Set(['error', 'assert', 'warning', 'warn']);

export class ConsoleLog {
  constructor(cap = CONSOLE_CAP) {
    this.ring = new Ring(cap);
  }

  /** Fold one CDP event in; returns true when it was a console event. */
  handle(method, params) {
    if (method === 'Runtime.consoleAPICalled') {
      const frame = params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0];
      const level = params.type === 'warning' ? 'warn' : params.type;
      this.ring.push({
        time: params.timestamp || Date.now(),
        level,
        text: (params.args || []).map(remoteObjectText).join(' '),
        source: frame ? where(frame.url, frame.lineNumber) : ''
      });
      return true;
    }
    if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails || {};
      const ex = d.exception;
      const text = (ex && (ex.description || remoteObjectText(ex))) || d.text || 'Uncaught exception';
      this.ring.push({
        time: params.timestamp || Date.now(),
        level: 'error',
        text: /^Uncaught/.test(text) ? text : `Uncaught ${text}`,
        source: where(d.url, d.lineNumber)
      });
      return true;
    }
    if (method === 'Log.entryAdded') {
      const e = params.entry || {};
      this.ring.push({
        time: e.timestamp || Date.now(),
        level: e.level === 'warning' ? 'warn' : e.level === 'verbose' ? 'debug' : e.level || 'info',
        text: `${e.source && e.source !== 'other' ? `[${e.source}] ` : ''}${e.text || ''}`,
        source: where(e.url, e.lineNumber)
      });
      return true;
    }
    return false;
  }

  entries({ errorsOnly = false } = {}) {
    const all = this.ring.toArray();
    return errorsOnly ? all.filter((e) => ERRORISH.has(e.level)) : all;
  }
}

/**
 * The console action's text. `since` is when Stem attached to the tab.
 * Runtime.enable hands back what the page logged before that (as much as the
 * browser kept), so older lines can predate the attach — they are kept: an
 * error from the page's load is often exactly what the model is looking for.
 *
 * @param {Array<{time: number, level: string, text: string, source: string}>} entries
 * @param {{since?: number, errorsOnly?: boolean, tabHeader?: string}} [opts]
 */
export function formatConsole(entries, { since, errorsOnly = false, tabHeader = '' } = {}) {
  const head = tabHeader ? `${tabHeader}\n` : '';
  const what = errorsOnly ? 'errors or warnings' : 'console messages';
  if (!entries.length) {
    return (
      `${head}No ${what} (Stem attached at ${clockTime(since)}). ` +
      'To catch what the page logs while loading: `navigate` with to: "reload", then `console` again.'
    );
  }
  const earlier = entries.filter((e) => e.time < since - 1000).length;
  const lines = entries.map((e) => `${clockTime(e.time)} ${e.level.padEnd(5)} ${clip(e.text, 2000)}${e.source}`);
  const note = earlier ? `; ${earlier} from before Stem attached at ${clockTime(since)}` : `; Stem attached at ${clockTime(since)}`;
  return `${head}${entries.length} ${what} (oldest first${note}):\n${lines.join('\n')}`;
}

const TEXTUAL = /^(text\/|application\/(json|javascript|ecmascript|xml|x-www-form-urlencoded|graphql|ld\+json)|[^;]*\+(json|xml))/i;

/**
 * Request history keyed by short ids ("r12") the model can hand back to
 * `network {request}` — CDP's own ids are long and opaque.
 */
export class NetworkLog {
  constructor(cap = NETWORK_CAP) {
    this.cap = cap;
    this.byShort = new Map();
    this.shortOf = new Map();
    this.seq = 0;
  }

  _add(requestId, entry) {
    const short = `r${++this.seq}`;
    entry.id = short;
    entry.requestId = requestId;
    this.byShort.set(short, entry);
    this.shortOf.set(requestId, short);
    while (this.byShort.size > this.cap) {
      const [oldest, old] = this.byShort.entries().next().value;
      this.byShort.delete(oldest);
      if (this.shortOf.get(old.requestId) === oldest) this.shortOf.delete(old.requestId);
    }
    return entry;
  }

  _current(requestId) {
    const short = this.shortOf.get(requestId);
    return short ? this.byShort.get(short) : undefined;
  }

  handle(method, params) {
    switch (method) {
      case 'Network.requestWillBeSent': {
        const prior = this._current(params.requestId);
        if (prior && params.redirectResponse) {
          // A redirect reuses the request id: close the earlier hop as its own
          // entry so the chain stays readable, then start the next one.
          prior.status = params.redirectResponse.status;
          prior.statusText = params.redirectResponse.statusText;
          prior.responseHeaders = params.redirectResponse.headers;
          prior.mime = params.redirectResponse.mimeType;
          prior.redirectedTo = params.request.url;
          prior.done = true;
          prior.bodyGone = true;
        }
        this._add(params.requestId, {
          time: params.wallTime ? params.wallTime * 1000 : Date.now(),
          method: params.request.method,
          url: params.request.url,
          type: params.type || 'Other',
          requestHeaders: params.request.headers || {},
          postData: params.request.postData,
          hasPostData: !!params.request.hasPostData,
          status: null,
          done: false
        });
        return true;
      }
      case 'Network.responseReceived': {
        const e = this._current(params.requestId);
        if (!e) return true;
        e.status = params.response.status;
        e.statusText = params.response.statusText;
        e.mime = params.response.mimeType;
        e.responseHeaders = params.response.headers || {};
        if (params.type) e.type = params.type;
        if (params.response.fromDiskCache || params.response.fromServiceWorker) e.cached = true;
        return true;
      }
      case 'Network.loadingFinished': {
        const e = this._current(params.requestId);
        if (e) {
          e.done = true;
          e.size = params.encodedDataLength;
        }
        return true;
      }
      case 'Network.loadingFailed': {
        const e = this._current(params.requestId);
        if (e) {
          e.done = true;
          e.failed = params.canceled ? 'canceled' : params.blockedReason ? `blocked: ${params.blockedReason}` : params.errorText || 'failed';
          if (params.type) e.type = params.type;
        }
        return true;
      }
      default:
        return method.startsWith('Network.');
    }
  }

  entries(filter) {
    const all = [...this.byShort.values()];
    if (!filter) return all;
    const f = filter.toLowerCase();
    return all.filter((e) => e.url.toLowerCase().includes(f));
  }

  get(short) {
    return this.byShort.get(String(short || '').trim());
  }
}

function statusOf(e) {
  if (e.failed) return `failed (${e.failed})`;
  if (e.status === null || e.status === undefined) return e.done ? 'done' : 'pending';
  return String(e.status);
}

/**
 * The network action's list text.
 *
 * @param {Array<object>} entries
 * @param {{since?: number, filter?: string, tabHeader?: string, limit?: number}} [opts]
 */
export function formatNetworkList(entries, { since, filter, tabHeader = '', limit = 150 } = {}) {
  const head = tabHeader ? `${tabHeader}\n` : '';
  const scope = filter ? ` matching "${clip(filter, 60)}"` : '';
  if (!entries.length) {
    return (
      `${head}No requests${scope} since Stem attached at ${clockTime(since)}. ` +
      'Requests made while the page loaded only appear if it loads while Stem is attached: `navigate` with to: "reload".'
    );
  }
  const shown = entries.slice(-limit);
  const lines = shown.map(
    (e) =>
      `${e.id} ${e.method} ${statusOf(e)} ${e.type.toLowerCase()} ${e.size !== undefined ? formatBytes(e.size) : '—'} ${clip(scrubUrl(e.url).text, 300)}` +
      (e.redirectedTo ? ` → redirected` : '')
  );
  const more = entries.length > shown.length ? `\n(${entries.length - shown.length} older requests not shown; use \`filter\`.)` : '';
  return (
    `${head}${entries.length} requests${scope} since Stem attached at ${clockTime(since)} (oldest first; ` +
    `\`network\` with \`request\`: an id for its headers and body):\n${lines.join('\n')}${more}`
  );
}

// ---- secrets ----
//
// The network detail is read by the model and stored with the turn on the
// server, so credentials stay out of it unless the model asks for them on
// purpose (`evaluate` is that explicit path, and is not scrubbed). A page the
// model was sent to could also ask it to repeat what it saw. Headers are
// hidden by name; form and JSON bodies by key, recursively. Other bodies are
// shown as they are (capped).

const SECRET_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization']);
const SECRET_HEADER_RE = /(token|secret|api[-_]?key|auth|session|csrf|xsrf)/i;

// Long words match anywhere in a key ("x_csrf_token", "userPassword"). Short
// ones only as a whole segment of it, or "pan" would hide "company" and "otp"
// would hide "footprint".
const SECRET_KEY_RE =
  /password|passwd|passcode|passphrase|secret|token|one[-_]?time|card[-_]?number|client_secret|refresh_token|access_token|id_token|session|csrf|xsrf/i;
const SECRET_SEGMENTS = new Set(['pass', 'pwd', 'otp', 'cvv', 'cvc', 'pan', 'pin']);

export function isSecretHeader(name) {
  const n = String(name || '').toLowerCase();
  return SECRET_HEADERS.has(n) || SECRET_HEADER_RE.test(n);
}

export function isSecretKey(key) {
  const k = String(key || '');
  if (SECRET_KEY_RE.test(k)) return true;
  const segments = k
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return segments.some((seg) => SECRET_SEGMENTS.has(seg));
}

const hiddenText = (value) => `(hidden, ${String(value).length} characters)`;

function scrubJsonValue(value, counter) {
  if (Array.isArray(value)) return value.map((v) => scrubJsonValue(v, counter));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k) && v !== null && v !== '') {
        counter.hidden++;
        out[k] = hiddenText(typeof v === 'string' ? v : JSON.stringify(v));
      } else out[k] = scrubJsonValue(v, counter);
    }
    return out;
  }
  return value;
}

/**
 * Hide secret-looking fields in a request or response body. `mime` decides the
 * parser (form-urlencoded or JSON; a body with no type is tried as JSON when it
 * looks like it). Returns the text to show and how many values were hidden.
 */
export function scrubBody(text, mime) {
  const counter = { hidden: 0 };
  if (typeof text !== 'string' || !text) return { text, hidden: 0 };
  const m = String(mime || '').toLowerCase();
  if (m.includes('application/x-www-form-urlencoded')) {
    const parts = text.split('&').map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const rawKey = pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        // Malformed escapes: judge the raw key.
      }
      if (!isSecretKey(key)) return pair;
      counter.hidden++;
      let value = pair.slice(eq + 1);
      try {
        value = decodeURIComponent(value.replace(/\+/g, ' '));
      } catch {
        // Count the raw characters instead.
      }
      return `${rawKey}=${hiddenText(value)}`;
    });
    return { text: parts.join('&'), hidden: counter.hidden };
  }
  const looksJson = /json/.test(m) || (!m && /^\s*[[{]/.test(text));
  if (looksJson) {
    try {
      const scrubbed = scrubJsonValue(JSON.parse(text), counter);
      return counter.hidden ? { text: JSON.stringify(scrubbed), hidden: counter.hidden } : { text, hidden: 0 };
    } catch {
      // Not actually JSON (or cut short): show it as text.
    }
  }
  return { text, hidden: 0 };
}

/** A URL with secret-looking query values hidden (signed links, OAuth codes in redirects). */
export function scrubUrl(url) {
  const s = String(url || '');
  const q = s.indexOf('?');
  if (q < 0) return { text: s, hidden: 0 };
  const hashAt = s.indexOf('#', q);
  const query = s.slice(q + 1, hashAt < 0 ? undefined : hashAt);
  const r = scrubBody(query, 'application/x-www-form-urlencoded');
  if (!r.hidden) return { text: s, hidden: 0 };
  return { text: `${s.slice(0, q + 1)}${r.text}${hashAt < 0 ? '' : s.slice(hashAt)}`, hidden: r.hidden };
}

export function formatHeaders(headers, counter = { hidden: 0 }) {
  const lines = Object.entries(headers || {}).map(([k, v]) => {
    if (isSecretHeader(k)) {
      counter.hidden++;
      return `  ${k}: ${hiddenText(v)}`;
    }
    return `  ${k}: ${clip(v, 500)}`;
  });
  return lines.length ? lines.join('\n') : '  (none)';
}

export function isTextual(mime) {
  return TEXTUAL.test(String(mime || ''));
}

function headerValue(headers, name) {
  const hit = Object.entries(headers || {}).find(([k]) => k.toLowerCase() === name);
  return hit ? String(hit[1]) : '';
}

const capBody = (text, cap) => (text.length > cap ? `${text.slice(0, cap)}\n… (cut at ${cap} characters)` : text);

/**
 * One request's details.
 *
 * @param {any} e  A NetworkLog entry.
 * @param {{postData?: string, body?: {body: string, base64Encoded: boolean}, bodyError?: string, cap?: number}} [opts]
 *   `body` is what Network.getResponseBody gave; `bodyError` why there is none.
 */
export function formatNetworkDetail(e, { postData, body, bodyError, cap = 20_000 } = {}) {
  const counter = { hidden: 0 };
  const url = scrubUrl(e.url);
  counter.hidden += url.hidden;
  const parts = [
    `${e.id} ${e.method} ${clip(url.text, 2000)}`,
    `Status: ${statusOf(e)}${e.statusText ? ` ${e.statusText}` : ''} · type ${e.type.toLowerCase()}${e.mime ? ` · ${e.mime}` : ''}${e.size !== undefined ? ` · ${formatBytes(e.size)}` : ''}${e.cached ? ' · from cache' : ''}`
  ];
  if (e.redirectedTo) {
    const to = scrubUrl(e.redirectedTo);
    counter.hidden += to.hidden;
    parts.push(`Redirected to: ${clip(to.text, 2000)}`);
  }
  parts.push(`Request headers:\n${formatHeaders(e.requestHeaders, counter)}`);
  const post = postData ?? e.postData;
  if (post) {
    const scrubbed = scrubBody(post, headerValue(e.requestHeaders, 'content-type'));
    counter.hidden += scrubbed.hidden;
    parts.push(`Request body:\n${capBody(scrubbed.text, cap)}`);
  } else if (e.hasPostData) parts.push('Request body: (not available)');
  if (e.responseHeaders) parts.push(`Response headers:\n${formatHeaders(e.responseHeaders, counter)}`);
  if (bodyError) parts.push(`Response body: ${bodyError}`);
  else if (body) {
    let text = body.body;
    if (body.base64Encoded) {
      const bytes = Math.floor((text.length * 3) / 4);
      if (isTextual(e.mime)) {
        try {
          text = new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
        } catch {
          text = null;
        }
      } else text = null;
      if (text === null) parts.push(`Response body: binary ${e.mime || 'data'}, about ${formatBytes(bytes)} (not shown).`);
    }
    if (text !== null && text !== undefined) {
      const scrubbed = /json/i.test(String(e.mime || '')) ? scrubBody(text, e.mime) : { text, hidden: 0 };
      counter.hidden += scrubbed.hidden;
      parts.push(`Response body:\n${capBody(scrubbed.text, cap) || '(empty)'}`);
    }
  }
  if (counter.hidden) {
    parts.push(
      `(${counter.hidden} sensitive value${counter.hidden === 1 ? ' is' : 's are'} shown as "(hidden, N characters)": credentials, tokens, session ids, passwords and card details stay out of the transcript.)`
    );
  }
  return parts.join('\n');
}
