import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { degrade } from '../degrade';
import { devicesStorePath } from '../workspace/paths';
import type { DeviceKind } from '../../shared/types';

// Who is allowed to talk to the transport. Two independent gates, because the
// transport is the surface a public deployment puts on the internet:
//
//   1. A bearer token — 32 random bytes as hex, held by the client and stored
//      here only as a SHA-256 hash. The registry is therefore no longer a file
//      full of credentials: reading devices.json (a copied backup, an export
//      tarball, a stray `cat`) tells you which devices exist and nothing that
//      would let you become one. A device learns its token exactly once, at the
//      moment it is minted — pairing (transport/pairing.ts) for a client that
//      does not share this disk, and a direct mint for one that does.
//   2. A request-origin check — the DNS-rebinding defense. No browser speaks to
//      this transport any more (the phone's web client was removed with the
//      phone role), so rebinding has no obvious vehicle today — but the check
//      costs one header comparison and would be the difference if anything
//      browser-shaped is ever pointed at Stem again. Checking the *Host* header
//      against the hostnames Stem can legitimately be reached under is what
//      actually stops rebinding: a matching Origin/Host pair proves nothing,
//      since a rebound attacker controls both.
//
// No KDF on the token. A password needs one because it is short, guessable and
// reused; this is 32 bytes from the CSPRNG, so a single SHA-256 leaves nothing
// to grind — an attacker who can enumerate 2^256 does not need the hash.

const TOKEN_BYTES = 32;
/** Both a token and its SHA-256 digest are 64 lowercase hex characters. */
const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * What a device is trusted to be. One value, and the field is kept anyway: the
 * registry has always carried it, dropping a persisted field is a migration in
 * both directions, and Phase 4's React Native client is the next thing that may
 * want a narrower one. What it must never again be is a curated allowlist with
 * no client exercising it — that was `phone`, and it is gone.
 */
export type DeviceRole = 'device';

/** A client the transport will answer, and what it is trusted to be. */
export interface DeviceRecord {
  /** Stable identity across re-pairing; the token is the credential, this is not. */
  id: string;
  /**
   * SHA-256 of the bearer token, hex. The token itself is never written here —
   * it is handed to the device at mint time and lives on that device only, so
   * this file can be read, copied or exported without handing anyone a session.
   */
  tokenHash: string;
  role: DeviceRole;
  /** Human label, shown in Settings → Server → Devices. */
  label: string;
  createdAt: string;
  /** Last successful authentication, or null if it has never connected. */
  lastSeenAt: string | null;
  /**
   * The device's APNs token, when it has asked to be woken (devices:registerPush).
   * Absent for every device that never did, which is every device today except an
   * iOS client — so devices.json stays version 2: an older file simply has no
   * such field, and a record without one is a device we never push to.
   *
   * It is not a credential. An APNs token addresses a device on Apple's network
   * and can only be spent by whoever also holds our provider key, so it is stored
   * in the clear where the bearer token deliberately is not — hashing it would
   * make it unusable for the one thing it is for.
   */
  apnsToken?: string;
  /** Which push network `apnsToken` belongs to. Only iOS has one today. */
  platform?: 'ios';
  /**
   * What the device says it is, given when it spends its pairing code. Absent
   * for every record written before the field existed, and {@link deviceKind}
   * reads that absence as `desktop` — the honest default, since the only client
   * that could have written such a record is a desktop one (the phone shipped
   * later). devices.json therefore stays version 2 and an old file round-trips
   * unchanged.
   *
   * `role` is what a device may DO and there is only one value; this is what it
   * IS, and it is used to decide what Stem offers it. Only a desktop is offered
   * as a host for a pinned MCP server, because availability is "has an open
   * stream" and iOS suspends the app — a phone would flicker in and out of
   * availability with the screen lock (docs/mcp-device-pinning.md, ⑦).
   *
   * Self-asserted, and that is fine: a device claiming to be a desktop can only
   * volunteer itself for work it will be bad at, on a server it is already
   * authenticated to. Worth saying plainly, though, because it decides how much
   * the check in pi/mcp.ts is worth: ⑦ is enforced against what a client SAID
   * when it spent its pairing code, not against what it is. Nothing verifies it,
   * and nothing can.
   */
  kind?: DeviceKind;
}

