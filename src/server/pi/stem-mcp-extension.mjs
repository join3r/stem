// Stem's MCP bridge for the pi backend.
//
// pi has no built-in MCP by design, but it has a clean extension API. This
// dependency-free extension (loaded via `pi -e`) reads Stem's mcp.json, connects
// to each configured stdio MCP server as a client, and registers every server
// tool as a native pi tool. Trusted servers (Stem's own, e.g. stem-recall) run
// without prompting; others gate each call behind ctx.ui.confirm — which, in RPC
// mode, surfaces to Stem as an extension_ui_request it can render and answer.
//
// It is plain ESM with only node builtins so it needs no install and can be
// spawned from the in-repo path (like the recall MCP server).

import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Stem's internal recall server stays EAGER (its one tool is used every turn);
// every other server goes behind the lazy router (invoke_tool/describe_tool) so
// its schemas don't bloat the prompt. Mirrors RECALL_MCP_NAME in recall/register-mcp.ts.
const RECALL_SERVER_NAME = 'stem-recall';

/**
 * Write a credential-bearing file owner-only (0600). mcp.json may carry bearer
 * headers and mcp-oauth.json holds OAuth tokens; neither should be readable by
 * other users. The explicit chmod also tightens a file that already exists with
 * looser perms (the `mode` create-option is ignored on truncate).
 *
 * Atomic: data is written to a unique sibling temp file and renamed over the
 * target, so a crash mid-write can only leave a stray `.tmp`, never a truncated
 * credential map. Main owns mcp.json; this bridge writes only refreshed OAuth
 * tokens after the identity/CAS checks below.
 */
function writeSecretSync(path, data) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort on platforms without POSIX perms
  }
  try {
    renameSync(tmp, path); // atomic on the same filesystem (same dir)
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // renamed or best-effort cleanup
    }
  }
}

// Secrets-at-rest twins of src/server/pi/secrets.ts (drift-guarded by
// tests/unit/pi-protocol.test.ts). Main encrypts mcp.json's auth fields and the
// whole mcp-oauth.json map with an AES-256-GCM key it wraps via safeStorage;
// since safeStorage only exists in the Electron main process, PiRuntime hands
// this bridge the raw key through the env at spawn. No key in the env (or an
// undecryptable value) degrades to plaintext passthrough / dropped credential —
// never a crash, never ciphertext sent upstream as a bearer token.
const ENV_SECRET_KEY = 'STEM_SECRET_KEY';
const SECRET_VALUE_PREFIX = 'stemenc:1:';
const SECRET_ENVELOPE_KEY = '__stemenc__';

function bridgeSecretKey() {
  const hex = process.env[ENV_SECRET_KEY];
  return hex && /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
}

/** Un-prefixed values are legacy plaintext; undecryptable ciphertext → null. */
function decryptSecretValue(value) {
  if (typeof value !== 'string' || !value.startsWith(SECRET_VALUE_PREFIX)) return value;
  const key = bridgeSecretKey();
  if (!key) return null;
  try {
    const raw = Buffer.from(value.slice(SECRET_VALUE_PREFIX.length), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function encryptSecretValue(plain) {
  const key = bridgeSecretKey();
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return SECRET_VALUE_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function decryptRecord(record) {
  const entries = [];
  for (const [k, v] of Object.entries(record)) {
    const plain = decryptSecretValue(v);
    if (plain !== null) entries.push([k, plain]);
  }
  return Object.fromEntries(entries);
}

/** Decrypt a server's auth fields so identity hashes match main's plaintext hashes. */
function decryptServerSecrets(server) {
  if (!server || typeof server !== 'object') return server;
  const out = { ...server };
  if (out.headers) out.headers = decryptRecord(out.headers);
  if (out.env) out.env = decryptRecord(out.env);
  if (out.oauthClientSecret) {
    const plain = decryptSecretValue(out.oauthClientSecret);
    if (plain === null) delete out.oauthClientSecret;
    else out.oauthClientSecret = plain;
  }
  return out;
}

/** Parse mcp-oauth.json, unwrapping the encrypted envelope when present. */
function decodeOAuthTokens(raw) {
  const parsed = JSON.parse(raw) || {};
  const envelope = parsed[SECRET_ENVELOPE_KEY];
  if (typeof envelope === 'string') {
    const plain = decryptSecretValue(envelope);
    if (plain === null) return {};
    return JSON.parse(plain) || {};
  }
  return parsed;
}

/** Serialize the token map, encrypted as an envelope when the key is present. */
function encodeOAuthTokens(all) {
  return bridgeSecretKey()
    ? JSON.stringify({ [SECRET_ENVELOPE_KEY]: encryptSecretValue(JSON.stringify(all)) }, null, 2)
    : JSON.stringify(all, null, 2);
}

const FILE_LOCK_STALE_MS = 30_000;
const FILE_LOCK_WAIT_MS = 15_000;

/** Serialize stale-lock recovery so a second reaper cannot unlink a successor. */
async function reapAbandonedLock(lockPath) {
  const reaperPath = `${lockPath}.reaper`;
  let reaper;
  try {
    reaper = await open(reaperPath, 'wx', 0o600);
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs <= FILE_LOCK_STALE_MS) return false;
    } catch {
      return true;
    }
    await rm(lockPath, { force: true });
    return true;
  } finally {
    await reaper.close().catch(() => undefined);
    await rm(reaperPath, { force: true }).catch(() => undefined);
  }
}

/** Owner-tagged cross-process lock; mirrors mcp-config.ts. */
async function withOwnedFileLock(lockPath, timeoutMessage, operation) {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + FILE_LOCK_WAIT_MS;
  const owner = `${process.pid}:${randomUUID()}`;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(owner, 'utf8');
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        handle = undefined;
      }
      if (!error || error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > FILE_LOCK_STALE_MS) {
          if (await reapAbandonedLock(lockPath)) continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    let currentOwner = '';
    try {
      currentOwner = readFileSync(lockPath, 'utf8');
    } catch {
      // already recovered/removed
    }
    if (currentOwner === owner) await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

function serverAuthIdentity(server) {
  if (!server || !server.url) return null;
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

/** Legacy name-only tokens are never attached after the identity-stamp migration. */
export function bridgeOAuthTokenForServer(server, token) {
  const identity = serverAuthIdentity(server);
  return identity && token && token.serverIdentity === identity ? token : null;
}

/**
 * Persist one refreshed token only if both the config identity and token snapshot
 * refreshed by this client are still current. This prevents an old bridge from
 * overwriting a newer browser login or resurrecting credentials after removal.
 */
export async function persistBridgeOAuthToken(
  oauthPath,
  configPath,
  name,
  expectedAuth,
  expectedIdentity,
  auth
) {
  return withOwnedFileLock(`${configPath}.state.lock`, 'Timed out waiting to update MCP configuration.', async () => {
    let config;
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8')) || {};
    } catch {
      return false;
    }
    const current = decryptServerSecrets(config.servers && config.servers[name]);
    if (serverAuthIdentity(current) !== expectedIdentity) return false;
    return withOwnedFileLock(`${oauthPath}.lock`, 'Timed out waiting to update MCP OAuth credentials.', async () => {
      let all = {};
      try {
        all = decodeOAuthTokens(readFileSync(oauthPath, 'utf8'));
      } catch {
        return false;
      }
      if (!all[name] || JSON.stringify(all[name]) !== JSON.stringify(expectedAuth)) return false;
      all[name] = { ...auth, serverIdentity: expectedIdentity };
      writeSecretSync(oauthPath, encodeOAuthTokens(all));
      return true;
    });
  });
}

/** Minimal MCP stdio client: newline-delimited JSON-RPC 2.0 over the child's stdio. */
class McpStdioClient {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    // Tracks whether the child is still up, so the cross-session connection cache
    // can detect a crashed server and reconnect instead of reusing a dead client.
    this.alive = false;
  }

  start() {
    this.proc = spawn(this.spec.command, this.spec.args ?? [], {
      env: { ...process.env, ...(this.spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.alive = true;
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (line.trim()) this.onLine(line);
      }
    });
    this.proc.stderr.on('data', () => {});
    // A missing/unspawnable binary (ENOENT etc.) emits 'error', which is FATAL to
    // the whole pi process when unhandled — one broken user-configured server must
    // never take down the backend. Treat it exactly like an exit: mark dead and
    // fail this server's pending requests only.
    this.proc.on('error', (err) => {
      this.alive = false;
      for (const p of this.pending.values()) p.reject(new Error(`${this.name} failed to start: ${err.message}`));
      this.pending.clear();
    });
    this.proc.on('exit', () => {
      this.alive = false;
      for (const p of this.pending.values()) p.reject(new Error(`${this.name} exited`));
      this.pending.clear();
    });
  }

  /** Kill the child (used when the connection cache rebuilds). Best-effort. */
  stop() {
    this.alive = false;
    try {
      this.proc?.kill();
    } catch {
      // already gone
    }
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
      else p.resolve(msg.result);
    }
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${this.name} ${method} timed out`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async handshake() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'stem-pi-bridge', version: '0.1.0' }
    });
    this.notify('notifications/initialized', {});
    const res = await this.request('tools/list', {});
    this.tools = (res && res.tools) || [];
    return this.tools;
  }

  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args ?? {} });
  }
}

/** Refresh an expired OAuth access token in place. Confidential clients (with a
 * stored clientSecret, e.g. Slack) send it via client_secret_post; public clients
 * just send the client_id. No PKCE on refresh either way. */
async function refreshOAuth(auth, signal) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken,
    client_id: auth.clientId
  });
  if (auth.clientSecret) body.set('client_secret', auth.clientSecret);
  if (auth.resource) body.set('resource', auth.resource);
  const res = await fetch(auth.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
    signal
  });
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);
  const raw = await res.json();
  // Standard servers return token fields at top level; Slack may nest them under
  // `authed_user`. Prefer top-level, else fall back to the wrapper.
  const tok = typeof raw.access_token === 'string' ? raw : raw.authed_user ?? raw;
  if (!tok.access_token) throw new Error('token refresh returned no access_token');
  auth.accessToken = tok.access_token;
  if (tok.refresh_token) auth.refreshToken = tok.refresh_token;
  auth.expiresAt = typeof tok.expires_in === 'number' ? Date.now() + tok.expires_in * 1000 : 0;
  return auth;
}

/**
 * Minimal MCP Streamable-HTTP client: JSON-RPC over HTTP POST. Auth is either a
 * static header (`spec.headers`, e.g. `Authorization: Bearer …`) or an OAuth
 * token (`auth`) obtained via Stem's browser sign-in — which this client injects
 * as a bearer header and transparently refreshes when it expires or a request
 * comes back 401. Handles both `application/json` and `text/event-stream`
 * responses and carries the `Mcp-Session-Id` the server returns on initialize.
 */
export const MCP_HTTP_REQUEST_TIMEOUT_MS = 30_000;

export class McpHttpClient {
  constructor(name, spec, auth, persist) {
    this.name = name;
    this.url = spec.url;
    this.headers = spec.headers || {};
    this.auth = auth || null;
    this.persist = persist || (() => {});
    this.sessionId = null;
    this.nextId = 1;
    this.tools = [];
    // Stateless (each call is a fresh fetch), so a successfully initialized HTTP
    // client stays live in the cache. `stop()` flips this false for failed/stale
    // entries so the next session factory knows it must reconnect.
    this.alive = true;
  }

  start() {
    this.alive = true;
  }

  /** No persistent resource to tear down; present for parity with the stdio client. */
  stop() {
    this.alive = false;
  }

  async authHeaders(signal) {
    if (!this.auth) return {};
    // Proactively refresh if we know the token is within a minute of expiring.
    if (this.auth.refreshToken && this.auth.expiresAt && Date.now() > this.auth.expiresAt - 60000) {
      try {
        const expectedAuth = { ...this.auth };
        await refreshOAuth(this.auth, signal);
        await this.persist(this.auth, expectedAuth);
      } catch {
        // fall through with the (possibly stale) token; a 401 retry may recover
      }
    }
    return this.auth.accessToken ? { Authorization: `Bearer ${this.auth.accessToken}` } : {};
  }

  async rpc(method, params, notify = false, retried = false) {
    const body = notify
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: this.nextId++, method, params };
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`${this.name} ${method} timed out after ${MCP_HTTP_REQUEST_TIMEOUT_MS}ms`)),
      MCP_HTTP_REQUEST_TIMEOUT_MS
    );
    timer.unref?.();
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          ...this.headers,
          ...(await this.authHeaders(controller.signal))
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      // A rejected token → refresh once and retry before surfacing the failure.
      if (res.status === 401 && this.auth && this.auth.refreshToken && !retried) {
        try {
          const expectedAuth = { ...this.auth };
          await refreshOAuth(this.auth, controller.signal);
          await this.persist(this.auth, expectedAuth);
          return this.rpc(method, params, notify, true);
        } catch {
          if (controller.signal.aborted) throw controller.signal.reason;
          // fall through to the error below
        }
      }
      if (notify) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      const ct = res.headers.get('content-type') || '';
      const msg = ct.includes('text/event-stream')
        ? parseSseResult(await res.text(), body.id)
        : await res.json();
      if (msg && msg.error) throw new Error(msg.error.message || 'MCP error');
      return msg ? msg.result : null;
    } catch (e) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error(`${this.name} ${method} timed out after ${MCP_HTTP_REQUEST_TIMEOUT_MS}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async handshake() {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'stem-pi-bridge', version: '0.1.0' }
    });
    await this.rpc('notifications/initialized', {}, true);
    const res = await this.rpc('tools/list', {});
    this.tools = (res && res.tools) || [];
    return this.tools;
  }

  callTool(name, args) {
    return this.rpc('tools/call', { name, arguments: args ?? {} });
  }
}

