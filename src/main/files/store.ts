// The persistent "Files" place — a user-facing folder inside the codex cwd
// (workspace/files/) where dropped files live, optionally organized into
// top-level subfolders. The folder on disk is the single source of truth: there
// is no separate database, so every mutation re-reads the directory. The agent's
// read tools reach these files because the folder is inside its cwd.

import { access, copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { shell } from 'electron';
import type { FileEntry, FilesListing } from '../../shared/types';
import { filesRoot } from '../workspace/paths';

/** Skip dotfiles like .DS_Store everywhere. */
function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/**
 * List the Files folder: top-level subfolders (which drive the drop-overlay
 * bands) plus files at the root and one level inside each subfolder. Files
 * nested deeper are still included (by their rel path) but don't get a band.
 */
export async function listFiles(): Promise<FilesListing> {
  const rootDir = filesRoot();
  const dirs: string[] = [];
  const files: FileEntry[] = [];

  async function walk(dir: string, topDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (isHidden(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (dir === rootDir) dirs.push(e.name);
        await walk(abs, dir === rootDir ? e.name : topDir);
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = (await stat(abs)).size;
        } catch {
          // unreadable — list it with size 0 rather than dropping it
        }
        const rel = relative(rootDir, abs).split(sep).join('/');
        files.push({ rel, name: e.name, dir: dir === rootDir ? '' : topDir, size });
      }
    }
  }

  await walk(rootDir, '');
  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { root: rootDir, dirs, files };
}

/** A monotonic suffix so two adds in the same millisecond don't collide. */
let seq = 0;

/** Return `dest` (or a numbered sibling) that does not yet exist in `dir`. */
async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = basename(name, ext);
  for (let i = 0; ; i++) {
    const candidate = join(dir, i === 0 ? name : `${stem}-${i}${ext}`);
    try {
      await access(candidate);
    } catch {
      return candidate; // doesn't exist
    }
  }
}

/** True when `subdir` is a single safe path segment (no slashes, no traversal). */
function isSafeSubdir(subdir: string): boolean {
  return subdir === basename(subdir) && subdir !== '..' && subdir !== '.';
}

/**
 * Copy each source file into files/<subdir> (subdir '' = root), avoiding name
 * collisions. Sources are absolute paths (the renderer resolves dropped/picked
 * Files to paths). Unreadable sources are skipped. Returns the fresh listing.
 */
export async function addFiles(paths: string[], subdir = ''): Promise<FilesListing> {
  if (subdir && !isSafeSubdir(subdir)) throw new Error(`Unsafe files subfolder: ${subdir}`);
  const destDir = subdir ? join(filesRoot(), subdir) : filesRoot();
  await mkdir(destDir, { recursive: true });
  for (const src of paths) {
    if (!src) continue;
    try {
      const dest = await uniquePath(destDir, basename(src) || `file-${Date.now()}-${seq++}`);
      await copyFile(src, dest);
    } catch {
      // Skip a single unreadable source rather than failing the whole drop.
    }
  }
  return listFiles();
}

/** Delete a file by its rel path (guards against escaping files/). */
export async function removeFile(rel: string): Promise<FilesListing> {
  const root = filesRoot();
  const abs = join(root, rel);
  const within = abs === root || abs.startsWith(root + sep);
  if (within) await rm(abs, { force: true });
  return listFiles();
}

/** Open the Files folder in Finder/Explorer. */
export async function revealFiles(): Promise<void> {
  await mkdir(filesRoot(), { recursive: true });
  await shell.openPath(filesRoot());
}
