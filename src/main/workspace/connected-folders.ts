import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ConnectedFolder, ConnectedFolderPatch } from '../../shared/types';
import { connectedFoldersStorePath, piHome, protectedRootsPath } from './paths';

// The Stem-owned registry of external "connected folders" the assistant may read
// in place (an Obsidian vault, a financials folder, …). The folders themselves
// stay where they live on disk — this file only records absolute paths plus each
// folder's write mode and memorize flag. Kept tiny and resilient like the chat
// store (chats.ts): a corrupt/missing file degrades to "no connected folders"
// rather than breaking the app.

interface ConnectedFoldersStore {
  version: 1;
  folders: ConnectedFolder[];
}

function emptyStore(): ConnectedFoldersStore {
  return { version: 1, folders: [] };
}

/** Coerce one parsed entry into a valid ConnectedFolder, or null to drop it. */
function coerce(raw: unknown): ConnectedFolder | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ConnectedFolder>;
  if (typeof r.path !== 'string' || !r.path) return null;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : randomUUID(),
    path: r.path,
    label: typeof r.label === 'string' && r.label ? r.label : basename(r.path) || r.path,
    mode: r.mode === 'readwrite' ? 'readwrite' : 'read',
    memorize: r.memorize !== false, // default true
    ...(typeof r.note === 'string' && r.note ? { note: r.note } : {})
  };
}

export async function readStore(): Promise<ConnectedFoldersStore> {
  try {
    const parsed = JSON.parse(await readFile(connectedFoldersStorePath(), 'utf8')) as Partial<ConnectedFoldersStore>;
    const folders = Array.isArray(parsed.folders) ? parsed.folders.map(coerce).filter((f): f is ConnectedFolder => !!f) : [];
    return { version: 1, folders };
  } catch {
    return emptyStore();
  }
}

// Serialize writes through a promise chain so concurrent IPC calls can't
// interleave a read-modify-write and lose updates (mirrors chats.ts).
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeStore(store: ConnectedFoldersStore): Promise<void> {
  const path = connectedFoldersStorePath();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await rename(tmp, path); // atomic on the same volume
}

/** Read, mutate, persist atomically, then re-publish the protected-roots gate. */
function update<T>(mutate: (store: ConnectedFoldersStore) => T): Promise<T> {
  return enqueue(async () => {
    const store = await readStore();
    const result = mutate(store);
    await writeStore(store);
    await publishProtectedRoots(store).catch(() => undefined);
    return result;
  });
}

/** Normalize a path to its real (symlink-resolved) absolute form; fall back to the input. */
async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

// ---- public API ----

/** List connected folders, flagging any whose path no longer exists on disk. */
export async function listConnectedFolders(): Promise<ConnectedFolder[]> {
  const { folders } = await readStore();
  return Promise.all(
    folders.map(async (f) => {
      const missing = await stat(f.path).then((s) => !s.isDirectory(), () => true);
      return missing ? { ...f, missing: true } : f;
    })
  );
}

/**
 * Register external folders by absolute path. Each path is canonicalized and
 * deduped (a folder already connected is left untouched). New folders default to
 * read-only + memorize-on; the user adjusts those in the Folders tab.
 */
export async function addConnectedFolders(paths: string[]): Promise<ConnectedFolder[]> {
  const resolved = await Promise.all(paths.filter(Boolean).map(canonical));
  return update((store) => {
    for (const path of resolved) {
      if (store.folders.some((f) => f.path === path)) continue;
      store.folders.push({
        id: randomUUID(),
        path,
        label: basename(path) || path,
        mode: 'read',
        memorize: true
      });
    }
    return store.folders;
  });
}

export function updateConnectedFolder(id: string, patch: ConnectedFolderPatch): Promise<ConnectedFolder[]> {
  return update((store) => {
    const f = store.folders.find((x) => x.id === id);
    if (f) {
      if (typeof patch.label === 'string') f.label = patch.label.trim() || f.label;
      if (patch.mode === 'read' || patch.mode === 'readwrite') f.mode = patch.mode;
      if (typeof patch.memorize === 'boolean') f.memorize = patch.memorize;
      if (typeof patch.note === 'string') {
        const note = patch.note.trim();
        if (note) f.note = note;
        else delete f.note;
      }
    }
    return store.folders;
  });
}

export function removeConnectedFolder(id: string): Promise<ConnectedFolder[]> {
  return update((store) => {
    store.folders = store.folders.filter((f) => f.id !== id);
    return store.folders;
  });
}

/** Absolute path of a connected folder by id, or null if unknown. */
export async function connectedFolderPath(id: string): Promise<string | null> {
  const { folders } = await readStore();
  return folders.find((f) => f.id === id)?.path ?? null;
}

/**
 * Canonical absolute paths of folders connected as memorize:false — the roots the
 * runtime taints a turn against so content read from them stays out of Recall.
 */
export async function getPrivateRoots(): Promise<string[]> {
  const { folders } = await readStore();
  return Promise.all(folders.filter((f) => !f.memorize).map((f) => canonical(f.path)));
}

/**
 * Write the protected-roots gate (read-only folders' absolute paths) the bridge
 * extension reads to block writes/edits inside them. Called on every registry
 * mutation and once at startup (see publishProtectedRootsNow).
 */
async function publishProtectedRoots(store: ConnectedFoldersStore): Promise<void> {
  const roots = await Promise.all(store.folders.filter((f) => f.mode === 'read').map((f) => canonical(f.path)));
  await mkdir(piHome(), { recursive: true });
  await writeFile(protectedRootsPath(), JSON.stringify({ roots }, null, 2), 'utf8');
}

/** Publish the protected-roots gate from the current store (idempotent; for startup). */
export async function publishProtectedRootsNow(): Promise<void> {
  await publishProtectedRoots(await readStore());
}
