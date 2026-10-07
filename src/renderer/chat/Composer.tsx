import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import { Square, ArrowUp, Paperclip, File, X, Check, NotebookPen, Globe, Zap, Pin, Wand2 } from 'lucide-react';
import type {
  ChatMessage,
  EscapeAction,
  ModelSummary,
  TurnAttachment
} from '../../shared/types';
import { ContextMeter } from './ContextMeter';
import { useOffline } from '../hooks/useServerReachable';
import { ShortcutHint, glyphsFor, useShortcut, useShortcutsBound, type ShortcutId } from '../shortcuts';
import { EffortModelControl } from '../ui/EffortModelControl';
import { slashMatches, type SlashCommand, type SlashCommandName } from './slashCommands';
import { NOTE_CONFIRM_MS, NOTE_FLASH_TEXT, detectNoteTrigger, noteBodyValid, useNoteMode } from '../noteMode';
import { clearDraft, readDraft, writeDraft } from './draft-store';
import { dismissLearnNotice, readLearn, startLearn, subscribeLearn } from './learn-store';
import { dismissCompactNotice, readCompact, startCompact, subscribeCompact } from './compact-store';
import { consumePrefill, consumeSheet, dismissRecorderError, readRecorder, subscribeRecorder } from './recorder-store';
import { RecordSheet } from './RecordSheet';

const MAX_COMPOSER_HEIGHT = 180;

// How long a `/learn` outcome stays up once its chat is on screen. Much longer
// than the note flash: main writes these as full sentences explaining what was
// (or wasn't) saved, not as a two-word confirmation that can be read at a glance.
const LEARN_NOTICE_MS = 8000;

// Read a File's bytes into a base64 TurnAttachment (for clipboard/dropped data
// with no on-disk path). Module-level: it depends on nothing in the component.
function fileToAttachment(file: File): Promise<TurnAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = reader.result as string; // data:<mime>;base64,<data>
      resolve({ name: file.name, dataBase64: result.split(',')[1] ?? '', mime: file.type });
    };
    reader.readAsDataURL(file);
  });
}

// `/learn [focus]` saves a skill from this chat instead of sending the draft to
// the model. Matched at submit rather than while typing —
// unlike `/note` this is a one-shot action, not a mode the composer sits in.
//
// Three commands are intercepted, `/learn`, `/compact` and `/pin`, each a
// literal match. The `/` menu that offers them lists them in slashCommands.ts.
export function detectLearnCommand(text: string): { focus: string } | null {
  if (text === '/learn') return { focus: '' };
  if (text.startsWith('/learn ')) return { focus: text.slice('/learn '.length).trim() };
  return null;
}

// `/compact [focus]` condenses the chat's history now — pi's summary of the
// older turns replaces them, as its automatic condense does near the limit. The
// focus, if any, tells the summary what to keep.
export function detectCompactCommand(text: string): { instructions: string } | null {
  if (text === '/compact') return { instructions: '' };
  if (text.startsWith('/compact ')) return { instructions: text.slice('/compact '.length).trim() };
  return null;
}

// `/pin <text>` pins a note to this chat's board (docs/chat-pinboard-plan.md)
// — the way to start a board in a chat that has nothing pinned yet. Like a
// memory note it starts no turn, so it works mid-turn. A bare `/pin` has
// nothing to pin and is left in the draft.
export function detectPinCommand(text: string): { note: string } | null {
  if (text === '/pin') return { note: '' };
  if (text.startsWith('/pin ')) return { note: text.slice('/pin '.length).trim() };
  return null;
}

/** The skill recorder runs only in the Mac app (the helper is a macOS binary). */
const CAN_RECORD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) && typeof window !== 'undefined' && !!window.stem?.startRecording;

/** How long "Pinned to this chat" stays up under the composer. */
const PIN_NOTICE_MS = 2000;

/** Imperative surface so App can push files into the composer (drop overlay). */
export interface ComposerHandle {
  addAttachments(files: File[]): void;
  /** Put the caret in the text field — used when a new chat opens. */
  focus(): void;
}

