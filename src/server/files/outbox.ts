import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { DownloadTarget } from '../transport/server';
import { browserOutboxRoot } from '../workspace/paths';
import type { BrowserOutboxFile } from '../../shared/types';

// Files the server hands ONE paired device for ONE job — today, a browser
// upload: the model names a file Stem holds, the server checks it, and the Mac
// running the browser fetches the bytes before the extension attaches them to
// the page. They travel on the existing GET /files/ route under a prefix,
// because a control frame is the wrong place for megabytes (it would hold up
// every chat stream on that desktop) and native messaging caps what reaches
// the extension at 1 MB anyway.
//
// What is served is a SNAPSHOT in Stem's private outbox folder, copied from a
// file handle the check verified (files/browser-sources.ts) — never the
// original path. The original lives where the assistant can write, and a path
// checked now and opened by name later is a path a run_command can swap for a
// symlink in between; a copy taken through the verified handle cannot be.
//
// An entry is single-use, bound to the device it was made for, and gone after
// ten minutes. The id is 128 CSPRNG bits and is the whole authorization, on
// top of the device's own bearer token: the same argument as the requestIds on
// the device rails.

/** GET /files/<OUTBOX_PREFIX><id> is an outbox fetch, not a Files-panel path. */
export const OUTBOX_PREFIX = 'stem-outbox:';

const TTL_MS = 10 * 60_000;

interface Entry {
  deviceId: string;
  path: string;
  name: string;
  size: number;
  expires: number;
}

const entries = new Map<string, Entry>();
let rootReady: Promise<string> | null = null;

/** The outbox folder, emptied once per process: entries do not survive a restart, so neither do their copies. */
function outboxRoot(): Promise<string> {
  rootReady ??= (async () => {
    const root = browserOutboxRoot();
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true, mode: 0o700 });
    return root;
  })();
  return rootReady;
}

function forget(id: string, e: Entry): void {
  entries.delete(id);
  // quiet: an orphaned copy is swept with the folder on the next start.
  void rm(e.path, { force: true }).catch(() => undefined);
}

function sweep(now: number): void {
  for (const [id, e] of entries) if (e.expires <= now) forget(id, e);
}

async function snapshotPath(): Promise<string> {
  return join(await outboxRoot(), randomBytes(16).toString('hex'));
}

/** Copy what an already-verified handle reads into a private snapshot. */
export async function snapshotFromHandle(fh: FileHandle): Promise<{ path: string; size: number }> {
  const path = await snapshotPath();
  try {
    await pipeline(fh.createReadStream({ autoClose: false, start: 0 }), createWriteStream(path, { flags: 'wx', mode: 0o600 }));
  } catch (e) {
    await rm(path, { force: true }).catch(() => undefined);
    throw e;
  }
  return { path, size: (await lstat(path)).size };
}

/** The same for bytes already in memory (an attached image by its id). */
export async function snapshotFromBytes(bytes: Buffer): Promise<{ path: string; size: number }> {
  const path = await snapshotPath();
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  return { path, size: bytes.length };
}

/** Put a snapshot (from snapshotFrom*) in `deviceId`'s outbox. */
export function outboxPut(
  deviceId: string,
  file: { path: string; name: string; size: number },
  now = Date.now()
): BrowserOutboxFile {
  sweep(now);
  const id = randomBytes(16).toString('hex');
  entries.set(id, { deviceId, path: file.path, name: file.name, size: file.size, expires: now + TTL_MS });
  return { id, name: file.name, size: file.size };
}

/**
 * Hand an entry to the device it was made for, once. Null for an unknown,
 * expired or spent id, or the wrong device — the route answers all of them
 * with the same 404.
 */
export async function outboxTake(deviceId: string, id: string, now = Date.now()): Promise<DownloadTarget | null> {
  sweep(now);
  const e = entries.get(id);
  if (!e || e.deviceId !== deviceId) return null;
  entries.delete(id);
  try {
    const info = await lstat(e.path);
    if (!info.isFile()) return null;
    // The copy must outlive the response that streams it; the TTL is the
    // deadline for that, after which it goes like an unclaimed one.
    setTimeout(() => forget(id, e), TTL_MS).unref?.();
    return { path: e.path, name: e.name, size: info.size };
  } catch {
    // quiet: the copy is gone (the folder was swept) — the device is told "no
    // such file" and the extension reports the upload as failed.
    return null;
  }
}

/** Tests only. */
export function clearOutbox(): void {
  for (const [id, e] of [...entries]) forget(id, e);
}
