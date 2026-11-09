// HTTP client for relay/PROTOCOL.md, plus authority lookup (which relay
// serves an address, and which keys may certify it).
import { resolveTxt } from 'node:dns/promises';
import { degrade } from '../degrade';
import { assertAddressAllowed, PolicyError, type InterStemPolicy } from './policy';
import { b64, domainOf, signRequestHeaders, unb64, type Cert, type Envelope, type IssuerKeys } from './proto';

// ---- the global relay ----

/**
 * The global relay every Stem ships with. Keys are pinned in the build once
 * the relay is deployed; until then (and for development) they are learned
 * from its /.well-known on first use and pinned in interstem.json.
 */
/**
 * Development and tests only: allow plain-http and IP-literal relays. Never set
 * in a real install — a DNS record could otherwise point this server's
 * requests at its own network (SSRF).
 */
export const insecureRelays = (): boolean => process.env.STEM_INTERSTEM_INSECURE === '1';

/**
 * A relay URL this server may contact: https with a hostname. TLS then
 * guarantees the far end really is that host, so a record pointing at an
 * internal address fails the handshake before a byte of the request is sent.
 */
export function acceptableRelayUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // quiet: an unparseable URL is simply not acceptable.
    return false;
  }
  if (insecureRelays()) return u.protocol === 'https:' || u.protocol === 'http:';
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // IP literals and single-label names (localhost, intranet hosts) are never relays.
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return false;
  return true;
}

/** Whether this Stem may trust the global relay's /.well-known on first use (no shipped keys). */
export const globalTofuAllowed = (): boolean => !!process.env.STEM_GLOBAL_RELAY_URL;

const GLOBAL_RELAY_URL = 'https://relay.heystem.app';
/** Earlier names of the global relay. Addresses stored with one move to GLOBAL_RELAY_URL on start. */
export const LEGACY_GLOBAL_RELAY_URLS = ['https://relay.stem.awantech.sk'];
/** The global relay's signing keys, shipped so a first fetch is never trusted. Rotation: relay/README.md. */
const GLOBAL_RELAY_KEYS = 'k1:f4E6lZT6fc1cwMnjQi15Kvgd/srN+BM+0wmkhO+7d04=';

export function globalRelay(): { url: string; keys: Record<string, string> } {
  const override = process.env.STEM_GLOBAL_RELAY_URL;
  const url = (override ?? GLOBAL_RELAY_URL).replace(/\/+$/, '');
  // Shipped keys belong to the shipped URL; a relay named by env brings its own or is learned on first use.
  const shipped = override ? '' : GLOBAL_RELAY_KEYS;
  const keys: Record<string, string> = {};
  for (const entry of (process.env.STEM_GLOBAL_RELAY_KEYS ?? shipped).split(',').filter(Boolean)) {
    const [kid, pub] = entry.split(':');
    if (kid && pub) keys[kid] = pub;
  }
  return { url, keys };
}

// ---- authority ----

export interface Authority {
  relay: string;
  /** kid → raw Ed25519 public key. */
  keys: Record<string, Buffer>;
  /** `access=closed`: the domain's people talk only on its own relay (PROTOCOL.md). */
  closed?: boolean;
}

export function parseRecord(txt: string): Authority | null {
  let v = false;
  let relay = '';
  const keys: Record<string, Buffer> = {};
  let closed = false;
  for (const part of txt.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (k === 'v') {
      if (val !== 'stem1') return null;
      v = true;
    } else if (k === 'access') closed = val === 'closed';
    else if (k === 'relay') relay = val.replace(/\/+$/, '');
    else if (k === 'k') {
      const colon = val.indexOf(':');
      const raw = colon > 0 ? unb64(val.slice(colon + 1)) : Buffer.alloc(0);
      if (raw.length === 32) keys[val.slice(0, colon)] = raw;
    }
  }
  if (!v || !acceptableRelayUrl(relay) || Object.keys(keys).length === 0) return null;
  return closed ? { relay, keys, closed } : { relay, keys };
}

export type TxtLookup = (name: string) => Promise<string[][]>;

export class AuthorityResolver {
  private cache = new Map<string, { rec: Authority | null; at: number }>();

  constructor(
    private globalAuthority: () => Promise<Authority>,
    private lookup: TxtLookup = resolveTxt,
    private ttlMs = 10 * 60_000,
    private policy: () => InterStemPolicy = () => ({ mode: 'open' })
  ) {}

