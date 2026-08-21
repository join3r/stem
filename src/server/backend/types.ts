import type { EventEmitter } from 'node:events';
import type {
  ChatMessage,
  ChatSummary,
  McpAdminProposal,
  McpLoginResult,
  ModelSummary,
  RuntimeStatus,
  ScheduleTaskRequest,
  ScheduledTask,
  StartTurnInput,
  StartTurnResult,
  ThreadTurnSettings
} from '../../shared/types';
import type { SkillBridge } from '../skills/bridge';

/**
 * The seam the backend uses to reach the scheduled-tasks subsystem (which lives in
 * main, not the backend). The assistant's `schedule_task` / `notify_user` tools run
 * inside the pi process; PiRuntime intercepts them and routes here, supplying the
 * authoritative current threadId. A backend with no scheduler can leave it unset.
 */
/**
 * Opaque token identifying a held approval round-trip (emitted with the
 * approval-request event, passed back on resolve). Backends choose the
 * representation — an id is only ever compared, never interpreted.
 */
export type ApprovalId = number | string;

/** One run_command request as it leaves the backend for the main-process ExecService. */
export interface ExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  /**
   * The paired computer the command should run on — a device label or id, as
   * the assistant heard it. Absent = the machine Stem runs on. Resolution,
   * policy and routing all happen in the ExecService; the tool passes the name
   * through verbatim.
   */
  device?: string;
  /** The originating conversation (null when no turn is live — shouldn't happen in practice). */
  threadId: string | null;
  /** True for autonomous scheduled runs — manual approvals are rejected there. */
  isScheduled: boolean;
  /**
   * The user message that started the current turn. Context for the safety judge,
   * which classifies the command relative to what the user actually asked for.
   */
  userText?: string;
  /**
   * The live chat's `provider/model` id when known. It is what the safety judge
   * runs on when neither it nor the shared background model is pinned — a
   * provider this chat is demonstrably signed in to.
   */
  currentModel?: string | null;
}

/** What the ExecService answers a run_command round-trip with. */
export type ExecBridgeResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * The seam the backend uses to reach the command executor (which lives in main,
 * not the backend). The assistant's `run_command` tool runs inside the pi
 * process; PiRuntime intercepts its round-trip and routes here, supplying the
 * authoritative threadId + scheduled flag. A backend without exec leaves it unset.
 */
export interface ExecBridge {
  /** Run the full policy (allowlist → judge → approval) and, if approved, the command. */
  handleExecRequest(req: ExecRequest): Promise<ExecBridgeResult>;
  /** Abort running commands + pending approvals for one thread (turn interrupted). */
  abortThread(threadId: string): void;
  /** Abort everything (the backend process died/restarted). */
  settleAll(): void;
}

/** What the assistant's coding_agent tool sends over its round-trip. */
export interface HarnessRequest {
  agent: string;
  prompt: string;
  cwd?: string;
  device?: string;
  freshSession?: boolean;
  /**
   * The tool call's own id in the turn strip, passed through so live progress
   * can target that row. Advisory and UI-only — nothing trusts it.
   */
  itemId?: string;
  /** Injected by PiRuntime from the live turn, never trusted from the payload. */
  threadId: string;
  isScheduled?: boolean;
}

/** What the HarnessService answers a coding_agent round-trip with. */
export type HarnessBridgeResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * The seam the backend uses to reach the coding-harness service (which lives
 * in main, not the backend). The assistant's `coding_agent` tool runs inside
 * the pi process; PiRuntime intercepts its round-trip and routes here,
 * supplying the authoritative threadId + scheduled flag. The call BLOCKS for
 * the whole harness turn — minutes to hours — and pi holds the elicitation
 * open the entire time (tests/unit/pi-elicitation-hold.test.ts is the proof).
 */
