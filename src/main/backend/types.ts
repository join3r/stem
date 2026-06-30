import type { EventEmitter } from 'node:events';
import type {
  ChatMessage,
  ChatSummary,
  McpLoginResult,
  ModelSummary,
  RuntimeStatus,
  ScheduleTaskRequest,
  ScheduledTask,
  StartTurnInput,
  StartTurnResult
} from '../../shared/types';

/**
 * The seam the backend uses to reach the scheduled-tasks subsystem (which lives in
 * main, not the backend). The assistant's `schedule_task` / `notify_user` tools run
 * inside the pi process; PiRuntime intercepts them and routes here, supplying the
 * authoritative current threadId. A backend with no scheduler can leave it unset.
 */
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
  complete(prompt: string, opts?: { model?: string | null; timeoutMs?: number }): Promise<string>;
  isInternalThread(threadId: string): boolean;
  /** True when the active turn read a memorize:false connected folder → skip Recall capture. */
  isCaptureSuppressed(threadId: string): boolean;

  // thread CRUD
  listThreads(): Promise<ChatSummary[]>;
  readThread(threadId: string): Promise<{ title: string; messages: ChatMessage[] }>;
  resumeThread(threadId: string): Promise<void>;
  renameThread(threadId: string, name: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  rollbackToTurn(threadId: string, turnId: string): Promise<void>;
  forkThread(threadId: string, turnId: string): Promise<{ threadId: string }>;

  // MCP
  mcpLogin(name: string): Promise<McpLoginResult>;
  getMcpStatus(): Record<string, { status: string; error: string | null }>;
  resolveAdminApproval(id: number | string, accept: boolean): void;
  /** Release a held custom-instructions approval (main has already written settings). */
  resolveInstructionsApproval(id: number | string, accept: boolean): void;
  configMcpServerReload(): Promise<void>;

  // Skills: apply out-of-band skill changes (the background curator) by reloading
  // the backend, deferring to turn end if a turn is in flight.
  requestSkillReload(): Promise<void>;

  // Scheduled tasks: wire the bridge the assistant's schedule_task/notify_user
  // tools route through. Pass null to detach. No-op on a backend without scheduling.
  setTaskBridge(bridge: TaskBridge | null): void;
}
