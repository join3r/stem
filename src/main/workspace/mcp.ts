import type { McpServerInput, McpServerSummary } from '../../shared/types';
import { readConfig, updateConfig } from './config';

export async function listMcpServers(): Promise<McpServerSummary[]> {
  const config = await readConfig();
  const servers = config.mcp_servers ?? {};
  return Object.entries(servers).map(([name, def]) => ({
    name,
    command: def?.command ?? '',
    args: Array.isArray(def?.args) ? def!.args! : []
  }));
}

export async function addMcpServer(input: McpServerInput): Promise<McpServerSummary[]> {
  if (!input.name.trim() || !input.command.trim()) {
    throw new Error('MCP server requires a name and a command.');
  }
  await updateConfig((config) => {
    config.mcp_servers = config.mcp_servers ?? {};
    config.mcp_servers[input.name] = {
      command: input.command,
      args: input.args ?? []
    };
  });
  return listMcpServers();
}

export async function removeMcpServer(name: string): Promise<McpServerSummary[]> {
  await updateConfig((config) => {
    if (config.mcp_servers) {
      delete config.mcp_servers[name];
    }
  });
  return listMcpServers();
}