/** What a record claims to be, with the pre-field default applied. */
export function deviceKind(device: DeviceRecord): DeviceKind {
  return device.kind ?? 'desktop';
}

/** A freshly minted device, and the one moment its token is knowable. */
export interface MintedDevice {
  device: DeviceRecord;
  /** The bearer token, in the clear. Never stored server-side; hand it over once. */
  token: string;
}

interface DeviceStore {
  version: 2;
  devices: DeviceRecord[];
}

/** In-process copy so the hot path (every /rpc call) doesn't hit the disk. */
let cached: DeviceRecord[] | null = null;
/** Serializes reads and writes, so two callers can't both mint onto one file. */
let chain: Promise<unknown> = Promise.resolve();

/**
 * lastSeenAt is a diagnostic, and the transport authenticates on every request —
 * writing the file per call would turn a hot path into disk I/O for nothing. One
 * write a minute per device is plenty to answer "is this laptop still around".
 */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

/** The stored form of a token. Exported because pairing mints tokens too. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Run `task` after every registry operation already queued. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeDevices(devices: DeviceRecord[]): Promise<void> {
  const path = devicesStorePath();
  // quiet: a directory that genuinely could not be made takes the writeFile below
  // down with it, and that throws to the caller — this only absorbs the racing
  // second creator.
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const store: DeviceStore = { version: 2, devices };
  // `mode` only applies when the file is created, so chmod after the write is
  // what makes a rewrite onto an existing (or umask-widened) file 0600 too. The
  // file holds no secrets now, but it still says which devices can reach this
  // server, and that is nobody else's business.
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch((err) =>
    // The mode is the whole reason this call is here: without it a rewrite onto a
    // file that predates the `mode` argument, or one a wide umask created, keeps
    // whatever mode it had, and the list of who can reach this server stays
    // readable. The write succeeded, so nothing else will look wrong.
    degrade('transport.devices', 'left the device registry at a wider mode than 0600', err)
  );
  cached = devices;
}

function parseDevices(raw: string): DeviceRecord[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A registry that is there and will not parse is not the same as no registry:
    // loadDevices rebuilds it empty below, so every paired phone and second
    // desktop has to pair again, and the only way they learn is by being refused.
    degrade('transport.devices', 'discarded an unparseable device registry', err);
    return null;
  }
  const devices = (parsed as Partial<DeviceStore> | null)?.devices;
  if (!Array.isArray(devices)) return null;
  // A record that isn't well-formed is dropped rather than trusted: a malformed
  // hash can only ever lock a device out, and a missing role would be a hole.
  //
  // Two kinds of record from earlier releases are dropped on purpose:
  //
  //   `phone` — a security decision rather than tidying. A phone token used to be
  //   constrained by an allowlist; with the allowlist gone, honouring one would
  //   silently promote it to the full registry.
  //
  //   version 1's plaintext `token` — there is no migration that keeps such a
  //   record USEFUL. Hashing it would leave a record whose device cannot prove
  //   anything (the client of that era never kept a copy; it read the token back
  //   off this very file), so the entry would linger in Settings → Server → Devices
  //   forever, belonging to nobody. Dropping it costs nothing visible: the
  //   desktop mints itself a fresh record the next time it starts, off the same
  //   shared disk, exactly as it did before.
  return devices.flatMap((d): DeviceRecord[] => {
    if (!d || typeof d !== 'object') return [];
    const record = d as Omit<DeviceRecord, 'role'> & { role?: unknown };
    if (typeof record.id !== 'string') return [];
    if (typeof record.tokenHash !== 'string' || !HEX_64.test(record.tokenHash)) return [];
    if (record.role !== 'desktop' && record.role !== 'device') return [];
    return [
      {
        id: record.id,
        tokenHash: record.tokenHash,
        role: 'device',
        label: typeof record.label === 'string' ? record.label : 'Unnamed device',
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
        lastSeenAt: typeof record.lastSeenAt === 'string' ? record.lastSeenAt : null,
        // Carried through rather than defaulted: a device with no push token is
        // the ordinary case, and the field is absent rather than empty so an old
        // file and a new one round-trip to the same JSON.
        ...(typeof record.apnsToken === 'string' && record.apnsToken ? { apnsToken: record.apnsToken } : {}),
        ...(record.platform === 'ios' ? { platform: 'ios' as const } : {}),
        // Carried through rather than defaulted here, for the same reason as
        // apnsToken: a record from before the field existed must round-trip to
        // the bytes it arrived as. Read it through deviceKind(), never directly.
        ...(record.kind === 'desktop' || record.kind === 'mobile' ? { kind: record.kind } : {})
      }
    ];
  });
}

async function loadDevices(): Promise<DeviceRecord[]> {
  if (cached) return cached;
  try {
    const parsed = parseDevices(await readFile(devicesStorePath(), 'utf8'));
    if (parsed) {
      cached = parsed;
      return parsed;
    }
    // Present but unreadable (truncated write, hand-edit): fall through and
    // rebuild rather than lock every device out of a machine nobody can log into.
  } catch (err) {
    // Absent is the ordinary case — first boot, or an install from before the
    // registry existed. A read that fails for any other reason (a permission, a
    // bad disk) also rebuilds the file empty and un-pairs every device.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('transport.devices', 'rebuilt the device registry empty', err);
    }
  }
  await writeDevices([]);
  return [];
}

/** Every registered device. */
export function readDevices(): Promise<readonly DeviceRecord[]> {
  return enqueue(loadDevices);
}

