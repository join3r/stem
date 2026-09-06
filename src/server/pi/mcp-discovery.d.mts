export function summarizeToolCapabilities(tools: readonly { name: string }[]): string;
export function compactCatalogText(text: string): string;
export interface DiscoveryTool { name: string; description?: string; signature?: string; inputSchema?: unknown }
export function searchMcpTools<T extends DiscoveryTool, E extends { tools: readonly T[] }>(clients: Map<string, E>, options?: { query?: string; server?: string; limit?: number; offset?: number }): {
  matches: { server: string; tool: T; entry: E; score: number }[];
  total: number;
  nextOffset: number | null;
};
