// Per-chat scratch folders: the accounting and the sweep.
//
// Both halves fail quietly if they are wrong. A size walk that follows the
// `files` symlink reports every chat as weighing as much as the user's whole
// Files place — plausible-looking numbers that send you deleting the wrong
// thing. And a sweep is a delete loop with a clock in it: if "idle" is computed
// from the wrong timestamp, or an unreadable chat list makes every live chat
// look like an orphan, the failure is other people's work disappearing, which no
// amount of the feature "working" would reveal.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import {
  clearScratch,
  copyThreadScratch,
  deleteThreadScratch,
  ensureThreadScratch,
  listScratchUsage,
  sweepScratch,
  sweepScratchOnce,
  UNFILED_KEY
} from '../../src/server/exec/scratch';
import { execWorkspaceDir, filesRoot, isScratchId, threadWorkspaceDir } from '../../src/server/workspace/paths';
import type { ChatSummary } from '../../src/shared/types';

const DAY_MS = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 7, 10);

function chat(threadId: string, updatedAtMs: number): ChatSummary {
  return {
    threadId,
    title: `Chat ${threadId}`,
    folderId: null,
    createdAt: Math.floor(updatedAtMs / 1000),
    updatedAt: Math.floor(updatedAtMs / 1000)
  };
}

/** Backdate a path and everything under it, so it reads as untouched. */
async function age(path: string, daysAgo: number): Promise<void> {
  const when = new Date(NOW - daysAgo * DAY_MS);
  if (!lstatSync(path).isDirectory()) {
    await utimes(path, when, when);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await age(full, daysAgo);
    else await utimes(full, when, when);
  }
  // The directory last, or writing its children would bump it again.
  await utimes(path, when, when);
}

beforeEach(() => {
  rmSync(execWorkspaceDir(), { recursive: true, force: true });
  mkdirSync(filesRoot(), { recursive: true });
});

afterEach(() => {
  rmSync(execWorkspaceDir(), { recursive: true, force: true });
});

describe('isScratchId', () => {
  it('accepts the ids pi actually produces', () => {
    expect(isScratchId('019a3f7c-1d2e-7c00-8f31-2b4a5c6d7e8f')).toBe(true);
    expect(isScratchId('session_2026-08-10T09.14.22')).toBe(true);
  });

  it('rejects anything that could leave the scratch root', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', '../escape', '/abs', 'x'.repeat(129)]) {
      expect(isScratchId(bad), bad).toBe(false);
    }
  });
});

describe('ensureThreadScratch', () => {
  it('gives a chat its own folder with a link to the Files place', async () => {
    const dir = await ensureThreadScratch('chat-a');
    expect(dir).toBe(threadWorkspaceDir('chat-a'));
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(lstatSync(join(dir, 'files')).isSymbolicLink()).toBe(true);
  });

  it('is idempotent — a second command in the same chat reuses the folder', async () => {
    writeFileSync(join(await ensureThreadScratch('chat-a'), 'out.txt'), 'first');
    const again = await ensureThreadScratch('chat-a');
    expect(readdirSync(again).sort()).toEqual(['files', 'out.txt']);
  });

  it('falls back to the unfiled root with no thread, or an id that could escape', async () => {
    expect(await ensureThreadScratch(null)).toBe(execWorkspaceDir());
    expect(await ensureThreadScratch('../escape')).toBe(execWorkspaceDir());
  });
});