// ---- A server that runs on one of the user's own devices ----
//
// Sentinel title for the ctx.ui.input round-trip PiRuntime intercepts (it never
// shows UI for this title). Hand-written twin of DEVICE_MCP_BRIDGE_TITLE in
// pi/protocol.ts, drift-guarded by tests/unit/pi-protocol.test.ts.
const DEVICE_MCP_BRIDGE_TITLE = 'stem-device-mcp-bridge';

// What each device announced it is hosting. Main rewrites this file on every
// announcement; we only ever read it. Twin of MCP_DEVICE_CATALOG_FILE.
const MCP_DEVICE_CATALOG_FILE = 'mcp-device-catalog.json';

/**
 * The pi context most recently handed to one of our event handlers.
 *
 * A device-located server's every operation is a ctx.ui.input round-trip, but
 * there is no ctx where they are needed: connections are built before any turn
 * exists, and registerRouterTools calls `client.callTool(name, args)` without
 * passing one — deliberately, since the router must not have to know that one of
 * its clients is special. So the bridge latches the ctx pi gives its hooks. It is
 * the same RPC channel whichever handler holds it, and the elicitation is
 * answered by id rather than by whoever raised it, so any live ctx will do.
 *
 * Module scope, like sharedConn and for the same reason: a client built during
 * one session keeps working after pi rebuilds the session runtime.
 */
let liveCtx = null;

/** Remember a ctx that can actually raise a dialog (RPC/TUI mode, not print). */
function latchCtx(_event, ctx) {
  if (ctx && ctx.ui && typeof ctx.ui.input === 'function') liveCtx = ctx;
}

/** Test seam: forget the latched context between focused bridge tests. */
export function setLiveCtxForTests(ctx) {
  liveCtx = ctx;
}

/**
 * Returns `report(deviceId, server)` reading one server's last announcement out
 * of mcp-device-catalog.json, mtime-cached like the other sibling-file gates.
 *
 * This is what makes a pinned server usable while the machine that hosts it is
 * asleep: the tool list came from the device the last time it was up, main keeps
 * it across the disconnection (③), and the bridge reads it back rather than
 * asking anyone. A file that was never written means "that device has never told
 * us anything", which is not an error — it is a device that has not connected
 * since the pin was made.
 */
function makeDeviceCatalogGate(catalogPath) {
  let cache = { mtime: -1, devices: {} };
  return (deviceId, server) => {
    try {
      const mtime = statSync(catalogPath).mtimeMs;
      if (mtime !== cache.mtime) {
        const data = JSON.parse(readFileSync(catalogPath, 'utf8'));
        cache = { mtime, devices: data && typeof data.devices === 'object' && data.devices ? data.devices : {} };
      }
    } catch {
      cache = { mtime: -1, devices: {} };
    }
    const entry = cache.devices[deviceId];
    const servers = entry && Array.isArray(entry.servers) ? entry.servers : [];
    return servers.find((s) => s && s.name === server) || null;
  };
}

/**
 * A JSON-Schema rebuilt from the compact signature a device announced, for the
 * case where the real one cannot be fetched — the machine is asleep, or the
 * server on it is not running.
 *
 * This is a FALLBACK and says so. The device announces `(path, limit?)` rather
 * than whole input schemas, on the same bargain the bridge's own catalog makes:
 * a few servers' worth of schemas is tens of thousands of tokens in every
 * prompt. When the machine is up, describe_tool asks it for the real schema and
 * this is never used. When it is not, argument names and which of them are
 * required is genuinely all anyone here knows — and an empty object schema would
 * read as "this tool takes no arguments", a lie that costs a turn.
 *
 * `why` is written into the schema's own description, where the model reads the
 * arguments, rather than somewhere beside it that it may not look at.
 */
function schemaFromSignature(signature, why) {
  const inner = typeof signature === 'string' ? signature.replace(/^\(|\)$/g, '') : '';
  const parts = inner.split(',').map((raw) => raw.trim());
  // The trailing "…" marks a signature the announcing device truncated at eight
  // arguments. Everything past the eighth is simply not here, and a schema that
  // did not say so would be read as a complete one that forbids them.
  const truncated = parts.includes('…');
  const schema = {
    type: 'object',
    properties: {},
    required: [],
    // Not `false`: what is listed is known to be incomplete, and an argument
    // this does not name may still be the right one to pass.
    additionalProperties: true,
    description:
      `PARTIAL SCHEMA — ${why} ` +
      'Only the argument names the hosting computer last announced are known: no types, no per-argument descriptions, no ' +
      'allowed values.' +
      (truncated
        ? ' The announced list was cut short, so this tool has further arguments beyond the ones named here.'
        : '') +
      ' Ask again once that computer is connected to get the real schema.'
  };
  for (const arg of parts) {
    if (!arg || arg === '…') continue;
    const optional = arg.endsWith('?');
    const name = optional ? arg.slice(0, -1) : arg;
    schema.properties[name] = {};
    if (!optional) schema.required.push(name);
  }
  return schema;
}

/**
 * What the panel should show under a device-located server, or null when there
 * is nothing to say. A server that simply lives on another machine is not in an
 * error state, so the healthy case is silence — the row already names the place.
 *
 * A MISSING report is not the healthy case, and used to be reported as one: a
 * pin whose machine was unpaired, or one that has never once connected, showed
 * up in mcp-status.json as `elsewhere` with no error at all. Anything reading
 * the status rather than the panel — which knows about orphans separately — then
 * saw a server that cannot run and looks fine. It names the machine as well as
 * the server (⑤) using the label stored beside the pin, since that is the whole
 * of what somebody needs to act on it.
 */
function deviceReportError(report, place) {
  if (!report) {
    return (
      `${place} has never told Stem it is running this server. Either it has not been connected since the server was ` +
      'pinned there, or it is no longer paired with this Stem — Settings → Tools → MCP servers says which.'
    );
  }
  if (report.status === 'ready') return null;
  if (report.status === 'unapproved') return 'Waiting for approval on the computer that runs it.';
  return report.error || 'It is not running on the computer that hosts it.';
}

/** How a pinned server's machine should be named, from what mcp.json remembers. */
function devicePlace(location) {
  const label = location && typeof location.label === 'string' ? location.label.trim() : '';
  return label ? `“${label}”` : 'The computer this server is pinned to';
}

/**
 * Announced tools as the router's clients map expects tool definitions.
 *
 * Anything without a usable name is dropped rather than carried: this list comes
 * off another machine, and one malformed entry must not be able to throw where
 * the throw would land — inside a connection nobody is awaiting.
 */
function deviceToolDefinitions(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => t && typeof t.name === 'string' && t.name)
    .map((tool) => ({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      // Kept alongside so describe_tool can rebuild the fallback schema with the
      // actual reason the real one could not be fetched, rather than this
      // stand-in written before anybody tried.
      signature: tool.signature,
      inputSchema: schemaFromSignature(
        tool.signature,
        'the computer that hosts this server has not been asked for the real one.'
      )
    }));
}

/**
 * A client for a server that runs on one of the user's devices. Same
 * start()/handshake()/callTool()/stop() surface as the stdio and HTTP clients,
 * so it goes into the same clients map and invoke_tool/describe_tool need to
 * know nothing about it — but every operation is a round-trip through
 * PiRuntime, which resolves the device from mcp.json and hands the op to the
 * DeviceMcpRouter (timeouts, correlation ids and the refusal text all live
 * there).
 *
 * Two properties are deliberate and load-bearing:
 *
 *  - handshake() never throws. A failed handshake drops a server from the
 *    clients map, and invoke_tool would then answer "no such server" — the
 *    assistant would lose the capability entirely the moment somebody closed
 *    their laptop, which is the exact failure ③ exists to prevent. So it
 *    returns whatever tools it can get, live or remembered, and the server
 *    stays connected as far as the router is concerned. The CALL is what fails,
 *    in a sentence naming the machine to wake.
 *  - `alive` stays true. The connection cache tears everything down and
 *    reconnects when any client reports alive:false, and there is no local
 *    resource here whose death would mean anything: whether the far end is up is
 *    a per-call question, asked per call.
 */
