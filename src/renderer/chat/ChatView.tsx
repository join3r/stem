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
  GitBranch
} from 'lucide-react';
import type { ChatMessage, ModelSummary, TurnAttachment } from '../../shared/types';
import { MdxView } from './MdxView';
import { MdxActionContext } from '../mdx/ActionContext';
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
  /** Regenerate the reply for a turn (assistant message). */
  onRetry: (turnId: string) => void;
  /** Edit a user message's text and re-run from that turn. */
  onEdit: (turnId: string, newText: string) => void;
  /** Branch the conversation into a new chat ending at this turn. */
  onFork: (turnId: string) => void;
  models: ModelSummary[];
  model: ModelSummary | null;
  effort: string | null;
  serviceTier: string | null;
  format: 'md' | 'mdx';
  onChangeEffort: (effort: string) => void;
  onChangeSpeed: (serviceTier: string | null) => void;
  onChangeFormat: (format: 'md' | 'mdx') => void;
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

export const ChatView = forwardRef<ChatViewHandle, ChatViewProps>(function ChatView({
  messages,
  running,
  streamingId,
  activity,
  onSend,
  onInterrupt,
  onRetry,
  onEdit,
  onFork,
  models,
  model,
  effort,
  serviceTier,
  format,
  onChangeEffort,
  onChangeSpeed,
  onChangeFormat
}: ChatViewProps, ref) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<TurnAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // Which user message is being edited inline, and its working text.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
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

  function submit() {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || running) return;
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

  // Show the working indicator while a turn runs and no answer text is streaming
  // yet (reasoning / tool calls happen before the first token, when no assistant
  // bubble exists). It's replaced by the streamed reply once content arrives.
  const streamingMsg = messages.find((m) => m.id === streamingId);
  const showActivity = running && !(streamingMsg && streamingMsg.content);

  // Bridge for interactive MDX components (Quiz/Form): submitting routes through the
  // normal send path, so it appears as a user message just like typing would.
  const mdxActions = useMemo(
    () => ({ submit: (text: string) => onSend(text, []), running }),
    [onSend, running]
  );

  return (
    <MdxActionContext.Provider value={mdxActions}>
    <div className="chat">
      <div className="messages" ref={messagesRef}>
        {messages.length === 0 && (
          <div className="empty">
            <h2>Stem</h2>
            <p>Ask me to explain something. I can use callouts, steps, and collapsible details.</p>
          </div>
        )}
        {messages.map((m) => {
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
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {showActivity && (
          <div className="message message-assistant activity-row" role="status" aria-live="polite">
            <div className="msg-avatar stem">{AVATAR.assistant.icon}</div>
            <div className="message-body">
              <div className="activity">
                <span className="activity-dots" aria-hidden="true">
                  <span className="activity-dot" />
                  <span className="activity-dot" />
                  <span className="activity-dot" />
                </span>
                <span className="activity-label">{activity ?? 'Working…'}</span>
              </div>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <div className="composer-controls">
          {model && model.supportedEfforts.length > 0 && (
            <div className="seg-ctl compact" role="group" aria-label="Reasoning effort">
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
            </button>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={onPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
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
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
    </MdxActionContext.Provider>
  );
});
