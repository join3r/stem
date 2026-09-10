import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react';
import { Square, ArrowUp, Paperclip, File, X, Check, NotebookPen, Globe, Zap } from 'lucide-react';
import type {
  ChatMessage,
  EscapeAction,
  ModelSummary,
  SkillLearnResult,
  TurnAttachment
} from '../../shared/types';
import { ContextMeter } from './ContextMeter';
import { useOffline } from '../hooks/useServerReachable';
import { ShortcutHint, glyphsFor, useShortcut, useShortcutsBound, type ShortcutId } from '../shortcuts';
import { EffortModelControl } from '../ui/EffortModelControl';
import { NOTE_CONFIRM_MS, NOTE_FLASH_TEXT, detectNoteTrigger, noteBodyValid, useNoteMode } from '../noteMode';
import { clearDraft, readDraft, writeDraft } from './draft-store';

const MAX_COMPOSER_HEIGHT = 180;

// How long a `/learn` outcome stays up. Much longer than the note flash: main
// writes these as full sentences explaining what was (or wasn't) saved, not as a
// two-word confirmation that can be read at a glance.
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

// `/learn [focus]` saves a skill from the turn that just finished instead of
// sending the draft to the model. Matched at submit rather than while typing —
// unlike `/note` this is a one-shot action, not a mode the composer sits in.
//
// `/learn` is the only command the composer intercepts. That is why this is a
// literal match and not a command table: a framework for one command would be
// mostly guesses about the second one. Add it when there is a second one.
export function detectLearnCommand(text: string): { focus: string } | null {
  if (text === '/learn') return { focus: '' };
  if (text.startsWith('/learn ')) return { focus: text.slice('/learn '.length).trim() };
  return null;
}

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
  onNoteSaved
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

  // `/learn` gets its own pending state rather than borrowing `running`: it starts
  // no turn, and on ask mode it stays outstanding until the user answers the
  // approval card — which may be a while, so nothing here may block the composer.
  const [learning, setLearning] = useState(false);
  const [learnNotice, setLearnNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const learnTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (learnTimer.current != null) window.clearTimeout(learnTimer.current);
  }, []);

  // Main phrases every outcome for the user — including the refusals — so its
  // message is shown as written rather than re-explained here.
  const runLearn = useCallback(async (thread: string, focus: string) => {
    if (learnTimer.current != null) window.clearTimeout(learnTimer.current);
    setLearnNotice(null);
    setLearning(true);
    let result: SkillLearnResult;
    try {
      result = await window.stem.learnFromLastTurn(thread, focus || undefined);
    } catch {
      result = { ok: false, message: 'Couldn’t save a skill — try restarting Stem.' };
    } finally {
      setLearning(false);
    }
    setLearnNotice({ ok: result.ok, text: result.message });
    learnTimer.current = window.setTimeout(() => setLearnNotice(null), LEARN_NOTICE_MS);
  }, []);

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
    if ((!text && attachments.length === 0) || running) return;
    const learn = detectLearnCommand(text);
    if (learn && threadId) {
      // A second `/learn` while one is still outstanding is dropped, but the draft
      // still clears — the alternative is sending the literal text to the model.
      if (!learning) void runLearn(threadId, learn.focus);
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
              {learnNotice?.text ?? 'Learning from the last reply…'}
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
              if (armed) setArmed(false); // any edit disarms the second-Escape retract
            }}
            onBlur={() => {
              if (armed) setArmed(false);
            }}
            onPaste={onPaste}
            onKeyDown={(e) => {
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
    </div>
  );
});
