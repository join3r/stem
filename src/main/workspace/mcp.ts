import { execFile } from 'node:child_process';
import type { McpServerInput, McpServerSummary } from '../../shared/types';
import { findCodexPath } from '../codex/locate';
import { codexEnv, runCodexJson } from '../codex/exec';
import { readConfig, updateConfig } from './config';
import { codexHome } from './paths';

// Shape of an entry from `codex mcp list --json` (codex-cli 0.141.0).
interface CodexMcpListEntry {
  name: string;
  transport?: { type?: string; url?: string | null; command?: string | null; args?: string[] | null };
  auth_status?: string | null;
}

/**
 * List configured MCP servers. Source of truth is `codex mcp list --json`,
 * which reports transport (stdio vs streamable_http) and OAuth `auth_status`
 * uniformly. Falls back to reading config.toml if codex can't be run.
 */
export async function listMcpServers(): Promise<McpServerSummary[]> {
  try {
    const entries = await runCodexJson<CodexMcpListEntry[]>(['mcp', 'list', '--json'], codexHome());
    return entries.map((entry) => {
      const t = entry.transport ?? {};
      const isHttp = t.type === 'streamable_http';
      return {
        name: entry.name,
        transport: isHttp ? 'http' : 'stdio',
        command: t.command ?? '',
        args: Array.isArray(t.args) ? t.args : [],
        url: t.url ?? '',
        authStatus: entry.auth_status ?? undefined
      } satisfies McpServerSummary;
    });
  } catch {
    return listFromConfig();
  }
}

/** Fallback path: read config.toml directly (no codex available). */
async function listFromConfig(): Promise<McpServerSummary[]> {
  const config = await readConfig();
  const servers = config.mcp_servers ?? {};
  return Object.entries(servers).map(([name, def]) => {
    const url = def?.url ?? '';
    return {
      name,
      transport: url ? 'http' : 'stdio',
      command: def?.command ?? '',
      args: Array.isArray(def?.args) ? def!.args! : [],
      url,
      authStatus: undefined
    } satisfies McpServerSummary;
  });
}

// Names become argv for `codex mcp …`; constrain them so a leading-dash name
// can't smuggle flags (argument injection).
const VALID_NAME = /^[A-Za-z0-9_.-]+$/;

function assertValidName(name: string): void {
  if (!VALID_NAME.test(name) || name.startsWith('-')) {
    throw new Error('MCP server name may only contain letters, numbers, dot, dash, or underscore, and cannot start with a dash.');
  }
}

export async function addMcpServer(input: McpServerInput): Promise<McpServerSummary[]> {
  const name = input.name.trim();
  if (!name) {
    throw new Error('MCP server requires a name.');
  }
  assertValidName(name);

  if (input.transport === 'http') {
    const url = input.url?.trim();
    if (!url) {
      throw new Error('A remote MCP server requires a URL.');
    }
    await updateConfig((config) => {
      config.mcp_servers = config.mcp_servers ?? {};
      config.mcp_servers[name] = { url };
    });
  } else {
    const command = input.command?.trim();
    if (!command) {
      throw new Error('A local MCP server requires a command.');
    }
    await updateConfig((config) => {
      config.mcp_servers = config.mcp_servers ?? {};
      config.mcp_servers[name] = { command, args: input.args ?? [] };
    });
  }

  return listMcpServers();
}

export async function removeMcpServer(name: string): Promise<McpServerSummary[]> {
  // Best-effort: clear any stored OAuth token before dropping the config entry.
  await codexLogout(name).catch(() => {});
  await updateConfig((config) => {
    if (config.mcp_servers) {
      delete config.mcp_servers[name];
    }
  });
  return listMcpServers();
}

async function codexLogout(name: string): Promise<void> {
  const codexPath = await findCodexPath();
  if (!codexPath) return;
  await new Promise<void>((resolve, reject) => {
    execFile(codexPath, ['mcp', 'logout', '--', name], { env: codexEnv(codexHome()), timeout: 8000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
