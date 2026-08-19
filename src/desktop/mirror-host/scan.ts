import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MirrorManifestEntry } from '../../shared/types';

// One scan of a mirrored folder on THIS machine: the full tree as
// '/'-separated rels with {size, mtimeMs}, minus what deliberately never
// mirrors. The rules are fixed (decision: no .gitignore/.stemignore in v1)
// and every exclusion the user might miss is REPORTED, not silent — the
// skipped list reaches the Folders tab, and the prompt discloses the rules so
// the assistant does not read a missing node_modules as a broken folder.

/** Names that never mirror, wherever they appear in the tree. */
export const MIRROR_IGNORED_NAMES = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Per-file cap. The transport allows 100 MB; mirrors stop well short of it. */
export const MIRROR_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** The skipped report is a summary for people; past this it says only that. */
const MAX_SKIPPED = 200;

export interface MirrorScan {
  entries: MirrorManifestEntry[];
  skipped: { rel: string; reason: string }[];
  /** The root itself is gone or not a directory — freeze, never "delete all". */
  rootMissing: boolean;
}

export async function scanMirrorRoot(root: string): Promise<MirrorScan> {
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) return { entries: [], skipped: [], rootMissing: true };

  const entries: MirrorManifestEntry[] = [];
  const skipped: { rel: string; reason: string }[] = [];
  const skip = (rel: string, reason: string): void => {
    if (skipped.length < MAX_SKIPPED) skipped.push({ rel, reason });
  };

  async function walk(dir: string, relBase: string): Promise<void> {
    let names;
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      skip(relBase || '.', 'unreadable directory');
      return;
    }
    for (const d of names) {
      if (MIRROR_IGNORED_NAMES.has(d.name)) continue; // the fixed rules; disclosed, not reported
      const rel = relBase ? `${relBase}/${d.name}` : d.name;
      // A symlink is skipped whatever it points at: following one could walk
      // out of the folder the user picked, which is the one thing a mirror
      // must never upload.
      if (d.isSymbolicLink()) {
        skip(rel, 'symbolic link');
        continue;
      }
      if (d.isDirectory()) {
        await walk(join(dir, d.name), rel);
        continue;
      }
      if (!d.isFile()) {
        skip(rel, 'not a regular file');
        continue;
      }
      const info = await stat(join(dir, d.name)).catch(() => null);
      if (!info) {
        skip(rel, 'unreadable');
        continue;
      }
      if (info.size > MIRROR_MAX_FILE_BYTES) {
        skip(rel, `too large (${Math.ceil(info.size / (1024 * 1024))} MB)`);
        continue;
      }
      entries.push({ rel, size: info.size, mtimeMs: Math.round(info.mtimeMs) });
    }
  }

  await walk(root, '');
  return { entries, skipped, rootMissing: false };
}
