import { Directory, File, Paths } from 'expo-file-system';
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';

export interface DraftAttachment {
  id: string;
  uri: string;
  name: string;
  mime?: string;
  size: number;
}
export interface Draft {
  body: string;
  attachments: DraftAttachment[];
  metadata: Record<string, string | boolean>;
}
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const draftErrors = new Map<string, string>();
const empty = (): Draft => ({ body: '', attachments: [], metadata: {} });
let db: SQLiteDatabase | undefined;
const values = new Map<string, Draft>();
const flights = new Map<string, Draft>();
const draftEpochs = new Map<string, number>();
export const isDraftSending = (id: string) => flights.has(id);
export function beginDraftSend(id: string) {
  if (flights.has(id)) throw new Error('This draft is already being sent.');
  const snapshot = readDraft(id);
  if (draftErrors.has(id)) throw new Error(draftErrors.get(id));
  const accountGeneration = generation;
  flights.set(id, snapshot);
  listeners.forEach((listener) => listener());
  let released = false;
  return {
    assertCurrent() {
      if (released || accountGeneration !== generation || flights.get(id) !== snapshot)
        throw new Error('The account changed before sending. The message was not sent.');
    },
    finish(accepted: boolean) {
      if (released) return;
      released = true;
      if (flights.get(id) !== snapshot) return;
      flights.delete(id);
      try {
        if (accepted && readDraft(id) === snapshot) clearDraft(id);
      } finally {
        listeners.forEach((listener) => listener());
      }
    }
  };
}
const listeners = new Set<() => void>();
let generation = 0;
export const draftGeneration = () => generation;
const files = () => new Directory(Paths.document, 'stem-draft-files');
function database() {
  if (!db) {
    db = openDatabaseSync('stem-drafts.db');
    db.execSync('CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  return db;
}
export function readDraft(id: string): Draft {
  const cached = values.get(id);
  if (cached) return cached;
  let value = empty();
  try {
    const row = database().getFirstSync<{ value: string }>(
      'SELECT value FROM drafts WHERE id = ?',
      id
    );
    if (row) {
      const parsed = JSON.parse(row.value) as Draft;
      if (Array.isArray(parsed?.attachments)) {
        parsed.attachments = parsed.attachments.map((item) => {
          if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(item.id) ||
              typeof item.uri !== 'string' || !item.uri.endsWith(`/stem-draft-files/${item.id}`)) throw new Error('Invalid attachment');
          // iOS changes the application container UUID on updates. Only the
          // owned basename survives; never continue using an old absolute URI.
          const owned = new File(files(), item.id);
          return {...item, uri: owned.uri, size: item.size ?? (owned.exists ? owned.size : null)};
        });
      }
      if (
        !parsed ||
        typeof parsed.body !== 'string' ||
        !Array.isArray(parsed.attachments) ||
        parsed.attachments.some(
          (item) =>
            !item ||
            typeof item.id !== 'string' ||
            typeof item.uri !== 'string' ||
            typeof item.name !== 'string' ||
            typeof item.size !== 'number' ||
            !Number.isFinite(item.size) ||
            item.size < 0
        ) ||
        !parsed.metadata ||
        typeof parsed.metadata !== 'object' ||
        Array.isArray(parsed.metadata) ||
        Object.values(parsed.metadata).some(
          (value) => typeof value !== 'string' && typeof value !== 'boolean'
        )
      )
        throw new Error('Invalid draft');
      value = parsed;
    }
  } catch {
    draftErrors.set(id, 'The saved draft could not be read. Discard this draft to reset it.');
  }
  values.set(id, value);
  return value;
}
export function updateDraft(id: string, transform: (draft: Draft) => Draft): void {
  if (flights.has(id)) throw new Error('Wait for sending to finish before changing this draft.');
  if (draftErrors.has(id)) throw new Error(draftErrors.get(id));
  const previous = readDraft(id);
  if (draftErrors.has(id)) throw new Error(draftErrors.get(id));
  const value = transform(previous);
  // Keep the user's edits visible even if disk storage fails; the caller must
  // report that these changes have not been saved.
  values.set(id, value);
  try {
    database().runSync(
      'INSERT OR REPLACE INTO drafts (id, value) VALUES (?, ?)',
      id,
      JSON.stringify(value)
    );
  } finally {
    listeners.forEach((listener) => listener());
  }
}
export function subscribeDraft(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function deleteFile(attachment: DraftAttachment) {
  // Delete only files created by this store, never arbitrary picker URIs.
  if (!attachment.uri.startsWith(`${files().uri.replace(/\/$/, '')}/`)) return;
  const file = new File(attachment.uri);
  try {
    if (file.exists) file.delete();
  } catch {
    /* Cleanup must not turn accepted delivery into a retry. */
  }
}
export function clearDraft(id: string): void {
  if (flights.has(id)) throw new Error('Wait for sending to finish before discarding this draft.');
  const previous = readDraft(id);
  draftEpochs.set(id, (draftEpochs.get(id) ?? 0) + 1);
  database().runSync('DELETE FROM drafts WHERE id = ?', id);
  draftErrors.delete(id);
  values.set(id, empty());
  listeners.forEach((listener) => listener());
  previous.attachments.forEach(deleteFile);
}
export function clearDrafts(): void {
  generation += 1;
  flights.clear();
  database().runSync('DELETE FROM drafts');
  values.clear();
  draftErrors.clear();
  const directory = files();
  if (directory.exists) directory.delete();
  listeners.forEach((listener) => listener());
}
export async function addDraftAttachment(
  id: string,
  input: { uri: string; name: string; mime?: string; size?: number }
): Promise<void> {
  const accountGeneration = generation;
  const draftEpoch = draftEpochs.get(id) ?? 0;
  const source = new File(input.uri);
  const size = input.size ?? source.size;
  if (size > MAX_ATTACHMENT_BYTES) throw new Error('Each attachment must be 100 MiB or smaller.');
  const directory = files();
  directory.create({ intermediates: true, idempotent: true });
  const fileId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const copied = new File(directory, fileId);
  try {
    await source.copy(copied);
    if (generation !== accountGeneration || (draftEpochs.get(id) ?? 0) !== draftEpoch)
      throw new Error('The account or draft changed while attaching this file.');
    const copiedSize = copied.size;
    if (!copied.exists || typeof copiedSize !== 'number' || !Number.isFinite(copiedSize) || copiedSize < 0)
      throw new Error('The attachment could not be copied. Please try again.');
    if (copiedSize > MAX_ATTACHMENT_BYTES) throw new Error('Each attachment must be 100 MiB or smaller.');
    updateDraft(id, (draft) => ({
      ...draft,
      attachments: [
        ...draft.attachments,
        { id: fileId, uri: copied.uri, name: input.name, mime: input.mime, size: copiedSize }
      ]
    }));
  } catch (error) {
    if (generation !== accountGeneration || !values.get(id)?.attachments.some((item) => item.id === fileId)) {
      try { if (copied.exists) copied.delete(); } catch { /* Best effort cleanup of an unclaimed copy. */ }
    }
    throw error;
  }
}
export function removeDraftAttachment(id: string, attachmentId: string) {
  const attachment = readDraft(id).attachments.find((item) => item.id === attachmentId);
  updateDraft(id, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item.id !== attachmentId)
  }));
  if (attachment) deleteFile(attachment);
}
