import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { log } from '../log';

// Talking to Apple Push Notification service, by hand.
//
// Hand-rolled for one reason: no new dependency. Every published APNs client
// brings a JWT library, and often an HTTP/2 one, to do what node:crypto and
// node:http2 already do in the ~120 lines below — and this is a path that touches
// a private key and a device address book, which is exactly where an unread
// transitive dependency is worth the least.
//
// Provider-token auth rather than a certificate: one .p8 key signs for every
// bundle id on the team, it does not expire annually, and the credential on disk
// is a file path in the environment instead of a keychain item nobody can rotate
// from a container. The token is a bare ES256 JWT with an issuer and an issued-at
// and nothing else — Apple rejects one older than an hour and rate-limits minting
// them, so it is cached for fifty minutes and reused across every send.
//
// THE FEATURE IS OFF UNLESS IT IS FULLY CONFIGURED. Four values (key, key id,
// team, bundle) and every one of them must be present; a partial configuration is
// a misconfiguration and is treated as "off" rather than as an error to report at
// each send. That is the default path for every existing install — an embedded
// desktop Stem sets none of these — and on it nothing here does any work at all:
// no key read, no connection, no label resolved. See push/index.ts, which checks
// `apnsConfigured()` before it so much as looks up which devices exist.

/** What a configured sender needs. All four, or the feature is off. */
interface ApnsConfig {
  keyPath: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id, which is also the APNs topic for an alert push. */
  bundleId: string;
  /** Sandbox unless production is asked for. Only Xcode dev builds are sandbox; TestFlight and App Store builds mint production tokens. */
  env: 'production' | 'sandbox';
}

/**
 * Where the two APNs environments live. A token minted by a development build is
 * only addressable on the sandbox host and vice versa, which is why this is
 * configuration and not a constant: the same server binary serves a dev build
 * and a TestFlight/App Store one.
 */
const HOSTS = {
  production: 'api.push.apple.com',
  sandbox: 'api.sandbox.push.apple.com'
} as const;

/** Apple refuses a provider token older than an hour; renew well inside that. */
const TOKEN_TTL_MS = 50 * 60 * 1000;

/** A push is a tap on the shoulder — if it cannot be delivered promptly it is stale. */
const REQUEST_TIMEOUT_MS = 10_000;

/** What one send did, in the only three flavours the caller acts on. */
export type ApnsResult =
  /** Apple accepted it. Whether the phone shows it is between the phone and Apple. */
  | 'sent'
  /** 410: that token is dead (app deleted, device restored). Stop keeping it. */
  | 'gone'
  /** Anything else — logged, counted as nothing, never retried here. */
  | 'failed';

/** One request to APNs, in the shape the transport below (or a test's) takes. */
export interface ApnsRequest {
  host: string;
  /** `/3/device/<token>`. */
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface ApnsResponse {
  status: number;
  /** Apple's JSON error body, when it sent one. Logged, never parsed for control flow. */
  body: string;
}

/** How a request actually goes out. Replaced wholesale by the unit tests. */
export type ApnsPost = (req: ApnsRequest) => Promise<ApnsResponse>;

let post: ApnsPost | null = null;

/**
 * Send through `next` instead of a real HTTP/2 connection (null restores it).
 * The tests own this: everything above the wire — the off-switch, the payload,
 * the 410 handling — is worth exercising, and none of it should need Apple.
 */
export function setApnsPost(next: ApnsPost | null): void {
  post = next;
}

/** The configuration, or null when the feature is off. Read fresh; env can change. */
function readConfig(): ApnsConfig | null {
  const keyPath = process.env.STEM_APNS_KEY_PATH?.trim();
  const keyId = process.env.STEM_APNS_KEY_ID?.trim();
  const teamId = process.env.STEM_APNS_TEAM_ID?.trim();
  const bundleId = process.env.STEM_APNS_BUNDLE_ID?.trim();
  if (!keyPath || !keyId || !teamId || !bundleId) return null;
  // Anything that is not the word 'production' is the safer of the two: a push
  // sent to the sandbox host for a production token simply fails, where the
  // reverse would mean a typo silently addressing real devices.
  const env = process.env.STEM_APNS_ENV?.trim() === 'production' ? 'production' : 'sandbox';
  return { keyPath, keyId, teamId, bundleId, env };
}

/** Whether pushes can be sent at all. Every trigger checks this first. */
export function apnsConfigured(): boolean {
  return readConfig() !== null;
}

/** The .p8, parsed once per path — it is read from disk, not from a request. */
let signingKey: { path: string; key: KeyObject } | null = null;

async function loadSigningKey(path: string): Promise<KeyObject> {
  if (signingKey?.path === path) return signingKey.key;
  const key = createPrivateKey(await readFile(path, 'utf8'));
  signingKey = { path, key };
  return key;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

let cachedToken: { value: string; keyId: string; teamId: string; mintedAt: number } | null = null;

/**
 * The provider token: `{alg:ES256, kid}` over `{iss, iat}`, and nothing more —
 * APNs specifies exactly these claims and ignores extras.
 *
 * `dsaEncoding: 'ieee-p1363'` is the whole subtlety. Node signs ECDSA as DER by
 * default; JWS requires the raw r‖s pair. A DER signature is accepted by nothing
 * and fails as a flat 403 InvalidProviderToken, which reads like a wrong key.
 */
async function providerToken(cfg: ApnsConfig): Promise<string> {
  const fresh =
    cachedToken &&
    cachedToken.keyId === cfg.keyId &&
    cachedToken.teamId === cfg.teamId &&
    Date.now() - cachedToken.mintedAt < TOKEN_TTL_MS;
  if (fresh) return cachedToken!.value;

  const key = await loadSigningKey(cfg.keyPath);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }));
  const claims = base64url(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) }));
  const signer = createSign('SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  const signature = base64url(signer.sign({ key, dsaEncoding: 'ieee-p1363' }));
  const value = `${header}.${claims}.${signature}`;
  cachedToken = { value, keyId: cfg.keyId, teamId: cfg.teamId, mintedAt: Date.now() };
  return value;
}

