// The chat store's `plain` map: chats that run as plain Markdown. Set by the
// runtime on the creating turn, switched by chats:setFormat, dropped with the
// chat. Absent means MDX, so a file from before 0.6.0 reads as all-MDX.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  getChatFormat,
  getPlainChats,
  removeChat,
  setChatFolder,
  setChatFormat
} from '../../src/server/workspace/chats';
import { chatStorePath } from '../../src/server/workspace/paths';

const path = chatStorePath();

beforeEach(() => {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
});
afterEach(() => {
  rmSync(path, { force: true });
});

describe('chat format in the chat store', () => {
  it('defaults to MDX, switches both ways, survives unrelated writes, and goes with the chat', async () => {
    expect(await getChatFormat('t-1')).toBe('mdx');
    await setChatFormat('t-1', 'md');
    expect(await getChatFormat('t-1')).toBe('md');
    expect(await getChatFormat('t-2')).toBe('mdx');
    await setChatFolder('t-1', null);
    expect([...(await getPlainChats())]).toEqual(['t-1']);
    await setChatFormat('t-1', 'mdx');
    expect(await getChatFormat('t-1')).toBe('mdx');
    expect(JSON.parse(readFileSync(path, 'utf8')).plain).toEqual({});
    await setChatFormat('t-1', 'md');
    await removeChat('t-1');
    expect(await getChatFormat('t-1')).toBe('mdx');
  });

  it('an older file without the map reads as all MDX', async () => {
    writeFileSync(path, JSON.stringify({ version: 1, folders: [], assignments: {}, private: {} }));
    expect(await getPlainChats()).toEqual(new Set());
  });
});