class McpDeviceClient {
  constructor(name, spec, remembered) {
    this.name = name;
    this.spec = spec;
    /** () => the device's last report for this server, or null. */
    this.remembered = remembered;
    /** Tools from a live listing; null until one succeeds. */
    this.liveTools = null;
    /** Why the last operation could not be served, in the far end's words. */
    this.lastError = null;
    this.alive = true;
  }

  /**
   * What this server offers, as fresh as anyone here can know.
   *
   * A getter rather than a field because the remembered catalog is rewritten
   * whenever the device announces, and pi keeps this connection for the life of
   * the process: with a snapshot, a machine that came online after pi started
   * would have its new tools advertised in the injected catalog (main renders
   * that from the same file) and rejected by invoke_tool, which checks this list.
   */
  get tools() {
    if (this.liveTools) return this.liveTools;
    const report = this.remembered();
    return deviceToolDefinitions(report && report.tools);
  }

  start() {
    this.alive = true;
  }

  /** Nothing to tear down; present for parity with the other two clients. */
  stop() {
    this.alive = false;
  }

  /** One op through PiRuntime. Returns a `{ ok }` result; never throws. */
  async request(payload) {
    const ctx = liveCtx;
    if (!ctx || !ctx.ui || typeof ctx.ui.input !== 'function') {
      // Ordinary at startup: connections are built before the first turn, so
      // there is no dialog channel yet. `noChannel` marks it as our own timing
      // rather than anything the far end did, so it never reaches the panel as
      // if it were a fault of the machine hosting the server.
      return {
        ok: false,
        noChannel: true,
        error: 'Stem is not in a turn, so this server cannot be reached right now.'
      };
    }
    let raw;
    try {
      raw = await ctx.ui.input(DEVICE_MCP_BRIDGE_TITLE, JSON.stringify(payload));
    } catch (e) {
      return { ok: false, error: `Stem could not reach the computer that hosts "${this.name}": ${(e && e.message) || e}` };
    }
    if (typeof raw !== 'string') return { ok: false, error: 'No response from Stem.' };
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : { ok: false, error: 'Malformed response from Stem.' };
    } catch {
      return { ok: false, error: 'Malformed response from Stem.' };
    }
  }

  async handshake() {
    const res = await this.request({ op: 'tools', server: this.name });
    if (res.ok && Array.isArray(res.tools)) {
      this.liveTools = deviceToolDefinitions(res.tools);
      this.lastError = null;
      return this.liveTools;
    }
    // Unreachable, asleep, or not yet approved over there. The remembered list
    // stands: those tools are real, and saying so is the whole of ③.
    this.lastError = res.noChannel ? null : res.error || null;
    return this.tools;
  }

  /**
   * One tool's REAL input schema, fetched from the machine that handshook with
   * the server, or `{ partial }` saying why it could not be.
   *
   * This is the on-demand half of the compact catalog, and the reason the
   * compact half is allowed to be compact. The per-turn block carries names and
   * a signature truncated at eight arguments; that is a summary, and a summary
   * is only honest if the full thing can be had when it matters. Rebuilding a
   * schema out of the summary instead — no types, no enums, no ninth argument —
   * is how a model ends up calling a tool wrongly and being told nothing about
   * why.
   */
  async describe(toolName) {
    const res = await this.request({ op: 'describe', server: this.name, tool: toolName });
    if (res.ok && res.schema) return res.schema;
    return {
      partial: res.noChannel
        ? 'Stem is not in a turn, so the computer that hosts this server could not be asked for the real schema.'
        : res.error || `The computer that hosts "${this.name}" could not be asked for the real schema.`
    };
  }

  /**
   * Run one tool over there. The result comes back in MCP's own shape
   * (`{ content: [...] }`) so registerRouterTools hands it to the model exactly
   * as it hands a local server's, and a refusal is thrown as an Error because
   * that is how the other two clients fail: pi turns a thrown tool error into
   * the tool's result, so the sentence — which names the server AND the machine
   * to wake — is what the model reads.
   */
  async callTool(name, args) {
    const res = await this.request({ op: 'call', server: this.name, tool: name, args: args ?? {} });
    if (!res.ok) throw new Error(res.error || `"${this.name}" could not be reached.`);
    return { content: Array.isArray(res.content) ? res.content : [{ type: 'text', text: JSON.stringify(res.content ?? null) }] };
  }
}

/** Pull the JSON-RPC reply for `id` out of an SSE body (one or more data: frames). */
function parseSseResult(text, id) {
  for (const frame of text.split(/\n\n+/)) {
    const data = frame
      .split(/\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) continue;
    try {
      const msg = JSON.parse(data);
      if (msg && (msg.id === id || msg.result !== undefined || msg.error !== undefined)) return msg;
    } catch {
      // skip non-JSON frames (comments, keep-alives)
    }
  }
  return null;
}

function sanitizeToolName(s) {
  return s.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}

// ---- Web-search gate ----
//
// Web search used to be an openai-codex-only trick: this extension injected the
// provider's server-side `web_search` tool into the outgoing request body via
// before_provider_request, because pi never asks for it (its serializer only
// emits function tools). No other provider had an equivalent, so Claude,
// OpenRouter, Ollama and LM Studio simply could not look anything up.
//
// Search is now served for EVERY provider by the vendored pi-web-access
// extension, which pi loads alongside this one and which registers ordinary pi
// tools. All that survives here is the per-turn gate: a single `{ enabled }` flag
// in native-search.json, rewritten by the main process before each prompt from the
// originating context's setting (main vs Quick Chat), used to activate or
// deactivate those tools for the turn.

/** Tools registered by the vendored pi-web-access extension, gated as one group. */
const WEB_ACCESS_TOOLS = ['web_search', 'source_check', 'fetch_content', 'get_search_content'];

/**
 * Returns `enabled()` reading the `{ enabled }` gate in native-search.json with an
 * mtime cache so it picks up the main process's per-turn write without a restart. A
 * missing/corrupt file defaults to enabled, so search works out of the box.
 */
function makeNativeSearchGate(nsPath) {
  let cache = { mtime: -1, enabled: true };
  return () => {
    try {
      const mtime = statSync(nsPath).mtimeMs;
      if (mtime !== cache.mtime) {
        const data = JSON.parse(readFileSync(nsPath, 'utf8'));
        cache = { mtime, enabled: data && typeof data.enabled === 'boolean' ? data.enabled : true };
      }
    } catch {
      cache = { mtime: -1, enabled: true };
    }
    return cache.enabled;
  };
}

/**
 * Returns `roots()` reading the absolute paths of read-only connected folders from
 * protected-roots.json (mtime-cached). The main process rewrites this whenever the
 * Folders registry changes. A file that was never readable means "nothing
 * protected" (a fresh install genuinely has no roots yet) — but once roots have
 * been read successfully, a later missing/corrupt file KEEPS the last-known-good
 * set rather than failing open: unprotecting a folder is a deliberate act that
 * arrives as a valid rewrite, never as a disappearing or half-written file.
 */
export function makeProtectedRootsGate(prPath) {
  let cache = { mtime: -1, roots: [] };
  return () => {
    try {
      const mtime = statSync(prPath).mtimeMs;
      if (mtime !== cache.mtime) {
        const data = JSON.parse(readFileSync(prPath, 'utf8'));
        cache = { mtime, roots: Array.isArray(data && data.roots) ? data.roots.filter((r) => typeof r === 'string') : [] };
      }
    } catch {
      cache = { mtime: -1, roots: cache.roots };
    }
    return cache.roots;
  };
}

// String args that even look like filesystem paths: absolute, home-relative,
// @-prefixed (pi's read syntax), file URLs, or Windows drive paths. Everything
// else (prose, queries, URLs) is skipped without touching the filesystem.
const PATHISH_RE = /^@?(?:[~/]|file:\/\/)|^[A-Za-z]:[\\/]/;

/**
 * Deep-scan an MCP tool-call's args for a path-shaped string inside one of the
 * protected roots; returns the first offender or null. MCP servers are external
 * processes with arbitrary write capability, so the read-only guarantee has to
 * hold against ANY of their tools — there is no reliable way to tell a server's
 * read tools from its write tools, so a protected path blocks the call outright
 * (pi's built-in read/grep/find/ls remain the sanctioned way to read).
 */
export function findProtectedPath(value, roots) {
  if (!Array.isArray(roots) || roots.length === 0) return null;
  const stack = [value];
  const seen = new Set();
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') {
      const s = v.trim();
      if (s.length > 0 && s.length <= 1024 && PATHISH_RE.test(s) && roots.some((root) => isInside(s, root))) {
        return s;
      }
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
    } else if (v && typeof v === 'object' && !seen.has(v)) {
      seen.add(v);
      for (const item of Object.values(v)) stack.push(item);
    }
  }
  return null;
}

/** The block/refusal text for an MCP call touching a read-only connected folder. */
function protectedPathRefusal(path) {
  return `"${path}" is inside a folder connected to Stem read-only, so MCP tools may not operate on it. ` +
    `Read it with the built-in read/grep/find/ls tools instead, or ask the user to switch the folder ` +
    `to read & write in the Folders tab.`;
}

/**
 * Canonicalize an existing path, or a not-yet-created path through its nearest
 * existing ancestor. The latter matters for `write`: the target file may not
 * exist yet, while a parent directory can still be a symlink into a protected
 * connected folder.
 */
export function canonicalPolicyPath(target, cwd = process.cwd()) {
  // Match pi's resolveToCwd input normalization. The tool itself expands these
  // forms, so checking their unexpanded spelling would authorize a different path.
  let normalized = target.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (normalized === '~') normalized = homedir();
  else if (normalized.startsWith('~/') || (process.platform === 'win32' && normalized.startsWith('~\\'))) {
    normalized = join(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      // A malformed URL is rejected by the tool; keep the policy hook non-fatal.
    }
  }

  let candidate = resolve(cwd, normalized);
  try {
    return realpathSync(candidate);
  } catch {
    // Resolve component-by-component below. lstat is essential here: unlike
    // realpath, it can see and follow a dangling symlink whose destination is a
    // not-yet-created write target inside a protected root.
  }

  for (let symlinks = 0; symlinks < 40; symlinks++) {
    const root = parse(candidate).root;
    const parts = candidate.slice(root.length).split(sep).filter(Boolean);
    let cursor = root;
    let followed = false;
    for (let i = 0; i < parts.length; i++) {
      const next = join(cursor, parts[i]);
      let stat;
      try {
        stat = lstatSync(next);
      } catch {
        return resolve(cursor, ...parts.slice(i));
      }
      if (stat.isSymbolicLink()) {
        candidate = resolve(dirname(next), readlinkSync(next), ...parts.slice(i + 1));
        followed = true;
        break;
      }
      cursor = next;
    }
    if (!followed) return candidate;
  }
  return candidate;
}

