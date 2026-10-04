// Favicons for the Sources panel under web answers. The renderer's CSP allows
// only `self` and data: images, and the phone has no business fetching
// arbitrary sites either, so the server fetches a site's own /favicon.ico and
// hands it over as a data URL. Nothing goes to a third-party icon service: the
// only site contacted is the one the answer already cited.
//
// The host comes from a model-produced citation, so it is treated as hostile:
// names only (no IP literals, no single-label or .local/.internal hosts), and
// the address each name resolves to must be public, checked at connect time;
// https only, redirects followed by hand and re-checked at every hop, a byte
// cap enforced while streaming, a short timeout. Failures are cached too, so a
// site without an icon is asked once per run, not once per render.

import { lookup as dnsLookup } from 'node:dns';
import { get as httpsGet } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 3_000;
const MAX_HOPS = 2;
const CACHE_LIMIT = 500;
/** Fetches in flight at once; the rest wait. A long Sources list can't fan out. */
const MAX_CONCURRENT = 4;

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

// Addresses a public site's icon never lives at. A public NAME can still
// resolve to one (or be rebound to one between two lookups), so the check runs
// inside the connection's own lookup: the address dialled is the one checked.
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]
] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv4');
}
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is unwrapped and checked as IPv4 below
// rather than listed here: BlockList matches plain IPv4 against a mapped
// subnet too, which would refuse every IPv4 address.
// ::/96 also covers the deprecated IPv4-compatible form; NAT64, 6to4 and
// Teredo embed an IPv4 address that may well be private, so they go whole.
for (const [net, bits] of [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv6');
}

/** Whether an address is somewhere a cited site's icon can't legitimately be. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPrivateAddress(mapped[1]);
  const family = isIP(address);
  if (family === 4) return PRIVATE.check(address, 'ipv4');
  if (family === 6) return PRIVATE.check(address, 'ipv6');
  return true;
}

/**
 * net's lookup hook, refusing private addresses. Node's happy-eyeballs connect
 * asks for every address (`all: true`); a plain connect asks for one. Either
 * way, nothing private is ever handed back to be dialled.
 */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  const refuse = () => callback(new Error(`${hostname} resolves to a private address`), '', 0);
  if (options.all) {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const open = addresses.filter((a) => !isPrivateAddress(a.address));
      if (!open.length) return refuse();
      (callback as unknown as (e: null, a: typeof open) => void)(null, open);
    });
    return;
  }
  dnsLookup(hostname, { ...options, all: false }, (err, address, family) => {
    if (err) return callback(err, '', 0);
    if (isPrivateAddress(address)) return refuse();
    callback(null, address, family);
  });
};

type Hop = { redirect: string } | { icon: string } | null;

/** One GET over https, through the checked lookup, reading at most MAX_BYTES. */
function getOnce(url: URL): Promise<Hop> {
  return new Promise((resolve) => {
    const req = httpsGet(
      url,
      { lookup: publicLookup, timeout: TIMEOUT_MS, headers: { accept: 'image/*', 'user-agent': 'Mozilla/5.0 (compatible; Stem favicon)' } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve(res.headers.location ? { redirect: res.headers.location } : null);
        }
        const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        // SVG is excluded on purpose: it is a document, not a picture.
        if (status !== 200 || !/^image\/(x-icon|vnd\.microsoft\.icon|png|gif|jpeg|webp)$/.test(type)) {
          res.resume();
          return resolve(null);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          // Counted as it arrives: a missing or lying content-length can't
          // make the server buffer more than the cap.
          if (size > MAX_BYTES) {
            req.destroy();
            resolve(null);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          resolve(bytes.length && size <= MAX_BYTES ? { icon: `data:${type};base64,${bytes.toString('base64')}` } : null);
        });
        res.on('error', () => resolve(null));
      }
    );
    // `timeout` above is per idle gap; this is the whole request. A server
    // dripping a byte a second would otherwise hold it open indefinitely.
    const deadline = setTimeout(() => {
      req.destroy();
      resolve(null);
    }, TIMEOUT_MS);
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

let running = 0;
const waiting: Array<() => void> = [];

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((go) => waiting.push(go));
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

async function fetchIcon(host: string): Promise<string | null> {
  let url = new URL(`https://${host}/favicon.ico`);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const result = await getOnce(url);
    if (!result) return null;
    if ('icon' in result) return result.icon;
    const target = new URL(result.redirect, url);
    if (target.protocol !== 'https:' || !isFetchableHost(target.hostname)) return null;
    url = target;
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
    hit = limited(() => fetchIcon(h)).catch(() => null);
    cache.set(h, hit);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  }
  return hit;
}
