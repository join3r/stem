import type { PiEvent } from './rpc';
import type { ActivityItem, SourceRef, TurnUsage } from '../../shared/types';
import { stripCiteMarkers } from '../../shared/citations';
import { WEB_ACCESS_TOOL_NAMES } from '../../shared/activity';
import { SECRET_ENVELOPE_KEY, toolArgsOf } from './protocol';
import type { InlinedSkill } from '../skills/inject';
import { extractSources } from './web-search';

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
  /**
   * The turn's assistant text up to and including the last message that ended
   * CLEANLY. A turn can hold several assistant messages (see message_end), and each
   * one joins the reply rather than replacing it — but only once it ends cleanly,
   * because pi retries a failed message inside the same run by replaying the whole
   * reply, and appending to a committed prefix would duplicate it.
   */
  committedText: string;
  /** A message committed and the next text delta opens a new one: separate them. */
  pendingJoin: boolean;
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
  /**
   * The turn called a web-access tool (web_search, fetch_content, …), so its
   * assistant reply may restate untrusted public-web content. Unlike
   * memoryTainted this does NOT suppress capture — the reply is still recorded,
   * but flagged `web` in the episodic store so distillation treats claims
   * grounded only in it as web-derived, never as the user's own words.
   */
  webTainted?: boolean;
  /**
   * The user's message, held back from Recall until the turn's memorize:false
   * verdict is knowable (the taint is set when the assistant reads a private
   * folder — after the prompt). Flushed on the first unsuppressed capture event
   * of the turn, or at settle; never captured when the turn ends tainted.
   */
  pendingUserCapture?: { text: string; cwd?: string };
  /**
   * Skills whose full body was inlined into this turn's context. Set by the
   * message builder and graded at turn end (skills/grade.ts). NOT a routing
   * signal on its own: injection is the top-2 of a cosine ranking, so it says
   * what we put in front of the model, not what the model followed.
   */
  skillsInjected?: InlinedSkill[];
  /**
   * The graded subset of `skillsInjected` — the slugs this turn showed evidence
   * of actually following. Written by PiRuntime.settleTurn from the
   * `gradeSkillUse` result it already computes for the usage sidecar, so the
   * snapshot taken a few lines later carries it for free.
   *
   * This is the ONLY affirmative signal available at settle time, and it is what
   * routes authoring to patch instead of create (skills/settle.ts). Its
   * predecessor, `skillsUsed`, was fed by watching for a read inside a skill's
   * folder; inlining removed that signal by construction and nothing ever wrote
   * the field again, so every end-of-turn write was a create for months.
   */
  skillsGradedUsed?: string[];
  /**
   * True for an autonomous scheduled-task run. Set by PiRuntime.startTurn from the
   * scheduler's input marker; the exec bridge uses it to reject commands that would
   * need a manual approval nobody is present to give.
   */
  isScheduled?: boolean;
  /** The raw user message that started this turn — intent context for the exec safety judge. */
  userText?: string;
  phase: 'pending' | 'thinking' | 'tool' | 'answer';
  lastEventAt?: number; // epoch ms of the last normalized event, for interval attribution
  timing?: TurnTimingBreakdown; // stashed by reportTurnTiming so recordTurnEntry can persist it
  /** Tool calls + native web searches this turn, in start order (drives activity rows). */
  activity: ActivityItem[];
  /** When each tool call started, so `tool_execution_end` can stamp its duration. */
  activityStartedAt: Map<string, number>;
  /** Web sources recovered from native web search (deduped by url). */
  sources: SourceRef[];
  /**
   * What the assistant actually DID this turn — arguments in, results out — kept
   * only in memory for the length of the turn (plus PiRuntime's short ring of
   * settled turns). Skill authoring reads this; `activity` is the display row and
   * has already thrown the substance away (paths shrink to a basename, results are
   * dropped entirely). See TRACE_* for the caps.
   */
  trace: TraceEntry[];
  /** Characters of args+results retained so far, against TRACE_TURN_MAX_CHARS. */
  traceChars: number;
}

/**
 * One tool call as the skill author sees it. `name` is already unwrapped from the
 * MCP router's invoke_tool meta-tool, so a skill can name the real tool.
 */
