import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { host } from '../../server/host';
import { log } from '../../server/log';

// Whether THIS Mac lets its Stem server drive its browser, and which browser.
// Same design sentence as computer-host/store.ts: it lives on this disk and
// never goes on the wire — the machine whose browser would be driven holds the
// decision. Off by default; only a window on this machine can flip it.

export interface KnownBrowser {
  /** The app bundle the native host was launched from ("/Applications/Arc.app"). */
  id: string;
  name: string;
}

export interface BrowserHostSettings {
  enabled: boolean;
  /** The browser Stem uses here; absent = the first one that connects. */
  chosen?: string;
  /** Every browser whose extension has connected here, so a closed one can be launched. */
  known: KnownBrowser[];
}

interface Stored extends Partial<BrowserHostSettings> {
  version: 1;
}

export function browserHostStorePath(): string {
  return process.env.STEM_BROWSER_HOST_FILE ?? join(host().stateRoot(), 'browser-host.json');
}

/** Read fresh — absent or unreadable both mean the safe answer: off, nothing known. */
export async function readBrowserHostSettings(): Promise<BrowserHostSettings> {
  try {
    const parsed = JSON.parse(await readFile(browserHostStorePath(), 'utf8')) as Stored;
    const known = Array.isArray(parsed?.known)
      ? parsed.known.filter(
          (b): b is KnownBrowser => !!b && typeof b.id === 'string' && !!b.id && typeof b.name === 'string'
        )
      : [];
    return {
      enabled: parsed?.enabled === true,
      ...(typeof parsed?.chosen === 'string' && parsed.chosen ? { chosen: parsed.chosen } : {}),
      known
    };
  } catch {
    return { enabled: false, known: [] };
  }
}

/** Serialised so a connect and a click on the switch cannot interleave their read-modify-writes. */
let tail: Promise<unknown> = Promise.resolve();

export function updateBrowserHostSettings(
  patch: (cur: BrowserHostSettings) => BrowserHostSettings
): Promise<BrowserHostSettings> {
  const work = async (): Promise<BrowserHostSettings> => {
    const next = patch(await readBrowserHostSettings());
    const path = browserHostStorePath();
    await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
    const doc: Stored = { version: 1, ...next };
    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
    return next;
  };
  const next = tail.then(work, work);
  // quiet: the rejection reaches the caller through `next`; this copy only keeps
  // one failed write from poisoning the updates queued behind it.
  tail = next.catch(() => undefined);
  return next;
}

export async function writeBrowserHostEnabled(enabled: boolean): Promise<BrowserHostSettings> {
  const next = await updateBrowserHostSettings((cur) => ({ ...cur, enabled }));
  log(
    'browser-host',
    enabled ? 'this Mac now lets Stem drive its browser' : 'this Mac stopped letting Stem drive its browser'
  );
  return next;
}
