import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The client half of client-folder mirroring, driven end to end against the
// REAL server modules in-process: the engine scans a real directory, "uploads"
// through the real staging area (only the HTTP leg is stubbed out), and the
// real mirror:diff/apply/report handlers land the bytes in the mirror tree.
// What this pins: the ignore rules, deletes propagating, the root-vanish
// freeze, and reconcile pruning a folder the server dropped.

const root = join(tmpdir(), `stem-mirror-host-${process.pid}`);
process.env.STEM_CONNECTED_FOLDERS_STORE = join(root, 'connected-folders.json');
process.env.STEM_MIRRORS_DIR = join(root, 'mirrors');
process.env.STEM_DEVICES_FILE = join(root, 'devices.json');
process.env.STEM_UPLOADS_DIR = join(root, 'uploads');
process.env.STEM_MIRRORS_FILE = join(root, 'mirrors.json');

// The one seam that would otherwise need a listening server: uploadFile streams
// to POST /upload; here it stages the same bytes through the same module the
// route handler uses, returning the same handle shape.
vi.mock('../../src/desktop/file-transfer', async () => {
  const { createReadStream } = await import('node:fs');
  const { stageUpload } = await import('../../src/server/files/staging');
  return {
    uploadFile: async (_creds: unknown, path: string) =>
      (await stageUpload(basename(path), createReadStream(path))).handle
  };
});

import { createMirrorHost, type MirrorHost } from '../../src/desktop/mirror-host';
import { readMirroredFolders } from '../../src/desktop/mirror-host/store';
import { registerWorkspaceIpc } from '../../src/server/ipc/workspace';
import { dispatchLocal } from '../../src/server/ipc/guard';
import { forgetCachedDevices, mintDevice } from '../../src/server/transport/auth';
import { readStore, removeConnectedFolder } from '../../src/server/workspace/connected-folders';
import { mirrorRoot } from '../../src/server/workspace/paths';
import type { IpcDeps } from '../../src/server/ipc/deps';

const CLIENT_DIR = join(root, 'the-folder');

let macId: string;
let host: MirrorHost;

// Generous: refresh() schedules syncs behind the host's 2s debounce, so a
// round is never faster than that, and CI runners add real load on top.
async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function folderId(): string {
  return JSON.parse(readFileSync(process.env.STEM_CONNECTED_FOLDERS_STORE!, 'utf8')).folders[0].id as string;
}

beforeEach(async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(CLIENT_DIR, { recursive: true });
  forgetCachedDevices();
  macId = (await mintDevice('MacBook', 'desktop')).device.id;
  registerWorkspaceIpc({
    e2e: false,
    runtime: () => {
      throw new Error('not needed');
    },
    scheduler: () => null,
    providerAuth: () => null,
    embedManager: () => null,
    remoteHealth: () => null,
    emit: () => {},
    onAuthenticated: () => Promise.reject(new Error('not needed')),
    scheduleMemoryRebuild: () => {},
    scheduleFolderIndexScan: () => {},
    scheduleFolderLearn: () => {}
  } as IpcDeps);
  host = createMirrorHost({
    invoke: (channel, args) => dispatchLocal(channel, args, { deviceId: macId }),
    creds: () => ({ url: 'http://unused', token: 'unused' })
  });
});

