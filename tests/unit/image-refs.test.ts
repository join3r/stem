// generate_image references that are files: read from the places save_file
// and browser uploads read, nowhere else.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveImageRefs, sniffImageMime } from '../../src/server/files/image-refs';
import type { BrowserSourceDeps } from '../../src/server/files/browser-sources';
import { threadWorkspaceDir, workspaceRoot } from '../../src/server/workspace/paths';

const project = mkdtempSync(join(tmpdir(), 'stem-imgref-project-'));
const outside = mkdtempSync(join(tmpdir(), 'stem-imgref-outside-'));
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]);
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');

mkdirSync(join(project, 'public', 'art'), { recursive: true });
writeFileSync(join(project, 'public', 'art', 'sword.png'), PNG);
writeFileSync(join(project, 'notes.txt'), 'not a picture');
writeFileSync(join(outside, 'secret.png'), PNG);
mkdirSync(join(workspaceRoot(), 'files'), { recursive: true });
writeFileSync(join(workspaceRoot(), 'files', 'photo.jpg'), JPEG);

const deps: BrowserSourceDeps = {
  findThreadImage: async (_t, id) => (id === 'img_0123456789' ? { mimeType: 'image/png', data: PNG.toString('base64') } : null),
  readRoots: () => [workspaceRoot(), threadWorkspaceDir('').replace(/\/$/, ''), project]
};

describe('resolveImageRefs', () => {
  it('reads connected-folder, Files and mailed-in references in order', async () => {
    const res = await resolveImageRefs('thread-r', [join(project, 'public/art/sword.png'), 'files/photo.jpg', 'img_0123456789'], deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.images.map((i) => [i.ref, i.mimeType])).toEqual([
      [join(project, 'public/art/sword.png'), 'image/png'],
      ['files/photo.jpg', 'image/jpeg'],
      ['img_0123456789', 'image/png']
    ]);
    expect(Buffer.from(res.images[0]!.data, 'base64')).toEqual(PNG);
  });

  it('reads a scratch file by its relative path', async () => {
    mkdirSync(threadWorkspaceDir('thread-r'), { recursive: true });
    writeFileSync(join(threadWorkspaceDir('thread-r'), 'sword-reference.png'), PNG);
    const res = await resolveImageRefs('thread-r', ['sword-reference.png'], deps);
    expect(res.ok).toBe(true);
  });

  it('refuses files outside the readable places and files that are not pictures', async () => {
    const out = await resolveImageRefs('thread-r', [join(outside, 'secret.png')], deps);
    expect(out).toMatchObject({ ok: false });
    expect(!out.ok && out.error).toContain('outside the files Stem may reference');
    const txt = await resolveImageRefs('thread-r', [join(project, 'notes.txt')], deps);
    expect(!txt.ok && txt.error).toContain('not a PNG, JPEG, WebP or GIF');
  });

  it('sniffs the four formats the image service takes', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('hello world!'))).toBeNull();
  });
});
