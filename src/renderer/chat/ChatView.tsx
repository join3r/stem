import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
  Pin,
  PinOff,
  ChevronRight,
  Clock,
  Lock
} from 'lucide-react';
import type {
  ActivityItem,
  ChatMessage,
  ChatPin,
  EscapeAction,
  ModelSummary,
  TurnAttachment,
  TurnTiming
} from '../../shared/types';
import { formatSystemVersion } from '../../shared/sys-version';
import { ActivityRows, SourcesList } from './ActivityRows';
import { GeneratedImages } from './GeneratedImage';
import { Composer, type ComposerHandle } from './Composer';
import { RecordingDraftCard } from './RecordingDraftCard';
import { loadDrafts, readDrafts, subscribeRecorder } from './recorder-store';
import { ApprovalCard } from '../manage/ApprovalCard';
import type { PendingApproval } from '../manage/approvalQueue';
import { MdxView } from './MdxView';
import { StreamingMdxView } from './StreamingMdxView';
import { HoverTip } from '../ui/InfoTip';
import { EARLIER_MESSAGE, LATEST_MESSAGE, MdxActionContext, MdxMessageContext } from '../mdx/ActionContext';
import { useAutoHideScroll } from '../hooks/useAutoHideScroll';
import { INITIAL_FOLLOW, onScrollEvent, type FollowState } from './followBottom';
import { EFFORT_LABELS } from '../modelLabels';
import { EmptyTips } from './EmptyTips';
import { PinBoard } from './PinBoard';
import { SelectionPin } from './SelectionPin';
import { locatePassage, messageAnchor, pinSource } from './pins';
import { useChatPins } from '../hooks/useChatPins';

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
  /** The fresh draft is set to start a private chat (see StartTurnInput.private). */
  draftPrivate?: boolean;
  /** Present only for a fresh draft: flips `draftPrivate`. An existing chat's flag is fixed. */
  onToggleDraftPrivate?: () => void;
  /** Show the context-fill meter in the controls row. Off in Quick Chat (too narrow). */
  showContextMeter?: boolean;
  /** The thread the composer's `/learn` saves a skill from. Passed only by the main
   *  window; null while the chat is still an unsent draft. */
  threadId?: string | null;
  /** Forwarded to the Composer so unsent text survives a chat switch. */
  draftKey?: string;
  /** Permission asks raised by this chat's turn, oldest first. The head renders
   *  as a card pinned above the composer — the turn waits on it. */
  approvals?: PendingApproval[];
  onChangeEffort: (effort: string) => void;
  /** Switch the model the next turn runs on (the composer's effort control opens the picker). */
  onSelectModel: (id: string) => void;
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
  /** Show the chat's pinboard. Main window only — Quick Chat is too narrow and too brief. */
  pinboard?: boolean;
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

