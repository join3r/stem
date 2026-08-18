import { host } from '../host';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  embedSocketPath,
  folderIndexDir,
  piHome,
  piMcpConfigPath,
  piMcpDeviceCatalogPath,
  recallDbPath
} from '../workspace/paths';
import { RECALL_MCP_NAME, recallMcpServerPath } from '../recall/register-mcp';
import { getEmbedEndpointToken } from '../recall/embed-endpoint';
import { renderDeviceCatalogBlock, type DeviceCatalogBlock } from '../mcp-device/catalog';
import { execDeviceRouter } from '../exec-device/router';
import { connectedDeviceIds } from '../startup/transport';
import { readDevices } from '../transport/auth';
import type { DeviceMcpCatalog } from '../../shared/types';
import type { OAuthToken } from './oauth';
import {
  ENV_MCP_OAUTH,
  MCP_OAUTH_FILE,
  NATIVE_SEARCH_GATE_FILE,
  SECRET_ENVELOPE_KEY,
  SERVICE_TIER_GATE_FILE
} from './protocol';
import { decryptSecretValue, encryptSecretValue, secretKeyAvailable } from './secrets';
import { degrade } from '../degrade';

// Stem's MCP config for the pi backend (mcp.json). Consumed by the bridge
// extension (stem-mcp-extension.mjs), which pi loads via `-e`. Stem owns this file
// end-to-end under the isolated pi home.

/**
 * ENOENT is the ordinary answer for every file under the pi home until whoever
 * owns it writes it the first time; any other read failure is a file that exists
 * and could not be read, which is a different story and worth telling.
 */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export interface PiMcpServer {
  /** stdio transport */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP transport (Streamable HTTP, with a static header or OAuth) */
  url?: string;
  headers?: Record<string, string>;
  /**
   * Static OAuth client for remote servers that lack dynamic client registration
   * (e.g. Slack). When `oauthClientId` is present, mcpLogin runs the confidential-
   * client code flow instead of auto-registering. `oauthScope` is the requested
   * scope string (verbatim); the secret is needed because these servers are
   * confidential clients (`client_secret_post`).
   */
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthScope?: string;
  /** Stem-internal servers run without per-call confirmation. */
  trusted?: boolean;
  disabled?: boolean;
  /**
   * Where this server runs. Absent = the machine hosting stem-server, which is
   * what every entry has always meant and still means — so an existing mcp.json
   * round-trips byte for byte and nothing changes for it.
   *
   * The device is named (`devices.json`), never inferred from wherever you
   * happened to be typing: what "my computer" means has to be readable from the
   * config. Only desktops may be named — see the kind check in mcp.ts.
   *
   * Deliberately outside {@link mcpServerAuthIdentity}: moving a server between
   * machines does not change WHO it authenticates as, and folding it into that
   * hash would invalidate every stored OAuth token the moment this field lands.
   */
  location?: {
    deviceId: string;
    /**
     * What that device was called when this pin was written. A snapshot, kept so
     * an entry whose machine was re-paired (a new id for the same Mac) can say
     * which machine it meant. Never routed on and never compared to decide what
     * may run — see McpServerLocation.rememberedLabel for why.
     */
    label?: string;
  };
  /**
   * Which `env`/`headers` values were in the file and could not be decrypted,
   * filled in by {@link readMcpConfig} and stripped again on write. Derived, not
   * stored: it is a fact about this machine's key, not about the server.
   */
  lostSecrets?: string[];
}

