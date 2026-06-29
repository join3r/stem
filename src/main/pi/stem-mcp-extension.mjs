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
// spawned from the in-repo path (like recall/mcp-server.mjs).

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

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
 * Atomic: data is written to a sibling temp file and renamed over the target, so
 * a crash mid-write can only leave a stray `.tmp`, never a truncated file. This
 * matters because both this bridge and Stem's main process write mcp.json; a
 * half-written file used to read back as corrupt and get reset to an empty
 * server list, silently dropping every user-added server.
 */
function writeSecretSync(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort on platforms without POSIX perms
  }
  renameSync(tmp, path); // atomic on the same filesystem (same dir)
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
async function refreshOAuth(auth) {
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
    body: body.toString()
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
class McpHttpClient {
  constructor(name, spec, auth, persist) {
    this.name = name;
    this.url = spec.url;
    this.headers = spec.headers || {};
    this.auth = auth || null;
    this.persist = persist || (() => {});
    this.sessionId = null;
    this.nextId = 1;
    this.tools = [];
    // Stateless (each call is a fresh fetch), so a cached HTTP client never goes
    // stale — always alive for the connection-cache liveness check.
    this.alive = true;
  }

  start() {}

  /** No persistent resource to tear down; present for parity with the stdio client. */
  stop() {}

  async authHeaders() {
    if (!this.auth) return {};
    // Proactively refresh if we know the token is within a minute of expiring.
    if (this.auth.refreshToken && this.auth.expiresAt && Date.now() > this.auth.expiresAt - 60000) {
      try {
        await refreshOAuth(this.auth);
        this.persist(this.auth);
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
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.headers,
        ...(await this.authHeaders())
      },
      body: JSON.stringify(body)
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    // A rejected token → refresh once and retry before surfacing the failure.
    if (res.status === 401 && this.auth && this.auth.refreshToken && !retried) {
      try {
        await refreshOAuth(this.auth);
        this.persist(this.auth);
        return this.rpc(method, params, notify, true);
      } catch {
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

// ---- Native web search injection ----
//
// Some providers expose a server-side web-search tool that pi never asks for (its
// serializer only emits function tools). The `before_provider_request` hook lets us
// add the provider's native tool to the outgoing request body — restoring the
// native web search the codex backend used to give us, billed to the user's
// subscription, with no third-party API. Whether THIS turn gets it is a single
// `{ enabled }` gate in native-search.json, rewritten by the main process before
// each prompt from the originating context's setting (main vs Quick Chat).

/**
 * Identify the outgoing request's provider from the request body shape and return
 * the native web-search tool to inject for it, or null if the provider has none.
 * Shape-based so we never touch a provider we don't recognize.
 */
function nativeSearchToolFor(p) {
  if (!p || typeof p !== 'object') return null;
  // openai-codex responses body: an `input` array plus an `instructions` string.
  if (Array.isArray(p.input) && typeof p.instructions === 'string') {
    return { type: 'web_search' };
  }
  // --- FUTURE: anthropic/Claude branch (Claude-via-pi is currently gated) ---
  // if (Array.isArray(p.messages) && typeof p.max_tokens === 'number') {
  //   return { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };
  // }
  return null;
}

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
 * Folders registry changes; a missing/corrupt file means "nothing protected".
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
      cache = { mtime: -1, roots: [] };
    }
    return cache.roots;
  };
}

/** True when `target` is at or inside `root` (lexical containment, both absolute). */
// Exported for scripts/cfolders-verify.mjs (and makeProtectedRootsGate below); pi
// only consumes the default export, so these named exports are inert at load time.
export function isInside(target, root) {
  const rel = resolve(root) + sep;
  const t = resolve(target);
  return t === resolve(root) || t.startsWith(rel);
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
function registerNativeMcpTool(pi, name, spec, client, tool) {
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
function registerRouterTools(pi, clients) {
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
      const text = JSON.stringify(
        { server, name: def.name, description: def.description || '', inputSchema: def.inputSchema || { type: 'object' } },
        null,
        2
      );
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

/** Names+signatures catalog text for the routed servers (the cheap per-turn list). */
function buildCatalogText(clients) {
  const sections = [];
  for (const [name, { tools }] of clients) {
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
let sharedConn = null; // { key, clients: Map, recall: [{name,spec,client,tools}], status }

/** Connect every configured server once; split recall (eager) from routed servers. */
async function connectServers(servers, oauthTokens, persistAuth) {
  const clients = new Map(); // name -> { client, spec, tools } (routed via meta-tools)
  const recall = []; // [{ name, spec, client, tools }] (eager, registered natively)
  const status = {};
  for (const [name, spec] of Object.entries(servers)) {
    if (spec.disabled) continue;
    // Remote (Streamable HTTP — static header or OAuth) or local (stdio); both
    // expose the same handshake()/callTool() surface.
    const client = spec.url
      ? new McpHttpClient(name, spec, oauthTokens[name], (auth) => persistAuth(name, auth))
      : new McpStdioClient(name, spec);
    try {
      client.start();
      const tools = await client.handshake();
      if (name === RECALL_SERVER_NAME) recall.push({ name, spec, client, tools });
      else clients.set(name, { client, spec, tools });
      status[name] = { status: 'ready', error: null };
    } catch (e) {
      status[name] = { status: 'failed', error: String((e && e.message) || e) };
    }
  }
  return { clients, recall, status };
}

/** Every connected client in a cached connection (recall + routed). */
function connClients(conn) {
  return [...conn.recall.map((r) => r.client), ...[...conn.clients.values()].map((e) => e.client)];
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
  const servers = (config && config.servers) || {};

  // OAuth tokens (from Stem's browser sign-in) live next to mcp.json; the bridge
  // injects them as bearer headers and rewrites the file when it refreshes one.
  const oauthPath = join(dirname(cfgPath), 'mcp-oauth.json');
  let oauthTokens = {};
  try {
    oauthTokens = JSON.parse(readFileSync(oauthPath, 'utf8')) || {};
  } catch {
    // none yet
  }
  const persistAuth = (name, auth) => {
    let all = {};
    try {
      all = JSON.parse(readFileSync(oauthPath, 'utf8')) || {};
    } catch {
      // start fresh
    }
    all[name] = auth;
    try {
      writeSecretSync(oauthPath, JSON.stringify(all, null, 2));
    } catch {
      // best-effort
    }
  };

  // (Re)connect only when there's no cache yet, the server set changed (defensive —
  // server changes go through a full process restart), or a cached child crashed.
  // Otherwise reuse the live connections and skip the ~2s of handshakes entirely.
  const key = JSON.stringify(servers);
  if (!sharedConn || sharedConn.key !== key || !connClients(sharedConn).every((c) => c.alive !== false)) {
    if (sharedConn) for (const c of connClients(sharedConn)) {
      try {
        c.stop();
      } catch {
        // best-effort teardown of the stale connection
      }
    }
    sharedConn = { key, ...(await connectServers(servers, oauthTokens, persistAuth)) };
  }
  const { clients, recall, status } = sharedConn;

  // Register tools on THIS session's pi (cheap, no network). Recall stays eager
  // (native tools, used every turn); everything else is behind the router.
  for (const r of recall) for (const tool of r.tools) registerNativeMcpTool(pi, r.name, r.spec, r.client, tool);

  // Register the router meta-tools over the connected servers.
  registerRouterTools(pi, clients);

  // Publish connection status so Stem's main process can surface it (getMcpStatus).
  try {
    writeFileSync(join(dirname(cfgPath), 'mcp-status.json'), JSON.stringify(status, null, 2));
  } catch {
    // best-effort
  }

  // Publish the names+signatures catalog so the main process can inject it each
  // turn (cheap discovery; full schemas come from describe_tool). Always written —
  // an empty object clears a stale catalog when no routed servers are connected.
  try {
    writeFileSync(
      join(dirname(cfgPath), 'mcp-catalog.json'),
      JSON.stringify({ text: buildCatalogText(clients) }, null, 2)
    );
  } catch {
    // best-effort
  }

  // Stem self-management tools (list/add/remove MCP servers). Always available.
  registerAdminTools(pi, cfgPath);

  // Scheduled tasks: let the assistant schedule a prompt to re-run autonomously, and
  // surface a run's result prominently (notify_user). All routed to the main process
  // (which owns the scheduler) via a ctx.ui.input round-trip; main supplies the
  // current thread id, so a task is always bound to the conversation it's created in.
  registerTaskTools(pi);

  // Stem self-authored skills: let the assistant create/patch/remove its own
  // SKILL.md procedures. Writes are silent (no approval card) and take effect on
  // the next reload — Stem detects the change and restarts at the end of the turn,
  // which also keeps the prompt cache valid (no mid-conversation skill edits).
  const skillsDir = process.env.STEM_SKILLS_DIR;
  if (skillsDir) registerSkillTools(pi, skillsDir);

  // Mutate each outgoing request to (a) restore native web search by injecting the
  // provider's server-side tool, and (b) apply the OpenAI service tier ("Fast"). Both
  // are gated per turn by sibling files (native-search.json / service-tier.json) that
  // the main process rewrites before each prompt, since main and Quick Chat share one
  // pi process and the hook can't tell them apart.
  if (typeof pi.on === 'function') {
    const nativeSearchEnabled = makeNativeSearchGate(join(dirname(cfgPath), 'native-search.json'));
    const serviceTier = makeServiceTierGate(join(dirname(cfgPath), 'service-tier.json'));

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
          if (!(active.includes('grep') && active.includes('find') && active.includes('ls'))) {
            pi.setActiveTools([...new Set([...active, 'grep', 'find', 'ls'])]);
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
    // falls inside a folder the user connected read-only (paths from the main
    // process via protected-roots.json). Relative paths resolve against pi's cwd
    // (Stem's workspace), which is never inside a connected folder, so only an
    // absolute write into a protected root trips this. Reads are never blocked.
    const protectedRoots = makeProtectedRootsGate(join(dirname(cfgPath), 'protected-roots.json'));
    pi.on('tool_call', (event) => {
      if (!event || (event.toolName !== 'write' && event.toolName !== 'edit')) return undefined;
      const p = event.input && typeof event.input.path === 'string' ? event.input.path : null;
      if (!p) return undefined;
      const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
      const roots = protectedRoots();
      if (roots.some((root) => isInside(abs, root))) {
        return { block: true, reason: 'This folder is connected to Stem read-only — editing it is not allowed. Ask the user to switch it to read & write in the Folders tab.' };
      }
      return undefined;
    });
    pi.on('before_provider_request', (event) => {
      const p = event && event.payload;
      if (!p || typeof p !== 'object') return undefined;
      let next; // lazily cloned on first mutation; undefined => no change

      // (a) Native web search: add the provider's server-side tool.
      if (nativeSearchEnabled()) {
        const tool = nativeSearchToolFor(p);
        const tools = Array.isArray(p.tools) ? p.tools : [];
        if (tool && !tools.some((t) => t && t.type === tool.type)) {
          next = { ...p, tools: [...tools, tool] };
        }
      }

      // (b) Service tier: openai-codex responses accept service_tier:'priority' only.
      const tier = serviceTier();
      const isCodexBody = Array.isArray(p.input) && typeof p.instructions === 'string';
      if (tier === 'priority' && isCodexBody && !p.service_tier) {
        next = { ...(next ?? p), service_tier: tier };
      }

      return next;
    });
  }
}

// ---- Stem admin: assistant self-manages MCP servers (edits mcp.json) ----

const ADMIN_RESERVED = new Set(['stem-recall', 'stem-admin']);
// Sentinel title so PiRuntime can distinguish an admin add/remove approval from
// an ordinary extension dialog and route it to Stem's McpApprovalCard.
const ADMIN_APPROVAL_TITLE = 'stem-admin-approval';
const ADMIN_VALID_NAME = /^[A-Za-z0-9_.-]+$/;

// Read mcp.json for the admin tools. A genuinely missing file is a fresh config;
// a file that exists but is corrupt must NOT be treated as empty — the add/remove
// tools read-modify-write it, so an empty fallback would persist a wipe of every
// user server. Preserve the bytes to a `.corrupt` sibling and throw instead.
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
    // `input` is shown on the approval card — carry the client id/scope so the
    // user can verify them, but never surface the secret (show presence only).
    const input = {
      name,
      transport,
      url,
      ...(headers ? { headers } : {}),
      ...(oauthClientId ? { oauthClientId } : {}),
      ...(oauthScope ? { oauthScope } : {}),
      ...(oauthClientSecret ? { oauthClientSecret: '********' } : {})
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
      "List the MCP servers currently configured for this assistant (excluding Stem's internal servers). Use this to see what is already set up before adding or removing one.",
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
        .map(([n, def]) =>
          def.url ? `- ${n} (http): ${def.url}` : `- ${n} (stdio): ${def.command} ${(def.args || []).join(' ')}`.trim()
        );
      const text = lines.length ? `Configured MCP servers:\n${lines.join('\n')}` : 'No MCP servers are configured yet.';
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
      let config;
      try {
        config = readMcpJson(cfgPath);
      } catch (e) {
        return { content: [{ type: 'text', text: `Cannot update MCP config: ${e.message}` }], details: {}, isError: true };
      }
      config.servers = config.servers || {};
      config.servers[built.name] = built.entry;
      writeSecretSync(cfgPath, JSON.stringify(config, null, 2));
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
      delete config.servers[name];
      writeSecretSync(cfgPath, JSON.stringify(config, null, 2));
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

// ---- Stem skills: assistant self-authors reusable SKILL.md procedures ----

// Keep skills small and human-readable (matches the pi/agentskills convention).
const SKILL_MAX_BYTES = 15_000;
const SKILL_VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

function skillOk(text) {
  return { content: [{ type: 'text', text }], details: {} };
}
function skillErr(text) {
  return { content: [{ type: 'text', text }], details: {}, isError: true };
}
function skillNowIso() {
  return new Date().toISOString();
}

/** Derive a filesystem slug from a free-text skill name. */
function slugifySkill(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Compose a SKILL.md. Scalars are JSON-stringified, which is valid YAML for
 * strings (a double-quoted scalar) and safely escapes colons/quotes/newlines —
 * so the bridge needs no YAML dependency to write well-formed front-matter.
 */
function composeSkillMd({ name, description, body, version, created, updated }) {
  const fm = [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    'metadata:',
    '  stem:',
    '    source: agent',
    `    version: ${version}`,
    `    created: ${JSON.stringify(created)}`,
    `    updated: ${JSON.stringify(updated)}`,
    '---'
  ].join('\n');
  return `${fm}\n\n${String(body).trim()}\n`;
}

/** On any skill write, touch a revision file so the main process notices and reloads. */
function bumpSkillsRev(skillsDir) {
  try {
    writeFileSync(join(skillsDir, '.skills-rev'), String(Date.now()));
  } catch {
    // best-effort: worst case the skill activates on the next backend restart
  }
}

function createSkill(skillsDir, params) {
  const name = String((params && params.name) || '').trim();
  const description = String((params && params.description) || '').trim();
  const body = String((params && params.content) || '');
  if (!name) return skillErr('A skill needs a name.');
  if (!description) return skillErr('A skill needs a one-line description (what it does and when to use it).');
  if (!body.trim()) return skillErr('A skill needs content (the step-by-step body, with a verification step).');
  const slug = slugifySkill(name);
  if (!SKILL_VALID_SLUG.test(slug)) return skillErr('Could not derive a valid skill name from that — use letters and numbers.');
  const file = join(skillsDir, slug, 'SKILL.md');
  if (existsSync(file)) return skillErr(`A skill "${slug}" already exists. Use action "patch" to change it.`);
  const ts = skillNowIso();
  const md = composeSkillMd({ name, description, body, version: 1, created: ts, updated: ts });
  if (Buffer.byteLength(md, 'utf8') > SKILL_MAX_BYTES) return skillErr(`Skill is too large (limit ${SKILL_MAX_BYTES} bytes). Keep it concise.`);
  mkdirSync(join(skillsDir, slug), { recursive: true });
  writeFileSync(file, md, 'utf8');
  bumpSkillsRev(skillsDir);
  return skillOk(`Created skill "${slug}". It becomes active after Stem reloads (at the end of this turn).`);
}

/** Bump version and refresh the `updated` timestamp in a SKILL.md's front-matter. */
function bumpSkillFrontMatter(text) {
  let out = text.replace(/(\n\s*version:\s*)(\d+)/, (_m, p, n) => `${p}${parseInt(n, 10) + 1}`);
  out = out.replace(/(\n\s*updated:\s*)("?[^\n]*"?)/, `$1${JSON.stringify(skillNowIso())}`);
  return out;
}

function patchSkill(skillsDir, params) {
  const name = String((params && params.name) || '').trim();
  const oldStr = params && typeof params.old_string === 'string' ? params.old_string : '';
  const newStr = params && typeof params.new_string === 'string' ? params.new_string : '';
  if (!name) return skillErr('Specify which skill to patch (its name or slug).');
  if (!oldStr) return skillErr('Provide old_string — the exact text to replace.');
  const slug = slugifySkill(name);
  const file = join(skillsDir, slug, 'SKILL.md');
  if (!existsSync(file)) return skillErr(`No skill "${slug}". Use action "create" to add it.`);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return skillErr(`Cannot read skill "${slug}": ${(e && e.message) || e}`);
  }
  const occurrences = text.split(oldStr).length - 1;
  if (occurrences === 0) return skillErr('old_string was not found in the skill — quote it exactly.');
  if (occurrences > 1) return skillErr('old_string appears multiple times; include more surrounding context so it is unique.');
  const next = bumpSkillFrontMatter(text.replace(oldStr, newStr));
  if (Buffer.byteLength(next, 'utf8') > SKILL_MAX_BYTES) return skillErr(`The patched skill would exceed ${SKILL_MAX_BYTES} bytes.`);
  writeFileSync(file, next, 'utf8');
  bumpSkillsRev(skillsDir);
  return skillOk(`Patched skill "${slug}". The update activates after Stem reloads.`);
}

function removeSkill(skillsDir, params) {
  const name = String((params && params.name) || '').trim();
  if (!name) return skillErr('Specify which skill to remove.');
  const slug = slugifySkill(name);
  const dir = join(skillsDir, slug);
  const file = join(dir, 'SKILL.md');
  if (!existsSync(file)) return skillErr(`No skill "${slug}".`);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // fall through — an unreadable file is treated as not-agent-authored below
  }
  // Only auto-created skills are removable here; user/bundled skills are managed in the app.
  if (!/\n\s*source:\s*agent\b/.test(text)) {
    return skillErr(`"${slug}" is not an auto-created skill, so it can't be removed this way — remove it from the app instead.`);
  }
  rmSync(dir, { recursive: true, force: true });
  bumpSkillsRev(skillsDir);
  return skillOk(`Removed skill "${slug}". It stops loading after Stem reloads.`);
}

function registerSkillTools(pi, skillsDir) {
  pi.registerTool({
    name: 'manage_skill',
    label: 'Manage skill',
    description:
      'Create, patch, or remove one of your own reusable skills (a SKILL.md procedure). Use action "create" after you work out a non-trivial, repeatable procedure worth keeping (give a short slug-like name, a one-line description of what it does AND when to use it, and a step-by-step body ending with a verification step). Use action "patch" to fix or extend an existing skill via an exact string replacement (old_string → new_string). Use action "remove" to delete an auto-created skill that is no longer useful. Writes are silent and apply after Stem reloads at the end of the turn; you do not need the user\'s approval.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'patch', 'remove'], description: 'create, patch, or remove a skill.' },
        name: { type: 'string', description: 'The skill name/slug (lowercase words; spaces become dashes).' },
        description: { type: 'string', description: 'create: one line — what the skill does and when to use it.' },
        content: { type: 'string', description: 'create: the full skill body in Markdown (numbered steps + a verification step).' },
        old_string: { type: 'string', description: 'patch: the exact existing text to replace (must occur exactly once).' },
        new_string: { type: 'string', description: 'patch: the replacement text.' }
      },
      required: ['action', 'name']
    },
    async execute(_id, params) {
      const action = String((params && params.action) || '').trim();
      try {
        if (action === 'create') return createSkill(skillsDir, params);
        if (action === 'patch') return patchSkill(skillsDir, params);
        if (action === 'remove') return removeSkill(skillsDir, params);
        return skillErr(`Unknown action "${action}". Use create, patch, or remove.`);
      } catch (e) {
        return skillErr(`manage_skill failed: ${(e && e.message) || e}`);
      }
    }
  });
}