interface ComposerProps {
  /** Only read by the context meter — the composer itself never renders messages. */
  messages: ChatMessage[];
  running: boolean;
  escapeAction: EscapeAction;
  onSend: (text: string, attachments: TurnAttachment[]) => void;
  onInterrupt: () => void;
  onRetractActiveTurn: () => void | Promise<void>;
  pendingRestore: { text: string; attachments: TurnAttachment[]; nonce: number } | null;
  onRestoreConsumed: () => void;
  models: ModelSummary[];
  model: ModelSummary | null;
  effort: string | null;
  serviceTier: string | null;
  format: 'md' | 'mdx';
  showContextMeter: boolean;
  onChangeEffort: (effort: string) => void;
  /** Switch the model the next turn runs on — the effort control's label opens the picker. */
  onSelectModel: (id: string) => void;
  onChangeSpeed: (serviceTier: string | null) => void;
  onChangeFormat: (format: 'md' | 'mdx') => void;
  /** Web search for this surface — its saved position, which the next turn uses. */
  webSearch: boolean;
  onToggleWebSearch: (next: boolean) => void;
  reportDraft: boolean;
  /** The thread `/learn` saves from. Null in an unsent draft and absent in Quick
   *  Chat; either way the draft takes the normal send path. */
  threadId?: string | null;
  /** Identity of the chat this composer writes for. Unsent text and attachments
   *  are parked under it across the remount a chat switch causes, so what was
   *  typed is still there when the user comes back (issue #13). Absent in Quick
   *  Chat, which never remounts mid-draft. */
  draftKey?: string;
  onDraftChange?: (text: string) => void;
  onNoteSaved?: () => void;
  /** Pin a note to this chat (`/pin <text>`). Absent where there is no board: a
   *  draft, Quick Chat — there the text takes the normal send path. */
  onPinNote?: (text: string) => Promise<boolean>;
}

