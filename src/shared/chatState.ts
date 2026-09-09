// How a thread's visible state is built out of the backend's event stream: the
// pure fold that every Stem client runs.
//
// It lived in src/renderer/ until the phone needed it, which was the moment the
// question "where does this belong" got its real answer. Nothing in here touches
// the DOM, React, or Electron — it is a reducer over BackendEventEnvelope plus
// three merge functions for the places a snapshot and a live stream have to be
// reconciled. Two clients folding the same events with two implementations would
// disagree about something eventually (which bubble a delta belongs to, whether a
// failed turn can be retried), and the disagreement would show up as a phone and
// a desk displaying different transcripts of the same conversation.
//
// src/renderer/chatState.ts is a re-export so desktop imports read unchanged.

import type {
  ActivityItem,
  AgentMessageDeltaParams,
  BackendEventEnvelope,
  ChatMessage,
  ItemEventParams,
  MessageMeta,
  QuickChatHandoff,
  ThreadStatus,
  TurnCompletedParams,
  TurnSourcesParams,
  TurnTiming,
  TurnTimingParams,
  TurnUsage,
  TurnUsageParams
} from './types';
import { agentMessageText } from './types';
import { activityLabel } from './activity';

// Everything about one chat's in-flight/visible state. Stored per thread id (plus
// the DRAFT slice in App) so multiple chats can run and stream at the same time.
export interface ThreadState {
  messages: ChatMessage[];
  running: boolean;
  streamingId: string | null;
  /** Label of the in-flight activity (tool/reasoning); null once text streams. */
  activity: string | null;
  /** Tool calls/web searches of the in-flight turn, in start order (activity rows). */
  activities: ActivityItem[];
  activeTurnId: string | null;
  /** Drives the status dot on the chat row. */
  status: ThreadStatus;
  /**
   * True once the slice holds the whole transcript — hydrated from disk, or
   * complete by construction (a draft, an adopted overlay chat). Absent on a
   * slice seeded purely from background events (a turn started on another
   * device or by a schedule lands in a thread this window never opened), whose
   * messages begin at that turn: such a slice streams fine but must not be
   * shown as the conversation on open without a disk read behind it.
   */
  hydrated?: boolean;
}

export const EMPTY_STATE: ThreadState = {
  messages: [],
  running: false,
  streamingId: null,
  activity: null,
  activities: [],
  activeTurnId: null,
  status: 'idle'
};

/** Merge a newly-sent draft into a real thread whose early backend events may
 * already have produced assistant messages before startTurn returned its id. */
export function mergeDraftIntoReal(draft: ThreadState, live: ThreadState | undefined): ThreadState {
  // The draft IS the whole conversation (the send created the chat), so the
  // merged slice is complete even when `live` was seeded from events alone.
  if (!live) return { ...draft, hydrated: true };
  const same = (a: ChatMessage, b: ChatMessage) => a.id === b.id || (a.role === b.role && !!a.runtimeTurnId && a.runtimeTurnId === b.runtimeTurnId);
  const messages = draft.messages.map((message) => {
    const raced = live.messages.find((candidate) => same(candidate, message));
    return raced ? { ...message, ...raced } : message;
  });
  const extra = live.messages.filter((message) => !draft.messages.some((candidate) => same(candidate, message)));
  return { ...live, messages: [...messages, ...extra], hydrated: true };
}

/**
 * Combine a disk snapshot with events that landed while that snapshot was being
 * read. ThreadState updates are immutable, so identity against `stateAtRequest`
 * tells us whether the live slice changed even when a whole turn started and
 * settled before the read completed (`running` is false again by then).
 */
