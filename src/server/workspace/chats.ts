import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { Folder } from '../../shared/types';
import { degrade } from '../degrade';
import { chatStorePath } from './paths';

// The Stem-owned chat-organization store. The backend owns the chats (threads);
// this file holds only what it can't: the user's folder tree and which folder each
// chat sits in. Kept deliberately tiny and resilient — a corrupt/missing file
// degrades to "no folders, everything at root" rather than breaking the app.

interface ChatStore {
  version: 1;
  folders: Folder[];
  /** threadId -> folderId. Absent / dangling entries mean "root". */
  assignments: Record<string, string>;
  /**
   * threadId -> the subject a model wrote from the thread's conversation.
   * Kept here, next to the folder assignment, because it is thread metadata
   * rather than Inbox state: it has to survive Settings → Chat → Chats being turned
   * down from `everywhere` to `inbox`, and it must not be lost when the user
   * renames the thread by hand.
   */
  subjects: Record<string, string>;
  /** threadId -> where the thread has got to in its naming schedule. */
  naming: Record<string, NamingState>;
}

/**
 * A thread's place in the widening naming schedule (see server/chats/subject.ts):
 * `step` counts the namings that have happened, `since` the user turns since the
 * last one. Persisted rather than held in memory because the schedule has to
 * survive a restart — otherwise every reopened thread would start counting from
 * zero and re-name itself a few turns later, forever.
 */
export interface NamingState {
  step: number;
  since: number;
}

function emptyStore(): ChatStore {
  return { version: 1, folders: [], assignments: {}, subjects: {}, naming: {} };
}

/** Keep only string→string pairs; a hand-edited file can hold anything. */
function coerceMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string')
  );
}

/** Same idea as {@link coerceMap} for the naming records: drop anything that isn't two counters. */
function coerceNaming(raw: unknown): Record<string, NamingState> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, NamingState> = {};
  for (const [threadId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const { step, since } = value as Partial<NamingState>;
    if (!Number.isFinite(step) || !Number.isFinite(since)) continue;
    out[threadId] = { step: Math.max(0, Math.trunc(step as number)), since: Math.max(0, Math.trunc(since as number)) };
  }
  return out;
}

export async function readStore(): Promise<ChatStore> {
  try {
    const parsed = JSON.parse(await readFile(chatStorePath(), 'utf8')) as Partial<ChatStore>;
    return {
      version: 1,
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
      assignments: parsed.assignments && typeof parsed.assignments === 'object' ? parsed.assignments : {},
      subjects: coerceMap(parsed.subjects),
      naming: coerceNaming(parsed.naming)
    };
  } catch (error) {
    // Absent is the real fresh install. A file that is there and will not read is
    // indistinguishable from one, and the next update() writes this empty store
    // back over it — taking the folder tree, the subjects and every thread's
    // naming schedule with it.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('chats', 'started from an empty folder store', error);
    }
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

export async function getSubjects(): Promise<Record<string, string>> {
  return (await readStore()).subjects;
}

/** Record a written subject for a thread (empty string clears it). */
export function setSubject(threadId: string, subject: string): Promise<void> {
  return update((store) => {
    const text = subject.trim();
    if (text) store.subjects[threadId] = text;
    else delete store.subjects[threadId];
  });
}

/** Where a thread has got to in its naming schedule, or null if it has never been counted. */
export async function getNaming(threadId: string): Promise<NamingState | null> {
  return (await readStore()).naming[threadId] ?? null;
}

/** Record a thread's naming schedule position. */
export function setNaming(threadId: string, state: NamingState): Promise<void> {
  return update((store) => {
    store.naming[threadId] = { step: Math.max(0, state.step), since: Math.max(0, state.since) };
  });
}

/**
 * Count one settled turn against a thread's schedule and hand back where that
 * leaves it. `fallbackStep` is where a thread with no record joins — a thread
 * that predates the schedule has already been named once, and starting it at
 * step 0 would have it re-named from a single exchange.
 *
 * Read-modify-write in one enqueued task, so two turns settling at once can't
 * both read `since: 2` and lose an increment.
 */
export function bumpNaming(threadId: string, fallbackStep: number): Promise<NamingState> {
  return update((store) => {
    const prior = store.naming[threadId] ?? { step: fallbackStep, since: 0 };
    const next = { step: prior.step, since: prior.since + 1 };
    store.naming[threadId] = next;
    return next;
  });
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

/** Drop a chat's assignment, subject and naming schedule when the chat itself is deleted. */
export function removeChat(threadId: string): Promise<void> {
  return update((store) => {
    delete store.assignments[threadId];
    delete store.subjects[threadId];
    delete store.naming[threadId];
  });
}
