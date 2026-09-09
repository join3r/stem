// Unsent composer text, kept per chat for the life of the window.
//
// ChatView is keyed on the active chat, so switching chats remounts the
// Composer and with it the `draft` state. Without this store anything typed but
// not yet sent — typically a follow-up written while the previous turn was still
// streaming — vanished the moment the user peeked at another chat (issue #13).
// Module-level rather than React state so it survives the remount without
// threading through App; not persisted to disk on purpose, a draft is a
// window-lifetime thing.
import type { TurnAttachment } from '../../shared/types';

export interface StoredDraft {
  text: string;
  attachments: TurnAttachment[];
}

const EMPTY: StoredDraft = { text: '', attachments: [] };
const drafts = new Map<string, StoredDraft>();

export function readDraft(key: string): StoredDraft {
  return drafts.get(key) ?? EMPTY;
}

export function writeDraft(key: string, draft: StoredDraft): void {
  if (!draft.text && draft.attachments.length === 0) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, draft);
}

export function clearDraft(key: string): void {
  drafts.delete(key);
}

/** Test hook: forget every draft. */
export function resetDrafts(): void {
  drafts.clear();
}
