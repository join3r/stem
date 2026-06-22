import { app } from 'electron';
import { join } from 'node:path';

// Stem Recall's internal `search_past_chats` MCP server. The pi backend wires it
// up via pi/mcp-config.ts (mcp.json) under the reserved name below; this module
// just owns the name and the script path both sides reference.

/** Reserved name; filtered out of the user-facing MCP list (see pi/mcp.ts). */
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
