import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ConnectedFolder, ConnectedFolderPatch } from '../../shared/types';
import { degrade } from '../degrade';
import { deviceKind, readDevices } from '../transport/auth';
import { connectedFoldersStorePath, mirrorManifestPath, mirrorRoot, piHome, protectedRootsPath } from './paths';

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
  const origin =
    r.origin && typeof r.origin === 'object' &&
    typeof r.origin.deviceId === 'string' && r.origin.deviceId &&
    typeof r.origin.clientPath === 'string' && r.origin.clientPath
      ? { deviceId: r.origin.deviceId, clientPath: r.origin.clientPath }
      : null;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : randomUUID(),
    path: r.path,
    label: typeof r.label === 'string' && r.label ? r.label : basename(r.path) || r.path,
    mode: r.mode === 'readwrite' ? 'readwrite' : 'read',
    memorize: r.memorize !== false, // default true
    ...(typeof r.note === 'string' && r.note ? { note: r.note } : {}),
    ...(r.index === true ? { index: true } : {}), // default off
    // Only non-default modes are persisted; absent = 'use' (learn on use).
    ...(r.learnMode === 'off' || r.learnMode === 'new' || r.learnMode === 'all' ? { learnMode: r.learnMode } : {}),
    ...(typeof r.learnModel === 'string' && r.learnModel ? { learnModel: r.learnModel } : {}),
    ...(origin ? { origin } : {}),
    ...(typeof r.lastSyncedAt === 'string' && r.lastSyncedAt ? { lastSyncedAt: r.lastSyncedAt } : {}),
    ...(r.rootMissing === true ? { rootMissing: true } : {})
  };
}

/**
 * Whether `label` (case-insensitive) is already the label of another folder.
 * Labels are the assistant's and the user's handle on a folder, and two folders
 * answering to one name is exactly the ambiguity client folders make worse
 * ("notes" here vs "notes" on the MacBook) — so the registry keeps them unique.
 */
function labelInUse(folders: ConnectedFolder[], label: string, exceptId?: string): boolean {
  const wanted = label.trim().toLowerCase();
  return folders.some((f) => f.id !== exceptId && f.label.trim().toLowerCase() === wanted);
}

/** `base` if free, else the first free `base-2`, `base-3`, … */
function freeLabel(folders: ConnectedFolder[], base: string): string {
  if (!labelInUse(folders, base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!labelInUse(folders, candidate)) return candidate;
  }
}

/** Last path segment of a path from ANOTHER machine (may use either separator). */
function clientBasename(p: string): string {
  const segments = p.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? p;
}

/**
 * The learn mode actually in force for a folder: the stored mode (absent =
 * 'use'), forced to 'off' unless the folder is both indexed and memorize —
 * learning reads the index, and private content must never feed facts.
 */
export function effectiveLearnMode(f: ConnectedFolder): 'off' | 'use' | 'new' | 'all' {
  if (!f.index || !f.memorize) return 'off';
  return f.learnMode ?? 'use';
}

async function loadStore(): Promise<ConnectedFoldersStore> {
  const parsed = JSON.parse(await readFile(connectedFoldersStorePath(), 'utf8')) as Partial<ConnectedFoldersStore>;
  const folders = Array.isArray(parsed.folders) ? parsed.folders.map(coerce).filter((f): f is ConnectedFolder => !!f) : [];
  return { version: 1, folders };
}

export async function readStore(): Promise<ConnectedFoldersStore> {
  try {
    return await loadStore();
  } catch (error) {
    // Present but unreadable: every connected folder disappears from the Folders
    // tab and the assistant stops reading paths nobody told it to stop reading.
    // Survivable for a reader — the registry is still on disk and the next launch
    // shows it again. (Absent is the ordinary case, nothing connected yet.)
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('folders', 'started from an empty connected-folders store', error);
    }
    return emptyStore();
  }
}

/**
 * The read half of {@link update}, where the forgiving version is what makes the
 * loss permanent: the empty registry is written straight back, and the
 * protected-roots gate is then republished from it — so the folders vanish AND
 * the read-only protection on them goes with it. Absent is still "nothing
 * connected yet"; anything else refuses.
 */