/** Drop the cached token, so the next send mints one (a 403 from Apple). */
function forgetProviderToken(): void {
  cachedToken = null;
}

/** Live HTTP/2 sessions to Apple, one per host. Reconnected when one dies. */
const sessions = new Map<string, ClientHttp2Session>();

function session(host: string): ClientHttp2Session {
  const existing = sessions.get(host);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  // Apple asks providers to hold the connection open rather than reconnect per
  // notification; a push here is rare enough that it barely matters, but a
  // reconnect per send would also mean a TLS handshake in the notification's
  // latency budget.
  const next = connect(`https://${host}`);
  next.on('error', (e) => {
    log('push', 'apns connection failed', { host, error: String(e?.message ?? e) });
    sessions.delete(host);
  });
  next.on('close', () => {
    if (sessions.get(host) === next) sessions.delete(host);
  });
  // A push connection must never be the reason the process stays up.
  next.unref();
  sessions.set(host, next);
  return next;
}

/** The real wire: one HTTP/2 POST, headers and body in, status and body out. */
function http2Post(req: ApnsRequest): Promise<ApnsResponse> {
  return new Promise((resolveResponse, rejectResponse) => {
    const stream = session(req.host).request({
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: req.path,
      ...req.headers
    });
    let status = 0;
    let body = '';
    stream.setEncoding('utf8');
    stream.on('response', (headers) => {
      status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
    });
    stream.on('data', (chunk: string) => {
      body += chunk;
    });
    stream.on('end', () => resolveResponse({ status, body }));
    stream.on('error', rejectResponse);
    stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
      stream.close();
      rejectResponse(new Error(`no answer from ${req.host} in ${REQUEST_TIMEOUT_MS}ms`));
    });
    stream.end(req.body);
  });
}

/**
 * Wake one device. `payload` is the whole APNs body (see push/index.ts, which
 * builds it and is the only place that decides what may be in one).
 *
 * Never throws: a caller is an event handler that was doing something else, and
 * a notification that could not be sent must not become that thing's failure.
 */
export async function sendApns(deviceToken: string, payload: unknown): Promise<ApnsResult> {
  const cfg = readConfig();
  if (!cfg) return 'failed';
  let response: ApnsResponse;
  const body = JSON.stringify(payload);
  try {
    const token = await providerToken(cfg);
    response = await (post ?? http2Post)({
      host: HOSTS[cfg.env],
      path: `/3/device/${deviceToken}`,
      headers: {
        authorization: `bearer ${token}`,
        'apns-topic': cfg.bundleId,
        // An alert push, at once. The payload is a tap on the shoulder about
        // something the user is being asked for right now; there is no shape of
        // Stem notification that wants to wait for the next radio wake-up.
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json'
      },
      body
    });
  } catch (e) {
    log('push', 'apns send failed', { error: String((e as Error)?.message ?? e) });
    return 'failed';
  }
  if (response.status === 200) return 'sent';
  if (response.status === 410) {
    log('push', 'apns reports the token is gone', {});
    return 'gone';
  }
  // 403 is nearly always the provider token: expired, or minted from a key that
  // has been revoked. Dropping the cached one costs a signature and turns "every
  // push fails until restart" into "the next push mints a fresh token".
  if (response.status === 403) forgetProviderToken();
  log('push', 'apns refused a push', { status: response.status, body: response.body.slice(0, 200) });
  return 'failed';
}

/** Close the connections (app quit; tests). Everything reconnects on demand. */
export function closeApns(): void {
  for (const [, s] of sessions) s.destroy();
  sessions.clear();
  cachedToken = null;
  signingKey = null;
}