  async domainRecord(domain: string): Promise<Authority | null> {
    const hit = this.cache.get(domain);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.rec;
    let rec: Authority | null = null;
    try {
      const txts = await this.lookup(`_stem.${domain}`);
      for (const chunks of txts) {
        rec = parseRecord(chunks.join(''));
        if (rec) break;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // No record is an answer (the global relay serves it); anything else
      // is a failure we must not turn into "global".
      if (code !== 'ENOTFOUND' && code !== 'ENODATA') throw err;
    }
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(domain, { rec, at: Date.now() });
    return rec;
  }

  /**
   * The relay that serves an address and the keys that may certify it.
   * Under an organization policy (policy.ts) this throws PolicyError for
   * anything outside it, and never falls back to the global relay.
   */
  async authority(address: string): Promise<Authority> {
    const policy = this.policy();
    assertAddressAllowed(policy, address);
    if (policy.mode === 'restricted') {
      if (policy.relay) return { relay: policy.relay.url, keys: policy.relay.keys };
      const rec = await this.domainRecord(domainOf(address));
      if (!rec) throw new PolicyError(`${domainOf(address)} has no Stem relay of its own.`);
      return rec;
    }
    return (await this.domainRecord(domainOf(address))) ?? this.globalAuthority();
  }

  issuerKeys(): IssuerKeys {
    return async (address) => {
      try {
        const a = await this.authority(address);
        return { issuer: a.relay, keys: a.keys };
      } catch (err) {
        // A sender the policy refuses is a certificate nobody may vouch for:
        // verification fails cleanly and the mail is dropped, not retried.
        if (err instanceof PolicyError) return { issuer: '', keys: {} };
        throw err;
      }
    };
  }
}

// ---- requests ----

export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(`relay answered ${status} ${code}`);
  }
}

export interface Identity {
  seed: Buffer;
  cert?: Cert;
}

