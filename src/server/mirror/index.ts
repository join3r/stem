import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MirrorApplyInput, MirrorDiffResult, MirrorManifestEntry } from '../../shared/types';
import { resolveUploadHandle } from '../files/staging';
import { log } from '../log';
import { mirrorManifestPath, mirrorRoot } from '../workspace/paths';

// The server half of client-folder mirroring. The owning device scans, diffs
// against the manifest kept here, streams changed files through the ordinary
// POST /upload staging area, and lands them with apply. This module never
// looks at the device and never initiates anything: it answers diffs from its
// manifest — {size, client mtime} per rel, because this machine's own mtimes
// say nothing about another machine's files — and moves staged bytes into the
// mirror tree. A lost or corrupt manifest degrades to "send me everything",
// which costs bandwidth and never correctness.

/** One apply call lands at most this many puts + deletes; the client batches. */
export const MAX_APPLY_ENTRIES = 500;

/** The skipped-files report is a summary for people, not a second manifest. */
const MAX_SKIPPED_ENTRIES = 200;

interface MirrorManifest {
  version: 1;
  /** rel → what was last applied, in the CLIENT's size/mtime terms. */
  files: Record<string, { size: number; mtimeMs: number }>;
  /** What the owning device's last scan could not mirror, for the Folders tab. */
  skipped: { rel: string; reason: string }[];
}

function emptyManifest(): MirrorManifest {
  return { version: 1, files: {}, skipped: [] };
}

/**
 * A mirror-relative path a client may name, or null. Every rel lands in a
 * `join(mirrorRoot, rel)` and in a `rm` — this shape check is the whole
 * defence against a crafted one: '/'-separated, no empty/dot/dotdot segments,
 * no backslashes (the client normalizes), no NUL, bounded length.
 */
export function safeRel(rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel || rel.length > 1024) return null;
  if (rel.includes('\\') || rel.includes('\0')) return null;
  const segments = rel.split('/');
  for (const s of segments) {
    if (!s || s === '.' || s === '..') return null;
  }
  return rel;
}

async function readManifest(folderId: string): Promise<MirrorManifest> {
  try {
    const parsed = JSON.parse(await readFile(mirrorManifestPath(folderId), 'utf8')) as Partial<MirrorManifest>;
    const files: MirrorManifest['files'] = {};
    if (parsed.files && typeof parsed.files === 'object') {
      for (const [rel, v] of Object.entries(parsed.files)) {
        if (!safeRel(rel) || !v || typeof v !== 'object') continue;
        const { size, mtimeMs } = v as { size?: unknown; mtimeMs?: unknown };
        if (typeof size !== 'number' || typeof mtimeMs !== 'number') continue;
        files[rel] = { size, mtimeMs };
      }
    }
    const skipped = Array.isArray(parsed.skipped)
      ? parsed.skipped
          .filter((s): s is { rel: string; reason: string } => !!s && typeof s.rel === 'string' && typeof s.reason === 'string')
          .slice(0, MAX_SKIPPED_ENTRIES)
      : [];
    return { version: 1, files, skipped };
  } catch {
    // quiet: absent or unreadable answers the empty manifest, which makes the
    // next diff ask for everything — a full re-upload, never a wrong mirror.
    return emptyManifest();
  }
}

// One folder's manifest is a read-modify-write; serialize per folder so two
// apply batches cannot interleave and lose entries (the connected-folders
// chain pattern, keyed by folder).
const chains = new Map<string, Promise<unknown>>();

function enqueue<T>(folderId: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(folderId) ?? Promise.resolve();
  const run = prev.then(task, task);
  chains.set(
    folderId,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

async function writeManifest(folderId: string, manifest: MirrorManifest): Promise<void> {
  const path = mirrorManifestPath(folderId);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest), 'utf8');
  await rename(tmp, path); // atomic on the same volume
}

/** Coerce a client-sent manifest into valid entries; junk is dropped, last rel wins. */
export function coerceManifestEntries(raw: unknown): MirrorManifestEntry[] {
  const list = Array.isArray(raw) ? raw : [];
  const byRel = new Map<string, MirrorManifestEntry>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { rel, size, mtimeMs } = item as { rel?: unknown; size?: unknown; mtimeMs?: unknown };
    const safe = safeRel(rel);
    if (!safe) continue;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) continue;
    if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) continue;
    byRel.set(safe, { rel: safe, size, mtimeMs });
  }
  return [...byRel.values()];
}

/**
 * What has to move for the mirror to match the device: `want` = new or changed
 * rels the client should upload, `delete` = rels the mirror has that the
 * device no longer does. The caller echoes them back through apply — the diff
 * itself changes nothing.
 */
