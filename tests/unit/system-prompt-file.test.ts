import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { piSystemPromptPath, writeSystemPromptFile } from '../../src/server/pi/mcp-config';

// The appended system prompt reaches pi as a file path, never as argv text:
// argv is world-readable on Linux. The file is the only copy, so it must hold
// the exact text and be readable by its owner alone.

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function gateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'stem-system-prompt-'));
  cleanup.push(root);
  return join(root, 'workers', '1');
}

describe('writeSystemPromptFile', () => {
  it('writes the prompt into the worker gate dir and returns its path', async () => {
    const dir = await gateDir();
    const path = await writeSystemPromptFile('You are Verifier.', dir);
    expect(path).toBe(piSystemPromptPath(dir));
    expect(await readFile(path, 'utf8')).toBe('You are Verifier.');
  });

  it.skipIf(process.platform === 'win32')('keeps the file owner-only, even one left readable before', async () => {
    const dir = await gateDir();
    await writeSystemPromptFile('v1', dir);
    await chmod(piSystemPromptPath(dir), 0o644);
    const path = await writeSystemPromptFile('v2', dir);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toBe('v2');
  });
});