async function call<T>(
  relay: string,
  method: string,
  path: string,
  opts: { body?: unknown; id?: Identity; withCert?: boolean; raw?: string; bytes?: Uint8Array } = {}
): Promise<{ status: number; json: T }> {
  const body = opts.bytes ?? opts.raw ?? (opts.body === undefined ? '' : JSON.stringify(opts.body));
  const headers: Record<string, string> = {
    'Content-Type': opts.bytes ? 'application/octet-stream' : 'application/json'
  };
  if (opts.id) Object.assign(headers, signRequestHeaders(opts.id.seed, method, path, body));
  if (opts.withCert && opts.id?.cert) headers['Stem-Cert'] = b64(Buffer.from(JSON.stringify(opts.id.cert)));
  if (!acceptableRelayUrl(relay)) throw new RelayError(0, 'unacceptable_relay_url');
  const res = await fetch(relay + path, {
    method,
    redirect: 'error',
    headers,
    body: method === 'GET' ? undefined : (body as BodyInit),
    signal: AbortSignal.timeout(opts.bytes ? 120_000 : 30_000)
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // quiet: a non-JSON answer (proxy error page) is reported by status below.
    json = {};
  }
  if (res.status >= 400) throw new RelayError(res.status, (json as { error?: string }).error ?? 'http_error');
  return { status: res.status, json: json as T };
}

export async function relayInfo(
  relay: string
): Promise<{ features: string[]; limits: { maxMailBytes: number; powBits: number } }> {
  return (
    await call<{ features: string[]; limits: { maxMailBytes: number; powBits: number } }>(relay, 'GET', '/v1/info')
  ).json;
}

export async function wellKnown(relay: string): Promise<{ url: string; keys: { kid: string; pub: string }[] }> {
  return (await call<{ url: string; keys: { kid: string; pub: string }[] }>(relay, 'GET', '/.well-known/stem-relay'))
    .json;
}

export async function register(
  relay: string,
  id: Identity,
  address: string,
  keyBlob: string,
  nonce: string
): Promise<void> {
  await call(relay, 'POST', '/v1/register', { id, body: { address, keyBlob, pow: { nonce } } });
}

export async function verifyCode(relay: string, id: Identity, address: string, code: string): Promise<Cert> {
  return (await call<{ cert: Cert }>(relay, 'POST', '/v1/verify', { id, body: { address, code } })).json.cert;
}

export async function fetchCert(relay: string, id: Identity, address: string): Promise<Cert> {
  return (await call<{ cert: Cert }>(relay, 'POST', '/v1/cert', { id, body: { address } })).json.cert;
}

/** null = not reachable (unregistered or unlisted — indistinguishable by design). */
export async function lookupKey(
  relay: string,
  id: Identity,
  address: string
): Promise<{ authKey: string; keyBlob: string } | null> {
  try {
    return (
      await call<{ authKey: string; keyBlob: string }>(
        relay,
        'GET',
        `/v1/keys?address=${encodeURIComponent(address)}`,
        { id, withCert: true }
      )
    ).json;
  } catch (err) {
    if (err instanceof RelayError && err.code === 'not_reachable') return null;
    throw err;
  }
}

export async function postMail(relay: string, env: Envelope): Promise<string> {
  return (await call<{ status: string }>(relay, 'POST', '/v1/mail', { raw: JSON.stringify(env) })).json.status;
}

export async function mailStatus(relay: string, id: Identity, envelopeId: string): Promise<string> {
  return (await call<{ status: string }>(relay, 'GET', `/v1/mail/status?id=${envelopeId}`, { id, withCert: true })).json
    .status;
}

export async function ack(relay: string, id: Identity, ids: string[]): Promise<void> {
  await call(relay, 'POST', '/v1/ack', { id, body: { ids } });
}

export async function listOp(
  relay: string,
  id: Identity,
  op: 'allow' | 'unallow' | 'block' | 'unblock',
  address: string
): Promise<void> {
  await call(relay, 'POST', `/v1/${op}`, { id, body: { address } });
}

export async function setUnlisted(relay: string, id: Identity, unlisted: boolean): Promise<void> {
  await call(relay, 'PUT', '/v1/account', { id, body: { unlisted } });
}

export async function invite(relay: string, id: Identity, address: string): Promise<void> {
  await call(relay, 'POST', '/v1/invite', { id, withCert: true, body: { address } });
}

/** Whether `fp` is still the key the address's home relay vouches for. */
export async function keyStatus(relay: string, address: string, fp: string): Promise<boolean> {
  const q = `/v1/keystatus?address=${encodeURIComponent(address)}&fp=${encodeURIComponent(fp)}`;
  return (await call<{ current: boolean }>(relay, 'GET', q)).json.current === true;
}

// ---- share links (PROTOCOL.md, "Share links") ----

export interface RelayShare {
  id: string;
  url: string;
  size?: number;
  created?: number;
  expires: number;
  /** A locked share: who may open it. On upload, the relay's proof that it locked it. */
  recipients?: string[];
  /** A locked share, in the list: who opened it. */
  opens?: { address: string; first: number; last: number; count: number }[];
}

/**
 * Upload an encrypted share blob. `id` must carry a certificate. `card` is
 * the link preview, published in the clear (it rides in the signed path).
 */
export async function postShare(
  relay: string,
  id: Identity,
  blob: Uint8Array,
  ttlDays?: number,
  card?: { title: string; description: string } | null,
  recipients?: string[]
): Promise<RelayShare> {
  const q = new URLSearchParams();
  if (ttlDays) q.set('ttl', String(ttlDays));
  if (recipients?.length) q.set('to', Buffer.from(JSON.stringify(recipients)).toString('base64url'));
  if (card && (card.title || card.description)) {
    q.set('card', Buffer.from(JSON.stringify({ t: card.title, d: card.description })).toString('base64url'));
  }
  const path = q.size ? `/v1/shares?${q}` : '/v1/shares';
  return (await call<RelayShare>(relay, 'POST', path, { id, withCert: true, bytes: blob })).json;
}

export async function deleteShare(relay: string, id: Identity, shareId: string): Promise<void> {
  await call(relay, 'DELETE', `/v1/shares/${encodeURIComponent(shareId)}`, { id, withCert: true });
}

export async function listShares(relay: string, id: Identity): Promise<RelayShare[]> {
  return (await call<{ shares: RelayShare[] }>(relay, 'GET', '/v1/shares', { id, withCert: true })).json.shares ?? [];
}

export async function revoke(relay: string, id: Identity): Promise<void> {
  await call(relay, 'POST', '/v1/revoke', { id, body: {} });
}

/**
 * Hold the relay's SSE stream open, calling onMail for each envelope
 * (held ones first). Resolves when the stream ends; rejects on HTTP errors.
 */
export async function streamMail(
  relay: string,
  id: Identity,
  onMail: (env: Envelope) => Promise<void>,
  signal: AbortSignal,
  onOpen?: () => void
): Promise<void> {
  if (!acceptableRelayUrl(relay)) throw new RelayError(0, 'unacceptable_relay_url');
  const res = await fetch(relay + '/v1/stream', {
    headers: signRequestHeaders(id.seed, 'GET', '/v1/stream', ''),
    signal,
    redirect: 'error'
  });
  if (!res.ok || !res.body) {
    let code = 'http_error';
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      // quiet: the status already says it failed; the code is a nicety.
    }
    throw new RelayError(res.status, code);
  }
  onOpen?.();
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (event !== 'mail' || data.length === 0) continue;
      try {
        await onMail(JSON.parse(data.join('\n')) as Envelope);
      } catch (err) {
        degrade('interstem', 'could not handle an incoming envelope', err);
      }
    }
  }
}