/** True when `target` is at or inside `root`, after resolving symlink aliases. */
// Exported for scripts/cfolders-verify.mjs; pi only consumes the default export,
// so these named exports are inert at load time.
export function isInside(target, root) {
  const r = canonicalPolicyPath(root);
  const t = canonicalPolicyPath(target);
  return t === r || t.startsWith(r + sep);
}

/**
 * Returns `tier()` reading the `{ tier }` gate in service-tier.json with an mtime cache,
 * mirroring makeNativeSearchGate. Returns the requested OpenAI service tier ('priority')
 * or null. A missing/corrupt file defaults to null (Standard — no service_tier sent).
 */
function makeServiceTierGate(stPath) {
  let cache = { mtime: -1, tier: null };
  return () => {
    try {
      const mtime = statSync(stPath).mtimeMs;
      if (mtime !== cache.mtime) {
        const data = JSON.parse(readFileSync(stPath, 'utf8'));
        cache = { mtime, tier: data && typeof data.tier === 'string' ? data.tier : null };
      }
    } catch {
      cache = { mtime: -1, tier: null };
    }
    return cache.tier;
  };
}

/**
 * The request payload with `service_tier` injected, or undefined to leave the
 * request alone. Only two providers accept 'priority', and each is identified
 * from the body itself so we never touch a provider we don't recognize:
 * openai-codex responses by their shape (input[] + instructions), and xAI by a
 * bare `grok…` model id over either the responses or chat-completions shape.
 * OpenRouter-hosted Grok is deliberately not matched — its ids are prefixed
 * (`x-ai/grok…`) and OpenRouter doesn't take xAI's tier.
 */
export function withServiceTier(payload, tier) {
  if (tier !== 'priority' || !payload || typeof payload !== 'object' || payload.service_tier) return undefined;
  const isCodexBody = Array.isArray(payload.input) && typeof payload.instructions === 'string';
  const isGrokBody =
    typeof payload.model === 'string' &&
    payload.model.startsWith('grok') &&
    (Array.isArray(payload.input) || Array.isArray(payload.messages));
  if (!isCodexBody && !isGrokBody) return undefined;
  return { ...payload, service_tier: tier };
}

// ---- Lazy MCP router ----
//
// Re-registering every server's tools as native pi tools puts all their JSON input
// schemas in the system prompt on every turn (~48k tokens for a few servers, and
// O(servers) as more are added). Instead, only the internal recall server stays
// native; all other servers are fronted by two meta-tools (invoke_tool/describe_tool)
// over a `clients` map, and a cheap names+signatures catalog is injected per turn by
// the main process (see buildMcpCatalogContext). The model discovers tools from the
// catalog and calls them through invoke_tool; full schemas come from describe_tool
// only when needed. Token floor stays ~flat regardless of server count.

/** Register one MCP tool as a native pi tool (used only for the eager recall server). */
function registerNativeMcpTool(pi, name, spec, client, tool, protectedRoots) {
  const toolName = spec.trusted ? sanitizeToolName(tool.name) : sanitizeToolName(`${name}_${tool.name}`);
  pi.registerTool({
    name: toolName,
    label: tool.title || tool.name,
    description: tool.description || `MCP tool "${tool.name}" from ${name}`,
    parameters: tool.inputSchema || { type: 'object', properties: {} },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!spec.trusted && ctx && ctx.ui && typeof ctx.ui.confirm === 'function') {
        const ok = await ctx.ui.confirm('Allow MCP tool', `Run ${name} → ${tool.name}?`);
        if (!ok) return { content: [{ type: 'text', text: 'Denied by user.' }], details: {} };
      }
      const offending = protectedRoots ? findProtectedPath(params || {}, protectedRoots()) : null;
      if (offending) return errText(protectedPathRefusal(offending));
      const result = await client.callTool(tool.name, params || {});
      const content = Array.isArray(result && result.content)
        ? result.content
        : [{ type: 'text', text: JSON.stringify(result ?? null) }];
      return { content, details: {} };
    }
  });
}

function errText(text) {
  return { content: [{ type: 'text', text }], details: {}, isError: true };
}

/** Register the router meta-tools over the connected (non-eager) clients map. */
function registerRouterTools(pi, clients, protectedRoots) {
  pi.registerTool({
    name: 'invoke_tool',
    label: 'Use a tool',
    description:
      'Call a tool on one of the MCP servers listed in the "Available tools" catalog in this turn\'s context. ' +
      'Pass the server name, the exact tool name, and an args object matching that tool. If you are unsure of a ' +
      "tool's arguments, call describe_tool first. Only use servers and tools shown in the catalog — do not invent them.",
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name from the catalog.' },
        tool: { type: 'string', description: 'Exact tool name on that server.' },
        args: { type: 'object', description: 'Arguments matching the tool input schema.', additionalProperties: true }
      },
      required: ['server', 'tool']
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const server = String((params && params.server) || '');
      const toolName = String((params && params.tool) || '');
      const entry = clients.get(server);
      if (!entry) return errText(`No connected MCP server named "${server}". See the Available tools catalog.`);
      const def = entry.tools.find((t) => t.name === toolName);
      if (!def) return errText(`Server "${server}" has no tool "${toolName}".`);
      // Preserve the per-call trusted gate (parity with the eager path): untrusted
      // servers confirm via ctx.ui; in practice all Stem-added servers are trusted.
      if (!entry.spec.trusted && ctx && ctx.ui && typeof ctx.ui.confirm === 'function') {
        const ok = await ctx.ui.confirm('Allow MCP tool', `Run ${server} → ${def.name}?`);
        if (!ok) return { content: [{ type: 'text', text: 'Denied by user.' }], details: {} };
      }
      const offending = protectedRoots ? findProtectedPath((params && params.args) || {}, protectedRoots()) : null;
      if (offending) return errText(protectedPathRefusal(offending));
      const result = await entry.client.callTool(def.name, (params && params.args) || {});
      const content = Array.isArray(result && result.content)
        ? result.content
        : [{ type: 'text', text: JSON.stringify(result ?? null) }];
      // details carries the real server/tool so normalize.ts can recover the activity label.
      return { content, details: { server, tool: def.name } };
    }
  });

  pi.registerTool({
    name: 'describe_tool',
    label: 'Describe a tool',
    description:
      'Return the full JSON input schema for one tool on a configured MCP server, so you can build a correct ' +
      "invoke_tool call. Only needed when a tool's arguments are not obvious from the catalog signature.",
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name from the catalog.' },
        tool: { type: 'string', description: 'Exact tool name on that server.' }
      },
      required: ['server', 'tool']
    },
    async execute(_id, params) {
      const server = String((params && params.server) || '');
      const toolName = String((params && params.tool) || '');
      const entry = clients.get(server);
      const def = entry && entry.tools.find((t) => t.name === toolName);
      if (!def) return errText(`No such tool "${toolName}" on server "${server}".`);
      let description = def.description || '';
      let inputSchema = def.inputSchema || { type: 'object' };
      // A server that runs on one of the user's own machines holds its tools'
      // real schemas over there, and this tool is exactly the moment to go and
      // get one: describe_tool is the escape hatch the compact catalog is
      // predicated on, so answering it from the compact catalog would be
      // circular. Everything else already has the real schema in hand.
      if (entry.client && typeof entry.client.describe === 'function') {
        const answer = await entry.client.describe(def.name);
        if (answer && answer.inputSchema) {
          inputSchema = answer.inputSchema;
          if (answer.description) description = answer.description;
        } else {
          // Unreachable. Fall back to what the machine last announced and say
          // in the schema itself that this is partial and why, rather than
          // handing over a confident-looking object with every property empty.
          inputSchema = schemaFromSignature(
            def.signature,
            (answer && answer.partial) || `The computer that hosts "${server}" could not be asked for the real schema.`
          );
        }
      }
      const text = JSON.stringify({ server, name: def.name, description, inputSchema }, null, 2);
      return { content: [{ type: 'text', text }], details: {} };
    }
  });
}

