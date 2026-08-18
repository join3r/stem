// Bytes a client sent us, waiting for something to use them.
//
// `TurnAttachment.path` and the paths `files:add` takes are the CLIENT's paths.
// That was always fine while there was only ever one machine, and it is wrong the
// moment the server is a container on a VPS: the server would readFile a path
// that, over there, is either missing or — worse — somebody else's file of the
// same name. So a remote client streams the bytes to POST /upload first and
// passes back a HANDLE, which the same two call sites resolve through this file.
//
// A handle is `stem-upload:<uuid>`, and the uuid is a directory holding exactly
// one file under its original basename. Two consequences, both deliberate: the
// name survives the round trip (so `files:add` still lands `cake.pdf` and not
// `a1b2c3`), and resolving a handle is a directory read with nothing to parse —
// the uuid is checked against a fixed shape, so no handle a client invents can
// name a path outside this root.
//
// Nothing here consumes a handle. Staged bytes are removed by AGE and nothing
// else (see sweepStagedUploads): a turn can be retried, an upload can be
// abandoned half way, and a store where "it worked the first time" is the whole
// difference is a store that fails in the least reproducible way possible. The
// cost is that an abandoned upload occupies disk until the sweep catches it,
// which is what the TTL is for.

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { log } from '../log';
import { uploadStagingRoot } from '../workspace/paths';

/** Every handle starts with this, which is also how a path is told from one. */
const HANDLE_PREFIX = 'stem-upload:';

/** A v4 uuid and nothing else — the entire defence against a crafted handle. */
const HANDLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * How long staged bytes survive without being claimed. Generous on purpose: it
 * has to outlast a slow turn, a retry, and a user who dropped a file and then
 * went to make coffee before pressing send. Short enough that a day of dropped
 * uploads is not a day of disk.
 */
export const STAGED_TTL_MS = 60 * 60_000;

/** How often the sweep runs while the server is up. */
const SWEEP_INTERVAL_MS = 10 * 60_000;

/** What POST /upload answers with. */
export interface UploadReceipt {
  /** Pass this where a path would have gone. */
  handle: string;
  /** The name it was stored under, after sanitising. */
  name: string;
  /** Bytes actually written. */
  size: number;
}

/**
 * The name a staged file is stored under. Reduced to a basename because the only
 * thing a client is entitled to choose here is what the file is CALLED — an
 * upload must never decide where it lands. Dotted and empty names fall back to a
 * placeholder rather than producing a hidden or nameless file.
 */
function safeName(name: string): string {
  const base = basename(String(name ?? '').replace(/\\/g, '/').trim());
  if (!base || base === '.' || base === '..' || base.startsWith('.')) return 'upload';
  return base.slice(0, 200);
}

/** True when `value` names staged bytes rather than a path on this machine. */
export function isUploadHandle(value: string): boolean {
  return typeof value === 'string' && value.startsWith(HANDLE_PREFIX);
}

/**
 * Write `body` into the staging area and return the handle for it. Any failure
 * (including the transport cutting an over-long body off) takes the half-written
 * directory with it, so a failed upload leaves nothing behind for the sweep to
 * find later.
 */
export async function stageUpload(name: string, body: Readable): Promise<UploadReceipt> {
  const id = randomUUID();
  const dir = join(uploadStagingRoot(), id);
  const stored = safeName(name);
  await mkdir(dir, { recursive: true });
  const target = join(dir, stored);
  try {
    await pipeline(body, createWriteStream(target));
  } catch (e) {
    // quiet: the upload's own failure is thrown on the next line, and a directory
    // that will not delete is one the age sweep collects.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  const size = await stat(target).then((s) => s.size, () => 0);
  log('uploads', 'staged an upload', { name: stored, size });
  return { handle: `${HANDLE_PREFIX}${id}`, name: stored, size };
}

/**
 * The absolute path of the file a handle stands for, or null when the handle is
 * malformed, expired or was never real. Callers treat null exactly as they treat
 * an unreadable path, which is what keeps this from needing its own error shape.
 */
export async function resolveUploadHandle(handle: string): Promise<string | null> {
  if (!isUploadHandle(handle)) return null;
  const id = handle.slice(HANDLE_PREFIX.length);
  // The id goes straight into a path, so it is checked against a shape that
  // cannot contain a separator, a dot segment, or anything else.
  if (!HANDLE_ID.test(id)) return null;
  const dir = join(uploadStagingRoot(), id);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const file = entries.find((e) => e.isFile());
    return file ? join(dir, file.name) : null;
  } catch {
    // quiet: the contract above is that a handle naming nothing readable answers
    // null, which callers already treat like any unreadable path.
    return null;
  }
}

/**
 * Delete staged uploads older than the TTL. Returns how many went, so a caller
 * (or a test) can see it did something. Errors on one entry never stop the rest:
 * a sweep that gives up on the first surprise is a sweep that stops running.
 */
export async function sweepStagedUploads(now = Date.now()): Promise<number> {
  const root = uploadStagingRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0; // quiet: nothing has ever been uploaded here
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !HANDLE_ID.test(entry.name)) continue;
    const dir = join(root, entry.name);
    try {
      const { mtimeMs } = await stat(dir);
      if (now - mtimeMs < STAGED_TTL_MS) continue;
      await rm(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // quiet: gone already, or unreadable. Either way the next sweep can have it.
    }
  }
  if (removed) log('uploads', 'swept staged uploads', { removed });
  return removed;
}

let sweeper: NodeJS.Timeout | null = null;

/**
 * Start sweeping, and sweep once now — the once matters more than the timer,
 * because the uploads most likely to be orphaned are the ones whose server was
 * killed mid-turn, and it is the next boot that has to clean up after that.
 */
export function startStagingSweeper(): void {
  if (sweeper) return;
  // quiet: the sweep swallows and explains its own per-entry failures already, so
  // a rejection out here is the staging root itself being unreadable — and the
  // cost of that is bytes waiting for the next pass.
  void sweepStagedUploads().catch(() => undefined);
  // quiet: the same, ten minutes at a time.
  sweeper = setInterval(() => void sweepStagedUploads().catch(() => undefined), SWEEP_INTERVAL_MS);
  // Never hold the process open for housekeeping.
  sweeper.unref?.();
}

export function stopStagingSweeper(): void {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
}