// Shared cached formatters — constructing an Intl.DateTimeFormat per call is one of
// the slowest common ops in JS, and the timeline re-renders on every stream delta.
// They take the OS clock format (region + 12/24-hour), not Chromium's app locale.
const OS_TIME = typeof window !== 'undefined' ? window.stem?.timeLocale : undefined;
const osFormat = (options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(OS_TIME?.locale, { ...options, ...(OS_TIME?.hourCycle ? { hourCycle: OS_TIME.hourCycle } : {}) });
const STAMP_FORMAT = osFormat({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const TIME_FORMAT = osFormat({ hour: '2-digit', minute: '2-digit' });
const DAY_FORMAT = osFormat({ month: 'short', day: 'numeric' });
const FULL_FORMAT = osFormat({ dateStyle: 'medium', timeStyle: 'medium' });

// When a message was sent (user) or finished (assistant), revealed on hover in
// the gutter left of the avatar: the time, the day under it when it isn't today.
function messageStamp(iso: string): { time: string; day?: string; full: string } | undefined {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const today = d.toDateString() === new Date().toDateString();
  return { time: TIME_FORMAT.format(d), ...(today ? {} : { day: DAY_FORMAT.format(d) }), full: FULL_FORMAT.format(d) };
}

// Tooltip on the answer-time label: the breakdown legend plus speed and output size.
function timingTitle(m: ChatMessage): string {
  const tps = tokensPerSecond(m);
  const out = m.timing?.outputTokens ?? m.usage?.output;
  const lines = ['total · thinking · tool execution'];
  if (tps !== undefined) lines.push(`${tps.toFixed(0)} tok/s`);
  if (out) lines.push(`${out.toLocaleString()} output tokens`);
  return lines.join('\n');
}

// Generation speed: the turn's output tokens over the time its model calls spent
// streaming them, measured per call on the server (pi/generation-speed.ts), so a
// tool turn has one too. Turns from before that measurement fall back to the old
// estimate, which only holds without tool time: a tool turn is several model
// calls, and its usage covers just the last one.
function tokensPerSecond(m: ChatMessage): number | undefined {
  const t = m.timing;
  if (!t) return undefined;
  if (t.outputTokens && t.generationMs) {
    return t.generationMs >= 200 ? t.outputTokens / (t.generationMs / 1000) : undefined;
  }
  const out = m.usage?.output;
  if (!out || t.toolMs >= 100) return undefined;
  const ms = t.thinkingMs + t.answerMs;
  return ms >= 200 ? out / (ms / 1000) : undefined;
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

/** The DOM range a pinned passage covers inside a rendered message, if it is still there. */
function passageRange(messageEl: HTMLElement, text: string): Range | null {
  const body = messageEl.querySelector('.message-body');
  if (!body) return null;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    // The author line and the action row are chrome, not the message.
    if (!(n.parentElement?.closest('.message-who, .message-actions'))) nodes.push(n as Text);
  }
  const at = locatePassage(nodes.map((n) => n.data), text);
  if (!at) return null;
  const range = document.createRange();
  range.setStart(nodes[at.startPiece], at.startOffset);
  range.setEnd(nodes[at.endPiece], at.endOffset);
  return range;
}

let passageTimer: number | null = null;

/** Light the passage up for a moment (CSS Custom Highlight: no DOM rewriting). */
function highlightPassage(range: Range): void {
  const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!highlights || !HighlightCtor) return;
  highlights.set('pin-passage', new HighlightCtor(range));
  if (passageTimer !== null) window.clearTimeout(passageTimer);
  passageTimer = window.setTimeout(() => {
    highlights.delete('pin-passage');
    passageTimer = null;
  }, 2200);
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
  draftPrivate = false,
  onToggleDraftPrivate,
  showContextMeter = true,
  threadId,
  draftKey,
  approvals,
  onChangeEffort,
  onSelectModel,
  onChangeSpeed,
  onChangeFormat,
  webSearch,
  onToggleWebSearch,
  reportDraft = false,
  onDraftChange,
  onNoteSaved,
  pinboard = false
}: ChatViewProps, ref) {
  const board = useChatPins(pinboard ? threadId : null);
  // Draft skills this chat's recordings became (recorder-store.ts): loaded on
  // open, kept current by pushes, shown after the conversation.
  const recordingDrafts = useSyncExternalStore(subscribeRecorder, () => readDrafts(threadId));
  useEffect(() => {
    if (threadId) void loadDrafts(threadId);
  }, [threadId]);
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
  // Follow new content only while the reader is at the bottom. A reader who has
  // scrolled up into a long chat keeps their place through history refreshes
  // (window focus, reconnect), scheduled runs and other devices' messages.
  const follow = useRef<FollowState>(INITIAL_FOLLOW);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const onScroll = () => {
      follow.current = onScrollEvent(follow.current, el);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [messagesRef]);

  useEffect(() => {
    if (didInitialScroll.current && !follow.current.following) return;
    endRef.current?.scrollIntoView({ behavior: didInitialScroll.current ? 'smooth' : 'auto' });
    didInitialScroll.current = true;
  }, [messages, running]);

  // Sending is an explicit ask to see the newest message: re-engage the follow so
  // the optimistic user bubble and the reply that streams under it stay in view.
  const sendAndFollow = useCallback(
    (text: string, attachments: TurnAttachment[]) => {
      follow.current = { ...follow.current, following: true };
      onSend(text, attachments);
    },
    [onSend]
  );

  // Bring a pin's source message into view and flash it. Scrolling up is
  // reading history, so the follow-the-stream behaviour lets go of the bottom.
  const jumpToPin = useCallback((pin: ChatPin, source: ChatMessage) => {
    const el = messagesRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(source.id)}"]`);
    if (!el) return;
    follow.current = { ...follow.current, following: false };
    // A passage lights up exactly where it is, when it can still be found.
    const passage = pin.kind === 'passage' ? passageRange(el, pin.text) : null;
    if (passage) {
      const target = passage.startContainer.parentElement ?? el;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      highlightPassage(passage);
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('pin-flash');
    // Restart the animation when the same message is jumped to twice in a row.
    void el.offsetWidth;
    el.classList.add('pin-flash');
    window.setTimeout(() => el.classList.remove('pin-flash'), 1600);
  }, [messagesRef]);

  // The message's own pin, if it has one: the action row's Pin toggles it. A
  // turn that rebuilt as several bubbles shares one anchor, so the pin belongs
  // to the bubble its text came from, not to every bubble of the turn.
  const messagePinOf = (m: ChatMessage): ChatPin | undefined =>
    board.pins.find((p) => p.kind === 'message' && pinSource(p, messages) === m);
  const togglePin = (m: ChatMessage) => {
    const pinned = messagePinOf(m);
    const anchor = messageAnchor(m);
    if (pinned) void board.remove(pinned.id);
    else if (anchor && (m.role === 'user' || m.role === 'assistant')) {
      void board.add({ kind: 'message', text: m.content, anchor, role: m.role });
    }
  };
  const pinPassage = useCallback(
    (text: string, m: ChatMessage) => {
      const anchor = messageAnchor(m);
      if (!anchor || (m.role !== 'user' && m.role !== 'assistant')) return;
      void board.add({ kind: 'passage', text, anchor, role: m.role });
    },
    [board]
  );
  const pinNote = useCallback((text: string) => board.add({ kind: 'note', text }), [board]);
  const pinsOn = pinboard && !!threadId;

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
  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;
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
    () => ({ submit: (text: string) => sendAndFollow(text, []), running }),
    [sendAndFollow, running]
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
    // Assistant replies render through the MDX renderer, live while streaming
    // too (once there's content to show): StreamingMdxView keeps a component
    // that is still being written out of sight behind a placeholder, so no
    // half-written tag ever shows. Settled replies get the exact full parse.
    const isStreaming = m.id === streamingId;
    const renderRich = m.role === 'assistant' && (!isStreaming || !!m.content);
    const metaText = m.role === 'assistant' ? metaTooltip(m.meta, models) : undefined;
    const stamp = m.role !== 'system' && m.createdAt ? messageStamp(m.createdAt) : undefined;
    const tps = m.role === 'assistant' ? tokensPerSecond(m) : undefined;
    const isEditing = editingId === m.id;
    // The bubble of the turn still in flight (the last assistant message).
    const liveTurn = running && m.role === 'assistant' && m.id === lastAssistantId;
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
      <div
        key={m.id}
        className={`message message-${m.role}`}
        data-message-id={m.id}
      >
        {stamp && (
          <div className="message-stamp" title={stamp.full}>
            <span>{stamp.time}</span>
            {stamp.day && <span>{stamp.day}</span>}
            {tps !== undefined && <span className="message-stamp-tps">{tps.toFixed(0)} tok/s</span>}
          </div>
        )}
        <div className={`msg-avatar ${a.cls}`}>{a.icon}</div>
        <div className="message-body">
          <div className="message-who">
            <span className="message-who-name">{a.label}</span>
            {pinsOn && m.role !== 'system' && messagePinOf(m) && (
              <span className="message-pinned" title="Pinned to this chat" aria-label="Pinned to this chat">
                <Pin size={11} />
              </span>
            )}
            {metaText && (
              <span
                className="message-meta"
                title={m.meta?.sys ? `Made by system: ${formatSystemVersion(m.meta.sys)}` : undefined}
              >
                {metaText}
              </span>
            )}
            {m.role === 'assistant' && m.timing && formatTiming(m.timing) && (
              <span className="message-timing" title={timingTitle(m)}>
                {formatTiming(m.timing)}
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
              <MdxMessageContext.Provider
                value={m.id === lastAssistantId && !running ? LATEST_MESSAGE : EARLIER_MESSAGE}
              >
                <MdxView text={m.content} />
              </MdxMessageContext.Provider>
            )
          ) : isStreaming && !m.content && showActivity ? (
            activityIndicator
          ) : (
            <div className="message-plain">{m.content}</div>
          )}
          {m.role === 'assistant' && !isEditing && (
            // While the turn runs, its placeholders live in the activity area
            // below — unless this bubble is the one streaming, which hides it.
            <GeneratedImages
              images={m.images}
              activity={liveTurn && !isStreaming ? undefined : m.activity}
              live={liveTurn}
            />
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
              {pinsOn && m.role !== 'system' && m.turnId && m.content.trim() && (() => {
                const pinned = !!messagePinOf(m);
                const tip = pinned ? 'Unpin from this chat' : 'Pin to this chat';
                return (
                  <ActionTip tip={tip}>
                    <button
                      type="button"
                      className={`message-action${pinned ? ' on' : ''}`}
                      aria-label={tip}
                      aria-pressed={pinned}
                      onClick={() => togglePin(m)}
                    >
                      {pinned ? <PinOff size={13} /> : <Pin size={13} />}
                    </button>
                  </ActionTip>
                );
              })()}
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
      {pinboard && threadId && (
        <PinBoard threadId={threadId} board={board} messages={messages} onJump={jumpToPin} />
      )}
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
                  onClick={() => sendAndFollow(s.prompt, [])}
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
            {onToggleDraftPrivate && (
              <button
                type="button"
                className={`empty-private${draftPrivate ? ' on' : ''}`}
                aria-pressed={draftPrivate}
                onClick={onToggleDraftPrivate}
                title="A private chat is saved like any other, but Stem learns nothing from it: no memory is written from it, none is read into it, and the recall tools are off. It cannot be changed once the chat starts."
              >
                <Lock size={12} />
                {draftPrivate
                  ? 'Private chat — nothing here is saved to memory or read from it'
                  : 'Make this chat private'}
              </button>
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
        {recordingDrafts.map((d) => (
          <RecordingDraftCard key={d.id} draft={d} />
        ))}
        {showActivity && !streamingMsg && (
          <div className="message message-assistant activity-row">
            <div className="msg-avatar stem">{AVATAR.assistant.icon}</div>
            <div className="message-body">
              {activities.length > 0 && <ActivityRows items={activities} running />}
              <GeneratedImages activity={activities} live />
              {/* The generic dots only when no tool row is already pulsing. */}
              {!activities.some((a) => a.status === 'running') && activityIndicator}
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      {pinsOn && (
        <SelectionPin containerRef={messagesRef} messages={messages} streamingId={streamingId} onPin={pinPassage} />
      )}

      {/* Outside the scroller on purpose: a card that could scroll off the
          bottom is a turn that silently hangs. */}
      {approvals && approvals.length > 0 && (
        <ApprovalCard
          key={`${approvals[0].kind}:${approvals[0].request.id}`}
          approval={approvals[0]}
          variant="inline"
          queued={approvals.length - 1}
        />
      )}

      <Composer
        ref={ref as React.Ref<ComposerHandle>}
        messages={messages}
        running={running}
        escapeAction={escapeAction}
        onSend={sendAndFollow}
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
        draftKey={draftKey}
        models={models}
        onChangeEffort={onChangeEffort}
        onSelectModel={onSelectModel}
        onChangeSpeed={onChangeSpeed}
        onChangeFormat={onChangeFormat}
        webSearch={webSearch}
        onToggleWebSearch={onToggleWebSearch}
        reportDraft={reportDraft}
        onDraftChange={onDraftChange}
        onNoteSaved={onNoteSaved}
        onPinNote={pinsOn ? pinNote : undefined}
      />
    </div>
    </MdxActionContext.Provider>
  );
});
