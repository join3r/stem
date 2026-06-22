import type { EventEmitter } from 'node:events';
import type {
  ChatMessage,
  ChatSummary,
  McpLoginResult,
  ModelSummary,
  RuntimeStatus,
  StartTurnInput,
  StartTurnResult
} from '../../shared/types';

/**
 * The single seam between Stem and whatever hosts the agent loop. CodexRuntime
 * is one implementation; PiRuntime (pi.dev, RPC mode) is the other. The renderer,
 * the IPC layer, the HUD, and Stem Recall all talk only to this surface plus the
 * normalized `'event'` stream — they never know which backend is live.
 *
 * Two load-bearing contracts every backend must honor:
 *
 *  1. It extends EventEmitter and emits `'event'` with a `BackendEventEnvelope`
 *     ({ method, params, receivedAt }). The set of `method` strings the UI
 *     consumes is Stem's canonical internal protocol (originally codex's):
 *     `item/agentMessage/delta`, `item/started`, `item/completed`,
 *     `turn/completed`, `turn/failed`, `turn/aborted`, `process/exit`,
 *     plus the side channels `mcp/login/url`, `mcp/changed`, `mcp/status`,
 *     `mcp/admin/approvalRequest`. Deltas and the completed item for one turn
 *     share a `turnId` (the renderer keys bubbles `assistant-${turnId}`).
 *  2. The method surface below mirrors the original CodexRuntime API so the seam
 *     is a drop-in. A new backend that lacks a codex feature should degrade
 *     gracefully (e.g. emit nothing) rather than change these shapes.
 */
export interface ChatBackend extends EventEmitter {
  // lifecycle / auth
  status(): Promise<RuntimeStatus>;
  login(): Promise<RuntimeStatus>;
  restart(): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
  newConversation(): Promise<void>;

  // turns
  createThread(model?: string): Promise<string>;
  startTurn(input: StartTurnInput): Promise<StartTurnResult>;
  interruptTurn(turnId: string): Promise<void>;
  listModels(): Promise<ModelSummary[]>;

  // recall seam (one-shot completion used by Stem Recall distillation)
  complete(prompt: string, timeoutMs?: number): Promise<string>;
  isInternalThread(threadId: string): boolean;

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
  configMcpServerReload(): Promise<void>;
}
