// Stem's internal `stem-admin` MCP server exposes the self-management tools
// (list/add/remove MCP servers) the chat assistant can call. Under the pi backend
// it's provided by the bridge extension (pi/stem-mcp-extension.mjs); this module
// just owns the reserved name both the extension and the user-facing MCP list use.

/** Reserved name; filtered out of the user-facing MCP list (see pi/mcp.ts). */
export const ADMIN_MCP_NAME = 'stem-admin';
