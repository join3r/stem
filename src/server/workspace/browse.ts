import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ServerFolderListing } from '../../shared/types';

// The server's answer to "what folders are there to connect?". A native picker
// runs on the client's machine, which is the wrong machine whenever the server
// is a VPS — a path picked there means nothing to the disk the assistant will
// actually read. So the remote picker walks the SERVER's filesystem through this
// listing, one directory per call, and the client renders it (see
// renderer/manage/ServerFolderPicker.tsx).
//
// Directories only: connected folders are folders, and a file list would only
// pad the modal. Dot-directories are filtered the way every OS picker filters
// them; the path field in the picker takes a pasted absolute path for the cases
// (a .config vault, say) the filter hides.
//
// No confinement to a root on purpose: cfolders:add already accepts any absolute
// path on the server, so hiding parts of the tree here would restrict nothing —
// it would only make the picker weaker than the API under it.

/** True for a plausible entry: a directory, following one level of symlink. */
async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory(); // stat follows symlinks
  } catch {
    // quiet: a dangling link or a mount that refuses stat is not a directory,
    // which is the whole question this asks.
    return false;
  }
}

/**
 * List the sub-directories of `path` on the server's own disk; no path starts at
 * the server user's home. An unreadable directory answers with `error` set and
 * an empty list rather than throwing, so the picker keeps its footing and the
 * user can navigate back up.
 */
export async function browseServerFolders(path?: string | null): Promise<ServerFolderListing> {
  const home = homedir();
  const target = resolve((path ?? '').trim() || home);
  const parent = dirname(target);
  const listing: ServerFolderListing = {
    path: target,
    parent: parent === target ? null : parent,
    home,
    dirs: []
  };
  let names: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
  try {
    names = await readdir(target, { withFileTypes: true });
  } catch (e) {
    // quiet: the reason goes back in listing.error, which is on screen in the
    // picker the moment a folder refuses to open.
    const code = (e as NodeJS.ErrnoException)?.code;
    listing.error =
      code === 'ENOENT'
        ? 'No folder at this path on the server.'
        : code === 'EACCES' || code === 'EPERM'
          ? 'The server may not read this folder.'
          : code === 'ENOTDIR'
            ? 'That path is a file, not a folder.'
            : `Could not read this folder (${code ?? String((e as Error)?.message ?? e)}).`;
    return listing;
  }
  const dirs = await Promise.all(
    names
      .filter((d) => !d.name.startsWith('.'))
      .map(async (d) => {
        const full = join(target, d.name);
        const dir = d.isDirectory() || (d.isSymbolicLink() && (await isDir(full)));
        return dir ? { name: d.name, path: full } : null;
      })
  );
  listing.dirs = dirs
    .filter((d): d is { name: string; path: string } => !!d)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return listing;
}