async function readForUpdate(): Promise<ConnectedFoldersStore> {
  try {
    return await loadStore();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyStore();
    degrade('folders', 'refused to write the folder registry over a file it could not read', error);
    throw error;
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
    const store = await readForUpdate();
    const result = mutate(store);
    await writeStore(store);
    await publishProtectedRoots(store).catch((error) => {
      // The registry is written, so the Folders tab shows the new mode — but the
      // gate the bridge actually reads still holds the previous roots, and a
      // folder just switched to read-only stays writable to the assistant until
      // something publishes it again (the next mutation, or the next startup).
      degrade('folders', 'left the write-protection gate on the previous folders', error);
    });
    return result;
  });
}

/** Normalize a path to its real (symlink-resolved) absolute form; fall back to the input. */
async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    // quiet: a path that will not resolve is stored as it was given, and the next
    // listing flags it missing — which is what the user needs to see anyway.
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
        // The user picked a path, not a name — a basename collision is resolved
        // here (notes → notes-2) instead of failing the add. Chosen labels
        // (rename, client folders) collide loudly instead; see updateConnectedFolder.
        label: freeLabel(store.folders, basename(path) || path),
        mode: 'read',
        memorize: true
      });
    }
    return store.folders;
  });
}

/**
 * Register a folder that lives on a paired desktop. The mirror directory this
 * side is created first and becomes the folder's `path`, so indexing, injection
 * and the protected-roots gate treat it like any other connected folder; where
 * it really lives is kept in `origin`. Called by `cfolders:addClient` with the
 * CALLER's device id — the client that owns the folder is the only one that can
 * connect it, which is also what keeps its own mirror list authoritative.
 */
export async function addClientFolder(input: {
  deviceId: string;
  clientPath: string;
  label?: string;
}): Promise<ConnectedFolder[]> {
  const clientPath = input.clientPath.trim();
  // An absolute path on SOME machine — never resolved here (it is not this disk).
  if (!/^([/\\]|[A-Za-z]:[/\\])/.test(clientPath)) {
    throw new Error('A client folder needs the absolute path of the folder on that computer.');
  }
  const device = (await readDevices()).find((d) => d.id === input.deviceId);
  if (!device) throw new Error('That computer is not paired with this Stem.');
  if (deviceKind(device) !== 'desktop') {
    throw new Error(`“${device.label}” is a phone, and folders can only be mirrored from computers.`);
  }
  const id = randomUUID();
  await mkdir(mirrorRoot(id), { recursive: true });
  let added = false;
  try {
    const folders = await update((store) => {
      const existing = store.folders.find(
        (f) => f.origin?.deviceId === input.deviceId && f.origin.clientPath === clientPath
      );
      if (existing) return store.folders; // already connected; leave it untouched
      const wanted = input.label?.trim();
      if (wanted && labelInUse(store.folders, wanted)) {
        throw new Error(
          `A connected folder is already called “${wanted}” — try “${freeLabel(store.folders, wanted)}”.`
        );
      }
      store.folders.push({
        id,
        path: mirrorRoot(id),
        label: wanted || freeLabel(store.folders, clientBasename(clientPath)),
        mode: 'read',
        memorize: true,
        origin: { deviceId: input.deviceId, clientPath }
      });
      added = true;
      return store.folders;
    });
    return folders;
  } finally {
    // The dedupe and label checks live inside the serialized mutate, so the
    // mirror directory is made optimistically — take it back when nothing was
    // registered, or `mirrors/` accumulates unowned empties.
    // quiet: an empty directory that would not delete costs nothing and owns nothing.
    if (!added) await rm(mirrorRoot(id), { recursive: true, force: true }).catch(() => undefined);
  }
}