export function mergeHydratedThread(
  historyMessages: ChatMessage[],
  live: ThreadState | undefined,
  stateAtRequest: ThreadState | undefined,
  complete = true
): ThreadState {
  const savedMessages = historyMessages.map((message) => message.role === 'assistant' && message.runtimeTurnId ? { ...message, hydratedContent: true } : message);
  const hydrated: ThreadState = { ...EMPTY_STATE, messages: savedMessages, hydrated: true };
  if (!live) return hydrated;
  const preserveLive = live !== stateAtRequest || live.running || !complete;
  const candidates = preserveLive ? live.messages : live.messages.filter((message) => message.pendingHistory);
  if (!candidates.length) return hydrated;

  // Disk supplies older transcript entries; newer in-memory versions win for
  // matching ids, and event-only messages are appended rather than discarded.
  const messages = [...savedMessages];
  const claimed = new Set<number>();
  let appendedNewTurn = false;
  for (const liveMessage of candidates) {
    if (liveMessage.role === 'user') appendedNewTurn = false;
    let index = messages.findIndex((message, i) => !claimed.has(i) && (message.id === liveMessage.id || (message.role === liveMessage.role && !!message.runtimeTurnId && message.runtimeTurnId === liveMessage.runtimeTurnId)));
    const trailingUnansweredUser =
      liveMessage.role === 'assistant' &&
      messages.length > 0 &&
      messages[messages.length - 1].role === 'user' &&
      !claimed.has(messages.length - 1);
    if (
      index === -1 &&
      !(appendedNewTurn && liveMessage.role === 'assistant') &&
      !trailingUnansweredUser
    ) {
      // Runtime events identify a live assistant bubble with the minted turn id,
      // while the persisted JSONL identifies the same bubble with its session-entry
      // id. Reconcile an equivalent raced suffix logically, preferring the newest
      // candidate so repeated prompts/replies keep their proper occurrence.
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const candidate = messages[i];
        if (
          !claimed.has(i) &&
          candidate.role === liveMessage.role &&
          !candidate.runtimeTurnId && !liveMessage.runtimeTurnId &&
          candidate.content === liveMessage.content &&
          candidate.scheduled?.at === liveMessage.scheduled?.at
        ) {
          index = i;
          break;
        }
      }
    }
    if (index === -1) {
      messages.push(liveMessage);
      claimed.add(messages.length - 1);
      if (liveMessage.role === 'user') appendedNewTurn = true;
    } else {
      const saved = messages[index];
      // A stream first observed halfway through a reply has no reliable prefix:
      // its raw offsets can include citation markers stripped from history.
      // Keep the saved answer until item/completed supplies the whole live text.
      const liveContent = liveMessage.content;
      const preferSaved = !!saved.runtimeTurnId && ((liveMessage.streamOffset ?? 0) > 0 || saved.content.startsWith(liveContent));
      messages[index] = {
        ...saved, ...liveMessage,
        streamOffset: 0,
        hydratedContent: preferSaved ? saved.hydratedContent : liveMessage.hydratedContent,
        turnId: saved.turnId ?? liveMessage.turnId,
        pendingHistory: complete ? undefined : liveMessage.pendingHistory,
        content: preferSaved ? saved.content : liveContent
      };
      claimed.add(index);
      if (liveMessage.role === 'user') appendedNewTurn = false;
    }
  }

  return {
    ...hydrated,
    ...live,
    messages,
    // The disk read is what makes this slice whole — `...live` must not carry
    // an event-seeded slice's missing flag over it.
    hydrated: true,
    // Opening the thread consumes its unread completion indicator.
    status: live.status === 'done' ? 'idle' : live.status
  };
}

type TurnSettledMethod = 'turn/completed' | 'turn/failed' | 'turn/aborted';

// A dropped provider connection surfaces as a bare, alarming failure like
// "WebSocket error". The ChatGPT/codex transport is a WebSocket that pi does NOT
// auto-retry once streaming has begun (replaying could re-run tools it already
// executed — see openai-codex-responses' websocketStarted branch), so the turn
// just fails even though its tool calls (e.g. a scheduled reminder) already
// committed. Rewrite transport-class failures into copy that explains the drop
// AND reassures that already-completed work was saved — so the user neither
// assumes it failed nor blindly resends and repeats a side effect.
const TRANSPORT_ERROR =
  /websocket|socket hang ?up|econnreset|econnrefused|etimedout|network error|fetch failed|stream (?:closed|ended|error)|connection (?:closed|reset|refused|error)|terminated|premature close/i;

export const TURN_INTERRUPTED_MESSAGE = 'The reply was interrupted. You can edit and resend your message.';

