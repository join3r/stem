import { app } from 'electron';
import { join } from 'node:path';
import { updateConfig } from '../workspace/config';
import { codexConfigPath } from '../workspace/paths';

// Registers Stem's internal `stem-admin` MCP server in the isolated config.toml so
// codex spawns it. It exposes the self-management tools (list/add/remove MCP
// servers) the chat assistant can call. Stem-managed and hidden from the user MCP
// UI via the reserved name below; re-registered every startup, before the
// app-server spawns, so no restart is needed.

/** Reserved name; filtered out of the user-facing MCP list (see workspace/mcp.ts). */
export const ADMIN_MCP_NAME = 'stem-admin';

/**
 * Absolute path to the standalone server script. In dev, app.getAppPath() is the
 * repo root (same basis as the recall server).
 * TODO(packaging): when an electron-builder pipeline exists, this script (and its
 * @iarna/toml dependency) must be unpacked (extraResources/asarUnpack) — it can't
 * be spawned from inside app.asar.
 */
function adminMcpServerPath(): string {
  return join(app.getAppPath(), 'src', 'main', 'admin', 'mcp-server.mjs');
}

export async function registerAdminMcpServer(): Promise<void> {
  try {
    await updateConfig((config) => {
      config.mcp_servers = config.mcp_servers ?? {};
      config.mcp_servers[ADMIN_MCP_NAME] = {
        // Spawn Electron-as-node so the server shares the exact Node runtime.
        command: process.execPath,
        args: [adminMcpServerPath()],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          // The isolated config.toml the server reads/writes (same file Stem edits).
          STEM_CODEX_CONFIG: codexConfigPath()
        }
      };
    });
  } catch {
    // Non-fatal: without the tool, the user can still manage MCP via the UI.
  }
}
