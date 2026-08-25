// HEIC detection and OS-decoder conversion. The decoder is mocked except for a
// macOS smoke that uses real `sips` — that's the path Stem ships, and a mock
// cannot catch a sips flag regression.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  convertHeicAttachment,
  heicToJpeg,
  isHeicNameOrMime,
  looksLikeHeicBytes,
  setHeicDecoderForTests
} from '../../src/server/pi/heic';

const MINI_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/** ISO BMFF `ftypheic` header — enough for brand detection, not a real photo. */
function fakeHeic(): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeUInt32BE(16, 0);
  buf.write('ftyp', 4);
  buf.write('heic', 8);
  buf.write('mif1', 12);
  return buf;
}

afterEach(() => {
  setHeicDecoderForTests(null);
});

describe('HEIC detection', () => {
  it('recognises names, MIME types, and ftyp brands', () => {
    expect(isHeicNameOrMime({ name: 'IMG_1.HEIC' })).toBe(true);
    expect(isHeicNameOrMime({ name: 'shot.heif' })).toBe(true);
    expect(isHeicNameOrMime({ name: 'x', mime: 'image/heic' })).toBe(true);
    expect(isHeicNameOrMime({ name: 'photo.png' })).toBe(false);
    // Client-side conversion keeps the .heic name but sets jpeg mime.
    expect(isHeicNameOrMime({ name: 'IMG_1.HEIC', mime: 'image/jpeg' })).toBe(false);
    expect(looksLikeHeicBytes(fakeHeic())).toBe(true);
    expect(looksLikeHeicBytes(MINI_JPEG)).toBe(false);
    expect(looksLikeHeicBytes(Buffer.from('hello'))).toBe(false);
  });
});

describe('convertHeicAttachment', () => {
  it('rewrites a HEIC attachment to JPEG dataBase64', async () => {
    setHeicDecoderForTests(async () => MINI_JPEG);
    const next = await convertHeicAttachment({
      name: 'IMG_1.HEIC',
      path: '/tmp/IMG_1.HEIC',
      dataBase64: fakeHeic().toString('base64')
    });
    expect(next).toEqual({
      name: 'IMG_1.HEIC',
      mime: 'image/jpeg',
      dataBase64: MINI_JPEG.toString('base64')
    });
    expect(next.path).toBeUndefined();
  });

  it('leaves a non-HEIC attachment alone', async () => {
    const att = { name: 'note.txt', path: '/tmp/note.txt' };
    expect(await convertHeicAttachment(att)).toEqual(att);
  });

  it('leaves a HEIC unchanged when the decoder returns null', async () => {
    setHeicDecoderForTests(async () => null);
    const att = { name: 'broken.heic', dataBase64: 'not-a-photo' };
    expect(await convertHeicAttachment(att)).toEqual(att);
  });

  it('reads HEIC from disk when there is no dataBase64', async () => {
    setHeicDecoderForTests(async () => MINI_JPEG);
    const dir = await mkdtemp(join(tmpdir(), 'stem-heic-att-'));
    const path = join(dir, 'shot.heic');
    try {
      await writeFile(path, fakeHeic());
      const next = await convertHeicAttachment({ name: 'shot.heic', path });
      expect(next).toEqual({
        name: 'shot.heic',
        mime: 'image/jpeg',
        dataBase64: MINI_JPEG.toString('base64')
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('heicToJpeg with the system decoder', () => {
  it.skipIf(process.platform !== 'darwin')('round-trips a sips-made HEIC to JPEG', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stem-heic-smoke-'));
    const pngPath = join(dir, 'in.png');
    const heicPath = join(dir, 'in.heic');
    // 1×1 PNG — sips can re-encode this as HEIC on any recent macOS.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    try {
      await writeFile(pngPath, png);
      const made = await new Promise<boolean>((resolve) => {
        execFile('/usr/bin/sips', ['-s', 'format', 'heic', pngPath, '--out', heicPath], (error) => {
          resolve(!error);
        });
      });
      // Encode can be blocked in a sandbox even though decode works in the app.
      if (!made) return;
      const jpeg = await heicToJpeg(await readFile(heicPath));
      expect(jpeg).not.toBeNull();
      expect(jpeg![0]).toBe(0xff);
      expect(jpeg![1]).toBe(0xd8);
      expect(jpeg![2]).toBe(0xff);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for garbage without throwing', async () => {
    setHeicDecoderForTests(null);
    await expect(heicToJpeg(Buffer.from('not really heic\0'))).resolves.toBeNull();
  });
});
