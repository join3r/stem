// Favicons for the Sources panel under web answers. The renderer's CSP allows
// only `self` and data: images, and the phone has no business fetching
// arbitrary sites either, so the server fetches a site's own /favicon.ico and
// hands it over as a data URL. Nothing goes to a third-party icon service: the
// only site contacted is the one the answer already cited.
//
// The host comes from a model-produced citation, so it is treated as hostile:
// names only (no IP literals, no single-label or .local/.internal hosts),
// https only, redirects followed by hand and re-checked at every hop, a small
// byte cap, a short timeout. Failures are cached too, so a site without an
// icon is asked once per run, not once per render.

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 3_000;
const MAX_HOPS = 2;
const CACHE_LIMIT = 500;

const cache = new Map<string, Promise<string | null>>();

/** A public DNS name worth asking: letters, digits, dots and hyphens, two labels at least. */
export function isFetchableHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h.length > 253 || !/^[a-z0-9.-]+$/.test(h)) return false;
  if (/^\d+(\.\d+){3}$/.test(h)) return false; // IPv4 literal
  const labels = h.split('.');
  if (labels.length < 2 || labels.some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return false;
  const tld = labels[labels.length - 1];
  if (/^\d+$/.test(tld)) return false;
  return !['localhost', 'local', 'internal', 'lan', 'home', 'arpa', 'test', 'invalid'].includes(tld);
}

async function fetchIcon(host: string): Promise<string | null> {
  let url = `https://${host}/favicon.ico`;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'image/*' }
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) return null;
      const target = new URL(next, url);
      if (target.protocol !== 'https:' || !isFetchableHost(target.hostname)) return null;
      url = target.toString();
      continue;
    }
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    // SVG is excluded on purpose: it is a document, not a picture.
    if (!/^image\/(x-icon|vnd\.microsoft\.icon|png|gif|jpeg|webp)$/.test(type)) return null;
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) return null;
    return `data:${type};base64,${bytes.toString('base64')}`;
  }
  return null;
}

/** The site's favicon as a data URL, or null when it has none (or isn't asked). */
export function faviconFor(host: string): Promise<string | null> {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!isFetchableHost(h)) return Promise.resolve(null);
  let hit = cache.get(h);
  if (!hit) {
    // quiet: a missing icon is the letter tile the panel already draws.
    hit = fetchIcon(h).catch(() => null);
    cache.set(h, hit);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  }
  return hit;
}
