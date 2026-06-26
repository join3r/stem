import type {
  AgentMessageDeltaParams,
  BackendEventEnvelope,
  ChatMessage,
  ItemEventParams,
  MessageMeta,
  ThreadStatus,
  TurnCompletedParams,
  TurnTiming,
  TurnTimingParams
} from '../shared/types';
import { agentMessageText } from '../shared/types';
import { activityLabel } from '../shared/activity';

// Everything about one chat's in-flight/visible state. Stored per thread id (plus
// the DRAFT slice in App) so multiple chats can run and stream at the same time.
export interface ThreadState {
  messages: ChatMessage[];
  running: boolean;
  streamingId: string | null;
  /** Label of the in-flight activity (tool/reasoning); null once text streams. */
  activity: string | null;
  activeTurnId: string | null;
  /** Drives the status dot on the chat row. */
  status: ThreadStatus;
}

export const EMPTY_STATE: ThreadState = {
  messages: [],
  running: false,
  streamingId: null,
  activity: null,
  activeTurnId: null,
  status: 'idle'
};

type TurnSettledMethod = 'turn/completed' | 'turn/failed' | 'turn/aborted';

interface ApplyBackendEventOptions {
  turnMeta?: ReadonlyMap<string, MessageMeta>;
  settledStatus?: (method: TurnSettledMethod, threadId: string) => ThreadStatus;
}

export function backendEventThreadId(event: BackendEventEnvelope): string | undefined {
  return (event.params as { threadId?: string } | undefined)?.threadId;
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
      return { ...state, messages, running: true, streamingId: id, activity: null, status: 'running' };
    }
    case 'item/started': {
      const p = event.params as ItemEventParams;
      const type = p.item?.type;
      if (!type || type === 'agentMessage') return null;
      return { ...state, activity: activityLabel(type, p.item?.name, p.item?.detail) };
    }
    case 'item/completed': {
      const p = event.params as ItemEventParams;
      if (p.item?.type !== 'agentMessage') return null;
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
      return { ...state, messages, streamingId: null };
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
    case 'turn/completed':
    case 'turn/failed':
    case 'turn/aborted': {
      const p = event.params as TurnCompletedParams;
      const method = event.method as TurnSettledMethod;
      return {
        ...state,
        running: false,
        streamingId: null,
        activity: null,
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