export interface HarnessBridge {
  /** Run one full harness turn (gate → session → turn → result text). */
  handleHarnessRequest(req: HarnessRequest): Promise<HarnessBridgeResult>;
  /** Cancel live harness turns + pending cards for one thread (turn interrupted). */
  abortThread(threadId: string): void;
  /** Cancel everything (the backend process died/restarted). */
  settleAll(): void;
}

export interface TaskBridge {
  /** Create a task bound to `threadId` from the assistant's schedule_task tool. */
  schedule(
    req: ScheduleTaskRequest,
    threadId: string
  ): Promise<{ ok: true; task: ScheduledTask } | { ok: false; error: string }>;
  /** Tasks bound to `threadId` (so the assistant can list/cancel its own). */
  listForThread(threadId: string): Promise<ScheduledTask[]>;
  /** Cancel a task the assistant created. */
  cancel(taskId: string): Promise<{ ok: boolean; error?: string }>;
  /** Surface a prominent in-app alert (the agent decided this run is worth showing). */
  notify(payload: { title?: string; message: string }, threadId: string): Promise<void>;
}

/**
 * The single seam between Stem and whatever hosts the agent loop. PiRuntime
 * (pi.dev, RPC mode) is the only implementation today. The renderer, the IPC
 * layer, the HUD, and Stem Recall all talk only to this surface plus the
 * normalized `'event'` stream — they never know which backend is live.
 *
 * Two load-bearing contracts every backend must honor:
 *
 *  1. It extends EventEmitter and emits `'event'` with a `BackendEventEnvelope`
 *     ({ method, params, receivedAt }). The set of `method` strings the UI
 *     consumes is Stem's canonical internal protocol:
 *     `item/agentMessage/delta`, `item/started`, `item/completed`,
 *     `turn/completed`, `turn/failed`, `turn/aborted`, `process/exit`,
 *     plus the side channels `mcp/login/url`, `mcp/changed`, `mcp/status`,
 *     `mcp/admin/approvalRequest`, `skills/changed`. Deltas and the completed item for one turn
 *     share a `turnId` (the renderer keys bubbles `assistant-${turnId}`).
 *  2. A new backend that lacks a feature in the method surface below should
 *     degrade gracefully (e.g. emit nothing) rather than change these shapes.
 */
export interface ChatBackend extends EventEmitter {
  // lifecycle / auth
  status(): Promise<RuntimeStatus>;
  login(): Promise<RuntimeStatus>;
  restart(): Promise<void>;
  /** Whether a turn is streaming — a config change that needs a respawn waits. */
  isTurnRunning(): boolean;
  shutdown(timeoutMs?: number): Promise<void>;
  newConversation(): Promise<void>;
  /** Eagerly spawn the backend process and connect MCP servers so the first turn
   *  doesn't pay cold-start. Idempotent; safe to call repeatedly. */
  prewarm(): Promise<void>;

  // turns
  createThread(model?: string): Promise<string>;
  startTurn(input: StartTurnInput): Promise<StartTurnResult>;
  interruptTurn(turnId: string): Promise<void>;
  listModels(): Promise<ModelSummary[]>;

  // recall seam (one-shot completion used by Stem Recall distillation).
  // `opts.model` is a `provider/model` id (null/undefined => the backend default).
  // `opts.effort` is a reasoning level (null/undefined => whatever the model
  // defaults to, which is what every background job did before the setting
  // existed — nobody chose it).
  // `opts.priority` jumps ahead of non-priority waiters when the complete() slot
  // queue is busy (used by the exec safety judge so distill does not starve it).
  complete(
    prompt: string,
    opts?: { model?: string | null; effort?: string | null; timeoutMs?: number; priority?: boolean }
  ): Promise<string>;
  isInternalThread(threadId: string): boolean;
  /** True when the active turn read a memorize:false connected folder → skip Recall capture. */
  isCaptureSuppressed(threadId: string): boolean;
  /** True when the active turn used web tools → captured messages are flagged `web` (untrusted content). */
  isWebTainted(threadId: string): boolean;
  /**
   * Capture the live turn's held-back user message (deferred until the turn's
   * memorize:false verdict is knowable). Called by main just before capturing
   * assistant material for the thread; no-op when nothing is pending.
   */
  flushPendingUserCapture(threadId: string): void;

