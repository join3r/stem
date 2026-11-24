import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Stem Recall's internal `search_past_chats` MCP server. The pi backend wires it
// up via pi/mcp-config.ts (mcp.json) under the reserved name below; this module
// just owns the name and the script path both sides reference.

/** Reserved name; filtered out of the user-facing MCP list (see pi/mcp.ts). */
export const RECALL_MCP_NAME = 'stem-recall';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * Absolute path to the standalone server script. The server is bundled by
 * electron-vite as its own entry (dist/main/recall-mcp-server.js, see
 * electron.vite.config.ts) so it can share search-core.ts with the main
 * process — unlike the copied .mjs runtime assets there is no runnable source
 * fallback (a lone .ts file can't be spawned). At runtime this module executes
 * from dist/main, so a sibling join resolves the built artifact. Packaged builds
 * ship without asar (see electron-builder.yml) precisely so this — and every
 * other ELECTRON_RUN_AS_NODE child — stays spawnable as a real file.
 */
export function recallMcpServerPath(): string {
  return join(moduleDir, 'recall-mcp-server.js');
}
