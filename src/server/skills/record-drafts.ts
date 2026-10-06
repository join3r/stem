import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RecordingDraft } from '../../shared/types';
import { userDataRoot } from '../workspace/paths';

// The draft skills recordings became, one card each in the chat that recorded
// them, until saved or discarded. Its own small file rather than a field on a
// chat message: a chat's messages are pi's session file, which Stem replays
// but does not write, and a draft changes after the fact (rewritten with a
// second example, saved, discarded). Saved and discarded drafts stay as a
// record of what the card said; deleting the chat deletes them.

interface DraftStore {
  version: 1;
  drafts: Record<string, RecordingDraft>;
}

/** Drafts kept per chat; the oldest closed ones go first past this. */
const MAX_PER_THREAD = 20;

export function recordingDraftsPath(): string {
  return process.env.STEM_RECORDING_DRAFTS_STORE ?? join(userDataRoot(), 'recording-drafts.json');
}

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  // quiet: the caller gets the failure from `next`; the chain only must not stay broken.
  queue = next.catch(() => undefined);
  return next;
}

async function readStore(): Promise<DraftStore> {
  try {
    const parsed = JSON.parse(await readFile(recordingDraftsPath(), 'utf8')) as Partial<DraftStore>;
    return { version: 1, drafts: parsed.drafts && typeof parsed.drafts === 'object' ? parsed.drafts : {} };
  } catch {
    // quiet: no file yet (or an unreadable one) is an empty store; the next write replaces it.
    return { version: 1, drafts: {} };
  }
}

async function writeStore(store: DraftStore): Promise<void> {
  const path = recordingDraftsPath();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

function update<T>(mutate: (store: DraftStore) => T): Promise<T> {
  return enqueue(async () => {
    const store = await readStore();
    const result = mutate(store);
    await writeStore(store);
    return result;
  });
}

export async function listDrafts(threadId: string): Promise<RecordingDraft[]> {
  const store = await enqueue(readStore);
  return Object.values(store.drafts)
    .filter((d) => d.threadId === threadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getDraft(id: string): Promise<RecordingDraft | null> {
  const store = await enqueue(readStore);
  return store.drafts[id] ?? null;
}

export function putDraft(draft: RecordingDraft): Promise<RecordingDraft> {
  return update((store) => {
    store.drafts[draft.id] = draft;
    const mine = Object.values(store.drafts)
      .filter((d) => d.threadId === draft.threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const old of mine.slice(0, Math.max(0, mine.length - MAX_PER_THREAD))) {
      if (old.status === 'saved' || old.status === 'discarded' || old.status === 'failed') delete store.drafts[old.id];
    }
    return draft;
  });
}

/** Change a draft in place; null when it is gone. */
export function patchDraft(id: string, change: (draft: RecordingDraft) => RecordingDraft): Promise<RecordingDraft | null> {
  return update((store) => {
    const cur = store.drafts[id];
    if (!cur) return null;
    const next = { ...change(cur), id: cur.id, threadId: cur.threadId, updatedAt: new Date().toISOString() };
    store.drafts[id] = next;
    return next;
  });
}

export function removeThreadDrafts(threadId: string): Promise<void> {
  return update((store) => {
    for (const [id, d] of Object.entries(store.drafts)) if (d.threadId === threadId) delete store.drafts[id];
  });
}