export interface TraceEntry {
  id: string;
  name?: string;
  /** JSON of the call's arguments, truncated. Absent when over budget or redacted. */
  args?: string;
  /** The result's text content, truncated. Absent until tool_execution_end. */
  result?: string;
  isError?: boolean;
}

// Retention caps. A skill is a few hundred bytes of procedure, so the trace only
// has to be long enough to reconstruct one — not to replay the turn. The per-turn
// ceiling is what actually bounds memory: a runaway loop of failing tool calls
// would otherwise accumulate without limit inside a single turn.
export const TRACE_ARGS_MAX_CHARS = 600;
export const TRACE_RESULT_MAX_CHARS = 2_000;
export const TRACE_TURN_MAX_CHARS = 24_000;

/**
 * A settled turn, reduced to what skill authoring needs. PiRuntime keeps a short
 * ring of these so `/learn` can reach the turn that just ended — by the time the
 * user reads the reply and decides it was worth keeping, the TurnContext is gone.
 * Nothing here is persisted; the ring dies with the process.
 */
export interface SettledTurnTrace {
  threadId: string;
  turnId: string;
  endedAt: number;
  userText: string;
  assistantText: string;
  trace: TraceEntry[];
  /**
   * Slugs whose bodies were inlined into this turn. Not a routing signal — the
   * author is shown these as candidates so it can recognize "this already
   * exists", but nothing here is evidence the turn followed any of them.
   */
  skillsInjected: string[];
  /** The graded subset of the above — the only affirmative use signal, and what routes patch-vs-create. */
  skillsGradedUsed: string[];
  /** The turn read inside a memorize:false folder: never author from it. */
  memoryTainted: boolean;
  isScheduled: boolean;
}

export function snapshotTurnTrace(turn: TurnContext, endedAt: number): SettledTurnTrace {
  return {
    threadId: turn.threadId,
    turnId: turn.turnId,
    endedAt,
    userText: turn.userText ?? '',
    assistantText: turn.assistantText,
    trace: turn.trace,
    skillsInjected: (turn.skillsInjected ?? []).map((s) => s.slug),
    skillsGradedUsed: [...(turn.skillsGradedUsed ?? [])],
    memoryTainted: turn.memoryTainted === true,
    isScheduled: turn.isScheduled === true
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

/**
 * Argument names whose VALUE is a credential rather than a fact about the task.
 * `add_mcp_server` takes `env` (a token the user typed), `headers`
 * (`Authorization: Bearer …`) and `oauthClientSecret` as plain tool arguments, and
 * this trace is fed to a model when a skill is authored. A skill never needs the
 * secret — "set MCP_TOKEN in env" is the reusable part — so the value is dropped
 * and the key kept, which also leaves the shape of the call legible.
 */
const SECRET_ARG_KEY_RE = /(token|secret|password|passwd|apikey|api_key|authorization|credential|cookie|bearer)/i;

/** Replace credential-looking values, recursively. Depth-capped against cycles. */
function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    // `env` and `headers` are containers of credentials rather than credentials
    // themselves, so their KEYS survive and their values do not.
    if (SECRET_ARG_KEY_RE.test(key)) out[key] = '[redacted]';
    else if ((key === 'env' || key === 'headers') && v && typeof v === 'object' && !Array.isArray(v)) {
      out[key] = Object.fromEntries(Object.keys(v as Record<string, unknown>).map((k) => [k, '[redacted]']));
    } else out[key] = redactSecrets(v, depth + 1);
  }
  return out;
}

/**
 * Serialize a call's arguments for the trace, or return undefined to keep them
 * out. Encrypted-secret envelopes are dropped wholesale rather than truncated —
 * a partial ciphertext is no safer than a whole one, and no skill needs it.
 */
function traceArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  let json: string;
  try {
    json = JSON.stringify(redactSecrets(args));
  } catch {
    // quiet: args that will not serialize (a cycle) are left out of the trace,
    // which is the same thing this function does for empty ones and for secret
    // envelopes. The call itself is traced either way.
    return undefined;
  }
  if (!json || json === '{}') return undefined;
  if (json.includes(SECRET_ENVELOPE_KEY)) return undefined;
  return truncate(json, TRACE_ARGS_MAX_CHARS);
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
    committedText: '',
    pendingJoin: false,
    errored: false,
    aborted: false,
    thinkingMs: 0,
    toolMs: 0,
    answerMs: 0,
    phase: 'pending',
    activity: [],
    activityStartedAt: new Map(),
    sources: [],
    trace: [],
    traceChars: 0
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
  /** Token usage on assistant messages; pi also persists this in the session JSONL. */
  usage?: PiUsage;
}