export function turnFailureMessage(error?: string): string {
  const trimmed = error?.trim();
  if (!trimmed) return 'The reply failed. Try sending the message again.';
  if (TRANSPORT_ERROR.test(trimmed)) {
    return `The connection to the model dropped before it finished replying (${trimmed}). Anything it already did this turn — like scheduling a task — was saved, so check the Tasks tab before resending to avoid repeating it.`;
  }
  return trimmed;
}

interface ApplyBackendEventOptions {
  turnMeta?: ReadonlyMap<string, MessageMeta>;
  settledStatus?: (method: TurnSettledMethod, threadId: string) => ThreadStatus;
}

export function backendEventThreadId(event: BackendEventEnvelope): string | undefined {
  return (event.params as { threadId?: string } | undefined)?.threadId;
}

/**
 * Label for the "working" line given the in-flight activity list: the single running
 * tool's label, or a count when several run at once (pi executes a turn's tool calls
 * in parallel). Null when no tool is running.
 */
function runningLabel(activities: ActivityItem[]): string | null {
  const running = activities.filter((a) => a.status === 'running');
  if (!running.length) return null;
  if (running.length > 1) return `Running ${running.length} tools…`;
  return activityLabel(running[0].type, running[0].name, running[0].detail);
}

/**
 * Build the main-window slice for a Quick Chat handoff. Events are rerouted before
 * the adopt push is handled, so an `existing` slice can contain newer deltas or a
 * settle event; those live fields win while the overlay snapshot supplies all
 * earlier user messages that main never received.
 */
export function mergeQuickChatHandoff(
  existing: ThreadState | undefined,
  payload: QuickChatHandoff
): ThreadState {
  const transferred: ThreadState = {
    messages: payload.messages,
    running: payload.running,
    streamingId: payload.streamingId,
    activity: payload.activity,
    activities: payload.activities,
    activeTurnId: payload.activeTurnId,
    status: payload.status,
    // The overlay hands over its complete in-memory conversation, so the
    // adopted slice needs no disk read behind it.
    hydrated: true
  };
  if (!existing) return transferred;

  const newer = new Map(existing.messages.map((m) => [m.id, m]));
  const messages = payload.messages.map((m) => newer.get(m.id) ?? m);
  const known = new Set(messages.map((m) => m.id));
  for (const m of existing.messages) if (!known.has(m.id)) messages.push(m);
  return { ...transferred, ...existing, messages, hydrated: true };
}

/** Copy the live activity list onto the turn's assistant bubble (if it exists yet). */
function stampActivity(messages: ChatMessage[], turnId: string, activities: ActivityItem[]): ChatMessage[] {
  if (!activities.length) return messages;
  const id = `assistant-${turnId}`;
  const idx = messages.findIndex((m) => m.id === id);
  if (idx === -1) return messages;
  return messages.map((m, i) => (i === idx ? { ...m, activity: activities } : m));
}

