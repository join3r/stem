// Stem Admin — standalone stdio MCP server exposing MCP self-management tools
// (`list_mcp_servers`, `add_mcp_server`, `remove_mcp_server`) to the chat assistant.
//
// Codex spawns this as an MCP server (registered in config.toml by
// admin/register-mcp.ts). It runs under Electron-as-node (ELECTRON_RUN_AS_NODE=1)
// and reads/writes the isolated config.toml at the path given in STEM_CODEX_CONFIG.
//
// IMPORTANT: add/remove only actually run AFTER the user approves the call — codex
// gates every MCP tool call through an approval that Stem surfaces as a confirm
// card (see runtime.ts handleServerRequest). A declined call never reaches here.
//
// Transport: MCP stdio = newline-delimited JSON-RPC 2.0 (one message per line).
// The validation + TOML mutation here intentionally mirror src/main/workspace/mcp.ts;
// keep them in sync (a separate process can't import the TS modules directly).

import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import TOML from '@iarna/toml';

const CONFIG_PATH = process.env.STEM_CODEX_CONFIG;

// Keep in sync with workspace/mcp.ts (RESERVED_NAMES) and the register-mcp names.
const RESERVED_NAMES = new Set(['stem-recall', 'stem-admin']);

// Names become argv for `codex mcp …`; constrain them so a leading-dash name
// can't smuggle flags (argument injection). Mirrors workspace/mcp.ts VALID_NAME.
const VALID_NAME = /^[A-Za-z0-9_.-]+$/;

function assertValidName(name) {
  if (!VALID_NAME.test(name) || name.startsWith('-')) {
    throw new Error(
      'MCP server name may only contain letters, numbers, dot, dash, or underscore, and cannot start with a dash.'
    );
  }
}

function readConfig() {
  if (!CONFIG_PATH) throw new Error('STEM_CODEX_CONFIG is not set');
  try {
    return TOML.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  writeFileSync(CONFIG_PATH, TOML.stringify(config), 'utf8');
}

function listServers() {
  const servers = readConfig().mcp_servers ?? {};
  return Object.entries(servers)
    .filter(([name]) => !RESERVED_NAMES.has(name))
    .map(([name, def]) => {
      const url = def?.url ?? '';
      return {
        name,
        transport: url ? 'http' : 'stdio',
        command: def?.command ?? '',
        args: Array.isArray(def?.args) ? def.args : [],
        url,
        env: def?.env ?? undefined
      };
    });
}

function addServer(args) {
  const name = String(args?.name ?? '').trim();
  if (!name) throw new Error('MCP server requires a name.');
  assertValidName(name);
  if (RESERVED_NAMES.has(name)) throw new Error(`"${name}" is a reserved Stem server name.`);
  const transport = args?.transport === 'http' ? 'http' : 'stdio';

  const config = readConfig();
  config.mcp_servers = config.mcp_servers ?? {};

  if (transport === 'http') {
    const url = String(args?.url ?? '').trim();
    if (!url) throw new Error('A remote (http) MCP server requires a url.');
    config.mcp_servers[name] = { url };
  } else {
    const command = String(args?.command ?? '').trim();
    if (!command) throw new Error('A local (stdio) MCP server requires a command.');
    const argv = Array.isArray(args?.args)
      ? args.args.map((a) => String(a))
      : typeof args?.args === 'string' && args.args.trim()
        ? args.args.trim().split(/\s+/)
        : [];
    const env =
      args?.env && typeof args.env === 'object' && Object.keys(args.env).length > 0
        ? Object.fromEntries(Object.entries(args.env).map(([k, v]) => [k, String(v)]))
        : undefined;
    config.mcp_servers[name] = { command, args: argv, ...(env ? { env } : {}) };
  }
  writeConfig(config);
  return name;
}

function removeServer(args) {
  const name = String(args?.name ?? '').trim();
  if (!name) throw new Error('Provide the name of the server to remove.');
  if (RESERVED_NAMES.has(name)) throw new Error(`"${name}" is a reserved Stem server and cannot be removed.`);
  const config = readConfig();
  if (!config.mcp_servers || !(name in config.mcp_servers)) {
    throw new Error(`No MCP server named "${name}" is configured.`);
  }
  delete config.mcp_servers[name];
  writeConfig(config);
  return name;
}

// ---- minimal MCP / JSON-RPC plumbing (mirrors recall/mcp-server.mjs) ----

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}
function textResult(text, isError) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

const TOOLS = [
  {
    name: 'list_mcp_servers',
    description:
      "List the MCP servers currently configured for this assistant (excluding Stem's internal servers). Use this to see what is already set up before adding or removing one. Returns each server's name, transport (stdio/http), command/args or url.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'add_mcp_server',
    description:
      'Add (or replace) an MCP server in this assistant\'s configuration so its tools become available. The user must approve the change in the app before it is applied; after approval Stem hot-reloads so the new tools are usable. Gather any required tokens/URLs from the user first. Use transport "stdio" for a local command (e.g. uvx/npx) or "http" for a remote streamable-HTTP URL (which the user signs into separately via OAuth).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short identifier (letters, numbers, dot, dash, underscore; no leading dash), e.g. "homeassistant".' },
        transport: { type: 'string', enum: ['stdio', 'http'], description: 'stdio = local command; http = remote URL.' },
        command: { type: 'string', description: 'stdio only: the executable to run, e.g. "uvx" or "npx".' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio only: command arguments, e.g. ["ha-mcp@latest"].' },
        url: { type: 'string', description: 'http only: the streamable-HTTP endpoint, e.g. "https://api.example.com/mcp".' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'stdio only: environment variables for the server, e.g. {"HOMEASSISTANT_URL": "...", "HOMEASSISTANT_TOKEN": "..."}.'
        }
      },
      required: ['name', 'transport']
    }
  },
  {
    name: 'remove_mcp_server',
    description:
      'Remove a configured MCP server by name. The user must approve the change in the app; after approval Stem hot-reloads. Stem\'s internal servers cannot be removed.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The exact server name to remove.' } },
      required: ['name']
    }
  }
];

function callTool(name, args) {
  switch (name) {
    case 'list_mcp_servers': {
      const servers = listServers();
      if (servers.length === 0) return textResult('No MCP servers are configured yet.');
      const lines = servers.map((s) =>
        s.transport === 'http'
          ? `- ${s.name} (http): ${s.url}`
          : `- ${s.name} (stdio): ${s.command} ${s.args.join(' ')}`.trim() +
            (s.env ? ` [env: ${Object.keys(s.env).join(', ')}]` : '')
      );
      return textResult(`Configured MCP servers:\n${lines.join('\n')}`);
    }
    case 'add_mcp_server': {
      const added = addServer(args);
      return textResult(`Added MCP server "${added}". It will be active after Stem reloads.`);
    }
    case 'remove_mcp_server': {
      const removed = removeServer(args);
      return textResult(`Removed MCP server "${removed}". It will stop being available after Stem reloads.`);
    }
    default:
      return null;
  }
}

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'stem-admin', version: '0.1.0' }
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return; // notification, no reply
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const toolName = params?.name;
      try {
        const result = callTool(toolName, params?.arguments ?? {});
        if (result === null) {
          replyError(id, -32602, `Unknown tool: ${toolName}`);
          return;
        }
        reply(id, result);
      } catch (e) {
        // Surface as a tool error rather than crashing the server.
        reply(id, textResult(`${toolName} failed: ${e.message}`, true));
      }
      return;
    }
    default:
      if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  try {
    handle(msg);
  } catch (e) {
    if (msg?.id !== undefined) replyError(msg.id, -32603, e.message);
  }
});
