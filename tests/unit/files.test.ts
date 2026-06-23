// Files-place suite — ported from scripts/files-verify.mjs. Exercises the REAL
// files store + inject against the throwaway STEM_FILES_DIR from setup-unit.ts:
// listing/grouping by subfolder, add (collisions + subdirs), the context builder,
// the traversal guard, and remove.
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../../src/main/files/store';
import * as inject from '../../src/main/files/inject';

const root = process.env.STEM_FILES_DIR!;
const stage = join(root, '..', 'stage');
const srcA = join(stage, 'a.txt');
const srcCake = join(stage, 'cake.pdf');

beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(stage, { recursive: true });
  writeFileSync(srcA, 'hello');
  writeFileSync(srcCake, 'PASSPHRASE-7731 chocolate');
});

describe('Files place', () => {
  it('starts empty with no context', async () => {
    const listing = await store.listFiles();
    expect(listing.files.length).toBe(0);
    expect(listing.dirs.length).toBe(0);
    expect(await inject.buildFilesContext()).toBeNull();
  });

  it('adds a file at the root', async () => {
    const listing = await store.addFiles([srcA]);
    expect(listing.files.some((f) => f.rel === 'a.txt' && f.dir === '')).toBe(true);
  });

  it('adds into a subfolder created on demand', async () => {
    const listing = await store.addFiles([srcCake], 'Recipes');
    expect(listing.files.some((f) => f.rel === 'Recipes/cake.pdf' && f.dir === 'Recipes')).toBe(true);
    expect(listing.dirs).toContain('Recipes');
  });

  it('renames colliding files to numbered siblings', async () => {
    const listing = await store.addFiles([srcA]);
    expect(listing.files.some((f) => f.rel === 'a-1.txt')).toBe(true);
  });

  it('builds a context that lists names (with files/ prefix) but never contents', async () => {
    const ctx = await inject.buildFilesContext();
    expect(ctx).toBeTruthy();
    expect(ctx!).toContain('files/Recipes/cake.pdf');
    expect(ctx!).not.toContain('PASSPHRASE-7731');
  });

  it('treats an escaping (path-traversal) remove as a no-op', async () => {
    const before = (await store.listFiles()).files.length;
    await store.removeFile('../stage/a.txt');
    expect((await store.listFiles()).files.length).toBe(before);
  });

  it('removes a real file', async () => {
    const listing = await store.removeFile('Recipes/cake.pdf');
    expect(listing.files.some((f) => f.rel === 'Recipes/cake.pdf')).toBe(false);
  });
});