export function applyBackendEventToThread(
  state: ThreadState,
  event: BackendEventEnvelope,
  options: ApplyBackendEventOptions = {}
): ThreadState | null {
  switch (event.method) {
    case 'item/agentMessage/delta': {
      const p = event.params as AgentMessageDeltaParams;
      const id = `assistant-${p.turnId}`;
      const meta = options.turnMeta?.get(p.turnId);
      const idx = state.messages.findIndex((m) => m.id === id);
      const foldDelta = (message: ChatMessage): string => {
        const content = message.content;
        // Disk strips citation markers, so its character positions cannot safely
        // accept raw deltas. Keep the saved answer until a completed item gives
        // us a new authoritative stream baseline. Fresh streaming is unaffected.
        if (message.hydratedContent) return content;
        const offset = p.offset === undefined ? undefined : p.offset - (message.streamOffset ?? 0);
        if (offset === undefined || offset < 0 || offset > content.length) return content + p.delta;
        if (content.slice(offset, offset + p.delta.length) === p.delta) return content;
        return content.slice(0, offset) + p.delta;
      };
      const messages =
        idx === -1
          ? [...state.messages, { id, role: 'assistant', content: p.delta, streamOffset: p.offset ?? 0, meta, turnId: p.turnId, runtimeTurnId: p.turnId } as ChatMessage]
          : state.messages.map((m, i) => (i === idx ? { ...m, content: foldDelta(m) } : m));
      return {
        ...state,
        messages: stampActivity(messages, p.turnId, state.activities),
        running: true,
        streamingId: id,
        activeTurnId: p.turnId,
        activity: null,
        status: 'running'
      };
    }
    case 'item/started': {
      const p = event.params as ItemEventParams;
      const type = p.item?.type;
      if (!type) return null;
      if (type === 'agentMessage') {
        return { ...state, running: true, activeTurnId: p.turnId, status: 'running' };
      }
      const label = activityLabel(type, p.item?.name, p.item?.detail);
      if (type === 'reasoning') {
        return {
          ...state,
          running: true,
          activeTurnId: p.turnId,
          status: 'running',
          activity: label
        };
      }
      // A tool call (web search included) becomes an activity row.
      const itemId = p.item.id;
      const activities = state.activities.some((a) => a.id === itemId)
        ? state.activities
        : [
            ...state.activities,
            {
              id: itemId,
              kind: type === 'webSearch' ? 'webSearch' : type === 'skill' ? 'skill' : 'tool',
              type,
              name: p.item.name,
              detail: p.item.detail,
              status: 'running'
            } as ActivityItem
          ];
      return {
        ...state,
        running: true,
        activeTurnId: p.turnId,
        status: 'running',
        activity: runningLabel(activities) ?? label,
        activities,
        messages: stampActivity(state.messages, p.turnId, activities)
      };
    }
    case 'item/completed': {
      const p = event.params as ItemEventParams;
      if (p.item?.type !== 'agentMessage') {
        // A tool call finished — flip its row's status.
        const idx = state.activities.findIndex((a) => a.id === p.item?.id);
        if (idx === -1) {
          // Post-run compaction: pi condensed the conversation AFTER the turn
          // settled (live activity list already cleared) — stamp a settled row
          // straight onto the turn's bubble so the condense is visible.
          if (p.item?.type === 'compaction' && p.item.id) {
            const mid = `assistant-${p.turnId}`;
            const i = state.messages.findIndex((m) => m.id === mid);
            if (i === -1 || state.messages[i].activity?.some((a) => a.id === p.item.id)) return null;
            const row: ActivityItem = { id: p.item.id, kind: 'tool', type: 'compaction', status: p.item.status ?? 'ok' };
            return {
              ...state,
              messages: state.messages.map((m, j) =>
                j === i ? { ...m, activity: [...(m.activity ?? []), row] } : m
              )
            };
          }
          return null;
        }
        const activities = state.activities.map((a, i) =>
          i === idx ? { ...a, status: p.item.status ?? 'ok', detail: p.item.detail ?? a.detail } : a
        );
        // Refresh the working label from whatever is still running; keep the last
        // label when nothing is (reasoning/answer events overwrite it as before).
        const activity = runningLabel(activities) ?? state.activity;
        return { ...state, activity, activities, messages: stampActivity(state.messages, p.turnId, activities) };
      }
      const id = `assistant-${p.turnId}`;
      const text = agentMessageText(p.item);
      const meta = options.turnMeta?.get(p.turnId);
      const idx = state.messages.findIndex((m) => m.id === id);
      const messages =
        idx === -1
          ? [...state.messages, { id, role: 'assistant', content: text, meta, turnId: p.turnId, runtimeTurnId: p.turnId } as ChatMessage]
          : state.messages.map((m, i) =>
              i === idx ? {
                ...m,
                content: m.hydratedContent && text && m.content.startsWith(text) ? m.content : text || m.content,
                hydratedContent: !!(m.hydratedContent && text && m.content !== text && m.content.startsWith(text)),
                streamOffset: 0, meta: m.meta ?? meta
              } : m
            );
      return { ...state, messages: stampActivity(messages, p.turnId, state.activities), streamingId: null };
    }
    case 'harness/progress': {
      // A live detail update for a running coding_agent row (synthesized from
      // the harness:progress channel, not a pi event). Missing one is harmless:
      // the final state arrives with the tool call's own completion.
      const p = event.params as { itemId?: string; detail?: string };
      if (typeof p.detail !== 'string') return null;
      const idx = state.activities.findIndex((a) =>
        p.itemId ? a.id === p.itemId : a.type === 'codingAgent' && a.status === 'running'
      );
      if (idx === -1) return null;
      const activities = state.activities.map((a, i) => (i === idx ? { ...a, detail: p.detail } : a));
      return { ...state, activity: runningLabel(activities) ?? state.activity, activities };
    }
    case 'turn/sources': {
      const p = event.params as TurnSourcesParams;
      if (!p.sources?.length) return null;
      const id = `assistant-${p.turnId}`;
      const idx = state.messages.findIndex((m) => m.id === id);
      if (idx === -1) return null;
      return {
        ...state,
        messages: state.messages.map((m, i) => (i === idx ? { ...m, sources: p.sources } : m))
      };
    }
    case 'turn/timing': {
      const p = event.params as TurnTimingParams;
      const id = `assistant-${p.turnId}`;
      const idx = state.messages.findIndex((m) => m.id === id);
      if (idx === -1) return null; // errored/aborted turn with no assistant bubble
      const timing: TurnTiming = {
        totalMs: p.totalMs,
        thinkingMs: p.thinkingMs,
        toolMs: p.toolMs,
        answerMs: p.answerMs,
        ttftMs: p.sendToFirstTokenMs,
        buildMs: p.buildMs,
        recallMs: p.recall?.total ?? null
      };
      return { ...state, messages: state.messages.map((m, i) => (i === idx ? { ...m, timing } : m)) };
    }
    case 'turn/usage': {
      const p = event.params as TurnUsageParams;
      const id = `assistant-${p.turnId}`;
      const idx = state.messages.findIndex((m) => m.id === id);
      if (idx === -1) return null; // errored/aborted turn with no assistant bubble
      const usage: TurnUsage = {
        input: p.input,
        output: p.output,
        cacheRead: p.cacheRead,
        cacheWrite: p.cacheWrite,
        totalTokens: p.totalTokens,
        cost: p.cost
      };
      return { ...state, messages: state.messages.map((m, i) => (i === idx ? { ...m, usage } : m)) };
    }
    case 'turn/completed':
    case 'turn/failed':
    case 'turn/aborted': {
      const p = event.params as TurnCompletedParams;
      const method = event.method as TurnSettledMethod;
      // Failed and interrupted turns need a visible system bubble even when the
      // model produced no text. An interruption always keeps its turn identity
      // because the start response can arrive later. For other failures, expose
      // Retry only when a user message
      // actually carries this turn (synthetic failures like the Quick Chat
      // hand-off mint an id no message has; Retry could never map those back).
      const canRetry = state.messages.some((m) => m.role === 'user' && (m.runtimeTurnId ?? m.turnId) === p.turn.id);
      const settled =
        method === 'turn/failed' || method === 'turn/aborted'
          ? [
              ...stampActivity(state.messages, p.turn.id, state.activities).filter((m) => m.id !== `system-${p.turn.id}`),
              {
                id: `system-${p.turn.id}`,
                role: 'system' as const,
                ...(canRetry || method === 'turn/aborted' ? { turnId: p.turn.id } : {}),
                content: method === 'turn/aborted' ? TURN_INTERRUPTED_MESSAGE : turnFailureMessage(p.error)
              }
            ]
          : stampActivity(state.messages, p.turn.id, state.activities);
      return {
        ...state,
        // Stamp the final activity list onto the turn's bubble before clearing the
        // live list — settled rows render collapsed from the message itself.
        messages: settled,
        running: false,
        streamingId: null,
        activity: null,
        activities: [],
        activeTurnId: null,
        status: options.settledStatus?.(method, p.threadId) ?? 'idle'
      };
    }
    default:
      return null;
  }
}

export function applyProcessExitToThread(state: ThreadState): ThreadState {
  return {
    ...state,
    running: false,
    streamingId: null,
    activity: null,
    activities: [],
    activeTurnId: null,
    status: state.status === 'running' ? 'idle' : state.status
  };
}

export function appendSystemMessage(state: ThreadState, error: unknown): ThreadState {
  return {
    ...state,
    messages: [
      ...state.messages,
      { id: `system-${Date.now()}`, role: 'system', content: String(error instanceof Error ? error.message : error) }
    ],
    running: false,
    activeTurnId: null,
    status: 'error'
  };
}
