import type { PiEvent } from './rpc';

// Translate pi's RPC event stream into Stem's canonical backend events (the
// { method, params } envelopes the renderer/HUD/recall consume).
//
// Verified event order for a turn (Phase-0 spike):
//   agent_start → turn_start → message_start(user) → message_end(user)
//   → message_start(assistant) → message_update[thinking_*, text_*]
//   → message_end(assistant) → turn_end → agent_end
//
// The user message ALSO emits message_start/end — those are ignored here.
// turnId is minted by PiRuntime per turn (pi has no stable turn id); deltas and
// the completed item share it so the renderer keys one bubble `assistant-${turnId}`.

export interface NormalizedEvent {
  method: string;
  params: unknown;
}

/** Per-turn state the normalizer accumulates. PiRuntime owns one per active turn. */
export interface TurnContext {
  threadId: string;
  turnId: string;
  assistantText: string;
  errored: boolean;
  aborted: boolean;
  errorMessage?: string;
  /**
   * Per-turn latency marks (ms epoch / durations), populated by PiRuntime — NOT by
   * the normalizer, which stays pure. Used to log a one-line breakdown at turn end
   * so we can see whether the lag is pre-send (recall/build) or the model itself.
   */
  startedAt?: number; // foreground work began (before ensureStarted)
  promptSentAt?: number; // just before the `prompt` RPC is written
  firstActivityAt?: number; // first streamed event of any kind (thinking/tool/text)
  firstTokenAt?: number; // first answer text delta
  endedAt?: number; // agent_end
  ensureMs?: number; // ensureStarted cost (process spawn on a cold turn)
  buildMs?: number; // buildMessage total (recall + files + attachments)
  recall?: { facts?: number; embed?: number; rerank?: number; search?: number; total?: number };
  /**
   * Approximate wall-time split, accumulated by PiRuntime: each inter-event
   * interval is attributed to the phase that was active. These do NOT sum to the
   * total — the pre-first-event wait (TTFT) and build/recall time are in no bucket.
   */
  thinkingMs: number;
  toolMs: number;
  answerMs: number;
  /**
   * Canonical absolute roots of connected folders flagged memorize:false, captured
   * at turn start. If the assistant reads inside any of them this turn, the turn is
   * marked `memoryTainted` so its reply is kept out of Recall (see PiRuntime).
   */
  privateRoots?: string[];
  memoryTainted?: boolean;
  phase: 'pending' | 'thinking' | 'tool' | 'answer';
  lastEventAt?: number; // epoch ms of the last normalized event, for interval attribution
  timing?: TurnTimingBreakdown; // stashed by reportTurnTiming so recordTurnEntry can persist it
}

/** The breakdown object PiRuntime.reportTurnTiming builds and emits as `turn/timing`. */
export interface TurnTimingBreakdown {
  threadId: string;
  turnId: string;
  ensureMs: number;
  buildMs: number | null;
  recall: { total: number | null; facts: number | null; embed: number | null; rerank: number | null; search: number | null };
  thinkingMs: number;
  toolMs: number;
  answerMs: number;
  sendToFirstActivityMs: number | null;
  sendToFirstTokenMs: number | null;
  firstTokenToEndMs: number | null;
  totalMs: number | null;
}

export function newTurnContext(threadId: string, turnId: string): TurnContext {
  return {
    threadId,
    turnId,
    assistantText: '',
    errored: false,
    aborted: false,
    thinkingMs: 0,
    toolMs: 0,
    answerMs: 0,
    phase: 'pending'
  };
}

/**
 * Classify a batch of normalized events into the phase they represent, for the
 * thinking/tool/answer wall-time split. Answer (text) wins over thinking/tool when
 * a batch carries several, so streaming text isn't mis-attributed.
 */
export function phaseOfEvents(events: NormalizedEvent[]): TurnContext['phase'] | undefined {
  let next: TurnContext['phase'] | undefined;
  for (const e of events) {
    if (e.method === 'item/agentMessage/delta') return 'answer';
    if (e.method === 'item/started') {
      const type = (e.params as { item?: { type?: string } }).item?.type;
      if (type === 'reasoning') next = 'thinking';
      else if (type && type !== 'agentMessage') next = 'tool';
    }
  }
  return next;
}

interface AssistantMessageEvent {
  type?: string;
  delta?: string;
}

interface ContentBlock {
  type?: string;
  text?: string;
}

interface PiMessage {
  role?: string;
  content?: ContentBlock[] | string;
  stopReason?: string;
  errorMessage?: string;
}

/** Map a pi tool name onto the item-type vocabulary `activityLabel` knows. */
function toolItemType(toolName: string | undefined): string {
  const n = (toolName ?? '').toLowerCase();
  if (n === 'bash' || n === 'read' || n === 'ls' || n === 'glob' || n === 'grep') return 'commandExecution';
  if (n === 'edit' || n === 'write' || n === 'multiedit' || n === 'apply_patch') return 'fileChange';
  if (n.startsWith('mcp')) return 'mcpToolCall';
  if (n.includes('search') || n.includes('web')) return 'webSearch';
  return 'mcpToolCall'; // generic tool → "Using a tool…"
}

