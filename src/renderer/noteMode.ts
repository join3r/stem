import { useCallback, useEffect, useRef, useState } from 'react';
import type { MemoryNoteResult, TurnAttachment } from '../shared/types';

// Composer note mode: `/note ` or `//` at the start of the draft flips the
// composer into saving a quick memory note instead of running an AI turn. The
// parsing lives here as pure functions (unit-tested without React); the hook
// owns the mode + transient-feedback state both composers share.

/** How long the "✓ Saved to memory" flash stays up before the composer resets. */
export const NOTE_CONFIRM_MS = 2000;

/**
 * Detect a note trigger at the START of the draft only — a `//` or `/note`
 * mid-message is ordinary text. `/note` requires a following space (or being the
 * entire draft) so `/notes…` never triggers; `//` triggers immediately. Returns
 * the draft body with the prefix stripped, or null when there is no trigger.
 */
export function detectNoteTrigger(text: string): { body: string } | null {
  if (text.startsWith('//')) return { body: text.slice(2) };
  // The trailing space is required — both so `/notes…` never triggers and so
  // that typing `/note ` character by character enters note mode only once the
  // space lands, keeping that space out of the note body.
  if (text.startsWith('/note ')) return { body: text.slice('/note '.length) };
  return null;
}

/** A note needs some content — the bare prefix isn't a saveable note. An
 *  attached image counts as content: the picture can be the whole note. */
export function noteBodyValid(body: string, attachmentCount = 0): boolean {
  return body.trim().length > 0 || attachmentCount > 0;
}

/** Notes take pictures only — a PDF or a text file has nowhere to go in a fact.
 *  Judged by name/mime here so the composer can say so before the save call. */
export function isImageAttachment(att: TurnAttachment): boolean {
  if (att.mime) return att.mime.startsWith('image/');
  return /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(att.name || att.path || '');
}

/** Transient post-save feedback: saved OK, memory disabled in settings, the
 *  note looked like a credential (never stored), an attachment was not a usable
 *  image, or the save call itself failed (IPC error — e.g. a stale main
 *  process). A failure must never be silent. */
export type NoteFlash = 'saved' | 'off' | 'secret' | 'image' | 'files' | 'error' | null;

/** What each flash says. 'saved' is rendered with its own ✓ by the composers. */
export const NOTE_FLASH_TEXT: Record<Exclude<NoteFlash, null>, string> = {
  saved: 'Saved to memory',
  off: 'Memory is off — note not saved',
  secret: 'Looks like a credential — not saved',
  image: 'Couldn’t read that image — not saved',
  files: 'Notes take images only — remove the other files',
  error: 'Couldn’t save the note — try restarting Stem'
};

export interface NoteMode {
  noteMode: boolean;
  flash: NoteFlash;
  enterNoteMode: () => void;
  exitNoteMode: () => void;
  toggleNoteMode: () => void;
  /** Save `body` (plus any attached images) as a memory note. Resolves true
   *  when saved (flash shows the outcome either way); the caller clears its own
   *  draft and attachments on true. */
  saveNote: (body: string, attachments?: TurnAttachment[]) => Promise<boolean>;
}

export function useNoteMode(): NoteMode {
  const [noteMode, setNoteMode] = useState(false);
  const [flash, setFlash] = useState<NoteFlash>(null);
  const flashTimer = useRef<number | null>(null);
  const savingRef = useRef(false);

  useEffect(() => () => {
    if (flashTimer.current != null) window.clearTimeout(flashTimer.current);
  }, []);

  const showFlash = useCallback((kind: Exclude<NoteFlash, null>) => {
    if (flashTimer.current != null) window.clearTimeout(flashTimer.current);
    setFlash(kind);
    flashTimer.current = window.setTimeout(() => setFlash(null), NOTE_CONFIRM_MS);
  }, []);

  const enterNoteMode = useCallback(() => setNoteMode(true), []);
  const exitNoteMode = useCallback(() => setNoteMode(false), []);
  const toggleNoteMode = useCallback(() => setNoteMode((v) => !v), []);

  const saveNote = useCallback(
    async (body: string, attachments: TurnAttachment[] = []): Promise<boolean> => {
      if (!noteBodyValid(body, attachments.length) || savingRef.current) return false;
      if (attachments.some((a) => !isImageAttachment(a))) {
        // Keep the draft: the fix is removing a chip, not retyping the note.
        showFlash('files');
        return false;
      }
      savingRef.current = true;
      let result: MemoryNoteResult | null;
      try {
        result = await window.stem.addMemoryNote(body.trim(), attachments);
      } catch {
        result = null;
      } finally {
        savingRef.current = false;
      }
      if (result?.saved) {
        setNoteMode(false);
        showFlash('saved');
        return true;
      }
      if (result?.reason === 'disabled') {
        setNoteMode(false);
        showFlash('off');
      } else if (result?.reason === 'secret') {
        // Keep note mode + draft so the user can reword; just explain why.
        showFlash('secret');
      } else if (result?.reason === 'image') {
        showFlash('image');
      } else {
        // IPC rejection or an unexpected refusal: keep the draft, say SOMETHING —
        // a swallowed failure reads as a dead Enter key.
        showFlash('error');
      }
      return false;
    },
    [showFlash]
  );

  return { noteMode, flash, enterNoteMode, exitNoteMode, toggleNoteMode, saveNote };
}
