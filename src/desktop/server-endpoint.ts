import { hostname } from 'node:os';
import { access } from 'node:fs/promises';
import { markDeviceLocal, mintDevice } from '../server/transport/auth';
import { serverEndpointPath } from '../server/workspace/paths';
import { log } from '../server/log';
import {
  clearClientIdentity,
  readClientDocument,
  readClientIdentity,
  storedServerUrl,
  writeClientIdentity
} from './client-store';
import { EXTERNAL_SERVER_URL } from './proxy';

// Which server this client talks to, and how it gets a credential for it.
//
// The ADDRESS comes from three places, most explicit first:
//
//   1. STEM_SERVER_URL — the test/override path, pinned for one launch.
//   2. client.json — set by Settings → Server, which is how a paired Mac
//      remembers its VPS.
//   3. Nothing, which means the embedded server this process starts itself.
//      Still the default: a fresh install runs its own backend, and remote is
//      opt-in (Phase 2's locked decision).
//
// The CREDENTIAL is not handed out by the server any more. It keeps hashes, so a
// token exists only on the device that owns it, and there are exactly four ways
// this machine can be holding one — tried in this order, most explicit first:
//
//   1. STEM_SERVER_TOKEN — an override for a harness or a one-off. Never stored.
//   2. client.json — we have been here before. The ordinary path after first run.
//   3. STEM_PAIRING_CODE — a one-shot code, spent on POST /pair. This is the
//      remote path: the code is the only thing that has to travel by hand, and
//      what comes back is stored for next time.
//   4. Mint one directly, which only works because the server reads the same
//      state root we are writing (an embedded server always does; a `stem-server`
//      that published its endpoint here does too). No pairing step, because there
//      is no trust boundary to cross: anything that can write that registry could
//      read the chat database beside it.
//
// A remote server with no code and no stored identity is a hard failure with a
// sentence saying so, rather than a mysterious 401 loop.

/** Everything the proxy needs to reach the server. */
export interface ServerCredentials {
  url: string;
  token: string;
}

/** Trailing slashes off, so the stored form and the compared form always agree. */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * The server to connect to this launch, or null for the one we start ourselves.
 * `pinnedByEnv` is what Settings → Server reads to explain why its form is inert.
 */
export async function resolveServerUrl(): Promise<{ url: string | null; pinnedByEnv: boolean }> {
  if (EXTERNAL_SERVER_URL) return { url: normalizeUrl(EXTERNAL_SERVER_URL), pinnedByEnv: true };
  const stored = await storedServerUrl();
  return { url: stored ? normalizeUrl(stored) : null, pinnedByEnv: false };
}

/** How this machine will appear in Settings → Server → Devices. */
function deviceLabel(): string {
  try {
    return hostname() || 'This machine';
  } catch {
    return 'This machine';
  }
}

/** Whether the server reads the state root we write — see reason 4 above. */
async function sharesStateRoot(): Promise<boolean> {
  try {
    await access(serverEndpointPath());
    return true;
  } catch {
    return false;
  }
}

/**
 * Spend a pairing code at `url` and keep what comes back. `remember` stores the
 * address alongside the credential, which is only right when the address will
 * still be valid next launch — an embedded server's port is not.
 */
export async function pairWithServer(
  rawUrl: string,
  code: string,
  remember = true
): Promise<ServerCredentials> {
  const url = normalizeUrl(rawUrl);
  if (!/^https?:\/\/[^/]+/i.test(url)) {
    throw new Error(`"${rawUrl.trim()}" is not a server address — it needs to start with http:// or https://.`);
  }
  let res: Response;
  try {
    res = await fetch(`${url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `kind` is what this client is, and every client that runs this file is a
      // desktop app on somebody's computer — which is what makes it eligible to
      // host a pinned MCP server later (docs/mcp-device-pinning.md).
      body: JSON.stringify({ code, kind: 'desktop' }),
      signal: AbortSignal.timeout(30_000)
    });
  } catch (e) {
    throw new Error(`could not reach ${url} to pair: ${String((e as Error)?.message ?? e)}`);
  }
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; result?: { deviceId?: string; token?: string }; error?: string }
    | null;
  const grant = body?.result;
  if (!res.ok || !body?.ok || !grant?.deviceId || !grant.token) {
    throw new Error(body?.error ?? `pairing was refused (HTTP ${res.status})`);
  }
  await writeClientIdentity({ deviceId: grant.deviceId, token: grant.token }, remember ? url : null);
  log('client', 'paired with the server', { deviceId: grant.deviceId, remembered: remember });
  return { url, token: grant.token };
}

/** Forget the configured server and its credential; the next launch runs its own. */
export async function useBuiltInServer(): Promise<void> {
  await clearClientIdentity();
  log('client', 'went back to the built-in server');
}

/**
 * Resolve this client's credentials for `serverUrl`, acquiring one if this is the
 * first time. Throws when there is no way to get one, because a client that
 * cannot authenticate has nothing useful to do next.
 *
 * `external` says whether the address outlives this launch — it is what decides
 * whether a credential acquired here is filed under an address at all.
 */
export async function clientCredentials(
  serverUrl: string,
  { external }: { external: boolean }
): Promise<ServerCredentials> {
  const url = normalizeUrl(serverUrl);

  const fromEnv = process.env.STEM_SERVER_TOKEN?.trim();
  if (fromEnv) return { url, token: fromEnv };

  const doc = await readClientDocument();
  const storedFor = typeof doc.serverUrl === 'string' ? normalizeUrl(doc.serverUrl) : null;
  // A token is only meaningful to the server that issued it. When the stored one
  // names a different address than the one we are dialling — STEM_SERVER_URL
  // pointed somewhere else, say — using it would buy a 401 loop, so acquire a
  // fresh credential for where we are actually going instead.
  if (storedFor && storedFor !== url) {
    log('client', 'the stored credential belongs to another server', { stored: storedFor, wanted: url });
  } else {
    const stored = await readClientIdentity();
    if (stored) {
      // Migration for a record minted before the `local` flag existed: an
      // embedded (or same-machine stem-server) client's stored identity lives
      // in the server's own devices.json (shared state root), so marking it
      // here is the same in-process proof of shared disk as minting with the
      // flag would have been. A genuinely remote server keeps its registry
      // elsewhere — the id is absent from the local file and the mark no-ops.
      if (await sharesStateRoot()) {
        await markDeviceLocal(stored.deviceId).catch((e) =>
          // quiet-ish: without the mark, file drops and path attachments are
          // refused as if this client were remote — visible, not dangerous.
          log('client', 'could not mark this machine\'s device record local', { error: String(e) })
        );
      }
      return { url, token: stored.token };
    }
  }

  const code = process.env.STEM_PAIRING_CODE?.trim();
  if (code) return pairWithServer(url, code, external);

  if (await sharesStateRoot()) {
    // `local: true` because minting straight into the server's own devices.json
    // proves the two halves share a disk — the one client whose filesystem
    // paths mean the same thing on both ends, which is what lets it keep
    // passing raw paths where every transported device must upload (SEC-002).
    const minted = await mintDevice(deviceLabel(), 'desktop', { local: true });
    await writeClientIdentity({ deviceId: minted.device.id, token: minted.token }, external ? url : null);
    log('client', 'minted this machine a device record', { deviceId: minted.device.id });
    return { url, token: minted.token };
  }

  throw new Error(
    `no credential for ${url}, and none can be minted here — that server keeps its state somewhere ` +
      'this machine cannot see. Pair instead: run `stem-server pair` where the server is, and start ' +
      'Stem with STEM_PAIRING_CODE set to the code it prints.'
  );
}