export function diffMirror(folderId: string, client: MirrorManifestEntry[]): Promise<MirrorDiffResult> {
  return enqueue(folderId, async () => {
    const manifest = await readManifest(folderId);
    const want: string[] = [];
    const seen = new Set<string>();
    for (const entry of client) {
      seen.add(entry.rel);
      const have = manifest.files[entry.rel];
      if (!have || have.size !== entry.size || have.mtimeMs !== entry.mtimeMs) want.push(entry.rel);
    }
    const remove = Object.keys(manifest.files).filter((rel) => !seen.has(rel));
    return { want, delete: remove };
  });
}

/** What one apply batch did; `failed` rels re-upload on the client's next round. */
export interface MirrorApplyResult {
  applied: number;
  deleted: number;
  /** Puts whose staged handle would not resolve (expired, swept, never real). */
  failed: string[];
}

/**
 * Land one batch: move each staged upload into the mirror tree (rename first —
 * staging and mirrors share a volume — copy as the fallback), remove deleted
 * rels, and record both in the manifest. A put whose handle no longer resolves
 * is reported back rather than failing the batch: staged bytes live on a TTL,
 * and the client simply re-uploads on its next round.
 */
export async function applyMirror(folderId: string, input: MirrorApplyInput): Promise<MirrorApplyResult> {
  if (input.puts.length + input.deletes.length > MAX_APPLY_ENTRIES) {
    throw new Error(`One mirror apply carries at most ${MAX_APPLY_ENTRIES} entries — send more batches instead.`);
  }
  return enqueue(folderId, async () => {
    const root = mirrorRoot(folderId);
    const manifest = await readManifest(folderId);
    const failed: string[] = [];
    let applied = 0;
    let deleted = 0;

    for (const put of input.puts) {
      const rel = safeRel(put.rel);
      if (!rel || typeof put.handle !== 'string') continue; // junk in a validated batch: drop it
      if (typeof put.size !== 'number' || typeof put.mtimeMs !== 'number') continue;
      const staged = await resolveUploadHandle(put.handle);
      if (!staged) {
        failed.push(rel);
        continue;
      }
      const target = join(root, rel);
      await mkdir(dirname(target), { recursive: true });
      try {
        await rename(staged, target);
      } catch {
        // quiet: cross-device staging (STEM_UPLOADS_DIR on another volume) is the
        // one expected cause, and the copy below either works or throws for real.
        await copyFile(staged, target);
      }
      // The staged upload's uuid directory is spent — sweep it now rather than
      // letting the TTL find an empty shell.
      // quiet: a directory that will not delete is one the age sweep collects.
      await rm(dirname(staged), { recursive: true, force: true }).catch(() => undefined);
      manifest.files[rel] = { size: put.size, mtimeMs: put.mtimeMs };
      applied++;
    }

    for (const raw of input.deletes) {
      const rel = safeRel(raw);
      if (!rel) continue;
      await rm(join(root, rel), { force: true }).catch((error) => {
        // A rel that will not delete stays in the manifest, so the next diff
        // names it again instead of the mirror silently keeping a ghost.
        log('mirror', 'could not remove a mirrored file', { folderId, rel, error: String(error) });
      });
      if (rel in manifest.files) {
        delete manifest.files[rel];
        deleted++;
      }
      await pruneEmptyDirs(root, rel);
    }

    await writeManifest(folderId, manifest);
    if (applied || deleted) log('mirror', 'applied a sync batch', { folderId, applied, deleted, failed: failed.length });
    return { applied, deleted, failed };
  });
}

/** Remove now-empty directories from `rel`'s parent up to (never including) the root. */
async function pruneEmptyDirs(root: string, rel: string): Promise<void> {
  let dir = dirname(join(root, rel));
  while (dir !== root && dir.startsWith(root)) {
    try {
      await rmdir(dir); // refuses non-empty, which is the loop's exit
    } catch {
      // quiet: ENOTEMPTY/ENOENT is the expected way this loop ends.
      return;
    }
    dir = dirname(dir);
  }
}

/** Store the owning device's skipped-files report (bounded; replaces the last one). */
export function recordMirrorSkipped(folderId: string, skipped: { rel: string; reason: string }[]): Promise<void> {
  return enqueue(folderId, async () => {
    const manifest = await readManifest(folderId);
    manifest.skipped = skipped
      .filter((s) => !!safeRel(s.rel) && typeof s.reason === 'string')
      .slice(0, MAX_SKIPPED_ENTRIES)
      .map((s) => ({ rel: s.rel, reason: s.reason.slice(0, 200) }));
    await writeManifest(folderId, manifest);
  });
}

/** The stored skipped-files report (for the Folders tab and skippedCount). */
export async function readMirrorSkipped(folderId: string): Promise<{ rel: string; reason: string }[]> {
  return (await readManifest(folderId)).skipped;
}
