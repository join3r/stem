import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { host } from '../../server/host';
import { log } from '../../server/log';

// Whether THIS machine runs coding agents for its Stem server. Same design
// sentence as exec-host/store.ts: one boolean, one file on this disk that
// never goes on the wire, read fresh before anything spawns, off until the
// person at this computer says otherwise here. `harnessHost:setEnabled` is a
// client-owned channel only a window on this machine can call.

interface StoredHarnessHost {
  version: 1;
  enabled?: boolean;
}

export function harnessHostStorePath(): string {
  // Overridable for tests, exactly as STEM_EXEC_HOST_FILE is next door.
  return process.env.STEM_HARNESS_HOST_FILE ?? join(host().stateRoot(), 'harness-host.json');
}

/** The switch, read fresh — absent or unreadable both mean the safe answer: off. */
export async function readHarnessHostEnabled(): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(harnessHostStorePath(), 'utf8')) as StoredHarnessHost;
    return parsed?.enabled === true;
  } catch {
    return false;
  }
}

export async function writeHarnessHostEnabled(enabled: boolean): Promise<void> {
  const path = harnessHostStorePath();
  // quiet: mkdir of an existing state root; the write below reports its own failure.
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const doc: StoredHarnessHost = { version: 1, enabled };
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // quiet: mode on create covers the common case; a chmod refused on an exotic
  // filesystem leaves a boolean readable, not a credential.
  await chmod(path, 0o600).catch(() => undefined);
  log('harness-host', enabled ? 'this computer now runs coding agents' : 'this computer stopped running coding agents');
}
