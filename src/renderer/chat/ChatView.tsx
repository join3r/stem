import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import {
  User,
  Sparkles,
  AlertTriangle,
  File,
  RotateCcw,
  Pencil,
  GitBranch,
  Copy,
  Check,
  Trash2,
  ChevronRight,
  Clock
} from 'lucide-react';
import type { ActivityItem, ChatMessage, EscapeAction, ModelSummary, TurnAttachment, TurnTiming } from '../../shared/types';
import { ActivityRows, SourcesList } from './ActivityRows';
import { Composer, type ComposerHandle } from './Composer';
import { MdxView } from './MdxView';
import { StreamingMdxView } from './StreamingMdxView';
import { HoverTip } from '../ui/InfoTip';
import { MdxActionContext } from '../mdx/ActionContext';
import { useAutoHideScroll } from '../hooks/useAutoHideScroll';
import { EFFORT_LABELS } from '../modelLabels';
import { EmptyTips } from './EmptyTips';

const AVATAR: Record<ChatMessage['role'], { cls: string; icon: ReactNode; label: string }> = {
  user: { cls: 'you', icon: <User size={15} />, label: 'You' },
  assistant: { cls: 'stem', icon: <Sparkles size={15} />, label: 'Stem' },
  system: { cls: 'sys', icon: <AlertTriangle size={15} />, label: 'Error' }
};

// Starter prompts for the welcome screen — one per marquee capability (rich MDX
// output, interactivity, cross-chat memory, plain drafting). mdxOnly starters
// are hidden in MD mode, where component-flavored replies can't render.
const STARTERS: { title: string; prompt: string; mdxOnly?: boolean }[] = [
  {
    title: 'Plan with a chart',
    prompt: 'Plan a 6-week training ramp for a 10k — include a weekly mileage chart.',
    mdxOnly: true
  },
  {
    title: 'Interactive quiz',
    prompt: 'Give me a quick interactive quiz — five questions on European capitals.',
    mdxOnly: true
  },
  {
    title: 'Personal memory',
    prompt: 'What do you remember about me so far?'
  },
  {
    title: 'Draft something',
    prompt: 'Draft a short standup update from these bullets: shipped the settings page, reviewing PR #42, blocked on API keys.'
  }
];

// Labeled tooltip for the hover action icons. The native title tooltip is slow
// (and easy to miss), so the icons explain themselves via the shared popup after
// a short hold — long enough not to flash while the pointer crosses the row.
function ActionTip({ tip, children }: { tip: string; children: ReactNode }) {
  return (
    <HoverTip tip={tip} className="msg-tip" delayMs={300}>
      {children}
    </HoverTip>
  );
}

/** Imperative surface so App can push files into this chat's composer (drop overlay). */
export interface ChatViewHandle {
  addAttachments(files: File[]): void;
  /** Put the caret in the composer — used when a new chat opens. */
  focus(): void;
}

interface ChatViewProps {
  messages: ChatMessage[];
  running: boolean;
  streamingId: string | null;
  activity: string | null;
  /** Tool calls/web searches of the in-flight turn (live activity rows). */
  activities?: ActivityItem[];
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
  /** Re-send a message whose send failed before a turn existed (startTurn rejected —
   *  no turn id anywhere; the orphan + its error bubble are spliced out locally). */
  onRetryFailedSend: (messageId: string) => void;
  /** Edit a failed send's text and re-send it (same local splice as retry). */
  onEditFailedSend: (messageId: string, newText: string) => void;
  /** Remove a failed send and its error bubble without re-sending. */
  onDeleteFailedSend: (messageId: string) => void;
  models: ModelSummary[];
  model: ModelSummary | null;
  effort: string | null;
  serviceTier: string | null;
  format: 'md' | 'mdx';
  /** Name of the folder a fresh draft will be saved in, or null for root / a real thread. */
  draftFolderName: string | null;
  /** Show the context-fill meter in the controls row. Off in Quick Chat (too narrow). */
  showContextMeter?: boolean;
  /** The thread the composer's `/learn` saves a skill from. Passed only by the main
   *  window; null while the chat is still an unsent draft. */
  threadId?: string | null;
  onChangeEffort: (effort: string) => void;
  onChangeSpeed: (serviceTier: string | null) => void;
  onChangeFormat: (format: 'md' | 'mdx') => void;
  /** Web search for this surface (main or Quick Chat), and its switch. */
  webSearch: boolean;
  onToggleWebSearch: (next: boolean) => void;
  /** When true, mirror the live draft upward so the Memory tab can preview which
   *  facts it would inject. Off by default; the normal compose path is unaffected. */
  reportDraft?: boolean;
  onDraftChange?: (text: string) => void;
  /** Called after a memory note is saved and its confirmation flash has shown
   *  (Quick Chat collapses the overlay here). */
  onNoteSaved?: () => void;
}

