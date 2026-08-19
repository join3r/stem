import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { host } from '../../server/host';

// The machine-local list of folders THIS computer mirrors up to its Stem
// server. It is the authority over what leaves this disk: the sync engine
// reads and uploads exclusively paths on this list, written here when the
// person at this machine picked the folder in a native dialog. The server's
// registry coordinates — it never commands. A compromised server can invent
// any entry it likes over there and this machine will not read a byte for it
// (the mcp-approvals/exec-host posture, applied to folders).
//
// `mode` is the one field that IS taken from the server: it is the user's
// Writable toggle, flipped in the Folders tab of any of their clients, and it
// is cached here so the exec host can refuse writes into read-only mirrored
// folders without a round trip (see exec-host guard, step 4).

export interface MirroredFolder {
  folderId: string;
  clientPath: string;
  mode: 'read' | 'readwrite';
}

interface MirrorStoreDoc {
  version: 1;
  folders: MirroredFolder[];
}

function storePath(): string {
  // STEM_MIRRORS_FILE lets unit tests point at a throwaway file, like its
  // neighbours (client.json, mcp-approvals.json, exec-host.json).
  return process.env.STEM_MIRRORS_FILE ?? join(host().stateRoot(), 'mirrors.json');
}

function coerce(raw: unknown): MirroredFolder[] {
  const doc = raw as Partial<MirrorStoreDoc> | null;
  if (!doc || !Array.isArray(doc.folders)) return [];
  const out: MirroredFolder[] = [];
  for (const f of doc.folders) {
    if (!f || typeof f !== 'object') continue;
    const { folderId, clientPath, mode } = f as Partial<MirroredFolder>;
    if (typeof folderId !== 'string' || !folderId) continue;
    if (typeof clientPath !== 'string' || !clientPath) continue;
    out.push({ folderId, clientPath, mode: mode === 'readwrite' ? 'readwrite' : 'read' });
  }
  return out;
}

// Serialized read-modify-write, like mcp-host/approvals.ts.
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function load(): Promise<MirroredFolder[]> {
  try {
    return coerce(JSON.parse(await readFile(storePath(), 'utf8')));
  } catch {
    // quiet: absent or unreadable = this machine mirrors nothing, which fails
    // safe — nothing is read or uploaded until the person adds a folder again.
    return [];
  }
}

/** Every folder this machine mirrors. */
export function readMirroredFolders(): Promise<MirroredFolder[]> {
  return enqueue(load);
}

/** Replace the list (add, prune, or refresh cached modes), atomically enough for one machine. */
export function writeMirroredFolders(folders: MirroredFolder[]): Promise<void> {
  return enqueue(async () => {
    const path = storePath();
    await mkdir(dirname(path), { recursive: true });
    const doc: MirrorStoreDoc = { version: 1, folders };
    await writeFile(path, JSON.stringify(doc, null, 2), { mode: 0o600 });
    // On an existing file writeFile's mode is ignored, so tighten explicitly
    // (the client-store/approvals pattern).
    await chmod(path, 0o600).catch(() => undefined); // quiet: best effort on exotic filesystems
  });
}
