// chats:list orders rows by the stamp it lists them with, not by the raw mtime
// the backend sorted on. A scheduled run that fires overnight bumps a chat's
// mtime while the quiet window keeps its listed stamp weeks back; ordering by
// mtime then put "Previous 30 Days" rows above "Yesterday" rows in the sidebar,
// and the date headers repeated down the list.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { registerChatsIpc } from '../../src/server/ipc/chats';
import { dispatchLocal } from '../../src/server/ipc/guard';
import { noteSilentRun } from '../../src/server/workspace/inbox';
import { inboxStorePath } from '../../src/server/workspace/paths';
import type { IpcDeps } from '../../src/server/ipc/deps';
import type { ChatBackend } from '../../src/server/backend';
import type { ChatListResult, ChatSummary } from '../../src/shared/types';

const DAY = 86_400;
const NOW = 1_800_000_000; // backend seconds

function chat(threadId: string, updatedAt: number): ChatSummary {
  return { threadId, title: threadId, folderId: null, createdAt: updatedAt - DAY, updatedAt };
}

let rows: ChatSummary[] = [];
const runtime = {
  listThreads: async () => rows.map((r) => ({ ...r })).sort((a, b) => b.updatedAt - a.updatedAt)
} as unknown as ChatBackend;

const deps = {
  e2e: true,
  runtime: () => runtime,
  scheduler: () => null,
  providerAuth: () => null,
  embedManager: () => null,
  emit: () => {},
  onAuthenticated: async () => ({}) as never,
  scheduleMemoryRebuild: () => {},
  scheduleFolderIndexScan: () => {},
  scheduleFolderLearn: () => {},
  scheduleAutoFile: () => {}
} as IpcDeps;

const inboxPath = inboxStorePath();

beforeEach(() => {
  rmSync(inboxPath, { force: true });
  mkdirSync(dirname(inboxPath), { recursive: true });
  registerChatsIpc(deps);
});
afterEach(() => rmSync(inboxPath, { force: true }));

describe('chats:list ordering', () => {
  it('sorts by the listed stamp after a quiet run moved a chat back in time', async () => {
    // "old" last meant something 20 days ago, then a silent scheduled run wrote
    // it an hour ago; "recent" had a real message yesterday.
    rows = [chat('recent', NOW - DAY), chat('old', NOW - 3600), chat('older', NOW - 10 * DAY)];
    await noteSilentRun('old', NOW - 20 * DAY, (NOW - 3600) * 1000); // `at` is ms, like the callers

    const result = (await dispatchLocal('chats:list', [])) as ChatListResult;
    expect(result.chats.map((c) => c.threadId)).toEqual(['recent', 'older', 'old']);
    expect(result.chats.find((c) => c.threadId === 'old')?.updatedAt).toBe(NOW - 20 * DAY);
    // Listed order and listed stamps agree, so date headers can never repeat.
    const stamps = result.chats.map((c) => c.updatedAt);
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
  });
});
