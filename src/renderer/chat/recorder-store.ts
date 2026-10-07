import type { RecorderState, RecordingDraft } from '../../shared/types';

// The skill recorder as the chat sees it, kept outside React for the reason
// learn-store.ts is: a chat switch remounts the Composer and the ChatView, and
// a recording (or the draft it becomes) outlives both. Fed by three pushes —
// the Mac recorder's state, the server's draft changes, and ⌃⌥R asking for
// the Record sheet — and read with useSyncExternalStore.

const IDLE: RecorderState = { phase: 'idle', threadId: null, draftId: null, startedAt: null, steps: 0, lastStep: null, error: null };

interface Snapshot {
  state: RecorderState;
  /**
   * A request to open the Record sheet: from ⌃⌥R (no thread — the chat on
   * screen) or a draft card's "Record another example". The visible composer
   * opens it and clears it.
   */
  sheet: { threadId: string | null; draftId: string | null; nonce: number } | null;
  /** "Try it" / "Practice run": text for one chat's composer, consumed once. */
  prefill: { threadId: string; text: string; caret?: number; nonce: number } | null;
  /**
   * A practice run waiting to be sent, per chat: the composer shows it as a
   * chip, and the next send in that chat carries the draft id (takePractice).
   */
  practice: Record<string, { draftId: string; name: string }>;
}

let snapshot: Snapshot = { state: IDLE, sheet: null, prefill: null, practice: {} };
const drafts = new Map<string, RecordingDraft[]>();
const listeners = new Set<() => void>();
let wired = false;

function emit(): void {
  for (const l of listeners) l();
}

function set(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next };
  emit();
}

function mergeDraft(draft: RecordingDraft): void {
  const list = drafts.get(draft.threadId) ?? [];
  const at = list.findIndex((d) => d.id === draft.id);
  const next = at === -1 ? [...list, draft] : list.map((d, i) => (i === at ? draft : d));
  next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  drafts.set(draft.threadId, next);
  emit();
}

/** Subscribe to the pushes once, the first time anything reads the store. */
function wire(): void {
  if (wired || typeof window === 'undefined' || !window.stem?.onRecorderState) return;
  wired = true;
  window.stem.onRecorderState((state) => set({ state }));
  window.stem.onRecordingDraft((draft) => mergeDraft(draft));
  window.stem.onRecorderOpenSheet(() => requestSheet(null, null));
  void window.stem
    .recorderState()
    .then((state) => set({ state }))
    .catch(() => undefined);
}

export function subscribeRecorder(listener: () => void): () => void {
  wire();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readRecorder(): Snapshot {
  return snapshot;
}

const EMPTY: RecordingDraft[] = [];

export function readDrafts(threadId: string | null | undefined): RecordingDraft[] {
  return (threadId && drafts.get(threadId)) || EMPTY;
}

/** Load a chat's drafts (on open); later changes arrive as pushes. */
export async function loadDrafts(threadId: string): Promise<void> {
  wire();
  if (!window.stem?.recordingDrafts) return;
  try {
    const list = await window.stem.recordingDrafts(threadId);
    drafts.set(threadId, list);
    emit();
  } catch {
    // An older server without the recorder: no cards to show.
  }
}

/** A draft answered by a direct call (save, discard, answer): show it at once. */
export function noteDraft(draft: RecordingDraft | null | undefined): void {
  if (draft) mergeDraft(draft);
}

export function requestSheet(threadId: string | null, draftId: string | null): void {
  set({ sheet: { threadId, draftId, nonce: Date.now() } });
}

export function consumeSheet(nonce: number): void {
  if (snapshot.sheet?.nonce === nonce) set({ sheet: null });
}

export function prefillComposer(threadId: string, text: string, caret?: number): void {
  set({ prefill: { threadId, text, ...(caret !== undefined ? { caret } : {}), nonce: Date.now() } });
}

/** "Practice run": the message goes in the composer, and the next send in this chat practices the draft. */
export function startPractice(threadId: string, draftId: string, name: string, text: string, caret: number): void {
  set({ practice: { ...snapshot.practice, [threadId]: { draftId, name } } });
  prefillComposer(threadId, text, caret);
}

/** The composer chip's ✕: the message goes as an ordinary one. */
export function dropPractice(threadId: string): void {
  if (!snapshot.practice[threadId]) return;
  const rest = { ...snapshot.practice };
  delete rest[threadId];
  set({ practice: rest });
}

/** The draft the send in this chat practices, if any; cleared — only one turn starts a run. */
export function takePractice(threadId: string): string | undefined {
  const p = snapshot.practice[threadId];
  if (p) dropPractice(threadId);
  return p?.draftId;
}

export function consumePrefill(nonce: number): void {
  if (snapshot.prefill?.nonce === nonce) set({ prefill: null });
}

/** Clear the last error once it has been shown. */
export function dismissRecorderError(): void {
  if (snapshot.state.error) set({ state: { ...snapshot.state, error: null } });
}

/** The startTurn field for a send in this chat (empty when it practices nothing). */
export function practiceInput(threadId: string): { practiceDraftId?: string } {
  const draftId = takePractice(threadId);
  return draftId ? { practiceDraftId: draftId } : {};
}
