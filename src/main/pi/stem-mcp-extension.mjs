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
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Write a credential-bearing file owner-only (0600). mcp.json may carry bearer
 * headers and mcp-oauth.json holds OAuth tokens; neither should be readable by
 * other users. The explicit chmod also tightens a file that already exists with
 * looser perms (the `mode` create-option is ignored on truncate).
 */
function writeSecretSync(path, data) {
  writeFileSync(path, data, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort on platforms without POSIX perms
  }
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

/** Refresh an expired OAuth access token in place (public client, no PKCE). */
async function refreshOAuth(auth) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken,
    client_id: auth.clientId
  });
  if (auth.resource) body.set('resource', auth.resource);
  const res = await fetch(auth.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString()
  });
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);
  const tok = await res.json();
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
      for (const tool of tools) {
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
      status[name] = { status: 'ready', error: null };
    } catch (e) {
      status[name] = { status: 'failed', error: String((e && e.message) || e) };
    }
  }

  // Publish connection status so Stem's main process can surface it (getMcpStatus).
  try {
    writeFileSync(join(dirname(cfgPath), 'mcp-status.json'), JSON.stringify(status, null, 2));
  } catch {
    // best-effort
  }

  // Stem self-management tools (list/add/remove MCP servers). Always available.
  registerAdminTools(pi, cfgPath);
}

// ---- Stem admin: assistant self-manages MCP servers (edits mcp.json) ----

const ADMIN_RESERVED = new Set(['stem-recall', 'stem-admin']);
// Sentinel title so PiRuntime can distinguish an admin add/remove approval from
// an ordinary extension dialog and route it to Stem's McpApprovalCard.
const ADMIN_APPROVAL_TITLE = 'stem-admin-approval';
const ADMIN_VALID_NAME = /^[A-Za-z0-9_.-]+$/;

function readMcpJson(cfgPath) {
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
    if (parsed && parsed.servers) return parsed;
  } catch {
    // fall through
  }
  return { servers: {} };
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
    const entry = { url, ...(headers ? { headers } : {}), trusted: true };
    const input = { name, transport, url, ...(headers ? { headers } : {}) };
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
      const servers = readMcpJson(cfgPath).servers || {};
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
      'Add (or replace) an MCP server so its tools become available. The user must approve the change in the app before it is applied; after approval Stem reloads so the new tools are usable. Use transport "stdio" for a local command (uvx/npx) or "http" for a remote streamable-HTTP URL (optionally with an auth header).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short identifier (letters, numbers, dot, dash, underscore; no leading dash).' },
        transport: { type: 'string', enum: ['stdio', 'http'], description: 'stdio = local command; http = remote URL.' },
        command: { type: 'string', description: 'stdio only: the executable to run, e.g. "uvx" or "npx".' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio only: command arguments.' },
        url: { type: 'string', description: 'http only: the streamable-HTTP endpoint.' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'stdio only: environment variables.' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'http only: request headers, e.g. {"Authorization": "Bearer …"}.' }
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
      const config = readMcpJson(cfgPath);
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
      const config = readMcpJson(cfgPath);
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
