import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shortLivedServerMessage, shortLivedServerPath } from '../../src/server/pi/mcp-install-paths.mjs';

const roots = [
  { root: '/state/pi-home/exec-workspace', kind: 'scratch' as const },
  { root: '/state/workspace/files', kind: 'files' as const }
];
const cwd = '/state/workspace';

describe('shortLivedServerPath', () => {
  it('flags a launcher in chat scratch (the Fio repair)', () => {
    const hit = shortLivedServerPath('/state/tools/fio/fio-node', ['/state/pi-home/exec-workspace/01a1/fio-repair/dist/index.mjs'], roots, cwd);
    // resolve(): on Windows the same path reads C:\\state\\….
    expect(hit).toEqual({ path: resolve('/state/pi-home/exec-workspace/01a1/fio-repair/dist/index.mjs'), kind: 'scratch' });
  });

  it('flags the Files place, absolute or relative to the bridge cwd', () => {
    expect(shortLivedServerPath('node', ['/state/workspace/files/fio-mcp/launch.mjs'], roots, cwd)?.kind).toBe('files');
    expect(shortLivedServerPath('node', ['files/fio-mcp/launch.mjs'], roots, cwd)?.kind).toBe('files');
    expect(shortLivedServerPath('node', ['--entry=/state/workspace/files/x.mjs'], roots, cwd)?.kind).toBe('files');
  });

  it('accepts the install root and plain package commands', () => {
    expect(shortLivedServerPath('/state/tools/fio/fio-node', ['/state/tools/fio/release/launch.mjs'], roots, cwd)).toBeNull();
    expect(shortLivedServerPath('uvx', ['ha-mcp@latest'], roots, cwd)).toBeNull();
    expect(shortLivedServerPath('npx', ['-y', '@scope/server'], roots, cwd)).toBeNull();
    expect(shortLivedServerPath('node', ['/state/workspace/files-other/x.mjs'], roots, cwd)).toBeNull();
  });

  it('names the install folder in the message', () => {
    const msg = shortLivedServerMessage({ path: '/x', kind: 'scratch' }, '/state/tools', 'fio');
    expect(msg).toContain('deleted together with that chat');
    expect(msg).toContain(resolve('/state/tools/fio'));
  });
});
