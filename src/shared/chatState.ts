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
  if (!live) return draft;
  const ids = new Set(draft.messages.map((m) => m.id));
  const extra = live.messages.filter((m) => !ids.has(m.id));
  return { ...live, messages: [...draft.messages, ...extra] };
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
  stateAtRequest: ThreadState | undefined
): ThreadState {
  const hydrated: ThreadState = { ...EMPTY_STATE, messages: historyMessages };
  if (!live || (live === stateAtRequest && !live.running)) return hydrated;

  // Disk supplies older transcript entries; newer in-memory versions win for
  // matching ids, and event-only messages are appended rather than discarded.
  const messages = [...historyMessages];
  const claimed = new Set<number>();
  let appendedNewTurn = false;
  for (const liveMessage of live.messages) {
    if (liveMessage.role === 'user') appendedNewTurn = false;
    let index = messages.findIndex((message, i) => !claimed.has(i) && message.id === liveMessage.id);
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
      messages[index] = liveMessage;
      claimed.add(index);
      if (liveMessage.role === 'user') appendedNewTurn = false;
    }
  }

  return {
    ...hydrated,
    ...live,
    messages,
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
    status: payload.status
  };
  if (!existing) return transferred;

  const newer = new Map(existing.messages.map((m) => [m.id, m]));
  const messages = payload.messages.map((m) => newer.get(m.id) ?? m);
  const known = new Set(messages.map((m) => m.id));
  for (const m of existing.messages) if (!known.has(m.id)) messages.push(m);
  return { ...transferred, ...existing, messages };
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
      const messages =
        idx === -1
          ? [...state.messages, { id, role: 'assistant', content: p.delta, meta, turnId: p.turnId } as ChatMessage]
          : state.messages.map((m, i) => (i === idx ? { ...m, content: m.content + p.delta } : m));
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
          ? [...state.messages, { id, role: 'assistant', content: text, meta, turnId: p.turnId } as ChatMessage]
          : state.messages.map((m, i) =>
              i === idx ? { ...m, content: text || m.content, meta: m.meta ?? meta } : m
            );
      return { ...state, messages: stampActivity(messages, p.turnId, state.activities), streamingId: null };
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
      // A failed turn carries its failure text — surface it as a system bubble
      // instead of silently stopping (auth expiry, provider errors, …). Stamp the
      // turn id so the bubble can offer Retry — but only when a user message
      // actually carries this turn (synthetic failures like the Quick Chat
      // hand-off mint an id no message has; Retry could never map those back).
      const canRetry = state.messages.some((m) => m.role === 'user' && m.turnId === p.turn.id);
      const settled =
        method === 'turn/failed'
          ? [
              ...stampActivity(state.messages, p.turn.id, state.activities),
              {
                id: `system-${p.turn.id}`,
                role: 'system' as const,
                ...(canRetry ? { turnId: p.turn.id } : {}),
                content: turnFailureMessage(p.error)
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