/** First sentence (or ~120 chars) of a tool description, collapsed to one line. */
function oneLine(desc) {
  if (!desc || typeof desc !== 'string') return '';
  const flat = desc.replace(/\s+/g, ' ').trim();
  const stop = flat.indexOf('. ');
  const s = stop > 0 && stop < 120 ? flat.slice(0, stop + 1) : flat;
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/** Compact "(req, req, opt?)" signature from a JSON-Schema object (required first). */
function compactSig(schema) {
  if (!schema || typeof schema !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
    return '()';
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const keys = Object.keys(schema.properties);
  if (!keys.length) return '()';
  const req = keys.filter((k) => required.has(k));
  const opt = keys.filter((k) => !required.has(k)).map((k) => `${k}?`);
  const ordered = [...req, ...opt];
  const shown = ordered.slice(0, 8);
  const more = ordered.length > shown.length ? ', …' : '';
  return `(${shown.join(', ')}${more})`;
}

/**
 * Names+signatures catalog text for the routed servers (the cheap per-turn list).
 *
 * Server-located servers ONLY. A device-located server is in the same clients map
 * — that is what makes invoke_tool work on it — but its block is rendered by the
 * main process instead, from the catalog the device announced, so that every turn
 * can stamp it with whether that machine is reachable right this second (③).
 * Rendering it here as well would put a second, staler copy in the same prompt.
 */
function buildCatalogText(clients) {
  const sections = [];
  for (const [name, { spec, tools }] of clients) {
    if (spec && spec.location) continue;
    const lines = tools.map((t) => {
      const desc = oneLine(t.description);
      const sig = compactSig(t.inputSchema);
      return desc ? `  - ${t.name}: ${desc} — ${sig}` : `  - ${t.name}: ${sig}`;
    });
    sections.push(`### ${name} (${tools.length} tool${tools.length === 1 ? '' : 's'})\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}

// Live MCP connections, cached at MODULE scope so they survive pi re-running this
// factory on every session change. pi rebuilds the whole session runtime — and
// re-invokes cached extension factories — on new/switch/fork/rollback. Connecting
// the servers (remote OAuth handshakes + uvx/stdio spawns) costs ~2s, so without
// this cache EVERY new chat / chat-open / fork re-paid it (measured: ~2.1s per
// session change, vs ~3ms with the bridge absent). We connect once per process,
// then on each subsequent session only re-register the (cheap, no-network) tools
// on that session's fresh `pi`. Module state persists because pi caches the
// extension factory function across sessions (loadExtensionsCached).
let sharedConn = null; // { key, clients: Map, recall: [...], failed: [...], status, stale, recallReady, settled }

/** Connect one configured server (remote HTTP/OAuth or local stdio). Never throws. */
async function connectOneServer(name, spec, oauthTokens, persistAuth) {
  // Remote (Streamable HTTP — static header or OAuth) or local (stdio); both
  // expose the same handshake()/callTool() surface.
  const client = spec.url
    ? new McpHttpClient(name, spec, bridgeOAuthTokenForServer(spec, oauthTokens[name]), (auth, expectedAuth) =>
        persistAuth(name, spec, auth, expectedAuth))
    : new McpStdioClient(name, spec);
  try {
    client.start();
    const tools = await client.handshake();
    return { ok: true, name, spec, client, tools };
  } catch (e) {
    try {
      client.stop();
    } catch {
      // best-effort
    }
    return { ok: false, name, client, error: String((e && e.message) || e) };
  }
}

/**
 * Kick off every configured server's connection WITHOUT blocking the caller on
 * the slow ones. pi awaits the extension factory before it answers any RPC, so a
 * handshake awaited there delays the whole app's readiness — Stem's spawn-time
 * get_state probe (20s) was timing out behind e.g. chrome-devtools launching a
 * browser, and the serial loop paid the SUM of all handshakes. Only stem-recall
 * is awaited by the factory (`recallReady`: a fast local stdio spawn whose native
 * tools must exist before the first turn); routed servers connect in parallel and
 * merge into the shared connection as they settle, republishing status + catalog
 * so tools become available on the next turn. Until a server settles, its status
 * is 'starting' (the Manage panel shows it as pending).
 *
 * A disabled server is never connected from here. Neither is one pinned to a
 * device — but that one still gets a client (McpDeviceClient), because "not
 * connected from here" is about the socket, not about whether the assistant can
 * use it: its calls travel to the machine it belongs to.
 */
function startConnections(servers, oauthTokens, persistAuth, publish, deviceReport) {
  const conn = {
    key: JSON.stringify(servers),
    clients: new Map(), // name -> { client, spec, tools } (routed via meta-tools)
    recall: [], // [{ name, spec, client, tools }] (eager, registered natively)
    failed: [], // retained as alive:false so a later session retries them
    status: {},
    stale: false, // flipped when a rebuild supersedes this entry mid-connect
    recallReady: Promise.resolve(),
    settled: Promise.resolve()
  };
  const jobs = [];
  for (const [name, spec] of Object.entries(servers)) {
    if (spec.disabled) continue;
    // Pinned to a paired device: this process must not open the connection —
    // from a VPS that would reach the wrong filesystem or a LAN address that
    // does not resolve — but it does route to it. The client goes into the map
    // SYNCHRONOUSLY, before any handshake, so the server is never briefly
    // missing from it: a gap there is a turn in which invoke_tool answers "no
    // such server" and the assistant concludes it cannot do the thing at all.
    if (spec.location) {
      const client = new McpDeviceClient(name, spec, () => deviceReport(spec.location.deviceId, name));
      client.start();
      // A getter, so the entry follows the client's view of its own tools (see
      // McpDeviceClient#tools) instead of freezing the list at connect time.
      conn.clients.set(name, {
        client,
        spec,
        get tools() {
          return client.tools;
        }
      });
      const place = devicePlace(spec.location);
      const deviceStatus = () => ({
        status: 'elsewhere',
        // What the machine itself last said, unless a live attempt just found
        // something more recent to say. 'elsewhere' is not a failure — it is
        // where the server is — so a healthy one carries no error at all; a
        // machine that has never reported this server is a different matter.
        error: client.lastError || deviceReportError(deviceReport(spec.location.deviceId, name), place)
      });
      conn.status[name] = deviceStatus();
      // Still handshaked, in the background and never awaited: at startup there
      // is no dialog channel yet and this resolves immediately with the
      // remembered tools, but a connection rebuilt mid-session gets a live list.
      jobs.push(
        client
          .handshake()
          .then(() => {
            if (conn.stale) return;
            conn.status[name] = deviceStatus();
            publish(conn);
          })
          .catch(() => {
            // handshake() is written not to throw; if it ever does, the server
            // keeps its remembered tools rather than the whole connection set
            // settling as a rejection.
          })
      );
      continue;
    }
    conn.status[name] = { status: 'starting', error: null };
    const job = connectOneServer(name, spec, oauthTokens, persistAuth).then((res) => {
      if (conn.stale) {
        // A rebuild replaced this entry while we were handshaking — don't leak the child.
        try {
          res.client.stop();
        } catch {
          // best-effort
        }
        return;
      }
      if (res.ok) {
        if (res.name === RECALL_SERVER_NAME) conn.recall.push(res);
        else conn.clients.set(res.name, { client: res.client, spec: res.spec, tools: res.tools });
        conn.status[res.name] = { status: 'ready', error: null };
      } else {
        // A discarded failure makes an empty/success-only cache look healthy
        // forever. Keep a stopped client in the cache so the same liveness check
        // used for later crashes forces a reconnect on the next session factory.
        conn.failed.push(res.client);
        conn.status[res.name] = { status: 'failed', error: res.error };
      }
      publish(conn);
    });
    if (name === RECALL_SERVER_NAME) conn.recallReady = job;
    jobs.push(job);
  }
  conn.settled = Promise.all(jobs).then(() => conn);
  return conn;
}

/** Every connected client in a cached connection (recall + routed). */
function connClients(conn) {
  return [
    ...conn.recall.map((r) => r.client),
    ...[...conn.clients.values()].map((e) => e.client),
    ...(conn.failed ?? [])
  ];
}

/** Test seam: clear module-level connections between focused bridge tests. */
export function resetMcpConnectionCacheForTests() {
  if (sharedConn) {
    sharedConn.stale = true; // in-flight background connects must discard themselves
    for (const client of connClients(sharedConn)) {
      try {
        client.stop();
      } catch {
        // best-effort
      }
    }
  }
  sharedConn = null;
}

/** Test seam: resolves once every in-flight background connect has settled. */
export function mcpConnectionsSettledForTests() {
  return sharedConn ? sharedConn.settled : Promise.resolve(null);
}

export default async function stemMcpBridge(pi) {
  const cfgPath = process.env.STEM_MCP_CONFIG;
  if (!cfgPath) return;
  let config;
  try {
    config = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch {
    return;
  }
  const servers = Object.fromEntries(
    Object.entries((config && config.servers) || {}).map(([name, spec]) => [name, decryptServerSecrets(spec)])
  );

  // OAuth tokens (from Stem's browser sign-in) live next to mcp.json; the bridge
  // injects them as bearer headers and rewrites the file when it refreshes one.
  const oauthPath = process.env.STEM_PI_MCP_OAUTH || join(dirname(cfgPath), 'mcp-oauth.json');
  let oauthTokens = {};
  try {
    oauthTokens = decodeOAuthTokens(readFileSync(oauthPath, 'utf8'));
  } catch {
    // none yet
  }
  // What the user's own devices announced they are hosting. Read-only here and
  // mtime-cached: main rewrites it on every announcement, and a server pinned to
  // a machine that is currently asleep gets its tool list from this file.
  const deviceReport = makeDeviceCatalogGate(join(dirname(cfgPath), MCP_DEVICE_CATALOG_FILE));

  const persistAuth = async (name, spec, auth, expectedAuth) => {
    try {
      return await persistBridgeOAuthToken(
        oauthPath,
        cfgPath,
        name,
        expectedAuth,
        serverAuthIdentity(spec),
        auth
      );
    } catch {
      // best-effort
      return false;
    }
  };

  // Publish connection status (getMcpStatus) and the names+signatures catalog the
  // main process injects each turn (cheap discovery; full schemas come from
  // describe_tool). Rewritten as each background connect settles; the catalog is
  // always written so an empty object clears a stale one when nothing is routed.
  const publish = (conn) => {
    try {
      writeFileSync(join(dirname(cfgPath), 'mcp-status.json'), JSON.stringify(conn.status, null, 2));
    } catch {
      // best-effort
    }
    try {
      writeFileSync(
        join(dirname(cfgPath), 'mcp-catalog.json'),
        JSON.stringify({ text: buildCatalogText(conn.clients) }, null, 2)
      );
    } catch {
      // best-effort
    }
  };

  // (Re)connect only when there's no cache yet, the server set changed (defensive —
  // server changes go through a full process restart), or a cached child crashed.
  // Otherwise reuse the live connections and skip the handshakes entirely.
  const key = JSON.stringify(servers);
  if (!sharedConn || sharedConn.key !== key || !connClients(sharedConn).every((c) => c.alive !== false)) {
    if (sharedConn) {
      sharedConn.stale = true; // in-flight connects from the old entry must discard themselves
      for (const c of connClients(sharedConn)) {
        try {
          c.stop();
        } catch {
          // best-effort teardown of the stale connection
        }
      }
    }
    sharedConn = startConnections(servers, oauthTokens, persistAuth, publish, deviceReport);
    publish(sharedConn); // 'starting' placeholders + cleared catalog, visible immediately
  }
  // Recall's native tools are needed from the very first turn, and its handshake is
  // a fast local stdio spawn — the only connection the factory (and therefore pi's
  // readiness) waits for.
  await sharedConn.recallReady;
  const { clients, recall } = sharedConn;

  // Read-only connected folders (paths from the main process via
  // protected-roots.json). One gate instance serves both the MCP guards below
  // and the write/edit tool_call hook further down.
  const protectedRoots = makeProtectedRootsGate(join(dirname(cfgPath), 'protected-roots.json'));

  // Register tools on THIS session's pi (cheap, no network). Recall stays eager
  // (native tools, used every turn); everything else is behind the router.
  for (const r of recall) for (const tool of r.tools) registerNativeMcpTool(pi, r.name, r.spec, r.client, tool, protectedRoots);

  // Register the router meta-tools over the connected servers. `clients` fills in
  // live as background connects land, so their tools become invokable without
  // re-running this factory.
  registerRouterTools(pi, clients, protectedRoots);

  // Stem self-management tools (list/add/remove MCP servers). Always available.
  registerAdminTools(pi, cfgPath);

  // Self-editable standing custom instructions. The tool only PROPOSES; the user
  // approves in a card (editing the text + choosing the surface) and the MAIN process
  // writes settings.json — the extension never touches it. Applies on the next turn.
  registerInstructionsTool(pi);

  // Scheduled tasks: let the assistant schedule a prompt to re-run autonomously, and
  // surface a run's result prominently (notify_user). All routed to the main process
  // (which owns the scheduler) via a ctx.ui.input round-trip; main supplies the
  // current thread id, so a task is always bound to the conversation it's created in.
  registerTaskTools(pi);

  // Command execution: run a shell command on the user's machine. The tool only
  // forwards the request — the main process runs the tiered auto-approve policy
  // (allowlist → LLM judge → approval card) and spawns the command itself.
  registerExecTool(pi);

  // Stem self-authored skills: let the assistant save its own SKILL.md procedures.
  // The write itself happens in main (see SKILL_BRIDGE_TITLE) — it owns the
  // contract validator and the Off/Ask/Auto policy, neither of which a subprocess
  // could reach. A saved skill takes effect on the next reload, which Stem does at
  // the end of the turn; that also keeps the prompt cache valid, since no skill
  // ever changes mid-conversation.
  registerSkillTools(pi);

  // Per-turn gates read from sibling files (native-search.json / service-tier.json)
  // that the main process rewrites before each prompt, since main and Quick Chat
  // share one pi process and the hooks can't tell them apart.
  if (typeof pi.on === 'function') {
    const webSearchEnabled = makeNativeSearchGate(join(dirname(cfgPath), 'native-search.json'));
    const serviceTier = makeServiceTierGate(join(dirname(cfgPath), 'service-tier.json'));

    // Keep hold of a context that can raise a dialog. A server pinned to a
    // device reaches its machine through ctx.ui.input, and the code that needs
    // to — a client in the router's map — is never handed one (see liveCtx).
    // Both hooks, because session_start does not fire for a session that was
    // already live when this factory re-ran.
    pi.on('session_start', latchCtx);
    pi.on('turn_start', latchCtx);

    // Turn ON pi's read-only browse tools grep/find/ls — they're registered but
    // INACTIVE by default, and the assistant needs them to explore connected folders
    // (an Obsidian vault is far too large to list in the prompt; it must ls/find/grep
    // on demand). We can't enable them via the CLI without an allowlist that would also
    // drop our extension tools, so we activate them here. Done on session_start (the
    // pattern pi's own plan-mode extension uses to control active tools): it fires
    // post-bind so getActiveTools reflects every built-in + extension tool, and it sets
    // the session's tools BEFORE the first turn computes its tool list (turn_start is
    // too late). Re-fires on new/switch/fork. We merge in idempotently, clobbering nothing.
    if (typeof pi.setActiveTools === 'function' && typeof pi.getActiveTools === 'function') {
      const enableBrowseTools = () => {
        try {
          const active = pi.getActiveTools();
          // Web search rides the same mechanism: the vendored pi-web-access tools
          // are active by default, so turning search OFF for this context means
          // dropping them from the session's tool set (and adding them back when
          // it flips on). Gating them here rather than in the request body is what
          // makes the toggle work identically on every provider.
          const wantSearch = webSearchEnabled();
          const next = new Set(active);
          for (const t of ['grep', 'find', 'ls']) next.add(t);
          for (const t of WEB_ACCESS_TOOLS) {
            if (wantSearch) next.add(t);
            else next.delete(t);
          }
          if (next.size !== active.length || active.some((t) => !next.has(t))) {
            pi.setActiveTools([...next]);
          }
          // Publish the resulting active set (like mcp-status.json) so Stem can confirm
          // the browse tools are live without spawning a turn.
          try {
            writeFileSync(join(dirname(cfgPath), 'active-tools.json'), JSON.stringify({ active: pi.getActiveTools() }, null, 2));
          } catch {
            // best-effort diagnostic
          }
        } catch {
          // best-effort: worst case the assistant falls back to `read` on known paths
        }
      };
      pi.on('session_start', enableBrowseTools);
      // Backstop: also enable right before each turn, in case session_start didn't fire
      // for an already-active session (e.g. a hot runtime reload mid-session).
      pi.on('turn_start', enableBrowseTools);
    }

    // Enforce read-only connected folders: block any write/edit whose target path
    // falls inside a folder the user connected read-only. Relative paths resolve
    // against pi's cwd (Stem's workspace), which is never inside a connected
    // folder, so only an absolute write into a protected root trips this. Reads
    // through the built-ins are never blocked; MCP tool calls are guarded
    // separately in the router (findProtectedPath), and `bash` is excluded from
    // pi's tool set entirely (runtime.ts) — together those close the paths around
    // this hook, which only sees pi's own write/edit tools.
    pi.on('tool_call', (event) => {
      if (!event || (event.toolName !== 'write' && event.toolName !== 'edit')) return undefined;
      const p = event.input && typeof event.input.path === 'string' ? event.input.path : null;
      if (!p) return undefined;
      const roots = protectedRoots();
      if (roots.some((root) => isInside(p, root))) {
        return { block: true, reason: 'This folder is connected to Stem read-only — editing it is not allowed. Ask the user to switch it to read & write in the Folders tab.' };
      }
      return undefined;
    });
    // Service tier ("Fast"): see withServiceTier for which requests accept it.
    pi.on('before_provider_request', (event) => withServiceTier(event && event.payload, serviceTier()));
  }
}

// ---- Stem admin: assistant proposes MCP changes for main to apply ----

const ADMIN_RESERVED = new Set(['stem-recall', 'stem-admin']);
// Sentinel title so PiRuntime can distinguish an admin add/remove approval from
// an ordinary extension dialog and route it to Stem's McpApprovalCard.
const ADMIN_APPROVAL_TITLE = 'stem-admin-approval';
const ADMIN_VALID_NAME = /^[A-Za-z0-9_.-]+$/;

// Read mcp.json for list/remove validation. A genuinely missing file is a fresh
// config; preserve corrupt bytes for diagnosis instead of silently treating them
// as an empty server list.
function readMcpJson(cfgPath) {
  let raw;
  try {
    raw = readFileSync(cfgPath, 'utf8');
  } catch {
    return { servers: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.servers) return parsed;
    throw new Error('mcp.json has no "servers" object');
  } catch (e) {
    try {
      writeFileSync(`${cfgPath}.corrupt`, raw, { mode: 0o600 });
    } catch {
      // best-effort backup
    }
    throw new Error(`mcp.json is corrupt (preserved at ${cfgPath}.corrupt): ${(e && e.message) || e}`);
  }
}

async function requestAdminApproval(ctx, proposal) {
  if (!ctx || !ctx.ui || typeof ctx.ui.confirm !== 'function') return false;
  // The "message" carries the JSON proposal; PiRuntime parses it to build the card.
  return ctx.ui.confirm(ADMIN_APPROVAL_TITLE, JSON.stringify(proposal));
}

// Sentinel title so PiRuntime routes a custom-instructions approval to the
// InstructionsApprovalCard (and MAIN writes settings.json on accept).
const INSTRUCTIONS_APPROVAL_TITLE = 'stem-instructions-approval';

function registerInstructionsTool(pi) {
  pi.registerTool({
    name: 'set_custom_instructions',
    label: 'Set custom instructions',
    description:
      "Update the user's standing custom instructions — durable, high-priority directives that shape EVERY reply (response length, tone, output format, language style, component usage), kept separate from recalled facts. Use this when the user asks you to adopt a STANDING BEHAVIORAL RULE (\"always answer briefly\", \"from now on reply in plain markdown\", \"stop using callouts\") — NOT for one-off requests, and NOT for facts about the user (those are remembered automatically). The user must approve in a card where they edit the final text and CHOOSE THE SURFACE — do not assume the surface yourself. Surfaces: \"main\" applies everywhere including Quick Chat; \"quickChat\" is an extra layered only on the Quick Chat overlay (Quick Chat inherits main). Actions: \"append\" adds a line, \"replace\" overwrites that surface's text, \"clear\" empties it. Pass `surface` only as a hint when the user clearly meant one; the card lets them change it.",
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['append', 'replace', 'clear'],
          description: 'append a line / replace the whole text / clear it.'
        },
        text: { type: 'string', description: 'Instruction text to append or replace with. Omit/empty for clear.' },
        surface: {
          type: 'string',
          enum: ['main', 'quickChat'],
          description: 'Optional hint; the user confirms in the card. "main" = everywhere; "quickChat" = overlay-only extra.'
        }
      },
      required: ['action']
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const action = params && params.action;
      if (action !== 'append' && action !== 'replace' && action !== 'clear') {
        return { content: [{ type: 'text', text: 'Invalid action; use append, replace, or clear.' }], details: {}, isError: true };
      }
      const text = params && typeof params.text === 'string' ? params.text : '';
      if ((action === 'append' || action === 'replace') && !text.trim()) {
        return { content: [{ type: 'text', text: 'Provide non-empty text for append/replace.' }], details: {}, isError: true };
      }
      if (!ctx || !ctx.ui || typeof ctx.ui.confirm !== 'function') {
        return { content: [{ type: 'text', text: 'Cannot request approval in this context.' }], details: {}, isError: true };
      }
      const surface = params && (params.surface === 'main' || params.surface === 'quickChat') ? params.surface : undefined;
      const proposal = { action, incomingText: action === 'clear' ? '' : text, surface };
      // PiRuntime parses this JSON, shows the card, and (on accept) MAIN writes settings.
      const approved = await ctx.ui.confirm(INSTRUCTIONS_APPROVAL_TITLE, JSON.stringify(proposal));
      return approved
        ? { content: [{ type: 'text', text: 'Custom instructions updated. They take effect on your next reply.' }], details: {} }
        : { content: [{ type: 'text', text: 'The user declined the custom-instructions change.' }], details: {} };
    }
  });
}

function buildServerEntry(params) {
  const name = String((params && params.name) || '').trim();
  if (!name) throw new Error('MCP server requires a name.');
  if (!ADMIN_VALID_NAME.test(name) || name.startsWith('-')) {
    throw new Error('MCP server name may only contain letters, numbers, dot, dash, or underscore, and cannot start with a dash.');
  }
  if (ADMIN_RESERVED.has(name)) throw new Error(`"${name}" is a reserved Stem server name.`);
  const transport = params && params.transport === 'http' ? 'http' : 'stdio';
  if (transport === 'http') {
    const url = String((params && params.url) || '').trim();
    if (!url) throw new Error('A remote (http) MCP server requires a url.');
    const headers =
      params && params.headers && typeof params.headers === 'object' && Object.keys(params.headers).length
        ? params.headers
        : undefined;
    // Optional static OAuth client for providers without dynamic client
    // registration (e.g. Slack). Stored on the entry; mcpLogin runs the
    // confidential-client flow when oauthClientId is present.
    const oauthClientId = String((params && params.oauthClientId) || '').trim() || undefined;
    const oauthClientSecret = String((params && params.oauthClientSecret) || '').trim() || undefined;
    const oauthScope = String((params && params.oauthScope) || '').trim() || undefined;
    const oauth = {
      ...(oauthClientId ? { oauthClientId } : {}),
      ...(oauthClientSecret ? { oauthClientSecret } : {}),
      ...(oauthScope ? { oauthScope } : {})
    };
    const entry = { url, ...(headers ? { headers } : {}), ...oauth, trusted: true };
    // Runtime keeps this complete mutation payload private and emits a separately
    // redacted approval card. Main needs the true secret if the user accepts.
    const input = {
      name,
      transport,
      url,
      ...(headers ? { headers } : {}),
      ...(oauthClientId ? { oauthClientId } : {}),
      ...(oauthScope ? { oauthScope } : {}),
      ...(oauthClientSecret ? { oauthClientSecret } : {})
    };
    return { name, entry, input };
  }
  const command = String((params && params.command) || '').trim();
  if (!command) throw new Error('A local (stdio) MCP server requires a command.');
  const args = Array.isArray(params.args)
    ? params.args.map(String)
    : typeof params.args === 'string' && params.args.trim()
      ? params.args.trim().split(/\s+/)
      : [];
  const env =
    params.env && typeof params.env === 'object' && Object.keys(params.env).length
      ? Object.fromEntries(Object.entries(params.env).map(([k, v]) => [k, String(v)]))
      : undefined;
  const entry = { command, args, ...(env ? { env } : {}), trusted: true };
  const input = { name, transport, command, args, ...(env ? { env } : {}) };
  return { name, entry, input };
}

function registerAdminTools(pi, cfgPath) {
  pi.registerTool({
    name: 'list_mcp_servers',
    label: 'List MCP servers',
    description:
      "List the MCP servers currently configured for this assistant (excluding Stem's internal servers), including WHICH MACHINE each one runs on and whether it is switched off. Use this to see what is already set up before adding or removing one, and whenever a server is failing — where it runs decides which machine has to have its command installed and be able to reach its URL.",
    parameters: { type: 'object', properties: {} },
    async execute() {
      let servers;
      try {
        servers = readMcpJson(cfgPath).servers || {};
      } catch (e) {
        return { content: [{ type: 'text', text: `Cannot read MCP config: ${e.message}` }], details: {}, isError: true };
      }
      const lines = Object.entries(servers)
        .filter(([n]) => !ADMIN_RESERVED.has(n))
        .map(([n, def]) => {
          const how = def.url
            ? `(http): ${def.url}`
            : `(stdio): ${`${def.command || ''} ${(def.args || []).join(' ')}`.trim()}`;
          const label = def.location && typeof def.location.label === 'string' ? def.location.label.trim() : '';
          const where = def.location
            ? `runs on the user's computer ${label ? `“${label}”` : '(the one it is pinned to)'}`
            : 'runs where Stem itself runs';
          return `- ${n} ${how} — ${where}${def.disabled ? ', switched off in Settings' : ''}`;
        });
      // The placement rules travel with the list, not in a doc page the model may
      // not read: a server failing on the wrong machine is the one question this
      // tool exists to answer, and the answer is useless without them.
      const footer =
        'A server with no pin runs on the same machine you do, so its command must exist there and its URL must be ' +
        'reachable from there. A pinned one runs on that computer of the user\'s instead, and its tools work whenever ' +
        'that computer is awake with Stem running. Only the user can move a server between machines — Settings → Tools ' +
        '→ MCP servers, select it, Move to — and add_mcp_server always adds one that runs where you do.';
      const text = lines.length
        ? `Configured MCP servers:\n${lines.join('\n')}\n\n${footer}`
        : `No MCP servers are configured yet.\n\n${footer}`;
      return { content: [{ type: 'text', text }], details: {} };
    }
  });

  pi.registerTool({
    name: 'add_mcp_server',
    label: 'Add MCP server',
    description:
      'Add (or replace) an MCP server so its tools become available. The user must approve the change in the app before it is applied; after approval Stem reloads so the new tools are usable. Use transport "stdio" for a local command (uvx/npx) or "http" for a remote streamable-HTTP URL. For a remote server, authenticate it in one of two ways: a static auth header (`headers`), or OAuth — for OAuth providers that lack dynamic client registration (e.g. Slack) supply `oauthClientId`/`oauthClientSecret`/`oauthScope` from a pre-registered provider app; the user then signs in via the browser. Pass OAuth credentials the user gives you here rather than as headers.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short identifier (letters, numbers, dot, dash, underscore; no leading dash).' },
        transport: { type: 'string', enum: ['stdio', 'http'], description: 'stdio = local command; http = remote URL.' },
        command: { type: 'string', description: 'stdio only: the executable to run, e.g. "uvx" or "npx".' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio only: command arguments.' },
        url: { type: 'string', description: 'http only: the streamable-HTTP endpoint.' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'stdio only: environment variables.' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'http only: request headers, e.g. {"Authorization": "Bearer …"}.' },
        oauthClientId: { type: 'string', description: 'http only: OAuth client id from a pre-registered provider app, for OAuth servers without dynamic client registration (e.g. Slack). The user signs in via the browser afterward.' },
        oauthClientSecret: { type: 'string', description: 'http only: OAuth client secret for a confidential client (e.g. Slack). Stored securely (0600); needed alongside oauthClientId.' },
        oauthScope: { type: 'string', description: 'http only: space-separated OAuth scopes to request; must match what is enabled on the provider app.' }
      },
      required: ['name', 'transport']
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      let built;
      try {
        built = buildServerEntry(params);
      } catch (e) {
        return { content: [{ type: 'text', text: `Cannot add server: ${e.message}` }], details: {}, isError: true };
      }
      const approved = await requestAdminApproval(ctx, { action: 'add', name: built.name, input: built.input });
      if (!approved) return { content: [{ type: 'text', text: `The user declined adding "${built.name}".` }], details: {} };
      // The main process applies the accepted proposal through its serialized
      // config writer before replying `true`. Keeping this extension read-only
      // avoids stale read/modify/write snapshots clobbering concurrent UI edits.
      return { content: [{ type: 'text', text: `Added MCP server "${built.name}". It will be active after Stem reloads.` }], details: {} };
    }
  });

  pi.registerTool({
    name: 'remove_mcp_server',
    label: 'Remove MCP server',
    description:
      "Remove a configured MCP server by name. The user must approve the change in the app; after approval Stem reloads. Stem's internal servers cannot be removed.",
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The exact server name to remove.' } },
      required: ['name']
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const name = String((params && params.name) || '').trim();
      if (!name) return { content: [{ type: 'text', text: 'Provide the name of the server to remove.' }], details: {}, isError: true };
      if (ADMIN_RESERVED.has(name))
        return { content: [{ type: 'text', text: `"${name}" is a reserved Stem server and cannot be removed.` }], details: {}, isError: true };
      let config;
      try {
        config = readMcpJson(cfgPath);
      } catch (e) {
        return { content: [{ type: 'text', text: `Cannot update MCP config: ${e.message}` }], details: {}, isError: true };
      }
      if (!config.servers || !(name in config.servers))
        return { content: [{ type: 'text', text: `No MCP server named "${name}" is configured.` }], details: {}, isError: true };
      const approved = await requestAdminApproval(ctx, { action: 'remove', name });
      if (!approved) return { content: [{ type: 'text', text: `The user declined removing "${name}".` }], details: {} };
      // Main has already removed the server and its name-keyed OAuth token before
      // approving this held request. Do not write the pre-approval config snapshot.
      return { content: [{ type: 'text', text: `Removed MCP server "${name}". It will stop being available after Stem reloads.` }], details: {} };
    }
  });
}

