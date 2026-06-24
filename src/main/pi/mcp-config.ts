import { app } from 'electron';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { piHome, piMcpConfigPath, recallDbPath } from '../workspace/paths';
import { RECALL_MCP_NAME, recallMcpServerPath } from '../recall/register-mcp';
import type { OAuthToken } from './oauth';

// Stem's MCP config for the pi backend (mcp.json). Consumed by the bridge
// extension (stem-mcp-extension.mjs), which pi loads via `-e`. Stem owns this file
// end-to-end under the isolated pi home.

export interface PiMcpServer {
  /** stdio transport */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** remote transport (HTTP/OAuth) — recognized but not yet connected by the bridge */
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
}

export interface PiMcpConfig {
  servers: Record<string, PiMcpServer>;
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function mainRuntimeAssetPath(rel: string): string {
  const built = join(__dirname, rel);
  return existsSync(built) ? built : join(app.getAppPath(), 'src', 'main', rel);
}

/** Absolute path to the bridge extension asset (mirrors recallMcpServerPath's basis). */
export function piExtensionPath(): string {
  return mainRuntimeAssetPath(join('pi', 'stem-mcp-extension.mjs'));
}

/** Where the bridge writes live connection status (next to mcp.json). */
export function piMcpStatusPath(): string {
  return join(piHome(), 'mcp-status.json');
}

/**
 * Per-turn gate the bridge's web-search hook reads to decide whether to inject the
 * current model's native web_search tool. The main process rewrites it just before
 * each prompt with the originating context's setting (main vs Quick Chat), since
 * both share one pi process and the hook can't tell them apart. Carries no
 * credentials, so a plain (non-secret) file is fine.
 */
export function piNativeSearchPath(): string {
  return join(piHome(), 'native-search.json');
}

/** Write the `{ enabled }` gate the bridge's web-search hook reads for the next turn. */
export async function writeNativeSearchGate(enabled: boolean): Promise<void> {
  await mkdir(piHome(), { recursive: true });
  await writeFile(piNativeSearchPath(), JSON.stringify({ enabled }, null, 2), 'utf8');
}

/**
 * OAuth tokens for remote MCP servers, keyed by server name. Written by
 * PiRuntime.mcpLogin after a browser sign-in; the bridge reads it to inject the
 * bearer header and rewrites it when it refreshes an expired token.
 */
export function piMcpOAuthPath(): string {
  return join(piHome(), 'mcp-oauth.json');
}

export async function readOAuthTokens(): Promise<Record<string, OAuthToken>> {
  try {
    const parsed = JSON.parse(await readFile(piMcpOAuthPath(), 'utf8')) as Record<string, OAuthToken>;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // missing/corrupt → none
  }
  return {};
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
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path); // atomic on the same filesystem (same dir)
}

export async function saveOAuthToken(name: string, token: OAuthToken): Promise<void> {
  const all = await readOAuthTokens();
  all[name] = token;
  await writeSecretFile(piMcpOAuthPath(), JSON.stringify(all, null, 2));
}

export async function deleteOAuthToken(name: string): Promise<void> {
  const all = await readOAuthTokens();
  if (!(name in all)) return;
  delete all[name];
  await writeSecretFile(piMcpOAuthPath(), JSON.stringify(all, null, 2));
}

/** The reserved stem-recall entry the bridge always spawns. */
function recallServerEntry(): PiMcpServer {
  return {
    command: process.execPath,
    args: [recallMcpServerPath()],
    env: { ELECTRON_RUN_AS_NODE: '1', STEM_RECALL_DB: recallDbPath() },
    trusted: true
  };
}

/**
 * Read mcp.json, distinguishing a genuinely missing file (legitimate first run →
 * fresh config) from one that exists but is corrupt/unparseable. The corrupt case
 * MUST NOT be silently treated as empty: callers that read-modify-write (notably
 * {@link ensureMcpConfig}) would then persist that emptiness and wipe every
 * user-added server. Instead we preserve the bytes to a `.corrupt` sibling for
 * recovery and throw, so the loss is visible and recoverable rather than silent.
 */
export async function readMcpConfig(): Promise<PiMcpConfig> {
  let raw: string;
  try {
    raw = await readFile(piMcpConfigPath(), 'utf8');
  } catch {
    return { servers: {} }; // genuinely missing → fresh
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PiMcpConfig>;
    if (parsed && typeof parsed === 'object' && parsed.servers) return { servers: parsed.servers };
    throw new Error('mcp.json has no "servers" object');
  } catch (e) {
    await writeFile(`${piMcpConfigPath()}.corrupt`, raw, { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);
    throw new Error(`mcp.json is corrupt (preserved at ${piMcpConfigPath()}.corrupt): ${String(e)}`);
  }
}

export async function writeMcpConfig(config: PiMcpConfig): Promise<void> {
  // mcp.json can carry remote-server auth headers (e.g. `Authorization: Bearer …`).
  await writeSecretFile(piMcpConfigPath(), JSON.stringify(config, null, 2));
}

/**
 * Ensure mcp.json exists with a fresh stem-recall entry (paths can change between
 * runs), preserving any user-added servers. Idempotent; called at bootstrap.
 */
export async function ensureMcpConfig(): Promise<void> {
  let config: PiMcpConfig;
  try {
    config = await readMcpConfig();
  } catch {
    // Corrupt mcp.json (already preserved as `.corrupt` by readMcpConfig). Start
    // fresh so recall and the app keep working; the backup keeps any recoverable
    // user servers around instead of erasing them without a trace.
    config = { servers: {} };
  }
  config.servers[RECALL_MCP_NAME] = recallServerEntry();
  await writeMcpConfig(config);
}