afterEach(() => {
  host.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the mirror host, end to end against the real server modules', () => {
  it('mirrors a folder up, applies the ignore rules, and propagates later edits and deletes', async () => {
    writeFileSync(join(CLIENT_DIR, 'a.md'), 'alpha');
    mkdirSync(join(CLIENT_DIR, 'sub'), { recursive: true });
    writeFileSync(join(CLIENT_DIR, 'sub', 'b.md'), 'beta');
    mkdirSync(join(CLIENT_DIR, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(CLIENT_DIR, 'node_modules', 'pkg', 'x.js'), 'never');
    writeFileSync(join(CLIENT_DIR, '.DS_Store'), 'junk');
    symlinkSync(join(CLIENT_DIR, 'a.md'), join(CLIENT_DIR, 'link.md'));

    await host.addFolder(CLIENT_DIR);
    const id = folderId();
    // Wait for the round's report (lastSyncedAt), not for any one file: puts land
    // in upload-completion order, so b.md existing does not mean a.md does yet.
    await until(() => !!JSON.parse(readFileSync(process.env.STEM_CONNECTED_FOLDERS_STORE!, 'utf8')).folders[0].lastSyncedAt, 'the first sync');

    expect(readFileSync(join(mirrorRoot(id), 'a.md'), 'utf8')).toBe('alpha');
    expect(readFileSync(join(mirrorRoot(id), 'sub', 'b.md'), 'utf8')).toBe('beta');
    expect(existsSync(join(mirrorRoot(id), 'node_modules'))).toBe(false);
    expect(existsSync(join(mirrorRoot(id), '.DS_Store'))).toBe(false);
    expect(existsSync(join(mirrorRoot(id), 'link.md'))).toBe(false);
    // The report handler stores the skipped list before it stamps lastSyncedAt,
    // so the manifest is readable the moment the first-sync wait above passed.
    const manifest = JSON.parse(readFileSync(join(root, 'mirrors', `${id}.manifest.json`), 'utf8'));
    expect(manifest.skipped).toEqual([{ rel: 'link.md', reason: 'symbolic link' }]);
    // And this machine remembers what it mirrors.
    expect(await readMirroredFolders()).toMatchObject([{ folderId: id, clientPath: CLIENT_DIR, mode: 'read' }]);

    // An edit and a delete on the "device" reach the mirror on the next round.
    writeFileSync(join(CLIENT_DIR, 'a.md'), 'alpha v2');
    // fs.watch may or may not fire under CI load; refresh() is the deterministic path.
    utimesSync(join(CLIENT_DIR, 'a.md'), new Date(), new Date());
    rmSync(join(CLIENT_DIR, 'sub'), { recursive: true });
    await host.refresh();
    await until(() => !existsSync(join(mirrorRoot(id), 'sub')), 'the delete to propagate');
    await until(() => readFileSync(join(mirrorRoot(id), 'a.md'), 'utf8') === 'alpha v2', 'the edit to propagate');
  }, 30_000);

  it('freezes on a vanished root instead of wiping the mirror', async () => {
    writeFileSync(join(CLIENT_DIR, 'keep.md'), 'precious');
    await host.addFolder(CLIENT_DIR);
    const id = folderId();
    await until(() => existsSync(join(mirrorRoot(id), 'keep.md')), 'the first sync');

    rmSync(CLIENT_DIR, { recursive: true }); // the unmounted-disk signature
    await host.refresh();
    await until(
      () => JSON.parse(readFileSync(process.env.STEM_CONNECTED_FOLDERS_STORE!, 'utf8')).folders[0].rootMissing === true,
      'the freeze'
    );
    // Nothing was deleted server-side.
    expect(readFileSync(join(mirrorRoot(id), 'keep.md'), 'utf8')).toBe('precious');

    // The root comes back → sync thaws and resumes.
    mkdirSync(CLIENT_DIR, { recursive: true });
    writeFileSync(join(CLIENT_DIR, 'keep.md'), 'precious');
    writeFileSync(join(CLIENT_DIR, 'new.md'), 'fresh');
    await host.refresh();
    // Wait for the flag, not the file: the round applies files BEFORE the
    // report that clears rootMissing, so watching new.md races the round's tail.
    await until(
      () => JSON.parse(readFileSync(process.env.STEM_CONNECTED_FOLDERS_STORE!, 'utf8')).folders[0].rootMissing !== true,
      'the thaw'
    );
    expect(readFileSync(join(mirrorRoot(id), 'new.md'), 'utf8')).toBe('fresh');
    expect((await readStore()).folders[0]!.rootMissing).toBeUndefined();
  }, 30_000);

  it('prunes the local entry when the folder was disconnected server-side', async () => {
    writeFileSync(join(CLIENT_DIR, 'a.md'), 'alpha');
    await host.addFolder(CLIENT_DIR);
    const id = folderId();
    await until(() => existsSync(join(mirrorRoot(id), 'a.md')), 'the first sync');

    await removeConnectedFolder(id);
    expect(existsSync(mirrorRoot(id))).toBe(false); // the server side of disconnect
    // reconcile inside refresh() awaits the prune before resolving.
    await host.refresh();
    expect(await readMirroredFolders()).toEqual([]);
  }, 15_000);
});
