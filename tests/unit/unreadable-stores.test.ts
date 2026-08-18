// A store that will not read must never be the thing a write is based on.
//
// Every store here is a read-modify-write: read the file, apply the change,
// write the whole thing back. When the read falls back to an empty value, that
// value is what the write persists — so one unreadable settings.json costs the
// user their custom instructions, their model overrides and their local-provider
// API keys, and one unreadable tasks.json deletes every schedule they have. The
// broken read and the healthy read return the same shape, which is why the suite
// never caught it: the assertion that separates them is that the file on disk
// still says what it said before.
//
// Corrupt JSON is the probe throughout. It is realistic (the same class as the
// EACCES/EIO/EMFILE cases these paths are actually about), it is deterministic on
// every platform, and — unlike making a file unreadable — it leaves the directory
// perfectly writable, so "the file is unchanged afterwards" really does prove the
// write was refused rather than merely impossible.
import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-unreadable-skills-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import { degradations, resetDegradations } from '../../src/server/degrade';
import {
  chatStorePath,
  connectedFoldersStorePath,
  inboxStorePath,
  settingsStorePath,
  tasksStorePath
} from '../../src/server/workspace/paths';
import { readSettings, updateCustomInstructions } from '../../src/server/workspace/settings';
import { readTasks, saveTasks, updateTasks } from '../../src/server/workspace/tasks';
import { createFolder, readStore as readChatStore } from '../../src/server/workspace/chats';
import { setArchived } from '../../src/server/workspace/inbox';
import { addConnectedFolders, readStore as readFolderStore } from '../../src/server/workspace/connected-folders';
import { SKILLS_IGNORE_FILE, disabledSlugs, syncSkillsIgnore } from '../../src/server/skills/ignore';

const GARBAGE = '{"folders": [ this is not json';

/** Write bytes no JSON.parse will accept, and hand back what is on disk. */
function corrupt(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, GARBAGE, 'utf8');
  return GARBAGE;
}

beforeEach(() => {
  resetDegradations();
});

describe('a store that will not read is not an empty store', () => {
  it('keeps the settings file when a mutator cannot read it', async () => {
    corrupt(settingsStorePath());

    await expect(updateCustomInstructions({ main: 'be brief' })).rejects.toThrow();
    expect(readFileSync(settingsStorePath(), 'utf8')).toBe(GARBAGE);
    expect(degradations().map((d) => d.what)).toContain(
      'refused to write settings over a file it could not read'
    );

    // Reading is still forgiving on purpose: a settings screen that will not open
    // is worse than one showing the factory values, and nothing persists them.
    expect((await readSettings()).customInstructions.main).toBe('');
    rmSync(settingsStorePath(), { force: true });
  });

  it('keeps every scheduled task when the store will not read', async () => {
    corrupt(tasksStorePath());

    await expect(
      updateTasks((tasks) => ({ tasks: [...tasks], result: tasks.length }))
    ).rejects.toThrow();
    expect(readFileSync(tasksStorePath(), 'utf8')).toBe(GARBAGE);

    // The scheduler's whole-list overwrite arrives by a different door: it boots
    // off readTasks(), which answers [] here, and used to persist exactly that.
    expect(await readTasks()).toEqual([]);
    await saveTasks([]);
    expect(readFileSync(tasksStorePath(), 'utf8')).toBe(GARBAGE);
    expect(degradations().map((d) => d.what)).toContain(
      'did not persist the task list over a store it could not read'
    );
    rmSync(tasksStorePath(), { force: true });
  });

  it('keeps the folder tree when the chat store will not read', async () => {
    corrupt(chatStorePath());

    await expect(createFolder('Work', null)).rejects.toThrow();
    expect(readFileSync(chatStorePath(), 'utf8')).toBe(GARBAGE);
    expect((await readChatStore()).folders).toEqual([]);
    rmSync(chatStorePath(), { force: true });
  });

  it('keeps archived and snoozed threads when the inbox will not read', async () => {
    corrupt(inboxStorePath());

    await expect(setArchived(['thread-1'], true)).rejects.toThrow();
    expect(readFileSync(inboxStorePath(), 'utf8')).toBe(GARBAGE);
    expect(degradations().map((d) => d.what)).toContain(
      'refused to write the inbox over a file it could not read'
    );
    rmSync(inboxStorePath(), { force: true });
  });

  it('keeps the connected folders when their registry will not read', async () => {
    corrupt(connectedFoldersStorePath());

    await expect(addConnectedFolders([tmpdir()])).rejects.toThrow();
    expect(readFileSync(connectedFoldersStorePath(), 'utf8')).toBe(GARBAGE);
    expect((await readFolderStore()).folders).toEqual([]);
    rmSync(connectedFoldersStorePath(), { force: true });
  });
});

describe('a skills directory that will not list is not a skills directory with nothing hidden', () => {
  beforeEach(() => {
    rmSync(skillsDir, { recursive: true, force: true });
    mkdirSync(skillsDir, { recursive: true });
  });

  it('leaves the ignore file alone rather than unhiding every disabled skill', () => {
    // The file as a real toggle would have left it.
    writeFileSync(join(skillsDir, SKILLS_IGNORE_FILE), 'archived-skill/\n', 'utf8');
    // A path that is a FILE cannot be listed as a directory — ENOTDIR, which is
    // the same branch EACCES takes and needs no permission games to reproduce.
    const notADirectory = join(skillsDir, SKILLS_IGNORE_FILE);

    expect(disabledSlugs(notADirectory)).toBeNull();
    expect(syncSkillsIgnore(notADirectory)).toEqual([]);
    // Deleting it is what put every disabled and curator-archived skill back in
    // the backend's prompt, with nothing to rebuild it until the next toggle.
    expect(readFileSync(join(skillsDir, SKILLS_IGNORE_FILE), 'utf8')).toBe('archived-skill/\n');
    expect(degradations().map((d) => d.what)).toContain('left the skills ignore file as it was');
  });

  it('still removes the file when the directory really does have nothing hidden', () => {
    writeFileSync(join(skillsDir, SKILLS_IGNORE_FILE), 'gone/\n', 'utf8');
    expect(syncSkillsIgnore(skillsDir)).toEqual([]);
    expect(existsSync(join(skillsDir, SKILLS_IGNORE_FILE))).toBe(false);
  });
});