// Build the inline meta label: "Claude Opus · Claude · High". Resolves the model
// id to its catalog display name plus its provider (the same model can be served
// by several providers, e.g. Anthropic vs OpenRouter); effort is appended only
// when known (some models have no effort). Speed is omitted — the pi backend has
// no service tier.
function metaTooltip(meta: ChatMessage['meta'], models: ModelSummary[]): string | undefined {
  if (!meta) return undefined;
  const parts: string[] = [];
  if (meta.model) {
    const m = models.find((x) => x.id === meta.model);
    parts.push(m ? `${m.displayName} · ${m.providerName}` : meta.model);
  }
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

// Shared cached formatter — constructing an Intl.DateTimeFormat per call is one of
// the slowest common ops in JS, and the timeline re-renders on every stream delta.
const STAMP_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
});

// Hover-revealed authored time on a user bubble, e.g. "Jun 28, 14:09". The full
// localized date/time rides in the span's title attribute.
function formatStamp(iso: string): string | undefined {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return STAMP_FORMAT.format(d);
}

// Local time-of-day for a scheduled run's collapsed header, e.g. "Jun 29, 09:00".
function formatRunTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'scheduled';
  return STAMP_FORMAT.format(d);
}

// One rendered block: either a normal message, or a scheduled-run group (the run's
// user message plus its reply, collapsed under one foldable row).
interface TimelineGroup {
  key: string;
  scheduledAt?: string;
  items: ChatMessage[];
  /**
   * A run that called `notify_user` asked for the user's attention, so its final
   * reply is pulled out of the fold and rendered as a normal Stem message; only
   * the prompt and intermediate work stay collapsed. Absent for silent runs.
   */
  alert?: ChatMessage;
}

/** Did this run call notify_user? The tool call rides the reply's activity rows. */
function ranNotify(items: ChatMessage[]): boolean {
  return items.some(
    (m) => m.role === 'assistant' && m.activity?.some((a) => a.name === 'notify_user')
  );
}

// Fold the flat message list into groups. A scheduled user message opens a group
// that absorbs the messages that follow it (its reply, tool/system rows) until the
// next user message; everything else is its own single-item group. A run that
// notified surfaces its last reply as `alert` instead of folding it.
export function buildTimelineGroups(messages: ChatMessage[]): TimelineGroup[] {
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
  for (const g of groups) {
    if (!g.scheduledAt || !ranNotify(g.items)) continue;
    const last = g.items.map((m) => m.role).lastIndexOf('assistant');
    g.alert = g.items[last];
    g.items = g.items.filter((_, i) => i !== last);
  }
  return groups;
}

// Inline editor for a user message. Owns its working text so keystrokes re-render
// only this box, not the whole timeline.
function MessageEditBox({
  initial,
  onSave,
  onCancel
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="message-edit">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSave(text);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        rows={1}
      />
      <div className="message-edit-actions">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => onSave(text)}
          disabled={!text.trim()}
        >
          Save &amp; run
        </button>
      </div>
    </div>
  );
}

