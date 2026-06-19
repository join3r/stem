import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { Folder } from '../../shared/types';
import { chatStorePath } from './paths';

// The Stem-owned chat-organization store. Codex owns the chats (threads); this
// file holds only what codex can't: the user's folder tree and which folder each
// chat sits in. Kept deliberately tiny and resilient — a corrupt/missing file
// degrades to "no folders, everything at root" rather than breaking the app.

interface ChatStore {
  version: 1;
  folders: Folder[];
  /** threadId -> folderId. Absent / dangling entries mean "root". */
  assignments: Record<string, string>;
}

function emptyStore(): ChatStore {
  return { version: 1, folders: [], assignments: {} };
}

export async function readStore(): Promise<ChatStore> {
  try {
    const parsed = JSON.parse(await readFile(chatStorePath(), 'utf8')) as Partial<ChatStore>;
    return {
      version: 1,
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
      assignments: parsed.assignments && typeof parsed.assignments === 'object' ? parsed.assignments : {}
    };
  } catch {
    return emptyStore();
  }
}

// Serialize writes through a promise chain so concurrent IPC calls can't
// interleave a read-modify-write and lose updates.
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  // Keep the chain alive regardless of individual task outcome.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeStore(store: ChatStore): Promise<void> {
  const path = chatStorePath();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  // rename is atomic on the same volume — readers never see a half-written file.
  await rename(tmp, path);
}

/** Read, mutate, persist atomically. All public mutators funnel through here. */
function update<T>(mutate: (store: ChatStore) => T): Promise<T> {
  return enqueue(async () => {
    const store = await readStore();
    const result = mutate(store);
    await writeStore(store);
    return result;
  });
}

// ---- folder-tree helpers ----

/** Collect a folder plus every descendant id (for cycle checks / cleanup). */
function descendantIds(folders: Folder[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  return ids;
}

function nextOrder(folders: Folder[], parentId: string | null): number {
  const siblings = folders.filter((f) => f.parentId === parentId);
  return siblings.reduce((max, f) => Math.max(max, f.order), -1) + 1;
}

// ---- public API ----

export async function listFolders(): Promise<Folder[]> {
  return (await readStore()).folders;
}

export async function getAssignments(): Promise<Record<string, string>> {
  return (await readStore()).assignments;
}

export function createFolder(name: string, parentId: string | null): Promise<Folder[]> {
  return update((store) => {
    const validParent = parentId && store.folders.some((f) => f.id === parentId) ? parentId : null;
    store.folders.push({
      id: randomUUID(),
      name: name.trim() || 'New folder',
      parentId: validParent,
      order: nextOrder(store.folders, validParent)
    });
    return store.folders;
  });
}

export function renameFolder(folderId: string, name: string): Promise<Folder[]> {
  return update((store) => {
    const folder = store.folders.find((f) => f.id === folderId);
    if (folder) folder.name = name.trim() || folder.name;
    return store.folders;
  });
}

/** Reparent a folder. Rejects cycles (new parent can't be the folder or a descendant). */
export function moveFolder(folderId: string, parentId: string | null): Promise<Folder[]> {
  return update((store) => {
    const folder = store.folders.find((f) => f.id === folderId);
    if (!folder) return store.folders;
    if (parentId !== null) {
      if (!store.folders.some((f) => f.id === parentId)) return store.folders;
      if (descendantIds(store.folders, folderId).has(parentId)) return store.folders; // cycle
    }
    folder.parentId = parentId;
    folder.order = nextOrder(store.folders.filter((f) => f.id !== folderId), parentId);
    return store.folders;
  });
}

/**
 * Delete a folder, reparenting its child folders and its chats to the deleted
 * folder's own parent (so nothing is orphaned and no chat silently disappears).
 */
export function deleteFolder(folderId: string): Promise<Folder[]> {
  return update((store) => {
    const folder = store.folders.find((f) => f.id === folderId);
    if (!folder) return store.folders;
    const newParent = folder.parentId;
    for (const child of store.folders) {
      if (child.parentId === folderId) child.parentId = newParent;
    }
    for (const [threadId, assigned] of Object.entries(store.assignments)) {
      if (assigned === folderId) {
        if (newParent) store.assignments[threadId] = newParent;
        else delete store.assignments[threadId];
      }
    }
    store.folders = store.folders.filter((f) => f.id !== folderId);
    return store.folders;
  });
}

/** Assign a chat to a folder (or to root with `null`). */
export function setChatFolder(threadId: string, folderId: string | null): Promise<void> {
  return update((store) => {
    if (folderId === null || !store.folders.some((f) => f.id === folderId)) {
      delete store.assignments[threadId];
    } else {
      store.assignments[threadId] = folderId;
    }
  });
}

/** Drop a chat's assignment when the chat itself is deleted. */
export function removeChat(threadId: string): Promise<void> {
  return update((store) => {
    delete store.assignments[threadId];
  });
}