describe('listScratchUsage', () => {
  it('reports each chat separately and aggregates everything loose as unfiled', async () => {
    writeFileSync(join(await ensureThreadScratch('chat-a'), 'a.bin'), 'x'.repeat(100));
    writeFileSync(join(await ensureThreadScratch('chat-b'), 'b.bin'), 'x'.repeat(50));
    // The pile from before per-chat folders: loose at the root.
    writeFileSync(join(execWorkspaceDir(), 'old.bin'), 'x'.repeat(9));
    mkdirSync(join(execWorkspaceDir(), 'old stuff'), { recursive: true });
    writeFileSync(join(execWorkspaceDir(), 'old stuff', 'more.bin'), 'x'.repeat(1));

    const rows = await listScratchUsage();
    expect(rows.find((r) => r.key === 'chat-a')).toMatchObject({ bytes: 100, files: 1 });
    expect(rows.find((r) => r.key === 'chat-b')).toMatchObject({ bytes: 50, files: 1 });
    expect(rows.find((r) => r.key === UNFILED_KEY)).toMatchObject({ bytes: 10, files: 2 });
  });

  it('does not charge a chat for the Files place its `files` link points at', async () => {
    writeFileSync(join(filesRoot(), 'huge.bin'), 'x'.repeat(100_000));
    const dir = await ensureThreadScratch('chat-a');
    writeFileSync(join(dir, 'small.txt'), 'x'.repeat(7));

    const row = (await listScratchUsage()).find((r) => r.key === 'chat-a');
    expect(row).toMatchObject({ bytes: 7, files: 1 });
  });

  it('omits the unfiled row when the root holds only chat folders', async () => {
    await ensureThreadScratch('chat-a');
    expect((await listScratchUsage()).map((r) => r.key)).toEqual(['chat-a']);
  });
});

describe('clearScratch', () => {
  it('removes one chat folder and leaves the others alone', async () => {
    writeFileSync(join(await ensureThreadScratch('chat-a'), 'a.txt'), 'a');
    writeFileSync(join(await ensureThreadScratch('chat-b'), 'b.txt'), 'b');

    await clearScratch('chat-a');
    expect((await listScratchUsage()).map((r) => r.key)).toEqual(['chat-b']);
  });

  it('empties the unfiled pile without touching any chat', async () => {
    writeFileSync(join(await ensureThreadScratch('chat-a'), 'a.txt'), 'a');
    writeFileSync(join(execWorkspaceDir(), 'old.bin'), 'junk');

    await clearScratch(UNFILED_KEY);
    expect((await listScratchUsage()).map((r) => r.key)).toEqual(['chat-a']);
  });

  it('ignores a key that could escape the root', async () => {
    writeFileSync(join(filesRoot(), 'keep.txt'), 'keep');
    await clearScratch('../files');
    expect(lstatSync(join(filesRoot(), 'keep.txt')).isFile()).toBe(true);
  });
});

describe('deleteThreadScratch', () => {
  it('takes the folder with the chat', async () => {
    writeFileSync(join(await ensureThreadScratch('chat-a'), 'a.txt'), 'a');
    await deleteThreadScratch('chat-a');
    expect(await listScratchUsage()).toEqual([]);
  });
});

describe('copyThreadScratch', () => {
  it('gives the fork the files its history talks about', async () => {
    writeFileSync(join(await ensureThreadScratch('chat-a'), 'report.py'), 'print(1)');
    await copyThreadScratch('chat-a', 'chat-fork');
    expect(readdirSync(threadWorkspaceDir('chat-fork')).sort()).toEqual(['files', 'report.py']);
  });

  it('copies the Files link as a link, not as a copy of the Files place', async () => {
    writeFileSync(join(filesRoot(), 'huge.bin'), 'x'.repeat(100_000));
    await ensureThreadScratch('chat-a');
    await copyThreadScratch('chat-a', 'chat-fork');

    expect(lstatSync(join(threadWorkspaceDir('chat-fork'), 'files')).isSymbolicLink()).toBe(true);
    expect((await listScratchUsage()).find((r) => r.key === 'chat-fork')?.bytes).toBe(0);
  });

  it('leaves the fork empty-handed rather than throwing when there is nothing to copy', async () => {
    await expect(copyThreadScratch('never-ran', 'chat-fork')).resolves.toBeUndefined();
    expect(await listScratchUsage()).toEqual([]);
  });
});

