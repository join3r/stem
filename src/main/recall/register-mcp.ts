import { app } from 'electron';
import { join } from 'node:path';
import { updateConfig } from '../workspace/config';
import { recallDbPath } from '../workspace/paths';

// Registers Stem Recall's internal `search_past_chats` MCP server in the isolated
// config.toml so codex spawns it. Stem-managed (hidden from the user MCP UI via
// the reserved name below); re-registered every startup, before the app-server
// spawns, so no restart is needed.

/** Reserved name; filtered out of the user-facing MCP list (see workspace/mcp.ts). */
export const RECALL_MCP_NAME = 'stem-recall';

/**
 * Absolute path to the standalone server script. In dev, app.getAppPath() is the
 * repo root (same basis as the app icon in index.ts).
 * TODO(packaging): when an electron-builder pipeline exists, this script must be
 * unpacked (extraResources/asarUnpack) — it can't be spawned from inside app.asar.
 */
export function recallMcpServerPath(): string {
  return join(app.getAppPath(), 'src', 'main', 'recall', 'mcp-server.mjs');
}

export async function registerRecallMcpServer(): Promise<void> {
  try {
    await updateConfig((config) => {
      config.mcp_servers = config.mcp_servers ?? {};
      config.mcp_servers[RECALL_MCP_NAME] = {
        // Spawn Electron-as-node so the server shares the exact node:sqlite runtime.
        command: process.execPath,
        args: [recallMcpServerPath()],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          STEM_RECALL_DB: recallDbPath()
        }
      };
    });
  } catch {
    // Non-fatal: without the tool, auto-injected recall still works.
  }
}
