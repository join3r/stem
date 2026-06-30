import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import {
  Square,
  ArrowUp,
  Paperclip,
  User,
  Sparkles,
  AlertTriangle,
  File,
  X,
  RotateCcw,
  Pencil,
  GitBranch,
  Copy,
  Check,
  Trash2,
  ChevronRight,
  Clock
} from 'lucide-react';
import type { ChatMessage, EscapeAction, ModelSummary, TurnAttachment, TurnTiming } from '../../shared/types';
import { ContextMeter } from './ContextMeter';
import { MdxView } from './MdxView';
import { ShortcutHint, useShortcut } from '../shortcuts';
import { MdxActionContext } from '../mdx/ActionContext';
import { mdxFeatureLabels } from '../mdx/components';
import { useAutoHideScroll } from '../hooks/useAutoHideScroll';
import { EFFORT_LABELS } from '../modelLabels';

const AVATAR: Record<ChatMessage['role'], { cls: string; icon: ReactNode; label: string }> = {
  user: { cls: 'you', icon: <User size={15} />, label: 'You' },
  assistant: { cls: 'stem', icon: <Sparkles size={15} />, label: 'Stem' },
  system: { cls: 'sys', icon: <AlertTriangle size={15} />, label: 'Error' }
};

const MAX_COMPOSER_HEIGHT = 180;

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

/** Imperative surface so App can push files into this chat's composer (drop overlay). */
export interface ChatViewHandle {
  addAttachments(files: File[]): void;
}

interface ChatViewProps {
  messages: ChatMessage[];
  running: boolean;
  streamingId: string | null;
  activity: string | null;
  onSend: (text: string, attachments: TurnAttachment[]) => void;
  onInterrupt: () => void;
  /** Escape-key behavior in the composer (off / single / two-stage). */
  escapeAction: EscapeAction;
  /** Stop the running turn and retract its message; the text/attachments come back
   *  via `pendingRestore`. */
  onRetractActiveTurn: () => void | Promise<void>;
  /** Text/attachments to refill the composer with after a retract (nonce-keyed). */
  pendingRestore: { text: string; attachments: TurnAttachment[]; nonce: number } | null;
  /** Called once a `pendingRestore` has been consumed (or intentionally skipped). */
  onRestoreConsumed: () => void;
  /** Regenerate the reply for a turn (assistant message). */
  onRetry: (turnId: string) => void;
  /** Edit a user message's text and re-run from that turn. */
  onEdit: (turnId: string, newText: string) => void;
  /** Branch the conversation into a new chat ending at this turn. */
  onFork: (turnId: string) => void;
  /** Delete this turn and everything after it (truncate, no re-send). */
  onDelete: (turnId: string) => void;
  models: ModelSummary[];
  model: ModelSummary | null;
  effort: string | null;
  serviceTier: string | null;
  format: 'md' | 'mdx';
  /** Name of the folder a fresh draft will be saved in, or null for root / a real thread. */
  draftFolderName: string | null;
  /** Show the context-fill meter in the controls row. Off in Quick Chat (too narrow). */
  showContextMeter?: boolean;
  onChangeEffort: (effort: string) => void;
  onChangeSpeed: (serviceTier: string | null) => void;
  onChangeFormat: (format: 'md' | 'mdx') => void;
  /** When true, mirror the live draft upward so the Memory tab can preview which
   *  facts it would inject. Off by default; the normal compose path is unaffected. */
  reportDraft?: boolean;
  onDraftChange?: (text: string) => void;
}

// Build the inline meta label: "Claude Opus · High". Resolves the model id to its
// catalog display name; effort is appended only when known (some models have no
// effort). Speed is omitted — the pi backend has no service tier.
function metaTooltip(meta: ChatMessage['meta'], models: ModelSummary[]): string | undefined {
  if (!meta) return undefined;
  const parts: string[] = [];
  if (meta.model) parts.push(models.find((m) => m.id === meta.model)?.displayName ?? meta.model);
  if (meta.effort) parts.push(EFFORT_LABELS[meta.effort] ?? meta.effort);
  return parts.length ? parts.join(' · ') : undefined;
}

// Build the answer-time label: "12.4s · 8.1s thinking · 2.0s tools". Total is the
// headline; thinking/tools are appended only when measurable (≥100ms) so trivial
// turns just show the total. The parts intentionally don't sum to the total —
// time-to-first-token and recall/build time sit outside any phase bucket.
function formatTiming(t: TurnTiming): string | undefined {
  const sec = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  const parts: string[] = [];
  if (t.totalMs != null) parts.push(sec(t.totalMs));
  if (t.thinkingMs >= 100) parts.push(`${sec(t.thinkingMs)} thinking`);
  if (t.toolMs >= 100) parts.push(`${sec(t.toolMs)} tools`);
  return parts.length ? parts.join(' · ') : undefined;
}