// ---- Scheduled tasks: assistant schedules autonomous re-runs + surfaces results ----

// Sentinel title for the ctx.ui.input round-trip PiRuntime intercepts (it never
// shows UI for this title — it runs the op and answers with a JSON result string).
const TASK_BRIDGE_TITLE = 'stem-task-bridge';

/** Round-trip one task op through PiRuntime; returns the parsed result (or an error object). */
async function taskBridge(ctx, payload) {
  if (!ctx || !ctx.ui || typeof ctx.ui.input !== 'function') {
    return { ok: false, error: 'Scheduled tasks are unavailable in this context.' };
  }
  const raw = await ctx.ui.input(TASK_BRIDGE_TITLE, JSON.stringify(payload));
  if (typeof raw !== 'string') return { ok: false, error: 'No response from Stem.' };
  try {
    return JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Malformed response from Stem.' };
  }
}

function taskOk(text) {
  return { content: [{ type: 'text', text }], details: {} };
}
function taskErr(text) {
  return { content: [{ type: 'text', text }], details: {}, isError: true };
}

function describeSchedule(task) {
  if (!task || !task.schedule) return '';
  return task.schedule.kind === 'cron' ? `cron "${task.schedule.expr}"` : `once at ${task.schedule.at}`;
}

function registerTaskTools(pi) {
  pi.registerTool({
    name: 'schedule_task',
    label: 'Schedule task',
    description:
      'Schedule the CURRENT conversation to re-run a prompt automatically on a schedule. Each run is a full autonomous turn appended to this same chat; no human watches it live, so the run should call notify_user only if it finds something the user should see. Provide EITHER `cron` (a standard 5-field cron expression, in local time, for a recurring task) OR `at` (an ISO 8601 datetime for a one-time task) — not both. The `at` time is interpreted in the user\'s LOCAL time and must be in the future; write it without a trailing "Z" (e.g. 2026-07-01T08:00:00) so it is not misread as UTC. Examples: cron "0 8 * * 1-5" = weekday mornings at 08:00; cron "*/30 * * * *" = every 30 minutes.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to do on each run, e.g. "Check the news page and summarize anything new about LLM releases."' },
        cron: { type: 'string', description: 'A 5-field cron expression (minute hour day-of-month month day-of-week) for a recurring task.' },
        at: { type: 'string', description: 'A future ISO 8601 datetime in the user\'s local time, without a "Z" suffix (e.g. 2026-07-01T08:00:00), for a one-time task.' }
      },
      required: ['prompt']
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const res = await taskBridge(ctx, { op: 'schedule', prompt: params?.prompt, cron: params?.cron, at: params?.at });
      if (!res.ok) return taskErr(res.error || 'Could not schedule the task.');
      return taskOk(`Scheduled this conversation to run ${describeSchedule(res.task)}. Manage it in the Tasks tab.`);
    }
  });

  pi.registerTool({
    name: 'list_tasks',
    label: 'List scheduled tasks',
    description: 'List the scheduled tasks attached to the CURRENT conversation, with their ids and schedules.',
    parameters: { type: 'object', properties: {} },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const res = await taskBridge(ctx, { op: 'list' });
      if (!res.ok) return taskErr(res.error || 'Could not list tasks.');
      const tasks = res.tasks || [];
      if (!tasks.length) return taskOk('No scheduled tasks for this conversation.');
      const lines = tasks.map(
        (t) => `- ${t.id} — ${describeSchedule(t)}${t.enabled ? '' : ' (paused)'}: ${t.title}`
      );
      return taskOk(`Scheduled tasks for this conversation:\n${lines.join('\n')}`);
    }
  });

  pi.registerTool({
    name: 'cancel_task',
    label: 'Cancel scheduled task',
    description: 'Cancel (delete) a scheduled task by its id. Use list_tasks first to find the id.',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'The exact task id to cancel.' } },
      required: ['taskId']
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const res = await taskBridge(ctx, { op: 'cancel', taskId: params?.taskId });
      if (!res.ok) return taskErr(res.error || 'Could not cancel the task.');
      return taskOk('Task cancelled.');
    }
  });

  pi.registerTool({
    name: 'notify_user',
    label: 'Notify user',
    description:
      'Surface a prominent in-app alert to the user. Intended for autonomous scheduled runs: call this ONLY when a run produced something the user should be told about right now (e.g. a watched condition became true). Keep the message short and specific. Does nothing useful during an ordinary interactive chat — just reply normally there.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The short alert message to show the user.' },
        title: { type: 'string', description: 'Optional short headline for the alert.' }
      },
      required: ['message']
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const message = String((params && params.message) || '').trim();
      if (!message) return taskErr('Provide a message to notify the user with.');
      const res = await taskBridge(ctx, { op: 'notify', message, title: params?.title });
      if (!res.ok) return taskErr(res.error || 'Could not notify the user.');
      return taskOk('Notified the user.');
    }
  });
}

