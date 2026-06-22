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
}

export function newTurnContext(threadId: string, turnId: string): TurnContext {
  return { threadId, turnId, assistantText: '', errored: false, aborted: false };
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
      const type = toolItemType(ev.toolName as string | undefined);
      out.push({
        method: 'item/started',
        params: { item: { type, id: String(ev.toolCallId ?? turnId) }, threadId, turnId }
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
