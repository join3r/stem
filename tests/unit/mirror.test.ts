import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The server half of client-folder mirroring: rel safety (every rel becomes a
// path and a deletion), the diff a lost manifest degrades to, apply's
// staged-handle landing, and that no channel lets one paired machine touch
// another machine's mirror.

const root = join(tmpdir(), `stem-mirror-${process.pid}`);
process.env.STEM_CONNECTED_FOLDERS_STORE = join(root, 'connected-folders.json');
process.env.STEM_MIRRORS_DIR = join(root, 'mirrors');
process.env.STEM_DEVICES_FILE = join(root, 'devices.json');
process.env.STEM_UPLOADS_DIR = join(root, 'uploads');

import {
  applyMirror,
  coerceManifestEntries,
  diffMirror,
  MAX_APPLY_ENTRIES,
  readMirrorSkipped,
  recordMirrorSkipped,
  safeRel
} from '../../src/server/mirror';
import { stageUpload } from '../../src/server/files/staging';
import { addClientFolder, readStore } from '../../src/server/workspace/connected-folders';
import { forgetCachedDevices, mintDevice } from '../../src/server/transport/auth';
import { registerWorkspaceIpc } from '../../src/server/ipc/workspace';
import { dispatchLocal } from '../../src/server/ipc/guard';
import { mirrorRoot } from '../../src/server/workspace/paths';
import type { IpcDeps } from '../../src/server/ipc/deps';
import type { MirrorDiffResult } from '../../src/shared/types';

const stage = (rel: string, content: string): Promise<string> =>
  stageUpload(rel.split('/').pop()!, Readable.from([content])).then((r) => r.handle);

let macId: string;

beforeEach(async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  forgetCachedDevices();
  macId = (await mintDevice('MacBook', 'desktop')).device.id;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('safeRel', () => {
  it('accepts ordinary nested rels and refuses every escape shape', () => {
    expect(safeRel('notes/2026/plan.md')).toBe('notes/2026/plan.md');
    for (const bad of ['', '/etc/passwd', '../up', 'a/../b', 'a/./b', 'a//b', 'a\\b', 'a/', '.', '..', 'a\0b']) {
      expect(safeRel(bad), bad).toBeNull();
    }
  });
});

describe('diff and apply', () => {
  it('wants everything on a fresh mirror, nothing after an apply, and names removals', async () => {
    const id = 'folder-1';
    const client = coerceManifestEntries([
      { rel: 'a.md', size: 2, mtimeMs: 100 },
      { rel: 'sub/dir/b.md', size: 3, mtimeMs: 200 }
    ]);
    expect((await diffMirror(id, client)).want.sort()).toEqual(['a.md', 'sub/dir/b.md']);

    await applyMirror(id, {
      puts: [
        { rel: 'a.md', handle: await stage('a.md', 'hi'), size: 2, mtimeMs: 100 },
        { rel: 'sub/dir/b.md', handle: await stage('b.md', 'hey'), size: 3, mtimeMs: 200 }
      ],
      deletes: []
    });
    expect(existsSync(join(mirrorRoot(id), 'sub/dir/b.md'))).toBe(true);
    // Spent handles leave no staging shell behind for the TTL sweep.
    expect(readdirSync(join(root, 'uploads'))).toEqual([]);
    expect(await diffMirror(id, client)).toEqual<MirrorDiffResult>({ want: [], delete: [] });

    // The file changes on the device → wanted again; it disappears → a delete.
    const changed = coerceManifestEntries([{ rel: 'a.md', size: 5, mtimeMs: 300 }]);
    const diff = await diffMirror(id, changed);
    expect(diff.want).toEqual(['a.md']);
    expect(diff.delete).toEqual(['sub/dir/b.md']);

    const res = await applyMirror(id, { puts: [], deletes: ['sub/dir/b.md'] });
    expect(res.deleted).toBe(1);
    expect(existsSync(join(mirrorRoot(id), 'sub/dir/b.md'))).toBe(false);
    // Emptied directories are pruned; the mirror root itself stays.
    expect(existsSync(join(mirrorRoot(id), 'sub'))).toBe(false);
    expect(existsSync(mirrorRoot(id))).toBe(true);
  });

  it('reports an expired handle as failed instead of failing the batch', async () => {
    const res = await applyMirror('folder-2', {
      puts: [{ rel: 'a.md', handle: 'stem-upload:00000000-0000-4000-8000-000000000000', size: 1, mtimeMs: 1 }],
      deletes: []
    });
    expect(res).toMatchObject({ applied: 0, failed: ['a.md'] });
    // Not in the manifest → the next diff asks for it again.
    const diff = await diffMirror('folder-2', coerceManifestEntries([{ rel: 'a.md', size: 1, mtimeMs: 1 }]));
    expect(diff.want).toEqual(['a.md']);
  });

  it('never lands or deletes an unsafe rel, and bounds a batch', async () => {
    const handle = await stage('x', 'boom');
    await applyMirror('folder-3', {
      puts: [{ rel: '../escape.md', handle, size: 4, mtimeMs: 1 }],
      deletes: ['../../etc/passwd']
    });
    expect(existsSync(join(root, 'mirrors', 'escape.md'))).toBe(false);
    expect(existsSync(join(root, 'escape.md'))).toBe(false);

    const many = Array.from({ length: MAX_APPLY_ENTRIES + 1 }, (_, i) => `f${i}`);
    await expect(applyMirror('folder-3', { puts: [], deletes: many })).rejects.toThrow(/at most/);
  });

  it('keeps a bounded skipped report', async () => {
    const skipped = Array.from({ length: 500 }, (_, i) => ({ rel: `big-${i}.bin`, reason: 'too large' }));
    await recordMirrorSkipped('folder-4', skipped);
    expect((await readMirrorSkipped('folder-4')).length).toBe(200);
  });
});

describe('the mirror channels are caller-scoped', () => {
  it('refuses another device, an unpaired caller, and a server-side folder id', async () => {
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

    await addClientFolder({ deviceId: macId, clientPath: '/Users/v/notes' });
    const folderId = (await readStore()).folders[0]!.id;
    const other = (await mintDevice('Other', 'desktop')).device.id;

    await expect(dispatchLocal('mirror:diff', [folderId, { files: [] }], { deviceId: other })).rejects.toThrow(
      /calling computer/
    );
    await expect(dispatchLocal('mirror:apply', [folderId, { puts: [], deletes: [] }])).rejects.toThrow(
      /paired device/
    );
    await expect(
      dispatchLocal('mirror:report', [folderId, { state: 'ok' }], { deviceId: macId })
    ).resolves.toBeUndefined();
    expect((await readStore()).folders[0]!.lastSyncedAt).toBeTruthy();

    // Freezing and thawing: root-missing sets the flag, the next ok clears it.
    await dispatchLocal('mirror:report', [folderId, { state: 'root-missing' }], { deviceId: macId });
    expect((await readStore()).folders[0]!.rootMissing).toBe(true);
    await dispatchLocal('mirror:report', [folderId, { state: 'ok' }], { deviceId: macId });
    expect((await readStore()).folders[0]!.rootMissing).toBeUndefined();

    // mirror:hello answers only the CALLER's folders.
    expect(await dispatchLocal('mirror:hello', [], { deviceId: other })).toEqual([]);
    expect(await dispatchLocal('mirror:hello', [], { deviceId: macId })).toMatchObject([
      { folderId, clientPath: '/Users/v/notes', mode: 'read' }
    ]);
  });
});