export function updateConnectedFolder(id: string, patch: ConnectedFolderPatch): Promise<ConnectedFolder[]> {
  return update((store) => {
    const f = store.folders.find((x) => x.id === id);
    if (f) {
      if (typeof patch.label === 'string') {
        const label = patch.label.trim();
        if (label && labelInUse(store.folders, label, id)) {
          throw new Error(
            `A connected folder is already called “${label}” — try “${freeLabel(store.folders, label)}”.`
          );
        }
        f.label = label || f.label;
      }
      if (patch.mode === 'read' || patch.mode === 'readwrite') f.mode = patch.mode;
      if (typeof patch.memorize === 'boolean') f.memorize = patch.memorize;
      if (typeof patch.index === 'boolean') {
        if (patch.index) f.index = true;
        else delete f.index;
      }
      if (typeof patch.note === 'string') {
        const note = patch.note.trim();
        if (note) f.note = note;
        else delete f.note;
      }
      if (patch.learnMode === 'off' || patch.learnMode === 'use' || patch.learnMode === 'new' || patch.learnMode === 'all') {
        if (patch.learnMode === 'use') delete f.learnMode; // 'use' is the absent default
        else f.learnMode = patch.learnMode;
      }
      if (typeof patch.learnModel === 'string') {
        const model = patch.learnModel.trim();
        if (model) f.learnModel = model;
        else delete f.learnModel; // empty = back to the memory default
      }
    }
    return store.folders;
  });
}

export async function removeConnectedFolder(id: string): Promise<ConnectedFolder[]> {
  let removed: ConnectedFolder | undefined;
  const folders = await update((store) => {
    removed = store.folders.find((f) => f.id === id);
    store.folders = store.folders.filter((f) => f.id !== id);
    return store.folders;
  });
  // A client folder's mirror is Stem's own copy — disconnecting deletes it (and
  // its manifest), exactly like the index. The real folder on the device is
  // never touched; reconnecting simply re-syncs.
  if (removed?.origin) {
    await rm(mirrorRoot(id), { recursive: true, force: true }).catch((error) => {
      degrade('folders', 'left a disconnected folder’s mirror directory behind', error);
    });
    // quiet: bookkeeping for a mirror that is already gone; a leftover manifest is inert.
    await rm(mirrorManifestPath(id), { force: true }).catch(() => undefined);
  }
  return folders;
}

/** The client folders that live on `deviceId` (what mirror:hello answers from). */
export async function clientFoldersForDevice(deviceId: string): Promise<ConnectedFolder[]> {
  const { folders } = await readStore();
  return folders.filter((f) => f.origin?.deviceId === deviceId);
}

/** Stamp a completed sync round: lastSyncedAt now, any root-missing freeze lifted. */
export function recordFolderSynced(id: string, at: string): Promise<void> {
  return update((store) => {
    const f = store.folders.find((x) => x.id === id);
    if (!f) return;
    f.lastSyncedAt = at;
    delete f.rootMissing;
  });
}

/** The owning device reported its folder root gone (or back). */
export function setFolderRootMissing(id: string, missing: boolean): Promise<void> {
  return update((store) => {
    const f = store.folders.find((x) => x.id === id);
    if (!f) return;
    if (missing) f.rootMissing = true;
    else delete f.rootMissing;
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
  // A client folder's mirror is in the gate UNCONDITIONALLY, whatever its mode:
  // the client is the single source of truth and nothing on this machine may
  // ever make the mirror diverge. 'readwrite' on a client folder means the
  // assistant may modify the folder ON THE DEVICE (device-targeted commands
  // against origin.clientPath) — never the mirror.
  const roots = await Promise.all(
    store.folders.filter((f) => f.mode === 'read' || f.origin).map((f) => canonical(f.path))
  );
  await mkdir(piHome(), { recursive: true });
  // Atomic: the bridge reads this mid-turn, and a half-written file must never
  // exist — its gate fails closed (keeps the previous roots) on a corrupt read,
  // so a torn write here would freeze protection on a stale set.
  const path = protectedRootsPath();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ roots }, null, 2), 'utf8');
  await rename(tmp, path);
}

/** Publish the protected-roots gate from the current store (idempotent; for startup). */
export async function publishProtectedRootsNow(): Promise<void> {
  await publishProtectedRoots(await readStore());
}
