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
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  }

  start() {
    this.proc = spawn(this.spec.command, this.spec.args ?? [], {
      env: { ...process.env, ...(this.spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
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
      for (const p of this.pending.values()) p.reject(new Error(`${this.name} exited`));
      this.pending.clear();
    });
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
  }

  start() {}

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
  const status = {};

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

  // Non-eager servers go here; their tools are reached via the router meta-tools.
  const clients = new Map(); // name -> { client, spec, tools }

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
      if (name === RECALL_SERVER_NAME) {
        // Internal recall server: keep eager (used every turn) as native pi tools.
        for (const tool of tools) registerNativeMcpTool(pi, name, spec, client, tool);
      } else {
        // Everything else: behind the lazy router + the per-turn catalog.
        clients.set(name, { client, spec, tools });
      }
      status[name] = { status: 'ready', error: null };
    } catch (e) {
      status[name] = { status: 'failed', error: String((e && e.message) || e) };
    }
  }

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

  // Mutate each outgoing request to (a) restore native web search by injecting the
  // provider's server-side tool, and (b) apply the OpenAI service tier ("Fast"). Both
  // are gated per turn by sibling files (native-search.json / service-tier.json) that
  // the main process rewrites before each prompt, since main and Quick Chat share one
  // pi process and the hook can't tell them apart.
  if (typeof pi.on === 'function') {
    const nativeSearchEnabled = makeNativeSearchGate(join(dirname(cfgPath), 'native-search.json'));
    const serviceTier = makeServiceTierGate(join(dirname(cfgPath), 'service-tier.json'));
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
