import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { host } from '../server/host';
import { log } from '../server/log';
import type { ClientSettings } from '../shared/types';

// What this CLIENT knows about itself: which server it talks to, its row in that
// server's device registry, the bearer token that proves it, and the handful of
// settings that describe this machine rather than Stem.
//
// This file is new in Phase 2, and it is the first client-side state Stem has
// ever had. It exists because the server stopped keeping tokens: devices.json
// holds hashes now, so the credential has to live on the device it belongs to or
// nowhere at all. A client learns its token exactly once — minting it off a
// shared state root, or spending a pairing code — and this is where it keeps it.
//
// The token is wrapped with the host's key wrapper (Electron safeStorage → the
// macOS Keychain) when one is available, and written as plaintext 0600 when it is
// not — the same documented degradation pi/secrets.ts takes, for the same reason:
// a Linux box with no keyring must still be able to run Stem, and 0600 in a
// directory that already holds the chat database is not a new exposure.
//
// `serverUrl` is deliberately sticky: once a machine has been pointed at a
// server, only the explicit "use the built-in server" action (clearClientIdentity)
// forgets the address. Rewriting the identity never does. Losing the address is
// strictly worse than holding a stale credential for it: a stale token is a 401
// against the right server, visible and fixable by re-pairing, while a lost
// address silently boots an empty embedded server that reads as "my Stem is
// gone" (happened twice — 2026-08-15 and 2026-08-21, both times a test run
// against the real profile minted an identity and took the address with it).

/** This client's identity as far as the server is concerned. */
export interface ClientIdentity {
  deviceId: string;
  /** The bearer token, in the clear. In memory and in this file, nowhere else. */
  token: string;
}

interface StoredClient {
  version: 1;
  deviceId?: string;
  /** Present when no key wrapper was available. */
  token?: string;
  /** Base64 of the wrapped token; preferred when present. */
  tokenEnc?: string;
  /** The server this client was paired with; absent = the one it starts itself. */
  serverUrl?: string;
  /** Absent until the one-time migration in ./settings.ts has run. */
  settings?: ClientSettings;
}

export function clientStorePath(): string {
  // STEM_CLIENT_FILE lets tests point at a throwaway file, like its neighbours
  // under server/workspace/paths.ts.
  return process.env.STEM_CLIENT_FILE ?? join(host().stateRoot(), 'client.json');
}

/** The raw document, or an empty one when there isn't a readable file yet. */
export async function readClientDocument(): Promise<StoredClient> {
  try {
    const stored = JSON.parse(await readFile(clientStorePath(), 'utf8')) as StoredClient;
    if (stored && typeof stored === 'object') return stored;
  } catch {
    // Absent, or half-written by a kill during the write below. Either way there
    // is nothing to recover and starting over is the only useful behavior.
  }
  return { version: 1 };
}

// Serialize read-modify-writes through a promise chain (see workspace/settings.ts)
// so a pairing and a settings toggle landing together cannot lose one of the two.
let chain: Promise<unknown> = Promise.resolve();

/**
 * Apply `mutate` to the stored document and persist the result. The whole
 * read-modify-write is inside the chain, which is the point: every writer here
 * touches one part of one file, and the parts are written by different subsystems
 * at unrelated moments.
 */
export function updateClientDocument<T>(mutate: (doc: StoredClient) => T | Promise<T>): Promise<T> {
  const task = async (): Promise<T> => {
    const doc = await readClientDocument();
    const result = await mutate(doc);
    const path = clientStorePath();
    await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
    // Write-then-rename, so a kill mid-write can't leave a half-written file.
    // A torn client.json parses as "fresh install" (readClientDocument above),
    // and a fresh install silently starts an embedded server where the user's
    // real one used to be — the address and credential must survive or the file
    // must stay whole, never in between.
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ ...doc, version: 1 }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await rename(tmp, path);
    // The rename carries the tmp file's 0600 along, but an existing file replaced
    // on Windows can differ; re-assert either way.
    await chmod(path, 0o600).catch(() => undefined);
    return result;
  };
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** This client's stored identity, or null if it has never had one. */
export async function readClientIdentity(): Promise<ClientIdentity | null> {
  const stored = await readClientDocument();
  if (typeof stored.deviceId !== 'string' || !stored.deviceId) return null;

  if (typeof stored.tokenEnc === 'string') {
    const wrapper = host().keyWrapper();
    try {
      if (!wrapper) throw new Error('no key wrapper');
      const token = wrapper.unwrap(Buffer.from(stored.tokenEnc, 'base64'));
      if (token) return { deviceId: stored.deviceId, token };
    } catch (e) {
      // A keychain reset, or a profile copied to another machine. The credential
      // is simply gone; say so and let the caller acquire a new one rather than
      // failing to start.
      log('client', 'could not unwrap the stored token', { error: String((e as Error)?.message ?? e) });
      return null;
    }
  }
  if (typeof stored.token === 'string' && stored.token) {
    return { deviceId: stored.deviceId, token: stored.token };
  }
  return null;
}

/**
 * Persist an identity acquired by minting or pairing, replacing any previous one.
 * `serverUrl` is the address it belongs to, or null for a server this machine
 * starts itself (whose port is ephemeral, so there is no address worth storing).
 *
 * Null PRESERVES a stored address rather than deleting it (see the header): an
 * embedded-server mint can only happen when no address is stored — the launch
 * would have dialled the address otherwise — so on every legitimate path this
 * is a no-op, and on the illegitimate one (a stray process minting against this
 * file) it keeps the user's server reachable. Only clearClientIdentity, the
 * explicit "use the built-in server" action, forgets an address.
 *
 * The machine's settings are deliberately untouched: re-pairing a laptop is not
 * a reason to forget its hotkey.
 */
export function writeClientIdentity(identity: ClientIdentity, serverUrl: string | null = null): Promise<void> {
  return updateClientDocument((doc) => {
    delete doc.token;
    delete doc.tokenEnc;
    doc.deviceId = identity.deviceId;
    if (serverUrl) doc.serverUrl = serverUrl;

    const wrapper = host().keyWrapper();
    if (wrapper) {
      try {
        doc.tokenEnc = wrapper.wrap(identity.token).toString('base64');
        return;
      } catch (e) {
        // Wrapping failed at the last moment (a locked keychain): fall back to the
        // plaintext form rather than leaving the device with no credential at all.
        log('client', 'could not wrap the token; storing it 0600 instead', {
          error: String((e as Error)?.message ?? e)
        });
      }
    }
    doc.token = identity.token;
  });
}

/**
 * Forget the configured server and the credential that went with it, so the next
 * launch starts Stem's own server and mints itself a fresh record.
 */
export function clearClientIdentity(): Promise<void> {
  return updateClientDocument((doc) => {
    delete doc.deviceId;
    delete doc.token;
    delete doc.tokenEnc;
    delete doc.serverUrl;
  });
}

/** The server this client is configured to use, or null for the built-in one. */
export async function storedServerUrl(): Promise<string | null> {
  const { serverUrl } = await readClientDocument();
  return typeof serverUrl === 'string' && serverUrl.trim() ? serverUrl.trim() : null;
}
