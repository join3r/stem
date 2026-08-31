// The two halves of "files in both directions", where each of them can go wrong
// quietly: the staging area a remote client's bytes land in, and the containment
// rule that decides what GET /files is allowed to send back.
//
// Both are worth their own tests for the same reason. A staging area that never
// forgets anything looks perfect right up until the disk is full, and a path
// guard that is one comparison away from wrong looks perfect until somebody asks
// it for `../../../etc/passwd`. Neither failure shows up in the feature working.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import {
  isUploadHandle,
  resolveUploadHandle,
  stageUpload,
  sweepStagedUploads,
  STAGED_TTL_MS
} from '../../src/server/files/staging';
import { addFiles, filePathWithin, listFiles, readableFilePath } from '../../src/server/files/store';
import { resolveAttachments } from '../../src/server/pi/attachments';
import { uploadStagingRoot } from '../../src/server/workspace/paths';

const filesDir = process.env.STEM_FILES_DIR!;
/** Somewhere outside both roots, for the escapes to point at. */
const outside = join(dirname(filesDir), 'outside');

/** Stage a string as if a client had streamed it to POST /upload. */
function upload(name: string, body: string) {
  return stageUpload(name, Readable.from([Buffer.from(body)]));
}

beforeEach(() => {
  rmSync(uploadStagingRoot(), { recursive: true, force: true });
  rmSync(filesDir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(filesDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'PASSPHRASE-7731');
});

afterEach(() => {
  rmSync(uploadStagingRoot(), { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('staged uploads', () => {
  it('round-trips bytes under the name they were sent with', async () => {
    const staged = await upload('cake.pdf', 'chocolate');
    expect(staged.name).toBe('cake.pdf');
    expect(staged.size).toBe('chocolate'.length);
    expect(isUploadHandle(staged.handle)).toBe(true);

    const path = await resolveUploadHandle(staged.handle);
    expect(path).toBeTruthy();
    expect(await readFile(path!, 'utf8')).toBe('chocolate');
    // The name survives the round trip, which is what lets files:add land the
    // file the user dropped rather than a uuid.
    expect(path!.endsWith('/cake.pdf')).toBe(true);
  });

  it('keeps two uploads of the same name apart', async () => {
    const a = await upload('notes.txt', 'first');
    const b = await upload('notes.txt', 'second');
    expect(a.handle).not.toBe(b.handle);
    expect(await readFile((await resolveUploadHandle(a.handle))!, 'utf8')).toBe('first');
    expect(await readFile((await resolveUploadHandle(b.handle))!, 'utf8')).toBe('second');
  });

  it('reduces the client-chosen name to a basename', async () => {
    // The one thing an upload may choose is what the file is CALLED. Where it
    // lands is never the client's to say.
    for (const name of ['../../etc/passwd', '/etc/passwd', 'a/b/c.txt']) {
      const staged = await upload(name, 'x');
      expect(staged.name).not.toContain('/');
      expect(staged.name).not.toContain('..');
      const path = await resolveUploadHandle(staged.handle);
      expect(path!.startsWith(uploadStagingRoot())).toBe(true);
    }
  });

  it('refuses to make a hidden or nameless file', async () => {
    for (const name of ['', '   ', '.', '..', '.ssh']) {
      expect((await upload(name, 'x')).name).toBe('upload');
    }
  });

  it('resolves nothing for a handle that was never real', async () => {
    for (const handle of [
      'stem-upload:../../../etc',
      'stem-upload:..',
      'stem-upload:',
      'stem-upload:not-a-uuid',
      'stem-upload:00000000-0000-0000-0000-000000000000',
      '/etc/passwd'
    ]) {
      expect(await resolveUploadHandle(handle)).toBeNull();
    }
  });

  it('sweeps what nothing came back for, and leaves what is still fresh', async () => {
    const stale = await upload('abandoned.txt', 'nobody wants me');
    const fresh = await upload('wanted.txt', 'still needed');

    // Backdate the stale one past the TTL. The sweep reads the directory's own
    // mtime, so this is the same thing an hour passing would do.
    const staleDir = dirname((await resolveUploadHandle(stale.handle))!);
    const old = new Date(Date.now() - STAGED_TTL_MS - 60_000);
    await utimes(staleDir, old, old);

    expect(await sweepStagedUploads()).toBe(1);
    expect(await resolveUploadHandle(stale.handle)).toBeNull();
    expect(await resolveUploadHandle(fresh.handle)).toBeTruthy();
  });

  it('leaves nothing behind when an upload dies part way through', async () => {
    // The transport cuts an over-long (or abandoned) body off by destroying the
    // stream. A partial file left in the staging area would then sit there until
    // the TTL, and — much worse — could be attached to a turn as though it were
    // the whole document.
    const cut = new Readable({
      read() {
        this.push(Buffer.from('the first half'));
        this.destroy(new Error('the connection closed before the body arrived'));
      }
    });
    await expect(stageUpload('half.txt', cut)).rejects.toThrow(/before the body arrived/);
    expect(readdirSync(uploadStagingRoot(), { withFileTypes: true }).filter((e) => e.isDirectory())).toEqual([]);
  });

  it('sweeps nothing when nothing has ever been uploaded', async () => {
    rmSync(uploadStagingRoot(), { recursive: true, force: true });
    expect(await sweepStagedUploads()).toBe(0);
  });

  it('does not consume a handle, so a retried turn still finds its bytes', async () => {
    // The deliberate half of the lifetime policy: age is the only thing that
    // removes staged bytes. A handle that worked once and then didn't would fail
    // exactly on the retry that was meant to recover a failed turn.
    const staged = await upload('note.txt', 'hello');
    const first = await resolveAttachments([{ name: 'note.txt', path: staged.handle }]);
    const second = await resolveAttachments([{ name: 'note.txt', path: staged.handle }]);
    expect(first.textBlocks[0]).toContain('hello');
    expect(second.textBlocks[0]).toContain('hello');
  });

  it('rejects an attachment whose staged bytes have expired', async () => {
    // Expiry has to read to the user as "that file couldn't be attached", which
    // is the same thing an unreadable path has always produced.
    const resolved = await resolveAttachments([
      { name: 'gone.txt', path: 'stem-upload:11111111-2222-3333-4444-555555555555' }
    ]);
    expect(resolved.rejected).toEqual(['gone.txt']);
    expect(resolved.textBlocks).toHaveLength(0);
  });

  it('lands a staged file in the Files folder under its original name', async () => {
    const staged = await upload('cake.pdf', 'chocolate');
    const listing = await addFiles([staged.handle], 'Recipes');
    expect(listing.files.some((f) => f.rel === 'Recipes/cake.pdf')).toBe(true);
    expect(await readFile(join(filesDir, 'Recipes', 'cake.pdf'), 'utf8')).toBe('chocolate');
  });

  it('skips an expired handle in a drop rather than failing the whole drop', async () => {
    const staged = await upload('good.txt', 'kept');
    const listing = await addFiles([staged.handle, 'stem-upload:11111111-2222-3333-4444-555555555555']);
    expect(listing.files.map((f) => f.rel)).toEqual(['good.txt']);
  });
});

describe('the Files download guard', () => {
  beforeEach(() => {
    mkdirSync(join(filesDir, 'Recipes'), { recursive: true });
    writeFileSync(join(filesDir, 'Recipes', 'cake.pdf'), 'chocolate');
  });

  it('resolves an ordinary file inside the folder', async () => {
    expect(filePathWithin('Recipes/cake.pdf')).toBe(join(filesDir, 'Recipes', 'cake.pdf'));
    expect(await readableFilePath('Recipes/cake.pdf')).toBeTruthy();
  });

  it('refuses everything that points outside it', async () => {
    for (const rel of [
      '../outside/secret.txt',
      '../../outside/secret.txt',
      'Recipes/../../outside/secret.txt',
      join(outside, 'secret.txt'),
      '/etc/passwd',
      '',
      'ok\0.txt'
    ]) {
      expect(filePathWithin(rel)).toBeNull();
      expect(await readableFilePath(rel)).toBeNull();
    }
  });

  it('refuses a symlink that leaves the folder', async () => {
    // The Files folder is a real directory the user can also edit in Finder, so
    // a link in it is something they can make by accident — and textual
    // containment alone would happily serve whatever it points at.
    symlinkSync(join(outside, 'secret.txt'), join(filesDir, 'innocent.txt'));
    // It IS textually inside; only resolving the link catches it.
    expect(filePathWithin('innocent.txt')).toBe(join(filesDir, 'innocent.txt'));
    expect(await readableFilePath('innocent.txt')).toBeNull();
  });

  it('follows a symlink that stays inside the folder', async () => {
    symlinkSync(join(filesDir, 'Recipes', 'cake.pdf'), join(filesDir, 'shortcut.pdf'));
    const resolved = await readableFilePath('shortcut.pdf');
    expect(resolved).toBeTruthy();
    expect(await readFile(resolved!, 'utf8')).toBe('chocolate');
  });

  it('refuses a directory and a file that is not there', async () => {
    expect(await readableFilePath('Recipes')).toBeNull();
    expect(await readableFilePath('Recipes/nothing.pdf')).toBeNull();
  });

  it('serves only what the listing shows', async () => {
    // The property the route depends on: anything readableFilePath says yes to is
    // something the Files panel already lists, so downloading cannot reach past
    // the surface the user can see.
    const listing = await listFiles();
    for (const file of listing.files) expect(await readableFilePath(file.rel)).toBeTruthy();
  });
});

describe('transported raw paths (SEC-002)', () => {
  const devicesFile = join(dirname(filesDir), `devices-${process.pid}.json`);

  beforeEach(() => {
    process.env.STEM_DEVICES_FILE = devicesFile;
    rmSync(devicesFile, { force: true });
  });

  afterEach(() => {
    rmSync(devicesFile, { force: true });
    delete process.env.STEM_DEVICES_FILE;
  });

  it('refuses a raw path from a transported device, allows handles and in-process callers', async () => {
    const { forgetCachedDevices, mintDevice } = await import('../../src/server/transport/auth');
    const { transportedRawPath } = await import('../../src/server/files/staging');
    forgetCachedDevices();
    const remote = (await mintDevice('Phone', 'mobile')).device;

    const serverPath = join(outside, 'secret.txt');
    // The deterministic SEC-002 shape: an authenticated device names a file on
    // the server. Refused whatever else rides along.
    expect(await transportedRawPath({ deviceId: remote.id }, [serverPath])).toBe(serverPath);
    expect(await transportedRawPath({ deviceId: remote.id }, ['stem-upload:x', serverPath])).toBe(serverPath);
    // Handles and empty/absent values are the sanctioned forms.
    expect(await transportedRawPath({ deviceId: remote.id }, ['stem-upload:whatever'])).toBeNull();
    expect(await transportedRawPath({ deviceId: remote.id }, [undefined, ''])).toBeNull();
    // No caller identity = an in-process call; paths are the server's own.
    expect(await transportedRawPath(undefined, [serverPath])).toBeNull();
  });

  it('lets a device marked local pass paths — and only the in-process mint can mark one', async () => {
    const { forgetCachedDevices, mintDevice, markDeviceLocal, readDevices } = await import(
      '../../src/server/transport/auth'
    );
    const { transportedRawPath } = await import('../../src/server/files/staging');
    forgetCachedDevices();
    const embedded = (await mintDevice('This Mac', 'desktop', { local: true })).device;
    const paired = (await mintDevice('Laptop', 'desktop')).device;

    const serverPath = join(outside, 'secret.txt');
    expect(await transportedRawPath({ deviceId: embedded.id }, [serverPath])).toBeNull();
    expect(await transportedRawPath({ deviceId: paired.id }, [serverPath])).toBe(serverPath);

    // The migration mark for pre-flag embedded records, and its persistence
    // through a reload of the registry file.
    expect(await markDeviceLocal(paired.id)).toBe(true);
    expect(await transportedRawPath({ deviceId: paired.id }, [serverPath])).toBeNull();
    forgetCachedDevices();
    const reloaded = await readDevices();
    expect(reloaded.find((d) => d.id === embedded.id)?.local).toBe(true);
    expect(reloaded.find((d) => d.id === paired.id)?.local).toBe(true);

    // An unknown id is a no-op, not an error.
    expect(await markDeviceLocal('nope')).toBe(false);
  });
});