export interface PiMcpConfig {
  servers: Record<string, PiMcpServer>;
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function mainRuntimeAssetPath(rel: string): string {
  const built = join(__dirname, rel);
  return existsSync(built) ? built : join(host().appRoot(), 'src', 'server', rel);
}

/** Absolute path to the bridge extension asset (mirrors recallMcpServerPath's basis). */
export function piExtensionPath(): string {
  return mainRuntimeAssetPath(join('pi', 'stem-mcp-extension.mjs'));
}

/** Where the bridge writes live connection status (next to mcp.json). */
export function piMcpStatusPath(): string {
  return join(piHome(), 'mcp-status.json');
}

/** Where the bridge writes the routed-tools names+signatures catalog (next to mcp.json). */
export function piMcpCatalogPath(): string {
  return join(piHome(), 'mcp-catalog.json');
}

// mtime-cached read of the routed-tools catalog. The file is static per pi-process
// lifetime (rewritten only when the bridge reconnects on a runtime restart), so we
// re-parse it only when its mtime changes rather than on every turn.
let catalogCache: { mtime: number; text: string } = { mtime: -1, text: '' };

/** The bridge's own catalog text: server-located servers, written by the extension. */
function bridgeCatalogText(): string {
  try {
    const mtime = statSync(piMcpCatalogPath()).mtimeMs;
    if (mtime !== catalogCache.mtime) {
      const data = JSON.parse(readFileSync(piMcpCatalogPath(), 'utf8')) as { text?: string };
      catalogCache = { mtime, text: typeof data.text === 'string' ? data.text : '' };
    }
    return catalogCache.text;
  } catch (error) {
    catalogCache = { mtime: -1, text: '' };
    // No file at all until the bridge's first publish, and nothing to list then.
    // A file that is there and unreadable is different: the extension rewrites it
    // in place, so a turn can read it torn, and that turn goes out with no
    // "Available tools" block — the model then says it has no such tool, which is
    // indistinguishable from the user never having added the server.
    if (!isMissing(error)) degrade('pi.mcpConfig', 'left every routed MCP tool out of this turn', error);
    return '';
  }
}

// The device catalog, parsed and mtime-cached the same way — but ONLY the parse.
// This file moves far more often than the bridge's (every announcement from every
// machine rewrites it), and the one thing that must never be cached is what the
// block is stamped with: whether each machine is reachable, which is asked fresh
// while the block is being built (③).
let deviceCatalogCache: { mtime: number; catalog: DeviceMcpCatalog } = {
  mtime: -1,
  catalog: { version: 1, devices: {} }
};

function deviceCatalog(): DeviceMcpCatalog {
  try {
    const mtime = statSync(piMcpDeviceCatalogPath()).mtimeMs;
    if (mtime !== deviceCatalogCache.mtime) {
      const parsed = JSON.parse(readFileSync(piMcpDeviceCatalogPath(), 'utf8')) as Partial<DeviceMcpCatalog>;
      const devices = parsed?.devices && typeof parsed.devices === 'object' ? parsed.devices : {};
      deviceCatalogCache = { mtime, catalog: { version: 1, devices } };
    }
    return deviceCatalogCache.catalog;
  } catch {
    // quiet: this file is written temp-then-rename, so what lands here is a
    // catalog no machine has announced into yet. One that truly cannot be read
    // is reported where it is owned (mcp-device/catalog.ts) and rebuilt by the
    // next announcement from every device.
    deviceCatalogCache = { mtime: -1, catalog: { version: 1, devices: {} } };
    return deviceCatalogCache.catalog;
  }
}

/** Drop both catalog caches (tests that rewrite the files under one process). */
export function forgetMcpCatalogCaches(): void {
  catalogCache = { mtime: -1, text: '' };
  deviceCatalogCache = { mtime: -1, catalog: { version: 1, devices: {} } };
}

/**
 * The per-turn "Available tools" block, injected alongside the files listing. Lists
 * routed MCP servers' tools as name + 1-line description + compact signature — the
 * heavy input schemas are deferred and fetched on demand via the bridge's
 * describe_tool. Returns null when there is nothing to list.
 *
 * Two sources, deliberately not one. The bridge writes mcp-catalog.json for the
 * servers it connects itself; the servers pinned to the user's own machines are
 * rendered here from what those machines announced, because only this process
 * knows — and only at the moment it is asked — which of them is awake. Neither
 * source parses the other: they are concatenated, and the sentence at the end
 * covers both.
 */
export async function buildMcpCatalogContext(): Promise<string | null> {
  const bridge = bridgeCatalogText().trim();
  const device = await buildDeviceCatalogSection();
  const exec = await buildExecHostSection();
  const text = [bridge, device.text].filter(Boolean).join('\n\n');
  const mcpBlock = text
    ? `Available tools (extra MCP servers, beyond your built-in file tools):\n${text}\n\n` +
      `To use any of these, call \`invoke_tool\` with the server name, the exact tool name, and an \`args\` object. ` +
      `The signatures above are compact — if a tool's arguments aren't obvious, call \`describe_tool\` first to get ` +
      `its full input schema. Do not invent servers or tools that aren't listed here.` +
      (device.anyAway
        ? ` A server marked NOT connected runs on one of the user's own machines, which is asleep or offline right now: ` +
          `its tools are real and will work again as soon as that computer is awake with Stem running on it. ` +
          `Say which machine that is rather than saying you cannot do the thing — calling one now fails with the same explanation.`
        : '')
    : '';
  const parts = [mcpBlock, exec].filter(Boolean);
  if (!parts.length) return null;
  return parts.join('\n\n');
}

/**
 * The one per-turn sentence about run_command's `device` targets, or empty when
 * no computer has ever said it runs commands (the common case — then the tool
 * parameter's own description is the only mention, and there is nothing to
 * name). Asked fresh each turn for the same reason the device catalog is: only
 * this moment knows which of those machines is awake.
 */
async function buildExecHostSection(): Promise<string> {
  const hosts = Object.values(await execDeviceRouter().hosts()).filter((h) => h.enabled);
  if (!hosts.length) return '';
  // quiet: loadDevices() already rebuilds an unreadable registry empty and
  // degrades under transport.devices, so a rejection here is the queue itself
  // failing — and the fault has been named once already, by the layer that has
  // the file open.
  const devices = await readDevices().catch(() => []);
  const labels = new Map(devices.map((d) => [d.id, d.label]));
  const connected = connectedDeviceIds();
  const listed = hosts
    // A host whose device was unpaired keeps nothing: it cannot be targeted,
    // and naming it would promise a computer that every call would refuse.
    .filter((h) => labels.has(h.deviceId))
    .map((h) => `“${labels.get(h.deviceId)}”${connected.has(h.deviceId) ? '' : ' (NOT connected right now)'}`);
  if (!listed.length) return '';
  return (
    `Computers that accept run_command's \`device\` target: ${listed.join(', ')}. ` +
    `A computer marked NOT connected will run commands again once it is awake with Stem running — say which ` +
    `machine that is rather than saying you cannot do the thing.`
  );
}

/**
 * The device-located section, or an empty one. Its shape and its wording live in
 * mcp-device/catalog.ts (which owns what a catalog is); what lives here is the
 * three per-turn facts it needs: which machines are up, what they are called,
 * and which of the announced servers mcp.json still points at them.
 *
 * That last one is a filter and not a merge. A device announces what it is
 * hosting, and the catalog keeps that across the disconnection — including,
 * briefly, a server the user has since disabled or unpinned while the machine
 * was away. mcp.json is the authority on what may be called, so a stale
 * announcement never puts a tool in the prompt that invoke_tool would refuse.
 */
async function buildDeviceCatalogSection(): Promise<DeviceCatalogBlock> {
  const catalog = deviceCatalog();
  if (Object.keys(catalog.devices).length === 0) return { text: '', anyAway: false };
  // A corrupt mcp.json throws, and every entry is unverifiable when it does —
  // so nothing is listed. The turn still goes out; the assistant simply cannot
  // see these servers, which is the honest state of a config nobody can read.
  const servers = await readMcpConfig().then(
    (config) => config.servers,
    () => ({}) as Record<string, PiMcpServer>
  );
  // quiet: same as buildExecHostSection — transport.devices owns this failure
  // and reports it. Here it costs only the friendly names: `label` falls back
  // to the device id, so the catalog still lists what can be called.
  const devices = await readDevices().catch(() => []);
  const labels = new Map(devices.map((d) => [d.id, d.label]));
  return renderDeviceCatalogBlock(catalog, {
    // The same fact DeviceMcpRouter.isAvailable() answers with, from the same
    // function, asked directly: the router reads mcp.json (this file) to find a
    // device's servers, so importing it here to ask one question would put a
    // cycle between the two for no additional truth.
    isAvailable: (deviceId) => connectedDeviceIds().has(deviceId),
    label: (deviceId) => labels.get(deviceId) ?? deviceId,
    include: (deviceId, name) => {
      const server = servers[name];
      return !!server && !server.disabled && server.location?.deviceId === deviceId;
    }
  });
}

/**
 * Per-turn gate the bridge reads to decide whether the vendored pi-web-access
 * search tools are active for this turn. The main process rewrites it just before
 * each prompt with the originating context's setting (main vs Quick Chat), since
 * both share one pi process and the hooks can't tell them apart. Carries no
 * credentials, so a plain (non-secret) file is fine.
 *
 * The file keeps its `native-search.json` name from when search WAS the provider's
 * own server-side tool: renaming it would strand the file in every existing pi
 * home for no behavioral gain.
 */
export function piNativeSearchPath(): string {
  return join(piHome(), NATIVE_SEARCH_GATE_FILE);
}

/** Write the `{ enabled }` web-search gate the bridge reads for the next turn. */
export async function writeNativeSearchGate(enabled: boolean): Promise<void> {
  await mkdir(piHome(), { recursive: true });
  await writeFile(piNativeSearchPath(), JSON.stringify({ enabled }, null, 2), 'utf8');
}

/**
 * Per-turn gate the bridge's service-tier hook reads to decide whether to inject the
 * OpenAI `service_tier` field on the next request. Like the web-search gate, the main
 * process rewrites it just before each prompt (main vs Quick Chat share one pi process).
 */
export function piServiceTierPath(): string {
  return join(piHome(), SERVICE_TIER_GATE_FILE);
}

/** Write the `{ tier }` gate: 'priority' = Fast; null = Standard (omit service_tier). */
export async function writeServiceTierGate(tier: string | null): Promise<void> {
  await mkdir(piHome(), { recursive: true });
  await writeFile(piServiceTierPath(), JSON.stringify({ tier }, null, 2), 'utf8');
}

/**
 * OAuth tokens for remote MCP servers, keyed by server name. Written by
 * PiRuntime.mcpLogin after a browser sign-in; the bridge reads it to inject the
 * bearer header and rewrites it when it refreshes an expired token.
 */
export function piMcpOAuthPath(): string {
  return process.env[ENV_MCP_OAUTH] ?? join(piHome(), MCP_OAUTH_FILE);
}

export async function readOAuthTokens(): Promise<Record<string, OAuthToken>> {
  return (await readOAuthTokensWithFormat()).tokens;
}

/**
 * Read the token map, reporting whether it was already encrypted at rest so the
 * boot migration can rewrite legacy plaintext files. An encrypted envelope that
 * no longer decrypts (lost/rotated key) reads as empty: the affected servers
 * come up 401 and the user signs in again — never a crash, never ciphertext
 * sent upstream as a bearer token.
 */
async function readOAuthTokensWithFormat(): Promise<{
  tokens: Record<string, OAuthToken>;
  encryptedAtRest: boolean;
}> {
  try {
    const parsed = JSON.parse(await readFile(piMcpOAuthPath(), 'utf8')) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      const envelope = parsed[SECRET_ENVELOPE_KEY];
      if (typeof envelope === 'string') {
        const plain = decryptSecretValue(envelope);
        if (plain === null) return { tokens: {}, encryptedAtRest: true };
        const inner = JSON.parse(plain) as Record<string, OAuthToken>;
        return { tokens: inner && typeof inner === 'object' ? inner : {}, encryptedAtRest: true };
      }
      return { tokens: parsed as unknown as Record<string, OAuthToken>, encryptedAtRest: false };
    }
  } catch (error) {
    // No file until the first server is signed in. One that exists and does not
    // parse costs every signed-in server its token at once, and the only thing
    // the user sees is being asked to sign in again to all of them.
    if (!isMissing(error)) degrade('pi.mcpConfig', 'read the OAuth token map as empty', error);
  }
  return { tokens: {}, encryptedAtRest: false };
}