  /**
   * The model/effort a scheduled run of this thread would use: the thread's last
   * explicitly selected model, not whatever the process happens to be on. Shown
   * in the Tasks tab and applied by startTurn for scheduled runs.
   */
  threadTurnSettings(threadId: string): Promise<ThreadTurnSettings>;

  /**
   * Condense a thread's context (summarize older messages). Used by the
   * scheduler's overflow self-heal before retrying a failed run.
   */
  compactThread(threadId: string): Promise<void>;

  // thread CRUD
  listThreads(): Promise<ChatSummary[]>;
  readThread(threadId: string): Promise<{ title: string; messages: ChatMessage[] }>;
  resumeThread(threadId: string): Promise<void>;
  renameThread(threadId: string, name: string): Promise<void>;
  /**
   * Ask a small model to name the thread from its conversation and apply the name
   * per Settings → Chat → Chats (see server/chats/subject.ts). Always resolves; a
   * thread that gets no subject just keeps the name it already has. `force` = the
   * explicit "Write a subject" action, which ignores the mode, reads the whole
   * thread and may replace a hand-typed name. The automatic naming schedule runs
   * inside the backend, off each settled turn. Emits `chats:changed` when a
   * subject actually lands.
   */
  writeThreadSubject(threadId: string, force?: boolean): Promise<string | null>;
  deleteThread(threadId: string): Promise<void>;
  rollbackToTurn(threadId: string, turnId: string): Promise<void>;
  forkThread(threadId: string, turnId: string): Promise<{ threadId: string }>;

  // MCP
  mcpLogin(name: string): Promise<McpLoginResult>;
  getMcpStatus(): Record<string, { status: string; error: string | null }>;
  /**
   * Release an assistant-proposed MCP mutation. Main performs the accepted
   * mutation through its serialized config writer before the held tool call is
   * allowed to continue.
   */
  resolveAdminApproval(
    id: ApprovalId,
    accept: boolean,
    beforeAccept?: (proposal: McpAdminProposal) => Promise<void>
  ): Promise<boolean>;
  /** Release a held custom-instructions approval (main has already written settings). */
  resolveInstructionsApproval(
    id: ApprovalId,
    accept: boolean,
    beforeAccept?: () => Promise<void>
  ): Promise<boolean>;

  // Skills: apply out-of-band skill changes (the background curator) by reloading
  // the backend, deferring to turn end if a turn is in flight.
  requestSkillReload(): Promise<void>;
  /**
   * Answer a pending skill approval card. `skill` is the card's final text, which
   * the user may have edited; main re-validates it before writing. False when the
   * card had already expired or been answered.
   */
  resolveSkillApproval(id: ApprovalId, accept: boolean, skill?: { name: string; description: string; body: string }): boolean;
  // Skills: wire the bridge the assistant's manage_skill tool routes through.
  // Pass null to detach. No-op on a backend without skills.
  setSkillBridge(bridge: SkillBridge | null): void;

  // Scheduled tasks: wire the bridge the assistant's schedule_task/notify_user
  // tools route through. Pass null to detach. No-op on a backend without scheduling.
  setTaskBridge(bridge: TaskBridge | null): void;

  // Command execution: wire the bridge the assistant's run_command tool routes
  // through. Pass null to detach. No-op on a backend without exec.
  setExecBridge(bridge: ExecBridge | null): void;

  // Coding agents: wire the bridge the assistant's coding_agent tool routes
  // through. Pass null to detach. No-op on a backend without harness support.
  setHarnessBridge(bridge: HarnessBridge | null): void;
}