export const ChatView = forwardRef<ChatViewHandle, ChatViewProps>(function ChatView({
  messages,
  running,
  streamingId,
  activity,
  activities = [],
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
  onRetryFailedSend,
  onEditFailedSend,
  onDeleteFailedSend,
  models,
  model,
  effort,
  serviceTier,
  format,
  draftFolderName,
  showContextMeter = true,
  threadId,
  onChangeEffort,
  onChangeSpeed,
  onChangeFormat,
  webSearch,
  onToggleWebSearch,
  reportDraft = false,
  onDraftChange,
  onNoteSaved
}: ChatViewProps, ref) {
  // Which user message is being edited inline (the working text lives in the box).
  const [editingId, setEditingId] = useState<string | null>(null);
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
      if (next.has(key)) next.delete(key);
      else next.add(key);
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
  const messagesRef = useAutoHideScroll<HTMLDivElement>();
  // ChatView is keyed by the active chat, so it remounts on every switch. Jump
  // instantly to the bottom on that first paint (no scrolling through history);
  // only smooth-scroll for subsequent updates within the same chat (streaming).
  const didInitialScroll = useRef(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: didInitialScroll.current ? 'smooth' : 'auto' });
    didInitialScroll.current = true;
  }, [messages, running]);

  function saveEdit(m: ChatMessage, rawText: string) {
    const text = rawText.trim();
    if (!text) return;
    // Two edit paths: a real turn is rolled back and re-run; a failed send (no
    // turn ever existed) is spliced out locally and re-sent.
    if (m.turnId) onEdit(m.turnId, text);
    else if (m.sendFailed) onEditFailedSend(m.id, text);
    else return;
    setEditingId(null);
  }

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

  // Welcome-screen subtext: lead with what Stem does (memory, rich replies), not
  // with the output format — the format toggle already lives in the composer.
  const emptyHint =
    format === 'md'
      ? 'Ask anything — Stem remembers what matters across chats. Replies come as clean Markdown.'
      : 'Ask anything — Stem remembers what matters across chats, and replies can include live charts, quizzes, and forms.';
  const starters = format === 'md' ? STARTERS.filter((s) => !s.mdxOnly) : STARTERS;

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
    // Retry/Edit/Fork need an authoritative turn id and a settled thread. Error
    // bubbles (role system) carry their failed turn's id, so they can offer
    // Copy + Retry — but not Edit/Fork/Delete, which belong to the real messages.
    // A send rejected before any turn existed leaves no id at all: its user
    // bubble is marked sendFailed, and retry/edit/delete take the local path.
    const failedSend = m.role === 'user' && !!m.sendFailed && !m.turnId;
    // For a turn-less error bubble, Retry targets the orphaned user message just
    // before it (skipping sibling error bubbles).
    const retryTarget = (() => {
      if (m.role !== 'system' || m.turnId) return null;
      for (let i = messages.findIndex((x) => x.id === m.id) - 1; i >= 0; i--) {
        const prev = messages[i];
        if (prev.role === 'system') continue;
        return prev.role === 'user' && prev.sendFailed && !prev.turnId ? prev : null;
      }
      return null;
    })();
    const canAct = !running && (!!m.turnId || failedSend || m.role === 'system');
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
          {m.role === 'assistant' && !isEditing && (m.activity?.length ?? 0) > 0 && (
            <ActivityRows items={m.activity!} running={running && isStreaming} />
          )}
          {isEditing ? (
            <MessageEditBox
              initial={m.content}
              onSave={(text) => saveEdit(m, text)}
              onCancel={() => setEditingId(null)}
            />
          ) : renderRich ? (
            isStreaming ? (
              <StreamingMdxView text={m.content} />
            ) : (
              <MdxView text={m.content} />
            )
          ) : isStreaming && !m.content && showActivity ? (
            activityIndicator
          ) : (
            <div className="message-plain">{m.content}</div>
          )}
          {m.role === 'assistant' && !isEditing && (m.sources?.length ?? 0) > 0 && (
            <SourcesList sources={m.sources!} />
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
              <ActionTip tip={copiedId === m.id ? 'Copied' : 'Copy message'}>
                <button
                  type="button"
                  className="message-action"
                  aria-label={copiedId === m.id ? 'Copied' : 'Copy message'}
                  onClick={() => copyMessage(m)}
                >
                  {copiedId === m.id ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </ActionTip>
              {(m.role === 'assistant' || m.role === 'system') && (m.turnId || retryTarget) && (
                <ActionTip
                  tip={m.role === 'system' ? 'Retry — send the message again' : 'Retry — regenerate this reply'}
                >
                  <button
                    type="button"
                    className="message-action"
                    aria-label={
                      m.role === 'system' ? 'Retry — send the message again' : 'Retry — regenerate this reply'
                    }
                    onClick={() => (m.turnId ? onRetry(m.turnId) : onRetryFailedSend(retryTarget!.id))}
                  >
                    <RotateCcw size={13} />
                  </button>
                </ActionTip>
              )}
              {m.role === 'user' && (m.turnId || failedSend) && (
                <ActionTip tip={failedSend ? 'Edit & send again' : 'Edit & re-run'}>
                  <button
                    type="button"
                    className="message-action"
                    aria-label={failedSend ? 'Edit & send again' : 'Edit & re-run'}
                    onClick={() => setEditingId(m.id)}
                  >
                    <Pencil size={13} />
                  </button>
                </ActionTip>
              )}
              {m.role !== 'system' && m.turnId && (
                <>
                  <ActionTip tip="Fork into a new chat from here">
                    <button
                      type="button"
                      className="message-action"
                      aria-label="Fork into a new chat from here"
                      onClick={() => onFork(m.turnId!)}
                    >
                      <GitBranch size={13} />
                    </button>
                  </ActionTip>
                  <ActionTip
                    tip={
                      confirmDeleteId === m.id
                        ? 'Click again to delete this turn and everything after it'
                        : 'Delete from here'
                    }
                  >
                    <button
                      type="button"
                      className={`message-action${confirmDeleteId === m.id ? ' danger' : ''}`}
                      aria-label={
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
                  </ActionTip>
                </>
              )}
              {failedSend && (
                <ActionTip
                  tip={
                    confirmDeleteId === m.id
                      ? 'Click again to remove'
                      : 'Remove — this message was never sent'
                  }
                >
                  <button
                    type="button"
                    className={`message-action${confirmDeleteId === m.id ? ' danger' : ''}`}
                    aria-label={
                      confirmDeleteId === m.id ? 'Click again to remove' : 'Remove — this message was never sent'
                    }
                    onClick={() => {
                      if (confirmDeleteId === m.id) {
                        setConfirmDeleteId(null);
                        onDeleteFailedSend(m.id);
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
                </ActionTip>
              )}
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
            <div className="empty-starters">
              {starters.map((s) => (
                <button
                  key={s.title}
                  type="button"
                  className="empty-starter"
                  disabled={running}
                  onClick={() => onSend(s.prompt, [])}
                >
                  <strong>{s.title}</strong>
                  <span>{s.prompt}</span>
                </button>
              ))}
            </div>
            <EmptyTips format={format} />
            {draftFolderName && (
              <p className="empty-folder">This chat will be saved in “{draftFolderName}”.</p>
            )}
          </div>
        )}
        {buildTimelineGroups(messages).map((g) => {
          if (!g.scheduledAt) return g.items.map(renderMessage);
          const open = expandedRuns.has(g.key);
          return (
            <Fragment key={g.key}>
              <div className={`sched-run${open ? ' open' : ''}`}>
                <button type="button" className="sched-run-head" onClick={() => toggleRun(g.key)}>
                  <ChevronRight size={13} className="sched-run-chevron" />
                  <Clock size={13} />
                  <span className="sched-run-title">Scheduled run — {formatRunTime(g.scheduledAt)}</span>
                </button>
                {open && <div className="sched-run-body">{g.items.map(renderMessage)}</div>}
              </div>
              {g.alert && renderMessage(g.alert)}
            </Fragment>
          );
        })}
        {showActivity && !streamingMsg && (
          <div className="message message-assistant activity-row">
            <div className="msg-avatar stem">{AVATAR.assistant.icon}</div>
            <div className="message-body">
              {activities.length > 0 && <ActivityRows items={activities} running />}
              {/* The generic dots only when no tool row is already pulsing. */}
              {!activities.some((a) => a.status === 'running') && activityIndicator}
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <Composer
        ref={ref as React.Ref<ComposerHandle>}
        messages={messages}
        running={running}
        escapeAction={escapeAction}
        onSend={onSend}
        onInterrupt={onInterrupt}
        onRetractActiveTurn={onRetractActiveTurn}
        pendingRestore={pendingRestore}
        onRestoreConsumed={onRestoreConsumed}
        model={model}
        effort={effort}
        serviceTier={serviceTier}
        format={format}
        showContextMeter={showContextMeter}
        threadId={threadId}
        onChangeEffort={onChangeEffort}
        onChangeSpeed={onChangeSpeed}
        onChangeFormat={onChangeFormat}
        webSearch={webSearch}
        onToggleWebSearch={onToggleWebSearch}
        reportDraft={reportDraft}
        onDraftChange={onDraftChange}
        onNoteSaved={onNoteSaved}
      />
    </div>
    </MdxActionContext.Provider>
  );
});
