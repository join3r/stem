import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Client-connected folders: the registry half. A folder that lives on a paired
// desktop is registered with `path` = a server-side mirror directory (so
// everything downstream treats it like any other connected folder) and `origin`
// = where it really lives. These tests pin the registry rules: who may be an
// origin, label uniqueness, the always-protected mirror, and cleanup on
// disconnect.

const root = join(tmpdir(), `stem-cfolders-client-${process.pid}`);
process.env.STEM_CONNECTED_FOLDERS_STORE = join(root, 'connected-folders.json');
process.env.STEM_MIRRORS_DIR = join(root, 'mirrors');
process.env.STEM_DEVICES_FILE = join(root, 'devices.json');

import {
  addClientFolder,
  addConnectedFolders,
  listConnectedFolders,
  readStore,
  removeConnectedFolder,
  updateConnectedFolder
} from '../../src/server/workspace/connected-folders';
import { enrichConnectedFolders } from '../../src/server/connected-folders/enrich';
import { buildConnectedFoldersContext } from '../../src/server/connected-folders/inject';
import { forgetCachedDevices, mintDevice, revokeDevice } from '../../src/server/transport/auth';
import { mirrorRoot, mirrorsDir } from '../../src/server/workspace/paths';

let macId: string;

beforeEach(async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  forgetCachedDevices();
  macId = (await mintDevice('MacBook', 'desktop')).device.id;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('addClientFolder', () => {
  it('registers the folder with a mirror path and survives a store round trip', async () => {
    await addClientFolder({ deviceId: macId, clientPath: '/Users/v/notes' });
    const { folders } = await readStore(); // fresh read: what coerce() lets through
    expect(folders).toHaveLength(1);
    const f = folders[0]!;
    expect(f.origin).toEqual({ deviceId: macId, clientPath: '/Users/v/notes' });
    expect(f.path).toBe(mirrorRoot(f.id));
    expect(f.label).toBe('notes');
    expect(f.mode).toBe('read');
    expect(existsSync(f.path)).toBe(true);
  });

  it('refuses an unpaired device, a phone, and a relative path', async () => {
    await expect(addClientFolder({ deviceId: 'nope', clientPath: '/x' })).rejects.toThrow(/not paired/);
    const phone = (await mintDevice('iPhone', 'mobile')).device.id;
    await expect(addClientFolder({ deviceId: phone, clientPath: '/x' })).rejects.toThrow(/phone/);
    await expect(addClientFolder({ deviceId: macId, clientPath: 'notes' })).rejects.toThrow(/absolute path/);
    // Nothing registered, and no mirror directory left behind by any refusal.
    expect((await readStore()).folders).toHaveLength(0);
    expect(existsSync(mirrorsDir()) ? (await import('node:fs')).readdirSync(mirrorsDir()) : []).toEqual([]);
  });

  it('is idempotent per (device, clientPath) and leaves no orphan mirror dir', async () => {
    await addClientFolder({ deviceId: macId, clientPath: '/Users/v/notes' });
    await addClientFolder({ deviceId: macId, clientPath: '/Users/v/notes' });
    const { folders } = await readStore();
    expect(folders).toHaveLength(1);
    const { readdirSync } = await import('node:fs');
    // Exactly the one registered mirror — the duplicate add took its dir back.
    expect(readdirSync(mirrorsDir())).toEqual([folders[0]!.id]);
  });

  it('rejects a chosen label that is taken, suggesting a free one', async () => {
    await addConnectedFolders([root]); // label = basename(root)
    await expect(
      addClientFolder({ deviceId: macId, clientPath: '/a/b', label: `stem-cfolders-client-${process.pid}` })
    ).rejects.toThrow(/already called .* try/);
  });

  it('auto-suffixes a colliding DEFAULT label instead of failing', async () => {
    await addClientFolder({ deviceId: macId, clientPath: '/Users/v/notes' });
    await addClientFolder({ deviceId: macId, clientPath: '/home/v/other/notes' });
    const labels = (await readStore()).folders.map((f) => f.label).sort();
    expect(labels).toEqual(['notes', 'notes-2']);
  });

  it('understands a Windows client path', async () => {
    await addClientFolder({ deviceId: macId, clientPath: 'C:\\Users\\v\\Documents' });
    expect((await readStore()).folders[0]!.label).toBe('Documents');
  });
});

describe('label uniqueness on rename', () => {
  it('refuses renaming one folder to another’s label', async () => {
    await addClientFolder({ deviceId: macId, clientPath: '/a/notes' });
    const folders = await addClientFolder({ deviceId: macId, clientPath: '/a/work' });
    const work = folders.find((f) => f.label === 'work')!;
    await expect(updateConnectedFolder(work.id, { label: 'Notes' })).rejects.toThrow(/already called/);
  });
});

describe('the mirror is protected whatever the mode', () => {
  it('keeps the mirror path in the gate when the folder is made writable', async () => {
    const folders = await addClientFolder({ deviceId: macId, clientPath: '/a/notes' });
    const f = folders[0]!;
    await updateConnectedFolder(f.id, { mode: 'readwrite' });
    const { readFileSync, realpathSync } = await import('node:fs');
    const { protectedRootsPath } = await import('../../src/server/workspace/paths');
    const gate = JSON.parse(readFileSync(protectedRootsPath(), 'utf8')) as { roots: string[] };
    // The gate holds canonical (symlink-resolved) roots — macOS's tmpdir is one.
    expect(gate.roots).toContain(realpathSync(f.path));
  });
});

describe('disconnecting a client folder', () => {
  it('deletes the mirror directory', async () => {
    const folders = await addClientFolder({ deviceId: macId, clientPath: '/a/notes' });
    const f = folders[0]!;
    expect(existsSync(f.path)).toBe(true);
    await removeConnectedFolder(f.id);
    expect(existsSync(f.path)).toBe(false);
    expect((await readStore()).folders).toHaveLength(0);
  });
});

describe('enrichment and injection', () => {
  it('names the device, its availability, and the sync state', async () => {
    await addClientFolder({ deviceId: macId, clientPath: '/Users/v/notes' });
    const [f] = await enrichConnectedFolders(await listConnectedFolders());
    expect(f).toMatchObject({
      deviceLabel: 'MacBook',
      deviceConnected: false, // no transport in a unit test
      syncState: 'awaiting-sync'
    });
    const ctx = await buildConnectedFoldersContext();
    expect(ctx).toContain('lives on MacBook at `/Users/v/notes`');
    expect(ctx).toContain('first sync not finished');
    expect(ctx).toContain('one-way mirrors');
    expect(ctx).toContain('`node_modules`'); // the ignore disclosure
  });

  it('marks a folder orphaned when its device is unpaired', async () => {
    await addClientFolder({ deviceId: macId, clientPath: '/Users/v/notes' });
    await revokeDevice(macId);
    const [f] = await enrichConnectedFolders(await listConnectedFolders());
    expect(f!.orphaned).toBe(true);
    expect(f!.deviceLabel).toBeUndefined();
    // Still present — never silently deleted (the MCP pinning ⑩ rule).
    expect((await readStore()).folders).toHaveLength(1);
  });
});