// ---- Command execution: run shell commands via the main-process executor ----

// Sentinel title for the ctx.ui.input round-trip PiRuntime intercepts (it never
// shows UI for this title — it runs the policy + command and answers with a JSON
// result string). The response can take minutes: main may hold the request open
// for an approval card and then for the command itself.
const EXEC_BRIDGE_TITLE = 'stem-exec-bridge';

/** Round-trip one exec request through PiRuntime; returns the parsed result (or an error object). */
async function execBridge(ctx, payload) {
  if (!ctx || !ctx.ui || typeof ctx.ui.input !== 'function') {
    return { ok: false, error: 'Command execution is unavailable in this context.' };
  }
  const raw = await ctx.ui.input(EXEC_BRIDGE_TITLE, JSON.stringify(payload));
  if (typeof raw !== 'string') return { ok: false, error: 'No response from Stem.' };
  try {
    return JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Malformed response from Stem.' };
  }
}

function registerExecTool(pi) {
  pi.registerTool({
    name: 'run_command',
    label: 'Run command',
    description:
      'Run a shell command on the machine Stem itself runs on — the user\'s own computer for an ordinary install, ' +
      'their server when Stem runs on one (your instructions say which, under "Where you are running"). ' +
      'With `device`, the command runs on one of the user\'s own paired computers instead — see that parameter ' +
      'for when and how. ' +
      'On macOS/Linux Stem uses the host shell (zsh where there is one, otherwise bash or sh) with the login-shell ' +
      'PATH (Homebrew/npm CLIs like `agent-browser` work). On Windows Stem uses the shell chosen in Settings → ' +
      'Chat → Command execution (Command Prompt by default, or Git Bash). Each turn names the one local shell ' +
      'that will run — follow that, not both. ' +
      'When the shell is cmd.exe (the Windows default, and the shell on a paired Windows computer), ' +
      'if you need PowerShell, invoke it explicitly as `powershell.exe -NoProfile -ExecutionPolicy Bypass ' +
      '-Command "..."` so a broken profile.ps1 cannot block the run. A bare `|` is a cmd pipe (it splits ' +
      'before PowerShell) — put PowerShell pipelines inside `-Command "..."` (or use `(...)` / property ' +
      'access instead). Quote with double quotes there: cmd does not treat `\'` as a quote, so a ' +
      'single-quoted argument goes to the safety check instead of running. ' +
      'Use this to drive CLIs, git, build tools, or quick scripts — NOT to read files ' +
      '(use the dedicated read/grep/find/ls tools). By default the command runs in a scratch folder ' +
      'belonging to THIS conversation: other chats cannot see it, and it is deleted when the user ' +
      'deletes this chat or once it has sat untouched for the period set in Settings. Treat it as ' +
      'working space, not storage — anything the user asked you to keep goes in the Files place, ' +
      'reachable from the shell as `files/` (e.g. `cp report.pdf files/`), which is the same folder ' +
      'your file tools read and write. Say so plainly if you leave something only in scratch. ' +
      'Pass `cwd` only when the command must run in a specific existing directory; a relative `cwd` ' +
      'resolves inside this chat\'s scratch folder. Folders ' +
      'connected read-only are blocked entirely. Safe commands run immediately; others are screened by ' +
      'an automatic safety check and may pause for the user\'s approval (denied automatically in ' +
      'scheduled runs — prefer simple, clearly-safe commands there). Always quote arguments containing ' +
      'special characters (&, ?, ;, spaces) — e.g. agent-browser open "https://example.com/watch?v=x&t=1" ' +
      '— an unquoted & or ; changes what the shell runs and forces the approval path. Output is captured ' +
      'with the exit code and truncated past 64KB per stream; default timeout 60s (max 300s via ' +
      '`timeout_ms`).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run, e.g. "agent-browser open https://example.com".' },
        cwd: { type: 'string', description: 'Optional absolute path of an existing directory to run in.' },
        timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds (default 60000, max 300000).' },
        device: {
          type: 'string',
          description:
            'Run the command on one of the user\'s own paired computers instead, named by its device label ' +
            '(e.g. "Vlado\'s MacBook"). Only works when that computer has switched on "accepts commands" and is ' +
            'awake with Stem running; your per-turn context says which computers accept commands. On that ' +
            'machine there is no files/ folder — outputs stay on that computer, so pass an absolute cwd ' +
            '(e.g. its Downloads folder) when the user should find the result, and tell them where it is. ' +
            'Commands there face the same approval policy, judged for that machine.'
        }
      },
      required: ['command']
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const command = String((params && params.command) || '').trim();
      if (!command) return taskErr('Provide a command to run.');
      const res = await execBridge(ctx, {
        command,
        cwd: params && typeof params.cwd === 'string' ? params.cwd : undefined,
        timeout_ms: params && typeof params.timeout_ms === 'number' ? params.timeout_ms : undefined,
        device: params && typeof params.device === 'string' && params.device.trim() ? params.device : undefined
      });
      if (!res.ok) return taskErr(res.error || 'The command could not be run.');
      return taskOk(res.text || '(no output)');
    }
  });
}