/**
 * Register a new device and hand back its token — the only moment that token
 * exists anywhere but on the device itself. Callers must persist it client-side
 * (src/desktop/client-store.ts) or deliver it over the pairing response; there is
 * no second chance, by design.
 */
export function mintDevice(label: string, kind: DeviceKind = 'desktop'): Promise<MintedDevice> {
  return enqueue(async () => {
    const devices = await loadDevices();
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const device: DeviceRecord = {
      id: randomBytes(8).toString('hex'),
      tokenHash: hashToken(token),
      role: 'device',
      label: label.trim() || 'Unnamed device',
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      // Written out even for the default, because a record minted from here
      // KNOWS what it is — absence is reserved for records that predate the
      // question and can only be guessed at.
      kind
    };
    await writeDevices([...devices, device]);
    return { device, token };
  });
}

/**
 * Remove a device from the registry. Returns whether anything was removed —
 * false for an id that is already gone, which is a no-op rather than an error.
 *
 * This only invalidates the CREDENTIAL. A device with an open SSE stream keeps
 * receiving on it until somebody tears that stream down, which is why
 * startup/transport.ts pairs every revoke with dropDeviceStreams().
 */
export function revokeDevice(id: string): Promise<boolean> {
  return enqueue(async () => {
    const devices = await loadDevices();
    const remaining = devices.filter((d) => d.id !== id);
    if (remaining.length === devices.length) return false;
    await writeDevices(remaining);
    return true;
  });
}

/**
 * The record with no push fields at all. Rebuilt field by field rather than
 * spread-and-delete, so that clearing really removes both: the fields go away
 * together, because a record carrying a platform but no token would claim a push
 * network for a device we cannot address on it. Returns the SAME object when
 * there was nothing to clear, so a caller can tell a no-op from a change.
 */
function withoutPushToken(d: DeviceRecord): DeviceRecord {
  if (d.apnsToken === undefined && d.platform === undefined) return d;
  return {
    id: d.id,
    tokenHash: d.tokenHash,
    role: d.role,
    label: d.label,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    // Rebuilt field by field, so anything that is not a push field has to be
    // listed here or dropping a token would quietly demote a phone to a desktop
    // — and desktops are what get offered as MCP hosts.
    ...(d.kind ? { kind: d.kind } : {})
  };
}

