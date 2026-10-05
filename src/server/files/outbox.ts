import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { DownloadTarget } from '../transport/server';
import type { BrowserOutboxFile } from '../../shared/types';

// Files the server hands ONE paired device for ONE job — today, a browser
// upload: the model names a file Stem holds, the server checks it, and the Mac
// running the browser fetches the bytes before the extension attaches them to
// the page. They travel on the existing GET /files/ route under a prefix,
// because a control frame is the wrong place for megabytes (it would hold up
// every chat stream on that desktop) and native messaging caps what reaches
// the extension at 1 MB anyway.
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

function sweep(now: number): void {
  for (const [id, e] of entries) if (e.expires <= now) entries.delete(id);
}

/** Put an already-checked server file in `deviceId`'s outbox. */
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
    // The size at fetch time: the file was checked when it went in, but the
    // model may have rewritten it since, and content-length must be true.
    return { path: e.path, name: e.name, size: (await stat(e.path)).size };
  } catch {
    // quiet: gone since it was queued — the device is told "no such file" and
    // the extension reports the upload as failed.
    return null;
  }
}

/** Tests only. */
export function clearOutbox(): void {
  entries.clear();
}