// ---- Stem skills: assistant self-authors reusable SKILL.md procedures ----

// This tool used to write SKILL.md straight to disk from inside the pi process.
// It validated three fields for emptiness and nothing else, which is how the
// library it built ended up with a 79-character English sentence in a `name:`
// field capped at 64 slug characters — and it could never pause for the user,
// because a subprocess has no way to raise a card.
//
// So the write now round-trips to the Electron main process, which owns the
// contract validator, the Off/Ask/Auto policy, and the approval card. This file
// keeps only the tool's shape and the argument marshalling. The response can take
// minutes: main may hold the request open behind a card the user has not seen yet.

const SKILL_BRIDGE_TITLE = 'stem-skill-bridge';

function skillOk(text) {
  return { content: [{ type: 'text', text }], details: {} };
}
function skillErr(text) {
  return { content: [{ type: 'text', text }], details: {}, isError: true };
}

/** Round-trip one skill write through PiRuntime; returns the parsed result. */
async function skillBridge(ctx, payload) {
  if (!ctx || !ctx.ui || typeof ctx.ui.input !== 'function') {
    return { ok: false, text: 'Saving skills is unavailable in this context.' };
  }
  const raw = await ctx.ui.input(SKILL_BRIDGE_TITLE, JSON.stringify(payload));
  if (typeof raw !== 'string') return { ok: false, text: 'No response from Stem.' };
  try {
    return JSON.parse(raw);
  } catch {
    return { ok: false, text: 'Malformed response from Stem.' };
  }
}

function registerSkillTools(pi) {
  pi.registerTool({
    name: 'manage_skill',
    label: 'Manage skill',
    description:
      'Save, update, or remove one of your own reusable skills (a SKILL.md procedure). ' +
      'Use action "save" both to add a skill and to replace an existing one — always send the FULL body, never a fragment. ' +
      'Set `initiated_by` honestly: "user" when the user asked you to save or change a skill (that always goes through, whatever the user\'s automatic-skills setting says), ' +
      '"assistant" when saving it is your own idea (that follows their setting, and may ask them first or be declined). ' +
      'A skill needs: a lowercase-hyphenated `name` of at most 64 characters, which is also its folder; a ONE-sentence `description` of at most 160 characters saying WHEN to reach for it, never restating the name; ' +
      'and a `content` body of at most 4096 bytes with exactly the headings "## When to use", "## Steps", "## Verification", in that order. Write no front-matter. ' +
      'If the reply says the skill was rejected, it lists exactly what was wrong — fix those points and call again. ' +
      'Use action "remove" to delete an auto-created skill that is no longer useful.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'remove'], description: 'save (add or replace) or remove a skill.' },
        name: { type: 'string', description: 'The skill slug: lowercase words joined by single hyphens, max 64 chars.' },
        initiated_by: {
          type: 'string',
          enum: ['user', 'assistant'],
          description: 'Who wanted this saved: "user" if they asked, "assistant" if it is your own idea. Defaults to "assistant".'
        },
        description: { type: 'string', description: 'save: ONE sentence, max 160 chars, saying when to use the skill.' },
        content: { type: 'string', description: 'save: the FULL body with the three required headings. Replaces any previous body.' },
        expect_existing: {
          type: 'boolean',
          description: 'save: true when you mean to change a skill that already exists (fails if it does not).'
        }
      },
      required: ['action', 'name']
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const action = String((params && params.action) || '').trim();
      // "create"/"patch" were the old action names; a model that reaches for one
      // means "save", and failing it on vocabulary would waste a whole turn.
      const op = action === 'remove' ? 'remove' : action === 'save' || action === 'create' || action === 'patch' ? 'save' : '';
      if (!op) return skillErr(`Unknown action "${action}". Use save or remove.`);
      try {
        const res = await skillBridge(ctx, {
          op,
          name: params && params.name,
          initiated_by: params && params.initiated_by,
          description: params && params.description,
          content: params && params.content,
          // "patch" carried the same intent the flag now carries explicitly.
          expect_existing: (params && params.expect_existing === true) || action === 'patch'
        });
        return res && res.ok ? skillOk(res.text || 'Done.') : skillErr((res && res.text) || 'The skill could not be saved.');
      } catch (e) {
        return skillErr(`manage_skill failed: ${(e && e.message) || e}`);
      }
    }
  });
}