/**
 * Record (or drop) the APNs token a device wants to be woken on. Returns whether
 * a record was touched — false for a device that is no longer registered, which
 * is a no-op rather than an error: a phone that was revoked mid-flight should not
 * be able to resurrect anything about itself by registering.
 *
 * Dropping is not only the phone's to ask for. APNs answers 410 for a token that
 * has gone (the app was deleted, the device restored), and the sender clears it
 * through here — otherwise every later push would spend a request proving the
 * same thing again.
 *
 * ONE TOKEN IS ONE APP INSTALL, so storing it here takes it away from every other
 * record. A phone that is unpaired and paired again keeps its native token (iOS
 * mints that per install, and knows nothing about our pairing) but arrives as a
 * NEW device row, since the old row's credential is what was withdrawn, not the
 * phone. Left alone, both rows would name the same phone and it would be woken
 * twice for everything, forever: APNs answers 200 to both, so the 410 healing
 * above never fires and nothing else would ever notice. The stale row keeps its
 * identity and its place in Settings → Server → Devices; it just stops being an
 * address.
 */
export function setDevicePushToken(
  id: string,
  apnsToken: string | null,
  platform: 'ios' = 'ios'
): Promise<boolean> {
  return enqueue(async () => {
    const devices = await loadDevices();
    if (!devices.some((d) => d.id === id)) return false;
    const next = devices.map((d) => {
      if (d.id !== id) {
        // Somebody else's row holding this very token: it is not theirs.
        return apnsToken && d.apnsToken === apnsToken ? withoutPushToken(d) : d;
      }
      if (!apnsToken) return withoutPushToken(d);
      if (d.apnsToken === apnsToken && d.platform === platform) return d;
      return { ...withoutPushToken(d), apnsToken, platform };
    });
    // Nothing moved — the ordinary case for a phone re-registering the token it
    // already had on launch, and not worth a file write.
    if (next.every((d, i) => d === devices[i])) return true;
    await writeDevices(next);
    return true;
  });
}

/**
 * Every device that has asked to be woken. The push sender's whole address book —
 * a device absent from here is one we have no way to reach out-of-band, which is
 * every device until an iOS client registers one.
 */
export async function devicesWithPushTokens(): Promise<readonly DeviceRecord[]> {
  return (await readDevices()).filter((d) => !!d.apnsToken);
}

/**
 * Which device presented this token, or null. Every record is compared even after
 * a match, so the answer takes the same time whichever device called (the loop
 * leaks only how many devices are registered, which is not a secret).
 */
export async function resolveDevice(presented: string | null | undefined): Promise<DeviceRecord | null> {
  const devices = await readDevices();
  if (typeof presented !== 'string' || presented === '') return null;
  const presentedHash = hashToken(presented);
  let matched: DeviceRecord | null = null;
  for (const device of devices) {
    if (hashEquals(device.tokenHash, presentedHash)) matched = device;
  }
  if (matched) noteDeviceSeen(matched);
  return matched;
}

/** Stamp lastSeenAt, at most once a LAST_SEEN_WRITE_INTERVAL_MS per device. */
function noteDeviceSeen(device: DeviceRecord): void {
  const now = Date.now();
  const last = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
  if (Number.isFinite(last) && now - last < LAST_SEEN_WRITE_INTERVAL_MS) return;
  const seenAt = new Date(now).toISOString();
  void enqueue(async () => {
    const devices = await loadDevices();
    const current = devices.find((d) => d.id === device.id);
    if (!current) return;
    await writeDevices(devices.map((d) => (d === current ? { ...d, lastSeenAt: seenAt } : d)));
    // The caller holds the pre-write object; keep it in step so the throttle
    // above sees the new timestamp without another read.
    device.lastSeenAt = seenAt;
    // quiet: lastSeenAt is only advanced by a write that landed, so a stamp that
    // failed leaves the throttle open and the next authenticated request past it
    // tries again.
  }).catch(() => undefined);
}

/** Drop the in-process copy (tests; also forces a re-read after an external edit). */
export function forgetCachedDevices(): void {
  cached = null;
}

/**
 * Constant-time digest compare. timingSafeEqual THROWS on a length mismatch, so
 * the lengths are compared first — that leaks only the digest length, which is a
 * fixed public constant (64 hex characters), not a secret.
 *
 * Both sides are already hashes here, so a timing leak would be worth much less
 * than it was against raw tokens. It stays constant-time because the cost is a
 * single comparison and the reasoning "the hash is not the secret" is exactly
 * the kind that stops being true when something else starts calling this.
 */
