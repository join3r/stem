import type { McpServerInput, McpServerSummary } from '../../shared/types';
import { readMcpConfig, writeMcpConfig, deleteOAuthToken, readOAuthTokens } from './mcp-config';
import { RECALL_MCP_NAME } from '../recall/register-mcp';
import { ADMIN_MCP_NAME } from '../admin/register-mcp';

// User-facing MCP add/remove/list for the pi backend, operating on mcp.json. The
// bridge extension (stem-mcp-extension.mjs) reads this file on (re)start; the
// renderer calls restartRuntime() after a change so the bridge reconnects.

/** Internal, Stem-owned servers hidden from the user-facing MCP list. */
const RESERVED_NAMES = new Set([RECALL_MCP_NAME, ADMIN_MCP_NAME]);
const VALID_NAME = /^[A-Za-z0-9_.-]+$/;

function assertValidName(name: string): void {
  if (!VALID_NAME.test(name) || name.startsWith('-')) {
    throw new Error(
      'MCP server name may only contain letters, numbers, dot, dash, or underscore, and cannot start with a dash.'
    );
  }
}

export async function listMcpServers(): Promise<McpServerSummary[]> {
  const config = await readMcpConfig();
  const oauth = await readOAuthTokens();
  return Object.entries(config.servers)
    .filter(([name]) => !RESERVED_NAMES.has(name))
    .map(([name, def]) => {
      const url = def.url ?? '';
      // Populate `auth_status` so the panel shows the right state before the
      // bridge reports live connection status: a stored OAuth token or a static
      // auth header both count as credentials-on-disk.
      const hasHeaderAuth = !!def.headers && Object.keys(def.headers).length > 0;
      const authStatus = url ? (oauth[name] ? 'o_auth' : hasHeaderAuth ? 'bearer_token' : undefined) : undefined;
      return {
        name,
        transport: url ? 'http' : 'stdio',
        command: def.command ?? '',
        args: Array.isArray(def.args) ? def.args : [],
        url,
        authStatus
      } satisfies McpServerSummary;
    });
}

export async function addMcpServer(input: McpServerInput): Promise<McpServerSummary[]> {
  const name = input.name.trim();
  if (!name) throw new Error('MCP server requires a name.');
  assertValidName(name);
  if (RESERVED_NAMES.has(name)) throw new Error(`"${name}" is a reserved Stem server name.`);

  const config = await readMcpConfig();
  if (input.transport === 'http') {
    const url = input.url?.trim();
    if (!url) throw new Error('A remote MCP server requires a URL.');
    const headers = input.headers && Object.keys(input.headers).length > 0 ? input.headers : undefined;
    // A user explicitly adding a server implies trust → its tools run without a
    // per-call confirmation (standard MCP-host behavior).
    config.servers[name] = { url, ...(headers ? { headers } : {}), trusted: true };
  } else {
    const command = input.command?.trim();
    if (!command) throw new Error('A local MCP server requires a command.');
    const env = input.env && Object.keys(input.env).length > 0 ? input.env : undefined;
    config.servers[name] = { command, args: input.args ?? [], ...(env ? { env } : {}), trusted: true };
  }
  await writeMcpConfig(config);
  return listMcpServers();
}

export async function removeMcpServer(name: string): Promise<McpServerSummary[]> {
  const config = await readMcpConfig();
  delete config.servers[name];
  await writeMcpConfig(config);
  await deleteOAuthToken(name); // drop any stored OAuth token with the server
  return listMcpServers();
}