// Hover-revealed authored time on a user bubble, e.g. "Jun 28, 14:09". The full
// localized date/time rides in the span's title attribute.
function formatStamp(iso: string): string | undefined {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Local time-of-day for a scheduled run's collapsed header, e.g. "Jun 29, 09:00".
function formatRunTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'scheduled';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// One rendered block: either a normal message, or a scheduled-run group (the run's
// user message plus its reply, collapsed under one foldable row).
interface TimelineGroup {
  key: string;
  scheduledAt?: string;
  items: ChatMessage[];
}

// Fold the flat message list into groups. A scheduled user message opens a group
// that absorbs the messages that follow it (its reply, tool/system rows) until the
// next user message; everything else is its own single-item group.
function buildTimelineGroups(messages: ChatMessage[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  for (const m of messages) {
    const open = groups[groups.length - 1];
    if (m.role === 'user' && m.scheduled) {
      groups.push({ key: `run-${m.id}`, scheduledAt: m.scheduled.at, items: [m] });
    } else if (open?.scheduledAt && m.role !== 'user') {
      open.items.push(m);
    } else {
      groups.push({ key: m.id, items: [m] });
    }
  }
  return groups;
}

export const ChatView = forwardRef<ChatViewHandle, ChatViewProps>(function ChatView({
  messages,
  running,
  streamingId,
  activity,
  onSend,
  onInterrupt,
  escapeAction,
  onRetractActiveTurn,
  pendingRestore,
  onRestoreConsumed,
  onRetry,
  onEdit,
  onFork,
  onDelete,
  models,
  model,
  effort,
  serviceTier,
  format,
  draftFolderName,
  showContextMeter = true,
  onChangeEffort,
  onChangeSpeed,
  onChangeFormat,
  reportDraft = false,
  onDraftChange
}: ChatViewProps, ref) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<TurnAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // Two-stage Escape: after the first Escape stops the turn, `armed` lets a second
  // Escape retract the just-stopped message. Cleared the moment the user acts
  // (types, sends, blurs); a chat switch remounts ChatView, resetting it too.
  const [armed, setArmed] = useState(false);
  // Which user message is being edited inline, and its working text.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  // Transient per-message UI: which bubble just got copied (check icon), and which
  // delete button is armed (first click → red; second click within 2.5s deletes).
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Which scheduled-run groups are expanded (collapsed by default — they're an
  // audit trail, not the focus). Keyed by the group's stable key.
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(new Set());
  const toggleRun = useCallback((key: string) => {
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const copyMessage = useCallback((m: ChatMessage) => {
    void navigator.clipboard.writeText(m.content).then(() => {
      setCopiedId(m.id);
      window.setTimeout(() => setCopiedId((c) => (c === m.id ? null : c)), 1500);
    });
  }, []);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useAutoHideScroll<HTMLDivElement>();
  // ChatView is keyed by the active chat, so it remounts on every switch. Jump
  // instantly to the bottom on that first paint (no scrolling through history);
  // only smooth-scroll for subsequent updates within the same chat (streaming).
  const didInitialScroll = useRef(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: didInitialScroll.current ? 'smooth' : 'auto' });
    didInitialScroll.current = true;
  }, [messages, running]);

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

  function submit() {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || running) return;
    setArmed(false);
    onSend(text, attachments);
    setDraft('');
    setAttachments([]);
  }

  function startEdit(m: ChatMessage) {
    setEditingId(m.id);
    setEditDraft(m.content);
  }
  function cancelEdit() {
    setEditingId(null);
    setEditDraft('');
  }
  function saveEdit(turnId: string | undefined) {
    if (!turnId || !editDraft.trim()) return;
    onEdit(turnId, editDraft);
    setEditingId(null);
    setEditDraft('');
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
  useImperativeHandle(ref, () => ({ addAttachments: (files) => void addFilesToComposer(files) }), [
    addFilesToComposer
  ]);

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

  const hasFast = !!model?.serviceTiers.some((t) => t.id === 'priority');

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
    if (running) onInterrupt();
  });

  // Show the working indicator while a turn runs and no answer text is streaming
  // yet (reasoning / tool calls happen before the first token, when no assistant
  // bubble exists). It's replaced by the streamed reply once content arrives.
  const streamingMsg = messages.find((m) => m.id === streamingId);
  const showActivity = running && !(streamingMsg && streamingMsg.content);

  // The pulsing-dots "Thinking…" indicator. It lives inside the assistant bubble
  // while that turn has no text yet (so there's a single Stem row, not two), and
  // only stands alone in the brief window before the bubble even exists.
  const activityIndicator = (
    <div className="activity" role="status" aria-live="polite">
      <span className="activity-dots" aria-hidden="true">
        <span className="activity-dot" />
        <span className="activity-dot" />
        <span className="activity-dot" />
      </span>
      <span className="activity-label">{activity ?? 'Working…'}</span>
    </div>
  );

  // Bridge for interactive MDX components (Quiz/Form): submitting routes through the
  // normal send path, so it appears as a user message just like typing would.
  const mdxActions = useMemo(
    () => ({ submit: (text: string) => onSend(text, []), running }),
    [onSend, running]
  );

  // Welcome-screen subtext: in MDX mode advertise the live component set (from the
  // registry, so it can't drift); in MD mode there are no components to offer.
  const emptyHint =
    format === 'md'
      ? "Ask me to explain something. I'll reply in plain Markdown."
      : `Ask me to explain something. I can use ${new Intl.ListFormat('en', {
          style: 'long',
          type: 'conjunction'
        }).format(mdxFeatureLabels)}.`;

  // One message bubble. Extracted so the timeline can render both standalone messages
  // and the contents of a collapsed scheduled-run group with identical markup.
  const renderMessage = (m: ChatMessage): ReactNode => {
    const a = AVATAR[m.role];
    // Render finalized assistant replies via the MDX renderer. Plain Markdown
    // (.md) is safe to render live while streaming — it has no JSX to break
    // mid-tag — so we render it progressively too (once there's content to show).
    // MDX stays plain-text until complete to avoid flickering half-written tags.
    const isStreaming = m.id === streamingId;
    const renderRich =
      m.role === 'assistant' && (!isStreaming || (format === 'md' && !!m.content));
    const metaText = m.role === 'assistant' ? metaTooltip(m.meta, models) : undefined;
    const isEditing = editingId === m.id;
    // Retry/Edit/Fork need an authoritative turn id and a settled thread.
    const canAct = !running && !!m.turnId && (m.role === 'user' || m.role === 'assistant');
    return (
      <div key={m.id} className={`message message-${m.role}`}>
        <div className={`msg-avatar ${a.cls}`}>{a.icon}</div>
        <div className="message-body">
          <div className="message-who">
            {a.label}
            {metaText && <span className="message-meta">{metaText}</span>}
            {m.role === 'assistant' && m.timing && formatTiming(m.timing) && (
              <span className="message-timing" title="total · thinking · tool execution">
                {formatTiming(m.timing)}
              </span>
            )}
            {m.role === 'user' && m.createdAt && formatStamp(m.createdAt) && (
              <span className="message-meta" title={new Date(m.createdAt).toLocaleString()}>
                {formatStamp(m.createdAt)}
              </span>
            )}
          </div>
          {isEditing ? (
            <div className="message-edit">
              <textarea
                autoFocus
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    saveEdit(m.turnId);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
                rows={1}
              />
              <div className="message-edit-actions">
                <button type="button" className="push" onClick={cancelEdit}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => saveEdit(m.turnId)}
                  disabled={!editDraft.trim()}
                >
                  Save &amp; run
                </button>
              </div>
            </div>
          ) : renderRich ? (
            <MdxView text={m.content} />
          ) : isStreaming && !m.content && showActivity ? (
            activityIndicator
          ) : (
            <div className="message-plain">{m.content}</div>
          )}
          {!isEditing && m.attachments && m.attachments.length > 0 && (
            <div className="message-attachments">
              {m.attachments.map((att, i) =>
                att.kind === 'image' && att.dataUrl ? (
                  <img
                    key={i}
                    className="message-image"
                    src={att.dataUrl}
                    alt={att.name ?? 'attachment'}
                  />
                ) : (
                  <span className="attachment-chip" key={i}>
                    <File size={13} />
                    <span className="attachment-name">{att.name ?? 'file'}</span>
                  </span>
                )
              )}
            </div>
          )}
          {canAct && !isEditing && (
            <div className="message-actions">
              <button
                type="button"
                className="message-action"
                title={copiedId === m.id ? 'Copied' : 'Copy message'}
                onClick={() => copyMessage(m)}
              >
                {copiedId === m.id ? <Check size={13} /> : <Copy size={13} />}
              </button>
              {m.role === 'assistant' && (
                <button
                  type="button"
                  className="message-action"
                  title="Retry — regenerate this reply"
                  onClick={() => onRetry(m.turnId!)}
                >
                  <RotateCcw size={13} />
                </button>
              )}
              {m.role === 'user' && (
                <button
                  type="button"
                  className="message-action"
                  title="Edit & re-run"
                  onClick={() => startEdit(m)}
                >
                  <Pencil size={13} />
                </button>
              )}
              <button
                type="button"
                className="message-action"
                title="Fork into a new chat from here"
                onClick={() => onFork(m.turnId!)}
              >
                <GitBranch size={13} />
              </button>
              <button
                type="button"
                className={`message-action${confirmDeleteId === m.id ? ' danger' : ''}`}
                title={
                  confirmDeleteId === m.id
                    ? 'Click again to delete this turn and everything after it'
                    : 'Delete from here'
                }
                onClick={() => {
                  if (confirmDeleteId === m.id) {
                    setConfirmDeleteId(null);
                    onDelete(m.turnId!);
                  } else {
                    setConfirmDeleteId(m.id);
                    window.setTimeout(
                      () => setConfirmDeleteId((c) => (c === m.id ? null : c)),
                      2500
                    );
                  }
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <MdxActionContext.Provider value={mdxActions}>
    <div className="chat">
      <div className="messages" ref={messagesRef}>
        {messages.length === 0 && (
          <div className="empty">
            <h2>Stem</h2>
            <p>{emptyHint}</p>
            {draftFolderName && (
              <p className="empty-folder">This chat will be saved in “{draftFolderName}”.</p>
            )}
          </div>
        )}
        {buildTimelineGroups(messages).map((g) => {
          if (!g.scheduledAt) return g.items.map(renderMessage);
          const open = expandedRuns.has(g.key);
          return (
            <div key={g.key} className={`sched-run${open ? ' open' : ''}`}>
              <button type="button" className="sched-run-head" onClick={() => toggleRun(g.key)}>
                <ChevronRight size={13} className="sched-run-chevron" />
                <Clock size={13} />
                <span className="sched-run-title">Scheduled run — {formatRunTime(g.scheduledAt)}</span>
              </button>
              {open && <div className="sched-run-body">{g.items.map(renderMessage)}</div>}
            </div>
          );
        })}
        {showActivity && !streamingMsg && (
          <div className="message message-assistant activity-row">
            <div className="msg-avatar stem">{AVATAR.assistant.icon}</div>
            <div className="message-body">{activityIndicator}</div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <div className="composer-controls">
          {model && model.supportedEfforts.length > 0 && (
            <div className="seg-ctl compact" role="group" aria-label="Reasoning effort">
              <ShortcutHint id="cycle-effort" />
              {model.supportedEfforts.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={effort === e ? 'active' : ''}
                  onClick={() => onChangeEffort(e)}
                  disabled={running}
                >
                  {EFFORT_LABELS[e] ?? e}
                </button>
              ))}
            </div>
          )}
          {hasFast && (
            <div className="seg-ctl compact" role="group" aria-label="Speed">
              <ShortcutHint id="toggle-speed" />
              <button
                type="button"
                className={serviceTier === 'priority' ? '' : 'active'}
                onClick={() => onChangeSpeed(null)}
                disabled={running}
              >
                Standard
              </button>
              <button
                type="button"
                className={serviceTier === 'priority' ? 'active' : ''}
                onClick={() => onChangeSpeed('priority')}
                disabled={running}
                title="1.5× speed, increased usage"
              >
                Fast
              </button>
            </div>
          )}
          <div className="seg-ctl compact" role="group" aria-label="Output format">
            <ShortcutHint id="toggle-format" />
            <button
              type="button"
              className={format === 'mdx' ? 'active' : ''}
              onClick={() => onChangeFormat('mdx')}
              disabled={running}
              title="Rich components (callouts, steps, collapsibles)"
            >
              MDX
            </button>
            <button
              type="button"
              className={format === 'md' ? 'active' : ''}
              onClick={() => onChangeFormat('md')}
              disabled={running}
              title="Plain Markdown only"
            >
              MD
            </button>
          </div>
          {showContextMeter && <ContextMeter messages={messages} model={model} />}
        </div>
        <div
          className={`composer-field${dragOver ? ' drag-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
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
            <button type="button" className="composer-attach" title="Attach" onClick={pickFiles}>
              <Paperclip size={17} />
              <ShortcutHint id="attach" />
            </button>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
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
                    onInterrupt();
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
              placeholder="Ask Stem…"
              rows={1}
            />
            {running ? (
              <button type="button" className="icon-btn stop" onClick={onInterrupt} title="Stop">
                <Square size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="icon-btn send"
                onClick={submit}
                disabled={!draft.trim() && attachments.length === 0}
                title="Send"
              >
                <ArrowUp size={16} />
                <ShortcutHint id="send" placement="br" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
    </MdxActionContext.Provider>
  );
});