export function hashEquals(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The token a request presents: `Authorization: Bearer …`, and nothing else.
 *
 * There used to be a `?token=…` fallback, because `EventSource` cannot set
 * request headers and the phone's SSE stream had no other way in. Every
 * remaining client speaks node:http and sets the header on /events like any
 * other request, so the query form had no caller — and it is exactly the shape
 * that would have written a full-admin credential into a reverse proxy's access
 * log the moment Phase 2 puts one in front. Removed while nothing depends on it.
 */
export function presentedToken(headers: IncomingHttpHeaders): string | null {
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^bearer /i.test(auth)) {
    const value = auth.slice('bearer '.length).trim();
    if (value) return value;
  }
  return null;
}

/** What counts as a hostname Stem can legitimately be reached under. */
export interface OriginPolicy {
  /** The loopback port the server listens on; loopback Hosts must carry it. */
  port: number;
  /**
   * Extra Host values accepted verbatim. This is how a deployment that is fronted
   * by something — Caddy on a public domain, a test harness proxying the socket —
   * declares the name clients actually type, since by the time the request
   * arrives here the Host header carries THAT name and not our own port.
   */
  extraHosts?: readonly string[];
}

/**
 * Sec-Fetch-Site values that can't be a cross-site page driving us: `same-origin`
 * is our own client's fetch/EventSource, `none` is a user-initiated navigation
 * (typing the URL, a Home Screen icon). `same-site` and `cross-site` are refused
 * — nothing in the design produces them.
 */
const SAFE_FETCH_SITES = new Set(['same-origin', 'none']);

/** Split `host:port` (handling a bracketed IPv6 literal) into name + port. */
function splitHostPort(host: string): { name: string; port: string | null } {
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close === -1) return { name: host, port: null };
    const rest = host.slice(close + 1);
    return { name: host.slice(1, close), port: rest.startsWith(':') ? rest.slice(1) : null };
  }
  const colon = host.lastIndexOf(':');
  if (colon === -1) return { name: host, port: null };
  return { name: host.slice(0, colon), port: host.slice(colon + 1) };
}

function hostAllowed(host: string, policy: OriginPolicy): boolean {
  const lower = host.toLowerCase();
  if (policy.extraHosts?.some((h) => h.toLowerCase() === lower)) return true;
  const { name, port } = splitHostPort(lower);
  if (name === '127.0.0.1' || name === 'localhost' || name === '::1') {
    // A loopback Host must name our port: an attacker's rebound hostname would
    // reach the same socket but arrive under its own name, not this one.
    return port === String(policy.port);
  }
  // MagicDNS names on the tailnet (`<machine>.<tailnet>.ts.net`), which is the
  // only other way in — `tailscale serve` fronts us and nothing else resolves
  // there. The port is unconstrained: serve usually terminates TLS on 443.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(name);
}

/**
 * Why this request's origin is untrusted, or null when it is fine. Order matters
 * only for the error message; every check is independent.
 */
export function requestOriginProblem(headers: IncomingHttpHeaders, policy: OriginPolicy): string | null {
  const site = headers['sec-fetch-site'];
  if (typeof site === 'string' && !SAFE_FETCH_SITES.has(site)) {
    return `cross-origin request (Sec-Fetch-Site: ${site})`;
  }
  const host = typeof headers.host === 'string' ? headers.host : '';
  if (!host) return 'missing Host header';
  if (!hostAllowed(host, policy)) return `unexpected Host ${host}`;

  const origin = headers.origin;
  // 'null' is what a sandboxed/opaque origin sends — never one of ours.
  if (typeof origin === 'string' && origin !== '') {
    if (origin === 'null') return 'opaque Origin';
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      // quiet: the failure IS the answer. An Origin that will not parse is one
      // this server refuses, and the caller gets that sentence to say so.
      return `unparseable Origin ${origin}`;
    }
    if (originHost.toLowerCase() !== host.toLowerCase()) return `Origin ${origin} does not match Host ${host}`;
  }
  return null;
}