/** pi's per-turn usage object (assistant messages). `cost.total` is the dollar cost. */
export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number } | null;
}

/**
 * Normalize pi's raw usage object into Stem's {@link TurnUsage}. Returns null when there's
 * no usage at all. `totalTokens` falls back to the component sum, matching pi's own
 * `calculateContextTokens`. Shared by the live event path and the history-parse path.
 */
export function toTurnUsage(usage: PiUsage | undefined | null): TurnUsage | null {
  if (!usage) return null;
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: typeof usage.cost?.total === 'number' ? usage.cost.total : null
  };
}

// The tools the vendored pi-web-access extension registers, shared with the
// label logic so classification and phrasing can't drift apart.
const WEB_ACCESS_TOOLS = WEB_ACCESS_TOOL_NAMES;

/** True for a tool whose result carries citable web sources. */
export function isWebSearchTool(toolName: string | undefined): boolean {
  const n = (toolName ?? '').toLowerCase();
  return n === 'web_search' || n === 'fetch_content';
}

/** Map a pi tool name onto the item-type vocabulary `activityLabel` knows. */
function toolItemType(toolName: string | undefined): string {
  const n = (toolName ?? '').toLowerCase();
  if (n === 'bash' || n === 'run_command' || n === 'read' || n === 'ls' || n === 'glob' || n === 'grep')
    return 'commandExecution';
  if (n === 'edit' || n === 'write' || n === 'multiedit' || n === 'apply_patch') return 'fileChange';
  if (WEB_ACCESS_TOOLS.has(n)) return 'webSearch';
  // No substring guessing beyond this point: MCP tools unwrapped from
  // invoke_tool keep server-side names like ha_search, which are not web tools.
  return 'mcpToolCall'; // generic tool → "Using a tool…"
}

/**
 * Flatten a pi tool result's content blocks to plain text. The result shape is
 * MCP-ish (`{ content: [{ type: 'text', text }] }`) but PiEvent is deliberately
 * open, so probe rather than cast.
 */
