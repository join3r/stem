// The persistent "Files" place — a user-facing folder inside the backend cwd
// (workspace/files/) where dropped files live, optionally organized into
// top-level subfolders. The folder on disk is the single source of truth: there
// is no separate database, so every mutation re-reads the directory. The agent's
// read tools reach these files because the folder is inside its cwd.

import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import type { FileEntry, FilesListing } from '../../shared/types';
import { degrade } from '../degrade';
import { filesRoot } from '../workspace/paths';
import { isUploadHandle, resolveUploadHandle } from './staging';

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
    } catch (error) {
      // Absent is ordinary: the Files place is created on first use, and a
      // subfolder can go while the walk is inside it. A folder that is there and
      // will not read is the other thing, and it looks the same — empty.
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        degrade('files', 'left a folder out of the listing', error);
      }
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
          // quiet: unreadable, but the file is there — listing it at size 0 beats
          // dropping it out of the folder the user is looking at.
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

/**
 * Copy to `name` (or a numbered sibling) without a check-then-copy race.
 * COPYFILE_EXCL makes reserving the destination and copying one atomic
 * operation from the perspective of concurrent addFiles calls.
 */
async function copyToUniquePath(src: string, dir: string, name: string): Promise<void> {
  const ext = extname(name);
  const stem = basename(name, ext);
  for (let i = 0; ; i++) {
    const candidate = join(dir, i === 0 ? name : `${stem}-${i}${ext}`);
    try {
      await copyFile(src, candidate, constants.COPYFILE_EXCL);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
}

/**
 * True when `subdir` is a single safe path segment (no slashes, no traversal)
 * that would actually show up in a listing — dotted names are skipped by
 * isHidden, so creating one would make an invisible folder.
 */
function isSafeSubdir(subdir: string): boolean {
  return subdir === basename(subdir) && subdir !== '..' && subdir !== '.' && !isHidden(subdir);
}

/**
 * Copy each source file into files/<subdir> (subdir '' = root), avoiding name
 * collisions. Sources are absolute paths (the renderer resolves dropped/picked
 * Files to paths) or, from a client whose server is elsewhere, staging handles
 * for bytes it has already streamed over (see files/staging.ts). A staged file
 * keeps its original basename, so both forms land under the same name here.
 * Unreadable sources are skipped. Returns the fresh listing.
 */
export async function addFiles(paths: string[], subdir = ''): Promise<FilesListing> {
  if (subdir && !isSafeSubdir(subdir)) throw new Error(`Unsafe files subfolder: ${subdir}`);
  const destDir = subdir ? join(filesRoot(), subdir) : filesRoot();
  await mkdir(destDir, { recursive: true });
  for (const src of paths) {
    if (!src) continue;
    const from = isUploadHandle(src) ? await resolveUploadHandle(src) : src;
    // A handle that resolves to nothing has expired or was never real; treat it
    // like any other unreadable source rather than failing the whole drop.
    if (!from) continue;
    try {
      await copyToUniquePath(from, destDir, basename(from) || `file-${Date.now()}-${seq++}`);
    } catch (error) {
      // Skip a single unreadable source rather than failing the whole drop. The
      // listing returned below is the only answer a drop gets, and a file missing
      // from it looks exactly like a file that was never dropped.
      degrade('files', 'skipped one dropped file', error);
    }
  }
  return listFiles();
}

/**
 * The absolute path `rel` names inside the Files folder, or null when it points
 * anywhere else. THE containment check for this folder: everything that turns a
 * client-supplied relative path into an absolute one goes through here, so there
 * is one rule to read and one place a mistake in it could live.
 *
 * `resolve` normalises the `..` segments away before the comparison, which is
 * what makes `../../etc/passwd` fail rather than escape. Purely textual — a
 * caller that is going to READ the file wants readableFilePath below, which also
 * resolves symlinks.
 */
export function filePathWithin(rel: string): string | null {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const root = filesRoot();
  const abs = resolve(root, rel);
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

/**
 * The same, for a caller about to serve the bytes: the path must survive symlink
 * resolution still inside the folder, and must be a regular file.
 *
 * Textual containment alone is not enough here. The Files folder is a real
 * directory the user can also edit in Finder, so a symlink in it is something
 * they can create by accident — and a link named `notes.txt` pointing at
 * `~/.ssh/id_rsa` would otherwise be served on request as though it were a file
 * they had dropped in. A directory is refused for the same reason a caller could
 * not have used it: there are no bytes to send.
 */
export async function readableFilePath(rel: string): Promise<string | null> {
  const abs = filePathWithin(rel);
  if (!abs) return null;
  try {
    const root = await realpath(filesRoot());
    const real = await realpath(abs);
    if (real !== root && !real.startsWith(root + sep)) return null;
    return (await stat(real)).isFile() ? real : null;
  } catch {
    // quiet: missing, or a broken link. Either way the caller has its answer —
    // there are no bytes here to serve.
    return null;
  }
}

/** Delete a file by its rel path (guards against escaping files/). */
export async function removeFile(rel: string): Promise<FilesListing> {
  const abs = filePathWithin(rel);
  if (abs) await rm(abs, { force: true });
  return listFiles();
}

/**
 * Create a top-level subfolder. Only one level: subfolders are the drop-overlay
 * bands, and a band per nested path would not fit (nested files still list, they
 * just belong to their top-level folder). Idempotent — an existing folder of the
 * same name is left as it is.
 */
export async function createSubdir(name: string): Promise<FilesListing> {
  const trimmed = name.trim();
  if (!trimmed || !isSafeSubdir(trimmed)) throw new Error(`Unsafe files subfolder: ${name}`);
  await mkdir(join(filesRoot(), trimmed), { recursive: true });
  return listFiles();
}

/** Delete a top-level subfolder and everything under it (guards the name first). */
export async function removeSubdir(name: string): Promise<FilesListing> {
  if (!isSafeSubdir(name)) throw new Error(`Unsafe files subfolder: ${name}`);
  await rm(join(filesRoot(), name), { recursive: true, force: true });
  return listFiles();
}

/**
 * The Files folder, created if this is the first anyone has asked for it. For
 * the client's "Show in Finder": opening the folder is the client's job (see
 * desktop/local), but a path that may not exist yet is the store's.
 */
export async function ensureFilesRoot(): Promise<string> {
  await mkdir(filesRoot(), { recursive: true });
  return filesRoot();
}
