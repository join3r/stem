// The chat store's `private` map: threads started as private chats. Set once by
// the runtime on the creating turn, read back on every later turn, and dropped
// only with the chat itself. An older file without the map reads as "none".
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  getPrivateChats,
  isChatPrivate,
  removeChat,
  setChatFolder,
  setChatPrivate
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

describe('private chats in the chat store', () => {
  it('marks, reads back, survives unrelated writes, and goes with the chat', async () => {
    expect(await isChatPrivate('t-1')).toBe(false);
    await setChatPrivate('t-1');
    expect(await isChatPrivate('t-1')).toBe(true);
    expect(await isChatPrivate('t-2')).toBe(false);
    // Another field's write re-serializes the whole store — the mark must hold.
    await setChatFolder('t-1', null);
    expect([...(await getPrivateChats())]).toEqual(['t-1']);
    expect(JSON.parse(readFileSync(path, 'utf8')).private).toEqual({ 't-1': true });
    await removeChat('t-1');
    expect(await isChatPrivate('t-1')).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8')).private).toEqual({});
  });

  it('an older file without the map, or a hand-edited one, reads as no private chats', async () => {
    writeFileSync(path, JSON.stringify({ version: 1, folders: [], assignments: {}, subjects: {}, naming: {} }));
    expect(await getPrivateChats()).toEqual(new Set());
    writeFileSync(
      path,
      JSON.stringify({ version: 1, folders: [], assignments: {}, private: { ok: true, no: 'yes', off: false } })
    );
    expect([...(await getPrivateChats())]).toEqual(['ok']);
  });
});