describe('sweepScratch', () => {
  /** Two chats, both with files; `stale` is backdated, `fresh` is not. */
  async function seed(): Promise<void> {
    writeFileSync(join(await ensureThreadScratch('stale'), 'a.txt'), 'a');
    writeFileSync(join(await ensureThreadScratch('fresh'), 'b.txt'), 'b');
    await age(threadWorkspaceDir('stale'), 90);
    await age(threadWorkspaceDir('fresh'), 1);
  }

  it('removes a folder nobody has touched and keeps the recent one', async () => {
    await seed();
    const chats = [chat('stale', NOW - 90 * DAY_MS), chat('fresh', NOW - 1 * DAY_MS)];

    expect(await sweepScratch({ ttlDays: 30, chats, now: NOW })).toEqual(['stale']);
    expect((await listScratchUsage()).map((r) => r.key)).toEqual(['fresh']);
  });

  it('keeps old files belonging to a chat you are still talking in', async () => {
    await seed();
    // The files are 90 days old, but the conversation was yesterday.
    const chats = [chat('stale', NOW - 1 * DAY_MS), chat('fresh', NOW - 1 * DAY_MS)];

    expect(await sweepScratch({ ttlDays: 30, chats, now: NOW })).toEqual([]);
  });

  it('keeps files you touched yourself even when the chat went quiet', async () => {
    await seed();
    // Mirror image of the case above: dormant chat, recently edited files.
    await age(threadWorkspaceDir('stale'), 2);
    const chats = [chat('stale', NOW - 300 * DAY_MS), chat('fresh', NOW - 1 * DAY_MS)];

    expect(await sweepScratch({ ttlDays: 30, chats, now: NOW })).toEqual([]);
  });

  it('sweeps an orphan and the unfiled pile on file age alone', async () => {
    writeFileSync(join(await ensureThreadScratch('orphan'), 'a.txt'), 'a');
    writeFileSync(join(execWorkspaceDir(), 'old.bin'), 'junk');
    await age(threadWorkspaceDir('orphan'), 90);
    await age(join(execWorkspaceDir(), 'old.bin'), 90);

    expect((await sweepScratch({ ttlDays: 30, chats: [], now: NOW })).sort()).toEqual([
      'orphan',
      UNFILED_KEY
    ]);
    expect(await listScratchUsage()).toEqual([]);
    // The root is the container, so it is emptied — never removed.
    expect(lstatSync(execWorkspaceDir()).isDirectory()).toBe(true);
  });

  it('removes nothing at all when the TTL is Never', async () => {
    await seed();
    expect(await sweepScratch({ ttlDays: null, chats: [], now: NOW })).toEqual([]);
    expect((await listScratchUsage()).map((r) => r.key).sort()).toEqual(['fresh', 'stale']);
  });

  it('skips the whole pass when the chat list cannot be trusted', async () => {
    await seed();
    const ttlDays = async () => 30;

    // Threw: nothing is swept, however stale it looks.
    expect(
      await sweepScratchOnce({
        listChats: () => Promise.reject(new Error('sessions unreadable')),
        ttlDays
      })
    ).toEqual([]);
    // Came back empty while chat folders exist — the quiet version of the same
    // failure, since an unreadable session directory reads as "no chats".
    expect(await sweepScratchOnce({ listChats: async () => [], ttlDays })).toEqual([]);
    expect((await listScratchUsage()).map((r) => r.key).sort()).toEqual(['fresh', 'stale']);
  });

  it('skips the pass rather than age folders on a TTL it could not read', async () => {
    await seed();

    // The old fallback was the DEFAULT ttl, which deletes: someone who chose
    // "Never", or 90 days, had their scratch aged out at 30 on a settings read
    // nobody saw fail.
    expect(
      await sweepScratchOnce({
        listChats: async () => [{ threadId: 'stale' }, { threadId: 'fresh' }] as never,
        ttlDays: () => Promise.reject(new Error('settings unreadable'))
      })
    ).toEqual([]);
    expect((await listScratchUsage()).map((r) => r.key).sort()).toEqual(['fresh', 'stale']);
  });

  it('still sweeps a lone unfiled pile when there are genuinely no chats', async () => {
    mkdirSync(execWorkspaceDir(), { recursive: true });
    writeFileSync(join(execWorkspaceDir(), 'old.bin'), 'junk');
    await age(join(execWorkspaceDir(), 'old.bin'), 90);

    // No chat-shaped folders, so an empty list is not evidence of a failed read.
    expect(
      await sweepScratchOnce({ listChats: async () => [], ttlDays: async () => 30 })
    ).toEqual([UNFILED_KEY]);
  });

  it('never treats 0 or a negative TTL as "delete everything now"', async () => {
    await seed();
    expect(await sweepScratch({ ttlDays: 0, chats: [], now: NOW })).toEqual([]);
    expect(await sweepScratch({ ttlDays: -1, chats: [], now: NOW })).toEqual([]);
    expect((await listScratchUsage()).map((r) => r.key).sort()).toEqual(['fresh', 'stale']);
  });
});