/**
 * The full composer block: controls row (effort/speed/format/note/meter) plus the
 * auto-growing text field with attachments, drag-drop, paste, and note mode.
 * Owns every piece of state that changes per keystroke — kept out of ChatView so
 * typing never re-renders the message timeline.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer({
  messages,
  running,
  escapeAction,
  onSend,
  onInterrupt,
  onRetractActiveTurn,
  pendingRestore,
  onRestoreConsumed,
  models,
  model,
  effort,
  serviceTier,
  format,
  showContextMeter,
  onChangeEffort,
  onSelectModel,
  onChangeSpeed,
  onChangeFormat,
  webSearch,
  onToggleWebSearch,
  reportDraft,
  threadId,
  draftKey,
  onDraftChange,
  onNoteSaved,
  onPinNote
}: ComposerProps, ref) {
  const [draft, setDraft] = useState(() => (draftKey ? readDraft(draftKey).text : ''));
  const [attachments, setAttachments] = useState<TurnAttachment[]>(
    () => (draftKey ? readDraft(draftKey).attachments : [])
  );
  // Mirror every change back to the store. Sending clears the store directly
  // (see submit): a first send turns the draft into a real thread, which remounts
  // this component before an effect could record the emptied field.
  useEffect(() => {
    if (draftKey) writeDraft(draftKey, { text: draft, attachments });
  }, [draftKey, draft, attachments]);
  const [dragOver, setDragOver] = useState(false);
  // Two-stage Escape: after the first Escape stops the turn, `armed` lets a second
  // Escape retract the just-stopped message. Cleared the moment the user acts
  // (types, sends, blurs); a chat switch remounts the composer, resetting it too.
  const [armed, setArmed] = useState(false);
  // Stop was clicked but the turn hasn't ended yet. The interrupt round-trips
  // through the backend (and may have to cancel a start that is still queued),
  // so without this the press gives no feedback at all — which reads as the
  // button not working. Cleared when `running` flips off.
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);
  const requestStop = useCallback(() => {
    setStopping(true);
    onInterrupt();
  }, [onInterrupt]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Stem's offline mode is read-only by decision, not by accident: there is no
  // local brain to answer with and no outbox to hold what you typed, so a
  // composer that still accepted text would be collecting messages it could only
  // throw away. Blocked at the field rather than at send — the honest moment to
  // find out is before you write the paragraph. Notes go the same way: they are
  // written into memory, which is on the server too.
  const offline = useOffline();

  // Auto-grow the composer from one line up to a max, then scroll internally.
  const resizeComposer = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const needed = el.scrollHeight;
    el.style.height = `${Math.min(needed, MAX_COMPOSER_HEIGHT)}px`;
    // Only show a scrollbar once content exceeds the max height.
    el.style.overflowY = needed > MAX_COMPOSER_HEIGHT ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeComposer();
  }, [draft, resizeComposer]);

  // Mirror the live draft to the Memory tab's fact preview while it's toggled on
  // (and once when it flips on). No-op on the normal compose path.
  useEffect(() => {
    if (reportDraft && onDraftChange) onDraftChange(draft);
  }, [draft, reportDraft, onDraftChange]);

  // Apply a retract's restored text/attachments to the composer. Skips clobbering a
  // follow-up the user began typing during streaming (the turn is still removed —
  // we just drop the restored text in that case). Nonce-guarded so it applies once.
  const lastRestoreNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!pendingRestore || lastRestoreNonce.current === pendingRestore.nonce) return;
    lastRestoreNonce.current = pendingRestore.nonce;
    if (!draft.trim() && attachments.length === 0) {
      setDraft(pendingRestore.text);
      setAttachments(pendingRestore.attachments);
      textareaRef.current?.focus();
    }
    onRestoreConsumed();
  }, [pendingRestore, draft, attachments, onRestoreConsumed]);

  // `/note` / `//` quick-note capture: saves the draft straight to memory, no turn.
  const { noteMode, flash: noteFlash, enterNoteMode, exitNoteMode, toggleNoteMode, saveNote } = useNoteMode();

  // The `/` menu. Only commands this composer can run are offered: `/pin` needs
  // a board, `/learn` a thread. Escape hides it until the draft stops starting
  // with `/`, so a message that really does begin with one can still be sent.
  const slashAvailable = useMemo(() => {
    const names = new Set<SlashCommandName>(['note']);
    if (onPinNote) names.add('pin');
    if (threadId) names.add('learn');
    if (threadId) names.add('compact');
    if (threadId && CAN_RECORD) names.add('record');
    return names;
  }, [onPinNote, threadId]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slash = noteMode || offline || slashDismissed ? null : slashMatches(draft, slashAvailable);
  const slashActive = slash ? Math.min(slashIndex, slash.length - 1) : 0;
  const pickSlash = (cmd: SlashCommand) => {
    setSlashIndex(0);
    // `/note` is a mode, not a prefix: enter it the way typing `/note ` would.
    if (cmd.name === 'note') {
      enterNoteMode();
      setDraft('');
    } else if (cmd.name === 'record') {
      setDraft('');
      setRecordSheet({ draftId: null });
    } else {
      setDraft(`/${cmd.name} `);
    }
    textareaRef.current?.focus();
  };

  // `/learn` gets its own pending state rather than borrowing `running`: it starts
  // no turn, and on ask mode it stays outstanding until the user answers the
  // approval card — which may be a while, so nothing here may block the composer.
  const [pinNotice, setPinNotice] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!pinNotice) return;
    const t = window.setTimeout(() => setPinNotice(null), PIN_NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [pinNotice]);
  // Kept outside the component (learn-store.ts): a chat switch remounts the
  // Composer, and a `/learn` outlives that by a minute or more.
  const { learning, notice: learnNotice } = useSyncExternalStore(subscribeLearn, () => readLearn(threadId));
  // The outcome's clock starts when its chat is on screen, so one that arrived
  // while the user was in another chat is still there when they come back.
  useEffect(() => {
    if (!threadId || !learnNotice) return;
    const t = window.setTimeout(() => dismissLearnNotice(threadId, learnNotice), LEARN_NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [threadId, learnNotice]);

  // The skill recorder (recorder-store.ts): the sheet this composer shows, the
  // recording's state for this chat, and "Try it" text a draft card hands over.
  const recorder = useSyncExternalStore(subscribeRecorder, readRecorder);
  const [recordSheet, setRecordSheet] = useState<{ draftId: string | null } | null>(null);
  const recordingHere = recorder.state.threadId === threadId && recorder.state.phase !== 'idle';
  useEffect(() => {
    const req = recorder.sheet;
    if (!req || !threadId || !CAN_RECORD) return;
    if (req.threadId && req.threadId !== threadId) return;
    consumeSheet(req.nonce);
    if (recorder.state.phase === 'idle') setRecordSheet({ draftId: req.draftId });
  }, [recorder.sheet, recorder.state.phase, threadId]);
  useEffect(() => {
    const p = recorder.prefill;
    if (!p || p.threadId !== threadId) return;
    consumePrefill(p.nonce);
    setDraft(p.text);
    window.setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(p.text.length, p.text.length);
    }, 0);
  }, [recorder.prefill, threadId]);
  // `/compact` lives outside the component for the same reason (compact-store.ts).
  const { compacting, notice: compactNotice } = useSyncExternalStore(subscribeCompact, () => readCompact(threadId));
  useEffect(() => {
    if (!threadId || !compactNotice) return;
    const t = window.setTimeout(() => dismissCompactNotice(threadId, compactNotice), LEARN_NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [threadId, compactNotice]);
  const recordError = recorder.state.threadId === threadId ? recorder.state.error : null;
  useEffect(() => {
    if (!recordError) return;
    const t = window.setTimeout(dismissRecorderError, LEARN_NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [recordError]);

  function submit() {
    if (offline) return;
    const text = draft.trim();
    if (noteMode) {
      // A note save never starts a turn, so it's allowed mid-turn. Attached
      // images go with the note (the picture can be the whole note).
      if (!noteBodyValid(text, attachments.length)) return;
      void saveNote(text, attachments).then((saved) => {
        if (!saved) return;
        setDraft('');
        setAttachments([]);
        if (draftKey) clearDraft(draftKey);
        if (onNoteSaved) window.setTimeout(onNoteSaved, NOTE_CONFIRM_MS);
      });
      return;
    }
    const pin = onPinNote ? detectPinCommand(text) : null;
    if (pin) {
      if (!pin.note) return;
      void onPinNote!(pin.note).then((ok) => {
        setPinNotice(ok ? { ok, text: 'Pinned to this chat' } : { ok, text: "Couldn't pin that note" });
        if (!ok) return;
        setDraft('');
        if (draftKey) clearDraft(draftKey);
      });
      return;
    }
    if ((!text && attachments.length === 0) || running) return;
    if (text === '/record' && threadId && CAN_RECORD) {
      setDraft('');
      if (recorder.state.phase === 'idle') setRecordSheet({ draftId: null });
      return;
    }
    const learn = detectLearnCommand(text);
    if (learn && threadId) {
      // A second `/learn` while one is still outstanding is dropped, but the draft
      // still clears — the alternative is sending the literal text to the model.
      const focus = learn.focus;
      void startLearn(threadId, () => window.stem.learnFromChat(threadId, focus || undefined));
      setArmed(false);
      setDraft('');
      return;
    }
    const compact = detectCompactCommand(text);
    if (compact && threadId) {
      // Gated on `running` above: pi's compact aborts whatever the chat is
      // doing, and the server refuses it mid-reply anyway.
      const instructions = compact.instructions;
      void startCompact(threadId, () => window.stem.compactChat(threadId, instructions || undefined));
      setArmed(false);
      setDraft('');
      return;
    }
    setArmed(false);
    onSend(text, attachments);
    setDraft('');
    setAttachments([]);
    if (draftKey) clearDraft(draftKey);
  }

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // Pick files via the native dialog (paperclip button).
  const pickFiles = useCallback(async () => {
    const paths = await window.stem.openFiles();
    if (!paths.length) return;
    setAttachments((prev) => [
      ...prev,
      ...paths.map((p) => ({ name: p.split('/').pop() || p, path: p }))
    ]);
  }, []);

  // Turn dropped/picked Files into composer attachments: prefer the on-disk path,
  // falling back to base64 bytes for path-less data. Shared by drop + the overlay.
  const addFilesToComposer = useCallback(async (files: File[]) => {
    if (!files.length) return;
    const next = await Promise.all(
      files.map(async (f) => {
        const path = window.stem.getPathForFile(f);
        return path ? { name: f.name, path } : await fileToAttachment(f);
      })
    );
    setAttachments((prev) => [...prev, ...next]);
  }, []);

  // App pushes overlay-dropped files ("Add to this conversation") in here.
  useImperativeHandle(
    ref,
    () => ({
      addAttachments: (files) => void addFilesToComposer(files),
      focus: () => textareaRef.current?.focus()
    }),
    [addFilesToComposer]
  );

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files);
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return; // let plain-text paste through untouched
    e.preventDefault();
    const next = await Promise.all(images.map(fileToAttachment));
    setAttachments((prev) => [...prev, ...next]);
  }

  async function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    await addFilesToComposer(Array.from(e.dataTransfer.files));
  }

  const fastTier = model?.serviceTiers.find((t) => t.id === 'priority');
  const hasFast = !!fastTier;

  // Composer shortcuts. Effort/format mirror the seg-ctls (inert while running, like
  // the buttons themselves); ⌘. stops only when a turn is in flight.
  useShortcut('cycle-effort', () => {
    const efforts = model?.supportedEfforts ?? [];
    if (running || efforts.length === 0) return;
    const next = efforts[(efforts.indexOf(effort ?? '') + 1) % efforts.length];
    onChangeEffort(next);
  });
  useShortcut('toggle-speed', () => {
    if (running || !hasFast) return;
    onChangeSpeed(serviceTier === 'priority' ? null : 'priority');
  });
  useShortcut('toggle-format', () => {
    if (running) return;
    onChangeFormat(format === 'mdx' ? 'md' : 'mdx');
  });
  useShortcut('attach', () => void pickFiles());
  useShortcut('stop', () => {
    if (running) requestStop();
  });

  // Hover labels carry their keycap — but only where the keycap is real. This is
  // also Quick Chat's composer, and that window mounts no shortcuts provider, so
  // the registrations above are no-ops there and a tooltip promising ⌘U would be
  // advertising a key that does nothing.
  const bound = useShortcutsBound();
  /** Append the keycap to a label the control would carry anyway. */
  const withKey = useCallback(
    (label: string, id: ShortcutId) => (bound ? `${label} (${glyphsFor(id)})` : label),
    [bound]
  );
  /** For tooltips that exist only to name the shortcut — with no key, no tooltip. */
  const keyTitle = useCallback(
    (label: string, id: ShortcutId) => (bound ? `${label} (${glyphsFor(id)})` : undefined),
    [bound]
  );

  return (
    <div className="composer">
      <div className="composer-controls">
        {/* The ⌘E keycap sits on the slider, not the stops: it cycles the whole
            control rather than selecting any one level, and the stops carry only
            their level name. The label beside it opens the model picker. */}
        <EffortModelControl
          models={models}
          model={model}
          effort={effort}
          disabled={running}
          onChangeEffort={onChangeEffort}
          onSelectModel={onSelectModel}
          sliderTitle={keyTitle('Cycle reasoning effort', 'cycle-effort')}
        >
          <ShortcutHint id="cycle-effort" />
        </EffortModelControl>
        {/* One toggle, not Standard|Fast: unpressed IS standard speed. */}
        {hasFast && (
          <div className="seg-ctl compact" role="group" aria-label="Speed">
            <ShortcutHint id="toggle-speed" />
            <button
              type="button"
              className={serviceTier === 'priority' ? 'active' : ''}
              onClick={() => onChangeSpeed(serviceTier === 'priority' ? null : 'priority')}
              disabled={running}
              title={withKey(
                serviceTier === 'priority'
                  ? fastTier?.description ?? '1.5× speed, increased usage'
                  : `${fastTier?.description ?? '1.5× speed, increased usage'} — off means standard speed`,
                'toggle-speed'
              )}
            >
              <Zap size={13} /> Fast
            </button>
          </div>
        )}
        {/* Same shape for format: pressed = rich MDX, unpressed = plain Markdown. */}
        <div className="seg-ctl compact" role="group" aria-label="Output format">
          <ShortcutHint id="toggle-format" />
          <button
            type="button"
            className={format === 'mdx' ? 'active' : ''}
            onClick={() => onChangeFormat(format === 'mdx' ? 'md' : 'mdx')}
            disabled={running}
            // Em dash rather than the usual parenthetical, so the keycap keeps
            // the trailing (…) slot the other labels put it in.
            title={withKey(
              format === 'mdx'
                ? 'Rich components — callouts, steps, collapsibles'
                : 'Plain Markdown — press for rich components',
              'toggle-format'
            )}
          >
            MDX
          </button>
        </div>
        {/* Not disabled while a turn runs, unlike effort/speed/format: those three
            describe the turn in flight, this one only decides the next one — and
            it is the same saved switch Settings shows, so a click has to land. */}
        <div className="seg-ctl compact" role="group" aria-label="Web search">
          <button
            type="button"
            className={webSearch ? 'active' : ''}
            onClick={() => onToggleWebSearch(!webSearch)}
            title={
              webSearch
                ? 'Web search on — Stem may search the live web, with citations'
                : 'Web search off — Stem answers from what it already knows'
            }
          >
            <Globe size={13} /> Web
          </button>
        </div>
        <div className="seg-ctl compact" role="group" aria-label="Memory note">
          <button
            type="button"
            className={noteMode ? 'active' : ''}
            onClick={toggleNoteMode}
            title="Save a note to memory — or type /note or //"
          >
            <NotebookPen size={13} /> Note
          </button>
        </div>
        {/* Recording is the person's own work, not a turn: like Note it is not
            disabled while a turn runs. While recording for this chat it stops. */}
        {threadId && CAN_RECORD && (
          <div className="seg-ctl compact" role="group" aria-label="Record a skill">
            <button
              type="button"
              className={recordingHere ? 'active record-chip' : 'record-chip'}
              disabled={recorder.state.phase === 'authoring' || (recorder.state.phase !== 'idle' && !recordingHere)}
              onClick={() => (recordingHere ? void window.stem.stopRecording() : setRecordSheet({ draftId: null }))}
              title={
                recordingHere
                  ? 'Stop recording and write the skill (⌃⌥R)'
                  : 'Show Stem a task on your Mac — it writes the skill (/record, ⌃⌥R)'
              }
            >
              <span className="record-dot" aria-hidden="true" /> {recordingHere ? 'Stop' : 'Record'}
            </button>
          </div>
        )}
        {showContextMeter && <ContextMeter messages={messages} model={model} />}
      </div>
      <div
        className={`composer-field${dragOver ? ' drag-over' : ''}${noteMode ? ' note-mode' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {slash && (
          <div className="slash-menu" id="composer-slash-menu" role="listbox" aria-label="Commands">
            {slash.map((cmd, i) => (
              <div
                key={cmd.name}
                id={`composer-slash-${cmd.name}`}
                role="option"
                aria-selected={i === slashActive}
                className={`slash-item${i === slashActive ? ' active' : ''}`}
                // mousedown, not click: the textarea keeps focus and the caret.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSlash(cmd);
                }}
                onMouseEnter={() => setSlashIndex(i)}
              >
                <span className="slash-icon" aria-hidden="true">
                  {cmd.name === 'pin' ? <Pin size={13} /> : cmd.name === 'note' ? <NotebookPen size={13} /> : cmd.name === 'record' ? <span className="record-dot" /> : <Wand2 size={13} />}
                </span>
                <span className="slash-name">/{cmd.name}</span>
                <span className="slash-args">{cmd.args}</span>
                <span className="slash-desc">{cmd.description}</span>
              </div>
            ))}
          </div>
        )}
        {noteMode && (
          <div className="composer-attachments">
            <span className="attachment-chip note-chip">
              <NotebookPen size={13} />
              <span className="attachment-name">Note to memory</span>
              <button
                type="button"
                className="attachment-remove"
                title="Back to chat (Esc)"
                onClick={exitNoteMode}
              >
                <X size={13} />
              </button>
            </span>
          </div>
        )}
        {noteFlash && (
          <div className="composer-attachments">
            <span className={`note-flash${noteFlash === 'saved' ? ' ok' : ''}`} role="status" aria-live="polite">
              {noteFlash === 'saved' && <Check size={13} />} {NOTE_FLASH_TEXT[noteFlash]}
            </span>
          </div>
        )}
        {pinNotice && (
          <div className="composer-attachments">
            <span className={`note-flash${pinNotice.ok ? ' ok' : ''}`} role="status" aria-live="polite">
              {pinNotice.ok && <Check size={13} />} {pinNotice.text}
            </span>
          </div>
        )}
        {(learning || learnNotice) && (
          <div className="composer-attachments">
            <span
              className={`note-flash${learnNotice?.ok ? ' ok' : ''}`}
              role="status"
              aria-live="polite"
            >
              {learnNotice?.ok && <Check size={13} />}
              {/* Deliberately not "Saving…": on ask mode this sits here while the
                  approval card waits, and nothing is saved until it's answered. */}
              {learnNotice?.text ?? 'Learning from this chat…'}
            </span>
          </div>
        )}
        {(compacting || compactNotice) && (
          <div className="composer-attachments">
            <span className={`note-flash${compactNotice?.ok ? ' ok' : ''}`} role="status" aria-live="polite">
              {compactNotice?.ok && <Check size={13} />}
              {compactNotice?.text ?? 'Condensing this chat…'}
            </span>
          </div>
        )}
        {(recordingHere || recordError) && (
          <div className="composer-attachments">
            <span className={`note-flash${recordError ? '' : ' ok'}`} role="status" aria-live="polite">
              {recordError ??
                (recorder.state.phase === 'authoring'
                  ? 'Writing the skill from your recording…'
                  : recorder.state.phase === 'paused'
                    ? 'Recording paused'
                    : `Recording · ${recorder.state.steps} step${recorder.state.steps === 1 ? '' : 's'}${recorder.state.lastStep ? ` · ${recorder.state.lastStep}` : ''}`)}
            </span>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((att, i) => (
              <span className="attachment-chip" key={`${att.name}-${i}`}>
                <File size={13} />
                <span className="attachment-name">{att.name}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  title="Remove"
                  onClick={() => removeAttachment(i)}
                >
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-row">
          <button
            type="button"
            className="composer-attach"
            title={withKey('Attach', 'attach')}
            onClick={pickFiles}
            disabled={offline}
          >
            <Paperclip size={17} />
            <ShortcutHint id="attach" />
          </button>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              const value = e.target.value;
              // Typing `/note ` or `//` at the start flips into note mode; the
              // prefix is consumed (the chip replaces it in the UI). Strip
              // before setDraft so the fact preview never sees the prefix.
              const trigger = noteMode ? null : detectNoteTrigger(value);
              if (trigger) {
                enterNoteMode();
                setDraft(trigger.body);
              } else {
                setDraft(value);
              }
              setSlashIndex(0);
              if (!value.startsWith('/')) setSlashDismissed(false);
              if (armed) setArmed(false); // any edit disarms the second-Escape retract
            }}
            onBlur={() => {
              if (armed) setArmed(false);
            }}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (slash) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  setSlashIndex((slashActive + step + slash.length) % slash.length);
                  return;
                }
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                  e.preventDefault();
                  pickSlash(slash[slashActive]);
                  return;
                }
                if (e.key === 'Escape') {
                  // preventDefault also keeps Quick Chat's window-level Escape
                  // from hiding the overlay on this press.
                  e.preventDefault();
                  setSlashDismissed(true);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
                return;
              }
              if (e.key !== 'Escape') return;
              if (noteMode) {
                // Back to chat mode. preventDefault also keeps Quick Chat's
                // window-level Escape from hiding the overlay on this press.
                e.preventDefault();
                exitNoteMode();
                return;
              }
              if (escapeAction === 'single') {
                // One Escape stops the running turn and retracts the message.
                if (running) {
                  e.preventDefault();
                  setArmed(false);
                  void onRetractActiveTurn();
                }
              } else if (escapeAction === 'twoStage') {
                if (running && !armed) {
                  // First Escape: stop only; the message stays, like ⌘.
                  e.preventDefault();
                  requestStop();
                  setArmed(true);
                } else if (armed) {
                  // Second Escape: retract the just-stopped message.
                  e.preventDefault();
                  setArmed(false);
                  void onRetractActiveTurn();
                }
              }
              // escapeAction === 'off' → leave Escape alone.
            }}
            placeholder={
              offline
                ? 'Offline — you can read your chats, but not send'
                : noteMode
                  ? 'Save a note to memory…'
                  : 'Ask Stem…'
            }
            disabled={offline}
            rows={1}
            aria-autocomplete="list"
            aria-expanded={!!slash}
            aria-controls={slash ? 'composer-slash-menu' : undefined}
            aria-activedescendant={slash ? `composer-slash-${slash[slashActive].name}` : undefined}
          />
          {running && !noteMode ? (
            <button
              type="button"
              className={stopping ? 'icon-btn stop stopping' : 'icon-btn stop'}
              onClick={requestStop}
              // Not disabled while stopping: a second press re-sends the
              // interrupt, which is idempotent — and a user mashing Stop on a
              // stuck turn deserves retries, not a dead control.
              aria-label={stopping ? 'Stopping…' : 'Stop'}
              title={stopping ? 'Stopping…' : withKey('Stop', 'stop')}
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              type="button"
              className="icon-btn send"
              onClick={submit}
              disabled={offline || (noteMode ? !draft.trim() : !draft.trim() && attachments.length === 0)}
              // Not withKey: Enter is handled by the textarea's own keydown, not
              // by the shortcuts provider, so it is the one keycap here that is
              // still true in Quick Chat.
              title={`${noteMode ? 'Save note' : 'Send'} (${glyphsFor('send')})`}
            >
              <ArrowUp size={16} />
              <ShortcutHint id="send" placement="br" />
            </button>
          )}
        </div>
      </div>
      {recordSheet && threadId && (
        <RecordSheet threadId={threadId} draftId={recordSheet.draftId} onClose={() => setRecordSheet(null)} />
      )}
    </div>
  );
});