// Argument keys that carry a human-meaningful target, most-specific first. pi's
// tool_execution_start arg shape isn't formally typed (PiEvent is open), so we
// probe both the event itself and a nested args object defensively.
const DETAIL_KEYS = ['file_path', 'path', 'filename', 'command', 'cmd', 'pattern', 'query', 'url'] as const;

/** Format a target value for the label: basename file paths, truncate long strings. */
function formatDetail(key: string, raw: string): string {
  const isPath = key === 'file_path' || key === 'path' || key === 'filename';
  const value = isPath ? raw.split('/').filter(Boolean).pop() ?? raw : raw;
  return value.length > 60 ? `${value.slice(0, 57)}…` : value;
}

/** Probe a single args object for the first human-meaningful target key. */
function detailFromArgs(src: Record<string, unknown> | undefined): string | undefined {
  if (!src) return undefined;
  for (const key of DETAIL_KEYS) {
    const v = src[key];
    if (typeof v === 'string' && v.trim()) return formatDetail(key, v.trim());
  }
  return undefined;
}

/** Pull a short, human target string (file/command/query) from a tool-start event. */
function toolDetail(ev: PiEvent): string | undefined {
  const nested = (ev.toolInput ?? ev.args ?? ev.input ?? ev.arguments ?? ev.params) as
    | Record<string, unknown>
    | undefined;
  const lookup = (src: Record<string, unknown> | undefined, key: string): string | undefined => {
    const v = src?.[key];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  for (const key of DETAIL_KEYS) {
    const raw = lookup(ev as unknown as Record<string, unknown>, key) ?? lookup(nested, key);
    if (!raw) continue;
    return formatDetail(key, raw);
  }
  return undefined;
}

function textOf(content: ContentBlock[] | string | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('');
}

/**
 * Process one pi event against the active turn, mutating `ctx` and returning the
 * normalized envelopes to emit (0 or more). Returns `done: true` once the turn
 * has fully ended (agent_end) so PiRuntime can clear its current-turn state.
 */
export function normalizePiEvent(ev: PiEvent, ctx: TurnContext): { events: NormalizedEvent[]; done: boolean } {
  const out: NormalizedEvent[] = [];
  const { threadId, turnId } = ctx;

  switch (ev.type) {
    case 'message_update': {
      const ame = ev.assistantMessageEvent as AssistantMessageEvent | undefined;
      if (!ame) break;
      if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
        ctx.assistantText += ame.delta;
        out.push({
          method: 'item/agentMessage/delta',
          params: { threadId, turnId, itemId: turnId, delta: ame.delta }
        });
      } else if (ame.type === 'thinking_start') {
        out.push({ method: 'item/started', params: { item: { type: 'reasoning', id: turnId }, threadId, turnId } });
      }
      break;
    }
    case 'tool_execution_start': {
      let name = ev.toolName as string | undefined;
      let detail = toolDetail(ev);
      // Router unwrap: the bridge's invoke_tool wraps the real call as
      // { server, tool, args }. Recover the underlying tool name + target so the
      // activity label stays specific ("Searching the web…") instead of collapsing
      // to "Using invoke_tool…".
      if (name === 'invoke_tool') {
        const inp = (ev.toolInput ?? ev.args ?? ev.input ?? ev.arguments ?? ev.params) as
          | Record<string, unknown>
          | undefined;
        const real = typeof inp?.tool === 'string' ? inp.tool : undefined;
        if (real) {
          name = real;
          const innerArgs = inp?.args as Record<string, unknown> | undefined;
          detail = detailFromArgs(innerArgs) ?? (typeof inp?.server === 'string' ? inp.server : undefined);
        }
      }
      const type = toolItemType(name);
      out.push({
        method: 'item/started',
        params: {
          item: { type, id: String(ev.toolCallId ?? turnId), name, detail },
          threadId,
          turnId
        }
      });
      break;
    }
    case 'message_end': {
      const msg = ev.message as PiMessage | undefined;
      if (msg?.role !== 'assistant') break; // ignore the user message echo
      const text = textOf(msg.content);
      if (msg.stopReason === 'error') {
        ctx.errored = true;
        ctx.errorMessage = msg.errorMessage;
      } else if (msg.stopReason === 'aborted') {
        ctx.aborted = true;
      }
      if (text) ctx.assistantText = text;
      // Emit the authoritative completed message (renderer replaces streamed deltas).
      if (text || (!ctx.errored && !ctx.aborted)) {
        out.push({
          method: 'item/completed',
          params: { item: { type: 'agentMessage', id: turnId, text: ctx.assistantText }, threadId, turnId }
        });
      }
      break;
    }
    case 'agent_end': {
      if (ctx.aborted) {
        out.push({ method: 'turn/aborted', params: { threadId, turn: { id: turnId, status: 'aborted' } } });
      } else if (ctx.errored) {
        out.push({
          method: 'turn/failed',
          params: { threadId, turn: { id: turnId, status: 'failed' }, error: ctx.errorMessage }
        });
      } else {
        out.push({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
      }
      return { events: out, done: true };
    }
    default:
      break;
  }
  return { events: out, done: false };
}
