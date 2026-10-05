// What a browser upload may attach (only files Stem holds) and how the bytes
// reach the Mac (a single-use outbox entry bound to that device).
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveUploadSources } from '../../src/server/files/browser-sources';
import { clearOutbox, OUTBOX_PREFIX, outboxPut, outboxTake } from '../../src/server/files/outbox';
import { resolveDownload } from '../../src/server/startup/transport';
import { threadWorkspaceDir, workspaceRoot } from '../../src/server/workspace/paths';

const outside = mkdtempSync(join(tmpdir(), 'stem-outside-'));
const connected = mkdtempSync(join(tmpdir(), 'stem-connected-'));
const noImages = { findThreadImage: async () => null };

beforeAll(() => {
  mkdirSync(join(workspaceRoot(), 'files'), { recursive: true });
  writeFileSync(join(workspaceRoot(), 'files', 'cv.pdf'), 'PDF');
  writeFileSync(join(outside, 'id_rsa'), 'SECRET');
  writeFileSync(join(connected, 'notes.txt'), 'notes');
  // A link inside a readable root pointing out of it must not smuggle the file out.
  symlinkSync(join(outside, 'id_rsa'), join(workspaceRoot(), 'files', 'innocent.txt'));
});

const roots = () => [workspaceRoot(), threadWorkspaceDir('').replace(/\/$/, ''), connected];

describe('resolveUploadSources', () => {
  it('accepts Files, connected-folder and scratch paths', async () => {
    const scratch = threadWorkspaceDir('thread-a');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'made.csv'), 'a,b');
    const res = await resolveUploadSources(
      'thread-a',
      ['files/cv.pdf', join(connected, 'notes.txt'), 'made.csv'],
      { ...noImages, readRoots: roots }
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.files.map((f) => [f.name, f.size])).toEqual([
      ['cv.pdf', 3],
      ['notes.txt', 5],
      ['made.csv', 3]
    ]);
  });

  it('refuses anything outside, symlinks out, traversal and missing files', async () => {
    for (const ref of [join(outside, 'id_rsa'), 'files/innocent.txt', 'files/../../../../etc/hosts', 'nope.txt']) {
      const res = await resolveUploadSources('thread-a', [ref], { ...noImages, readRoots: roots });
      expect(res.ok, ref).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/outside|No file/);
    }
    expect((await resolveUploadSources('thread-a', [], { ...noImages, readRoots: roots })).ok).toBe(false);
  });

  it('writes an attached image out by its id', async () => {
    const res = await resolveUploadSources('thread-a', ['img_abcdef12'], {
      readRoots: roots,
      findThreadImage: async (_t, id) => (id === 'img_abcdef12' ? { mimeType: 'image/jpeg', data: 'QUJD' } : null)
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.files[0]).toMatchObject({ name: 'img_abcdef12.jpg', size: 3 });
    const missing = await resolveUploadSources('thread-a', ['img_ffffff00'], { ...noImages, readRoots: roots });
    expect(missing.ok).toBe(false);
  });
});

describe('outbox', () => {
  afterEach(() => clearOutbox());

  it('hands a private snapshot to its own device once, through the /files route', async () => {
    const resolved = await resolveUploadSources('thread-a', ['files/cv.pdf'], { ...noImages, readRoots: roots });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const snap = resolved.files[0]!;
    expect(snap.path.startsWith(realpathSync(workspaceRoot()))).toBe(false);
    const entry = outboxPut('mac-1', snap);
    expect(entry.id).toMatch(/^[0-9a-f]{32}$/);
    expect(await resolveDownload(`${OUTBOX_PREFIX}${entry.id}`, 'mac-2')).toBeNull();
    expect(await resolveDownload(`${OUTBOX_PREFIX}${entry.id}`)).toBeNull();
    const served = await resolveDownload(`${OUTBOX_PREFIX}${entry.id}`, 'mac-1');
    expect(served).toEqual({ path: snap.path, name: 'cv.pdf', size: 3 });
    expect(readFileSync(served!.path, 'utf8')).toBe('PDF');
    expect(await resolveDownload(`${OUTBOX_PREFIX}${entry.id}`, 'mac-1')).toBeNull();
  });

  it('serves the checked copy even when the original is swapped for a symlink afterwards', async () => {
    const path = join(workspaceRoot(), 'files', 'swap.txt');
    writeFileSync(path, 'ok');
    const resolved = await resolveUploadSources('thread-a', ['files/swap.txt'], { ...noImages, readRoots: roots });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const entry = outboxPut('mac-1', resolved.files[0]!);
    rmSync(path);
    symlinkSync(join(outside, 'id_rsa'), path);
    const served = await outboxTake('mac-1', entry.id);
    expect(readFileSync(served!.path, 'utf8')).toBe('ok');
  });

  it('expires after ten minutes', async () => {
    const resolved = await resolveUploadSources('thread-a', ['files/cv.pdf'], { ...noImages, readRoots: roots });
    if (!resolved.ok) throw new Error(resolved.error);
    const entry = outboxPut('mac-1', resolved.files[0]!, 0);
    expect(await outboxTake('mac-1', entry.id, 10 * 60_000 + 1)).toBeNull();
  });
});

afterAll(() => {
  rmSync(outside, { recursive: true, force: true });
  rmSync(connected, { recursive: true, force: true });
});
