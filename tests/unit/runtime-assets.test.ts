import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { piExtensionPath } from '../../src/main/pi/mcp-config';
import { recallMcpServerPath } from '../../src/main/recall/register-mcp';

describe('main runtime asset paths', () => {
  it('resolves the pi bridge extension from the source tree in unit/dev mode', () => {
    const path = piExtensionPath();
    expect(path.endsWith('src/main/pi/stem-mcp-extension.mjs')).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('resolves the recall MCP server from the source tree in unit/dev mode', () => {
    const path = recallMcpServerPath();
    expect(path.endsWith('src/main/recall/mcp-server.mjs')).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});