function resultText(result: { content?: unknown } | undefined): string {
  const blocks = result?.content;
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (block && typeof block === 'object') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
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

/**
 * Build an ActivityItem for a tool call — from a live tool_execution_start or a
 * replayed session `toolCall` content block. Unwraps the MCP router's invoke_tool
 * meta-tool so the row stays specific. `fallbackDetail` covers the live path where
 * the target may ride on the event itself rather than the args object.
 */
export function toolCallActivity(
  id: string,
  rawName: string | undefined,
  args: Record<string, unknown> | undefined,
  fallbackDetail?: string
): ActivityItem {
  let name = rawName;
  let detail = detailFromArgs(args) ?? fallbackDetail;
  if (name === 'invoke_tool') {
    const real = typeof args?.tool === 'string' ? args.tool : undefined;
    if (real) {
      name = real;
      const innerArgs = args?.args as Record<string, unknown> | undefined;
      // Parenthesized so the label reads "Used ha_get_history (homeassistant)"
      // rather than running the tool and server names together.
      detail = detailFromArgs(innerArgs) ?? (typeof args?.server === 'string' ? `(${args.server})` : undefined);
    }
  }
  const type = toolItemType(name);
  return { id, kind: type === 'webSearch' ? 'webSearch' : 'tool', type, name, detail, status: 'running' };
}

/** Pull a short, human target string (file/command/query) from a tool-start event. */
function toolDetail(ev: PiEvent): string | undefined {
  const nested = toolArgsOf(ev);
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

// Leaked web-search citation markers are stripped from the authoritative text
// here (message_end), which is what recall capture, chat search, and the settled
// bubble consume. Streaming deltas stay raw — a marker can split across delta
// boundaries, so the renderer strips the ACCUMULATED text at render time instead.
function textOf(content: ContentBlock[] | string | undefined): string {
  if (typeof content === 'string') return stripCiteMarkers(content);
  if (!Array.isArray(content)) return '';
  return stripCiteMarkers(
    content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('')
  );
}

/**
 * Process one pi event against the active turn, mutating `ctx` and returning the
 * normalized envelopes to emit (0 or more). Returns `done: true` once the turn
 * has fully ended (agent_end without a pending auto-retry) so PiRuntime can
 * clear its current-turn state.
 */
export function normalizePiEvent(ev: PiEvent, ctx: TurnContext): { events: NormalizedEvent[]; done: boolean } {
  const out: NormalizedEvent[] = [];
  const { threadId, turnId } = ctx;

  switch (ev.type) {
    case 'message_update': {
      const ame = ev.assistantMessageEvent as AssistantMessageEvent | undefined;
      if (!ame) break;
      if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
        // These are the first tokens of a NEW assistant message in a turn that
        // already has one (see message_end). Open it as its own block — in the
        // stream too, not just in the accumulated text, so the live bubble reads
        // the same as the settled one instead of fusing two paragraphs.
        const delta = ctx.pendingJoin ? `\n\n${ame.delta}` : ame.delta;
        ctx.pendingJoin = false;
        ctx.assistantText += delta;
        out.push({
          method: 'item/agentMessage/delta',
          params: { threadId, turnId, itemId: turnId, delta }
        });
      } else if (ame.type === 'thinking_start') {
        out.push({ method: 'item/started', params: { item: { type: 'reasoning', id: turnId }, threadId, turnId } });
      }
      break;
    }
    case 'tool_execution_start': {
      const nested = toolArgsOf(ev);
      const item = toolCallActivity(
        String(ev.toolCallId ?? turnId),
        ev.toolName as string | undefined,
        nested,
        toolDetail(ev)
      );
      if (!ctx.activity.some((a) => a.id === item.id)) ctx.activity.push(item);
      if (!ctx.activityStartedAt.has(item.id)) ctx.activityStartedAt.set(item.id, Date.now());
      // Any web-access tool call taints the turn's capture as web-derived (see
      // TurnContext.webTainted) — set at start, not end, so even a failed fetch
      // that still returned partial content can never dodge the flag.
      if (WEB_ACCESS_TOOLS.has((item.name ?? '').toLowerCase())) ctx.webTainted = true;
      // The entry is recorded even when the turn is over its retention budget, so
      // the tool COUNT stays honest for the authoring gate; only the payload is
      // dropped.
      if (!ctx.trace.some((t) => t.id === item.id)) {
        const args = ctx.traceChars < TRACE_TURN_MAX_CHARS ? traceArgs(nested) : undefined;
        ctx.traceChars += args?.length ?? 0;
        ctx.trace.push({ id: item.id, name: item.name, args });
      }
      out.push({
        method: 'item/started',
        params: {
          item: { type: item.type, id: item.id, name: item.name, detail: item.detail },
          threadId,
          turnId
        }
      });
      break;
    }
    case 'tool_execution_end': {
      const id = String(ev.toolCallId ?? '');
      const entry = ctx.activity.find((a) => a.id === id);
      if (!entry) break; // an end without a tracked start (or unkeyed) — nothing to flip
      const result = ev.result as { isError?: boolean; content?: unknown } | undefined;
      entry.status = ev.isError === true || result?.isError === true ? 'error' : 'ok';
      // Retain the outcome for skill authoring. A failure is worth more than a
      // success here — it is what turns a list of steps into a warning about the
      // dead end — so errors are kept even once the budget is spent.
      const traced = ctx.trace.find((t) => t.id === id);
      if (traced) {
        traced.isError = entry.status === 'error';
        const text = resultText(result).trim();
        if (text && (traced.isError || ctx.traceChars < TRACE_TURN_MAX_CHARS)) {
          traced.result = truncate(text, TRACE_RESULT_MAX_CHARS);
          ctx.traceChars += traced.result.length;
        }
      }
      // Attribute the turn's tool time to the tool that spent it. A slow backend
      // is otherwise indistinguishable from a chatty one.
      const startedAt = ctx.activityStartedAt.get(id);
      if (startedAt !== undefined) entry.ms = Date.now() - startedAt;
      // Web sources for the citations panel. Native search used to stream these on
      // the provider's own event stream (recovered by a codex-only tee); now they
      // come back inside the pi-web-access tool result, as inline markdown links
      // plus a trailing "**Sources:**" list, and are parsed out of its text.
      if (entry.status === 'ok' && isWebSearchTool(entry.name)) {
        ctx.webTainted = true;
        for (const source of extractSources(resultText(result))) {
          if (!ctx.sources.some((s) => s.url === source.url)) ctx.sources.push(source);
        }
      }
      out.push({
        method: 'item/completed',
        params: {
          item: { type: entry.type, id, name: entry.name, detail: entry.detail, status: entry.status },
          threadId,
          turnId
        }
      });
      break;
    }
    // pi condensing the conversation mid-run (context-overflow recovery, or the
    // pre-send threshold check) — shown as an activity row like any tool call.
    // Post-run threshold compaction arrives after the turn settled and is handled
    // by PiRuntime instead (no live TurnContext exists by then).
    case 'compaction_start': {
      const n = ctx.activity.filter((a) => a.type === 'compaction').length;
      const id = `compaction-${turnId}-${n}`;
      ctx.activity.push({ id, kind: 'tool', type: 'compaction', status: 'running' });
      out.push({ method: 'item/started', params: { item: { type: 'compaction', id }, threadId, turnId } });
      break;
    }
    case 'compaction_end': {
      const entry = [...ctx.activity].reverse().find((a) => a.type === 'compaction' && a.status === 'running');
      if (!entry) break; // an end without a tracked start — nothing to flip
      entry.status = ev.aborted === true || typeof ev.errorMessage === 'string' ? 'error' : 'ok';
      out.push({
        method: 'item/completed',
        params: { item: { type: 'compaction', id: entry.id, status: entry.status }, threadId, turnId }
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
      } else {
        // pi retries transient provider failures (fetch failed, context overflow
        // via auto-compaction) within the same agent run. A later assistant
        // message that ends cleanly means the run recovered — clear the latched
        // error so agent_end reports the turn's final outcome, not its worst one.
        ctx.errored = false;
        ctx.errorMessage = undefined;
      }
      // One turn can carry several assistant messages: a message that stops on a
      // tool call is followed by another once the tool returns, and the web-access
      // extension nudges a fresh one (sendMessage triggerTurn) when a background
      // URL fetch lands — sometimes after the answer was already written. They are
      // consecutive parts of ONE reply: the renderer keys a single bubble on the
      // turn id, so joining them is what keeps the earlier parts on screen. Before
      // this, the last message REPLACED everything the user had already read.
      if (text) {
        ctx.assistantText = ctx.committedText ? `${ctx.committedText}\n\n${text}` : text;
        // Errored/aborted messages are left uncommitted so pi's in-run retry — which
        // replays the whole reply — overwrites the partial instead of appending to it.
        if (!ctx.errored && !ctx.aborted) {
          ctx.committedText = ctx.assistantText;
          ctx.pendingJoin = true;
        }
      }
      // Emit the authoritative completed message (renderer replaces streamed deltas).
      if (text || (!ctx.errored && !ctx.aborted)) {
        out.push({
          method: 'item/completed',
          params: { item: { type: 'agentMessage', id: turnId, text: ctx.assistantText }, threadId, turnId }
        });
      }
      // Per-turn token usage (context fill) — absent on errored/aborted turns.
      if (!ctx.errored && !ctx.aborted) {
        const usage = toTurnUsage(msg.usage);
        if (usage) out.push({ method: 'turn/usage', params: { threadId, turnId, ...usage } });
      }
      break;
    }
    case 'agent_end': {
      // pi announces post-run auto-retry on the agent_end itself (willRetry): after
      // a backoff the SAME run continues (`agent.continue()`), so the turn is not
      // over — keep it open and let the continuation stream into it. A later clean
      // message_end clears the latched error (see above). If the promised retry
      // never materializes, agent_settled settles the turn (runtime backstop).
      if (ev.willRetry === true && !ctx.aborted) return { events: out, done: false };
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