/** Persist the token map, encrypted as a whole-file envelope when the key exists. */
async function writeOAuthTokensFile(all: Record<string, OAuthToken>): Promise<void> {
  const data = secretKeyAvailable()
    ? JSON.stringify({ [SECRET_ENVELOPE_KEY]: encryptSecretValue(JSON.stringify(all)) }, null, 2)
    : JSON.stringify(all, null, 2);
  await writeSecretFile(piMcpOAuthPath(), data);
}

/**
 * Write a credential-bearing file owner-only (0600) in an owner-only dir (0700).
 * mcp.json may carry bearer headers and mcp-oauth.json holds OAuth tokens, so
 * neither should be group/world-readable. The explicit chmod also tightens a
 * file that already exists with looser perms (the `mode` create-option is
 * ignored when the file is merely truncated).
 *
 * The write is atomic: data goes to a sibling temp file that is then renamed over
 * the target. A crash or force-quit mid-write can therefore only leave a stray
 * `.tmp` (harmlessly overwritten next time) — never a truncated mcp.json, which
 * used to read back as corrupt and get reset to an empty server list, silently
 * dropping every user-added server.
 */
async function writeSecretFile(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path); // atomic on the same filesystem (same dir)
  } finally {
    // quiet: the temp is created 0600 inside the 0700 dir, so one that survives
    // is exactly as unreadable to anyone else as the file it was to become. It
    // is litter, and litter is what the stray-`.tmp` note above already allows.
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

let oauthMutationTail: Promise<void> = Promise.resolve();
let mcpStateMutationTail: Promise<void> = Promise.resolve();

const FILE_LOCK_STALE_MS = 30_000;
const FILE_LOCK_WAIT_MS = 15_000;

/** Only one waiter may reap an abandoned lock. Without this tiny secondary
 * lock, two waiters can both decide the old inode is stale and the slower one
 * can accidentally unlink the faster waiter's newly-acquired lock. */
async function reapAbandonedLock(lockPath: string): Promise<boolean> {
  const reaperPath = `${lockPath}.reaper`;
  let reaper: Awaited<ReturnType<typeof open>>;
  try {
    reaper = await open(reaperPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs <= FILE_LOCK_STALE_MS) return false;
    } catch {
      // quiet: the stat failing means the lock is already gone, which is the
      // answer reaping it was looking for.
      return true;
    }
    await rm(lockPath, { force: true });
    return true;
  } finally {
    // quiet: a descriptor this process holds until it exits.
    await reaper.close().catch(() => undefined);
    // quiet: a reaper file that survives makes every later reap answer false on
    // EEXIST, so a genuinely stale lock stops being recoverable — and that
    // arrives as the lock timeout, which throws with its own message.
    await rm(reaperPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Cross-process, owner-tagged lock used by main and the MCP bridge. The owner
 * check matters when recovering an abandoned lock: an old owner must never
 * unlink a successor's lock from its `finally` block.
 */
async function withOwnedFileLock<T>(
  lockPath: string,
  timeoutMessage: string,
  operation: () => Promise<T>
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + FILE_LOCK_WAIT_MS;
  const owner = `${process.pid}:${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(owner, 'utf8');
    } catch (error) {
      if (handle) {
        // quiet: a descriptor this process holds until it exits.
        await handle.close().catch(() => undefined);
        // quiet: the lock file this branch is abandoning was never stamped with
        // an owner, so it is already the stale case — the reap 30s later is the
        // path that clears it, and it needs no help from here.
        await rm(lockPath, { force: true }).catch(() => undefined);
        handle = undefined;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > FILE_LOCK_STALE_MS) {
          if (await reapAbandonedLock(lockPath)) continue;
        }
      } catch {
        // quiet: it disappeared between open/stat, so the wait is over; retry
        // immediately and take it.
        continue;
      }
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await operation();
  } finally {
    // quiet: a descriptor this process holds until it exits.
    await handle.close().catch(() => undefined);
    // quiet: '' is the safe answer and the one this check wants. It cannot equal
    // `owner`, so an unreadable lock file is left alone rather than unlinked out
    // from under whoever holds it now — the invariant the owner tag exists for.
    const currentOwner = await readFile(lockPath, 'utf8').catch(() => '');
    // quiet: a lock that outlives its owner is what FILE_LOCK_STALE_MS is for;
    // the next waiter reaps it 30s on. The cost is a wait, not a lost write.
    if (currentOwner === owner) await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function withOAuthFileLock<T>(operation: () => Promise<T>): Promise<T> {
  return withOwnedFileLock(
    `${piMcpOAuthPath()}.lock`,
    'Timed out waiting to update MCP OAuth credentials.',
    operation
  );
}

/**
 * Serialize changes whose security invariant spans both mcp.json and its token
 * map. The bridge uses the same `.state.lock` path before persisting refreshes.
 */
export async function withMcpStateMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mcpStateMutationTail;
  let release!: () => void;
  mcpStateMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await withOwnedFileLock(
      `${piMcpConfigPath()}.state.lock`,
      'Timed out waiting to update MCP configuration.',
      operation
    );
  } finally {
    release();
  }
}

async function serializeOAuthMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = oauthMutationTail;
  let release!: () => void;
  oauthMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await withOAuthFileLock(operation);
  } finally {
    release();
  }
}

export async function saveOAuthToken(name: string, token: OAuthToken): Promise<void> {
  await serializeOAuthMutation(async () => {
    const all = await readOAuthTokens();
    all[name] = token;
    await writeOAuthTokensFile(all);
  });
}

export async function deleteOAuthToken(name: string): Promise<void> {
  await serializeOAuthMutation(async () => {
    const all = await readOAuthTokens();
    if (!(name in all)) return;
    delete all[name];
    await writeOAuthTokensFile(all);
  });
}

/** Delete only the credential snapshot the caller inspected, never a newer login. */
export async function deleteOAuthTokenIfMatches(name: string, expected: OAuthToken): Promise<boolean> {
  return serializeOAuthMutation(async () => {
    const all = await readOAuthTokens();
    if (!all[name] || JSON.stringify(all[name]) !== JSON.stringify(expected)) return false;
    delete all[name];
    await writeOAuthTokensFile(all);
    return true;
  });
}

/** Stable identity determining whether a stored OAuth token may be reused. */
export function mcpServerAuthIdentity(server: PiMcpServer | undefined): string | null {
  if (!server?.url) return null;
  const headers = server.headers
    ? Object.fromEntries(Object.entries(server.headers).sort(([a], [b]) => a.localeCompare(b)))
    : null;
  const serialized = JSON.stringify([
    server.url,
    headers,
    server.oauthClientId ?? null,
    server.oauthClientSecret ?? null,
    server.oauthScope ?? null
  ]);
  return createHash('sha256').update(serialized).digest('hex');
}

/** True only for identity-stamped tokens; legacy name-only records are unsafe. */
export function oauthTokenMatchesServer(token: OAuthToken | undefined, server: PiMcpServer | undefined): boolean {
  const identity = mcpServerAuthIdentity(server);
  return !!identity && !!token?.serverIdentity && token.serverIdentity === identity;
}

/**
 * One-time repair for tokens saved before the identity stamp existed: they lack
 * `serverIdentity`, so the bridge (correctly) refuses to attach them and every
 * previously-signed-in remote server comes up 401 until the user re-logs-in.
 * Stamping them with the CURRENT identity of the server they're keyed to grants
 * exactly the trust they had when saved — the name-keyed binding — without
 * weakening the stamp check for anything saved afterwards. Tokens whose server no
 * longer exists (or is stdio) are left untouched, as are already-stamped tokens,
 * including mismatched ones (a repointed server must force a fresh login).
 */
export async function migrateLegacyOAuthTokens(): Promise<void> {
  await withMcpStateMutation(async () => {
    const config = await readMcpConfig();
    await serializeOAuthMutation(async () => {
      const { tokens: all, encryptedAtRest } = await readOAuthTokensWithFormat();
      // A plaintext legacy file gets rewritten encrypted even when no stamp
      // changes — this is the one-time encrypt-at-rest migration.
      let changed = !encryptedAtRest && Object.keys(all).length > 0 && secretKeyAvailable();
      for (const [name, token] of Object.entries(all)) {
        if (token.serverIdentity) continue;
        const identity = mcpServerAuthIdentity(config.servers[name]);
        if (!identity) continue;
        all[name] = { ...token, serverIdentity: identity };
        changed = true;
      }
      if (changed) await writeOAuthTokensFile(all);
    });
  });
}

/** Persist a completed browser login only if its server identity is still current. */
export async function saveOAuthTokenIfServerMatches(
  name: string,
  expectedIdentity: string,
  token: OAuthToken
): Promise<boolean> {
  return withMcpStateMutation(async () => {
    const current = (await readMcpConfig()).servers[name];
    if (mcpServerAuthIdentity(current) !== expectedIdentity) return false;
    await saveOAuthToken(name, { ...token, serverIdentity: expectedIdentity });
    return true;
  });
}

/** The reserved stem-recall entry the bridge always spawns. */
function recallServerEntry(): PiMcpServer {
  return {
    command: host().nodeSpawn().command,
    args: [recallMcpServerPath()],
    env: {
      ...host().nodeSpawn().env,
      STEM_RECALL_DB: recallDbPath(),
      // Query-embed channel for hybrid search (embed-endpoint.ts). The token is a
      // lazy singleton, so reading it here at bootstrap is safe even before (or
      // without) the endpoint actually listening — the server falls back to
      // keyword-only whenever the socket doesn't answer.
      STEM_EMBED_SOCK: embedSocketPath(),
      STEM_EMBED_TOKEN: getEmbedEndpointToken(),
      // Indexed connected folders: the server re-reads manifest.json in this dir
      // on every search_folder_docs call, so new indexes need no pi restart.
      STEM_FOLDER_INDEX_DIR: folderIndexDir()
    },
    trusted: true
  };
}

/**
 * Field-level secrets in mcp.json: header values (bearer tokens), stdio env
 * values (API keys, the embed-endpoint token), and the static OAuth client
 * secret are encrypted on write and decrypted on read, so the parsed config in
 * memory is always plaintext — mcpServerAuthIdentity therefore hashes the same
 * bytes it always has, keeping existing token identity stamps valid. A value
 * that no longer decrypts is dropped (the server re-auths) rather than sent
 * upstream as ciphertext.
 */
function encryptServerSecrets(server: PiMcpServer): PiMcpServer {
  const out = { ...server };
  // Derived on read and never persisted: a config that had been read and written
  // back would otherwise grow a field describing a decryption failure that may
  // not even be true of the next machine to open it.
  delete out.lostSecrets;
  if (out.headers) {
    out.headers = Object.fromEntries(Object.entries(out.headers).map(([k, v]) => [k, encryptSecretValue(v)]));
  }
  if (out.env) {
    out.env = Object.fromEntries(Object.entries(out.env).map(([k, v]) => [k, encryptSecretValue(v)]));
  }
  if (out.oauthClientSecret) out.oauthClientSecret = encryptSecretValue(out.oauthClientSecret);
  return out;
}

/**
 * Decrypt a map of secret values, reporting which of them did not survive.
 *
 * A value that no longer decrypts is dropped rather than passed on as
 * ciphertext, which is right — but dropping it SILENTLY is what makes a lost
 * credential indistinguishable from a deleted one. Downstream the difference is
 * a whole sentence: the machine hosting the server sees a spec whose fingerprint
 * moved and says it "changed — approve it again", which reads as somebody's
 * edit, when what actually happened is that the key that opened this value is
 * gone (an import with the wrong passphrase is the usual way) and approving it
 * starts a server without its API key.
 */
function decryptRecord(record: Record<string, string>): { values: Record<string, string>; lost: string[] } {
  const entries: Array<[string, string]> = [];
  const lost: string[] = [];
  for (const [k, v] of Object.entries(record)) {
    const plain = decryptSecretValue(v);
    if (plain !== null) entries.push([k, plain]);
    else lost.push(k);
  }
  return { values: Object.fromEntries(entries), lost };
}

function decryptServerSecrets(server: PiMcpServer): PiMcpServer {
  const out = { ...server };
  const lost: string[] = [];
  if (out.headers) {
    const decrypted = decryptRecord(out.headers);
    out.headers = decrypted.values;
    lost.push(...decrypted.lost);
  }
  if (out.env) {
    const decrypted = decryptRecord(out.env);
    out.env = decrypted.values;
    lost.push(...decrypted.lost);
  }
  if (out.oauthClientSecret) {
    const plain = decryptSecretValue(out.oauthClientSecret);
    // Dropping it and saying nothing is the exact failure the doc comment above
    // describes, so it goes on `lost` with the headers and env values.
    if (plain === null) {
      delete out.oauthClientSecret;
      lost.push('oauthClientSecret');
    } else out.oauthClientSecret = plain;
  }
  // Absent rather than empty when nothing was lost, so the ordinary case adds no
  // field to a config that gets compared, hashed and written back.
  if (lost.length > 0) out.lostSecrets = lost.sort();
  else delete out.lostSecrets;
  return out;
}

/** mcp.json parsed as far as `.corrupt`: unusable, but its bytes are preserved. */
export class McpConfigCorrupt extends Error {}

/**
 * mcp.json is on disk, intact, and would not open — EACCES after a permission
 * change, EIO on a failing disk, EBUSY behind a scanner. Distinct from
 * {@link McpConfigCorrupt} because there is nothing preserved and nothing to
 * rebuild from: the servers are still in that file, so the only safe move is to
 * leave it alone.
 */
export class McpConfigUnreadable extends Error {}

/**
 * Read mcp.json, distinguishing a genuinely missing file (legitimate first run →
 * fresh config) from one that exists but did not yield a config. Neither failing
 * case may be silently treated as empty: callers that read-modify-write (notably
 * {@link ensureMcpConfig}) would then persist that emptiness and wipe every
 * user-added server. A corrupt file has its bytes preserved to a `.corrupt`
 * sibling; an unreadable one is left exactly where it is. Both throw, so the loss
 * is visible and recoverable rather than silent.
 */
export async function readMcpConfig(): Promise<PiMcpConfig> {
  let raw: string;
  try {
    raw = await readFile(piMcpConfigPath(), 'utf8');
  } catch (error) {
    // ENOENT is the first run this promises to distinguish. Anything else is a
    // file that IS there and did not open; returning the same empty config for it
    // is what would write emptiness back over every server the user added — with
    // not even a `.corrupt` copy to recover from, since we never got the bytes.
    if (!isMissing(error)) {
      throw new McpConfigUnreadable(`mcp.json could not be read: ${String(error)}`);
    }
    return { servers: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PiMcpConfig>;
    if (parsed && typeof parsed === 'object' && parsed.servers) {
      return {
        servers: Object.fromEntries(
          Object.entries(parsed.servers).map(([name, server]) => [name, decryptServerSecrets(server)])
        )
      };
    }
    throw new Error('mcp.json has no "servers" object');
  } catch (e) {
    await writeFile(`${piMcpConfigPath()}.corrupt`, raw, { encoding: 'utf8', mode: 0o600 }).catch(
      (writeError) =>
        // The throw below names a file to recover from, and ensureMcpConfig
        // rebuilds mcp.json empty on the strength of it. If the copy never
        // landed, that rebuild is the moment every user-added server is gone
        // with nothing to restore — and the error the user reads still points
        // at a path that does not exist.
        degrade('pi.mcpConfig', 'kept no .corrupt copy of the unreadable mcp.json', writeError)
    );
    throw new McpConfigCorrupt(`mcp.json is corrupt (preserved at ${piMcpConfigPath()}.corrupt): ${String(e)}`);
  }
}

export async function writeMcpConfig(config: PiMcpConfig): Promise<void> {
  // mcp.json can carry remote-server auth headers (e.g. `Authorization: Bearer …`)
  // and stdio env tokens; those fields go to disk encrypted (see above).
  const servers = Object.fromEntries(
    Object.entries(config.servers).map(([name, server]) => [name, encryptServerSecrets(server)])
  );
  await writeSecretFile(piMcpConfigPath(), JSON.stringify({ servers }, null, 2));
}

/**
 * Ensure mcp.json exists with a fresh stem-recall entry (paths can change between
 * runs), preserving any user-added servers. Idempotent; called at bootstrap.
 *
 * The one write that does NOT go through `writeServers` in pi/mcp.ts, and so the
 * one that tells no device its assignments moved. That is correct only because
 * what it touches is the reserved recall entry, which is never pinned anywhere —
 * `RESERVED_NAMES` refuses a location for it, and it reads a database that only
 * exists on this machine. If a reserved server ever does gain a location, this
 * becomes a silent hole and the write belongs behind the same notification as
 * every other one.
 */
export async function ensureMcpConfig(): Promise<void> {
  await withMcpStateMutation(async () => {
    let config: PiMcpConfig;
    try {
      config = await readMcpConfig();
    } catch (error) {
      if (!(error instanceof McpConfigCorrupt)) {
        // The file is there and intact and merely would not open. Rebuilding
        // from an empty config here would overwrite servers that are still on
        // disk and still recoverable — a permission slip turned into permanent
        // loss. Leave it; recall runs on whatever entry the file already has,
        // and the next bootstrap after the cause clears fixes it for free.
        degrade('pi.mcpConfig', 'left mcp.json untouched and did not refresh the recall entry', error);
        return;
      }
      // Corrupt mcp.json (already preserved as `.corrupt` by readMcpConfig). Start
      // fresh so recall and the app keep working; the backup keeps any recoverable
      // user servers around instead of erasing them without a trace. The user's
      // servers disappear from the MCP tab in the same breath, so say which run
      // did it rather than leaving a `.corrupt` file to be found later.
      degrade('pi.mcpConfig', 'rebuilt mcp.json without the user-added servers', error);
      config = { servers: {} };
    }
    config.servers[RECALL_MCP_NAME] = recallServerEntry();
    await writeMcpConfig(config);
  });
}
