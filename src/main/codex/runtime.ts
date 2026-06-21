import { EventEmitter } from 'node:events';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  ChatMessage,
  ChatSummary,
  CodexEventEnvelope,
  CodexItem,
  McpAdminProposal,
  McpLoginResult,
  McpServerInput,
  MessageMeta,
  ModelSummary,
  RuntimeStatus,
  StartTurnInput,
  StartTurnResult
} from '../../shared/types';
import { agentMessageText } from '../../shared/types';
import { PLAIN_MD_DIRECTIVE, STEM_ASSISTANT_INSTRUCTIONS } from '../workspace/bootstrap';
import { captureMemoryFromUserInput, isRecallEnabled } from '../workspace/memory';
import { buildRecallContext } from '../recall/inject';
import { buildFilesContext } from '../files/inject';
import { captureUserMessage } from '../recall/capture';
import { RECALL_MCP_NAME } from '../recall/register-mcp';
import { ADMIN_MCP_NAME } from '../admin/register-mcp';
import { ingestAttachments } from '../workspace/attachments';
import { findCodexPath } from './locate';

const RPC_TIMEOUT_MS = 60_000;
type JsonRpcId = number | string;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RuntimeOptions {
  codexHome: string;
  workspaceRoot: string;
}

/** A codex thread as returned by `thread/list` / `thread/read` (subset we use). */
interface RawThread {
  id: string;
  name?: string | null;
  preview?: string | null;
  createdAt?: number;
  updatedAt?: number;
  /**
   * Absolute path to the on-disk rollout JSONL. `thread/read` does NOT expose
   * per-turn model/effort, but the rollout's `turn_context` records do — we read
   * them from here and join by turn id (see readTurnMeta / threadToMessages).
   */
  path?: string;
  turns?: RawTurn[];
}

/** A turn within a thread. `id` matches the rollout's `turn_context.turn_id`. */
interface RawTurn {
  id?: string;
  items?: CodexItem[];
}

/** One JSON line of a codex rollout file (only the turn_context shape we need). */
interface RolloutLine {
  type?: string;
  payload?: { type?: string; turn_id?: string; model?: string; effort?: string | null };
}

/** A codex model as returned by `model/list` (subset we use). */
interface RawModel {
  id: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[];
  defaultReasoningEffort?: string;
  serviceTiers?: { id: string; name: string; description: string }[];
  isDefault?: boolean;
}

/**
 * Owns the `codex app-server` child process and the newline-delimited JSON-RPC
 * transport. Authenticates against the app's isolated CODEX_HOME and forces
 * ChatGPT (subscription) auth by stripping API-key env vars.
 */
export class CodexRuntime extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private initialized = false;
  private starting: Promise<void> | null = null;
  // Threads with a live codex subscription. Multiple threads can stream turns at
  // once, so we track them as a set rather than a single "active" id — this is
  // what makes concurrent runs across chats possible. Cleared/unsubscribed only
  // on shutdown (for graceful memory-drain) and process exit.
  private subscribed = new Set<string>();
  // Threads Stem creates for its own internal LLM work (Level-1 distillation).
  // Their events are neither forwarded to the UI nor captured into recall, and
  // they use a distinct cwd so they never appear in the chat list.
  private internalThreads = new Set<string>();
  private startupError: string | null = null;
  /** Pending assistant MCP-change approvals, keyed by codex elicitation request id. */
  private adminApprovals = new Map<JsonRpcId, (accept: boolean) => void>();
  /** Latest stem-admin mcpToolCall args per thread, to enrich the approval card. */
  private adminToolArgsByThread = new Map<string, { tool: string; arguments: unknown }>();
  /** Set when an assistant MCP change is approved; triggers a reload on turn end. */
  private pendingMcpReload = false;
  /**
   * Latest live connection status per MCP server, from app-server
   * `mcpServer/startupStatus/updated` notifications. This is the ONLY honest
   * signal of whether a server actually loaded: `codex mcp list` reports
   * `auth_status` (whether OAuth creds exist in the keyring), which stays
   * `o_auth` even when the token is rejected at connect time and the server
   * exposes zero tools. Cleared on every (re)spawn.
   */
  private mcpStatus = new Map<string, { status: string; error: string | null }>();

  constructor(private readonly options: RuntimeOptions) {
    super();
  }

  async status(): Promise<RuntimeStatus> {
    const base: RuntimeStatus = {
      ok: false,
      codexPath: null,
      codexHome: this.options.codexHome,
      workspaceRoot: this.options.workspaceRoot
    };

    const codexPath = await findCodexPath();
    if (!codexPath) {
      return { ...base, error: 'codex was not found on PATH.' };
    }
    base.codexPath = codexPath;

    const health = await this.run(codexPath, ['--version']);
    if (!health.ok) {
      return { ...base, error: `codex is installed but could not run: ${health.detail}` };
    }

    const login = await this.run(codexPath, ['login', 'status']);
    if (!login.ok) {
      return {
        ...base,
        authenticated: false,
        loginCommand: this.loginCommand(codexPath),
        error: 'Stem is not signed in. Sign in with ChatGPT to continue.'
      };
    }

    if (this.startupError) {
      return { ...base, authenticated: true, error: this.startupError };
    }

    return {
      ...base,
      ok: true,
      authenticated: true,
      loginCommand: this.loginCommand(codexPath)
    };
  }

  /** Drives the interactive `codex login` browser flow against the isolated home. */
  async login(): Promise<RuntimeStatus> {
    const codexPath = await findCodexPath();
    if (!codexPath) {
      return this.status();
    }
    await new Promise<void>((resolve) => {
      const child = execFile(
        codexPath,
        ['login'],
        { env: this.sanitizedEnv(), timeout: 180_000 },
        () => resolve()
      );
      child.on('error', () => resolve());
    });
    return this.status();
  }

  /**
   * Drive `codex mcp login <name>` (OAuth) against the isolated home. Codex
   * opens the browser itself; we also stream the authorize URL out as an
   * `mcp/login/url` event so the UI can show a click/copy fallback.
   */
  async mcpLogin(name: string): Promise<McpLoginResult> {
    // Defense-in-depth: names are validated on add, but guard here too since
    // this reaches argv — a leading-dash name could otherwise smuggle flags.
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('-')) {
      return { ok: false, error: 'Invalid MCP server name.' };
    }
    const codexPath = await findCodexPath();
    if (!codexPath) {
      return { ok: false, error: 'codex was not found on PATH.' };
    }
    return new Promise<McpLoginResult>((resolve) => {
      const child = spawn(codexPath, ['mcp', 'login', '--', name], {
        env: this.sanitizedEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let urlEmitted = false;
      let output = '';
      const scan = (chunk: Buffer): void => {
        const text = chunk.toString('utf8');
        output += text;
        if (!urlEmitted) {
          const match = text.match(/https?:\/\/\S+/);
          if (match) {
            urlEmitted = true;
            this.emitEvent('mcp/login/url', { name, url: match[0] });
          }
        }
      };
      child.stdout.on('data', scan);
      child.stderr.on('data', scan);

      const timer = setTimeout(() => {
        child.kill();
        resolve({ ok: false, error: 'Timed out waiting for browser authorization.' });
      }, 180_000);

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, error: error.message });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, error: output.trim() || `codex mcp login exited with code ${code ?? 'null'}.` });
      });
    });
  }

  /**
   * Restart the app-server so config.toml changes and new MCP OAuth tokens take
   * effect in place (no app quit). Shuts the old process down gracefully and
   * waits for it to fully exit before respawning, so the old exit handler can't
   * null out the new process.
   */
  async restart(): Promise<void> {
    await this.shutdown();
    await this.ensureStarted();
  }

  // A fresh conversation needs no server-side action: the next turn creates its
  // own thread lazily (startTurn with no threadId). We deliberately do NOT
  // unsubscribe anything here — doing so would tear down the event stream of any
  // chat still answering in the background.
  async newConversation(): Promise<void> {
    // no-op
  }

  /**
   * Gracefully stop the app-server: send SIGTERM so Codex can drain its
   * background jobs — crucially the memory ingestion/consolidation worker — and
   * await its exit. A hard SIGKILL backstop guarantees quit/restart never hangs
   * if Codex's own drain wedges.
   *
   * This matters: Codex guards each memory job with a ~1h lease for crash
   * safety. Killing the process without letting it drain orphans that lease, so
   * no later worker resumes consolidation and the human-readable memory files
   * silently stop updating. SIGTERM gives Codex the window to release/finish.
   */
  async shutdown(timeoutMs = 12_000): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    await this.unsubscribeAll(1500);
    this.initialized = false;
    await new Promise<void>((resolve) => {
      const backstop = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
      proc.once('exit', () => {
        clearTimeout(backstop);
        resolve();
      });
      proc.kill('SIGTERM');
    });
  }

  /**
   * Create an empty thread and return its id, without running a turn. Lets the
   * Quick Chat overlay pre-create its thread so the main process knows the
   * thread id (for event routing) before any events flow.
   */
  async createThread(model?: string): Promise<string> {
    await this.ensureStarted();
    return this.startThread(model);
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const memory = await captureMemoryFromUserInput(input.input);
    if (memory.shouldAcknowledge) {
      return {
        handled: true,
        assistantMessage: "I'll remember that.",
        rememberedPath: memory.path
      };
    }

    await this.ensureStarted();
    const threadId = input.threadId ?? (await this.startThread(input.model));
    this.subscribed.add(threadId);

    const recallEnabled = isRecallEnabled();
    const recallContext = recallEnabled ? buildRecallContext(input.input, { currentThreadId: threadId }) : null;
    // The current Files-folder listing, so the assistant always knows what the
    // user has on hand and can read any of them on demand.
    const filesContext = await buildFilesContext();
    // Assemble per-turn additional context: recalled memory (when present), the
    // Files listing (when non-empty), plus a plain-Markdown directive when the
    // user picked .md for this prompt.
    const additionalContext: Record<string, { value: string; kind: string }> = {};
    if (recallContext) {
      additionalContext['stem-recall'] = { value: recallContext, kind: 'application' };
    }
    if (filesContext) {
      additionalContext['stem-files'] = { value: filesContext, kind: 'application' };
    }
    if (input.format === 'md') {
      additionalContext['stem-format'] = { value: PLAIN_MD_DIRECTIVE, kind: 'application' };
    }
    // Attached images become localImage items the model sees directly; non-image
    // files are copied into the workspace and noted in the text for the agent.
    const { imageItems, textNote } = input.attachments?.length
      ? await ingestAttachments(input.attachments, this.options.workspaceRoot)
      : { imageItems: [], textNote: '' };
    const result = (await this.request('turn/start', {
      threadId,
      cwd: this.options.workspaceRoot,
      input: [{ type: 'text', text: input.input + textNote }, ...imageItems],
      // Per-turn overrides ("for this turn and subsequent turns"). Only send keys
      // the UI actually set so unspecified values keep codex's defaults.
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
      ...(Object.keys(additionalContext).length > 0 ? { additionalContext } : {})
    })) as { turn?: { id?: string } };

    const turnId = result?.turn?.id;
    // Capture the user message into Stem Recall now that the turn ids are known
    // (assistant replies are captured from item/completed in index.ts).
    if (recallEnabled) {
      captureUserMessage({ threadId, turnId, text: input.input, cwd: this.options.workspaceRoot });
    }

    return { threadId, turnId };
  }

  /** Codex's selectable model catalog (`model/list`), shaped for the UI. */
  async listModels(): Promise<ModelSummary[]> {
    await this.ensureStarted();
    const result = (await this.request('model/list', { includeHidden: false })) as {
      data?: RawModel[];
    };
    return (result?.data ?? [])
      .filter((m) => !m.hidden)
      .map((m) => ({
        id: m.id,
        displayName: m.displayName ?? m.id,
        description: m.description ?? '',
        supportedEfforts: (m.supportedReasoningEfforts ?? [])
          .map((e) => e.reasoningEffort)
          .filter((e): e is string => typeof e === 'string'),
        defaultEffort: m.defaultReasoningEffort ?? 'medium',
        serviceTiers: (m.serviceTiers ?? []).map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description
        })),
        isDefault: !!m.isDefault
      }));
  }

  async interruptTurn(turnId: string): Promise<void> {
    if (!this.proc) return;
    await this.request('turn/interrupt', { turnId });
  }

  /** True for hidden internal threads (distillation) — used to suppress UI + capture. */
  isInternalThread(threadId: string): boolean {
    return this.internalThreads.has(threadId);
  }

  /**
   * One-shot prompt → completion via a hidden app-server turn. Backs the
   * LlmClient seam (Level-1 distillation). The thread uses a distinct cwd so it
   * never shows in the cwd-filtered chat list, is flagged internal so its events
   * are suppressed (index.ts) instead of rendered/captured, and is deleted after.
   */
  async complete(prompt: string, timeoutMs = 120_000): Promise<string> {
    await this.ensureStarted();
    const cwd = join(this.options.workspaceRoot, '.stem-internal');
    const startRes = (await this.request('thread/start', {
      cwd,
      baseInstructions:
        'You are a precise extraction engine. Follow the instructions exactly and output only what is requested.'
    })) as { thread?: { id?: string } };
    const threadId = startRes?.thread?.id;
    if (!threadId) throw new Error('Codex did not return a thread id for completion.');
    this.internalThreads.add(threadId);

    try {
      let text = '';
      const done = new Promise<void>((resolve, reject) => {
        const onEvent = (env: CodexEventEnvelope): void => {
          const p = env.params as { threadId?: string; item?: CodexItem } | undefined;
          if (!p || p.threadId !== threadId) return;
          if (env.method === 'item/completed' && p.item?.type === 'agentMessage') {
            text = agentMessageText(p.item) || text;
          } else if (env.method === 'turn/completed') {
            cleanup();
            resolve();
          } else if (env.method === 'turn/failed' || env.method === 'turn/aborted') {
            cleanup();
            reject(new Error(`Completion turn ${env.method}.`));
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Completion timed out.'));
        }, timeoutMs);
        const cleanup = (): void => {
          clearTimeout(timer);
          this.off('event', onEvent);
        };
        this.on('event', onEvent);
      });
      await this.request('turn/start', { threadId, cwd, input: [{ type: 'text', text: prompt }] });
      await done;
      return text;
    } finally {
      this.internalThreads.delete(threadId);
      void this.request('thread/delete', { threadId }).catch(() => {});
    }
  }

  // ---- chats (codex thread store) ----
  //
  // Codex persists every thread on disk under CODEX_HOME, so these survive app
  // restarts. We scope to Stem's chats by the app-owned workspace cwd (the
  // `source` field reports 'vscode' for app-server threads, so filtering by
  // sourceKinds would wrongly exclude them — cwd is the reliable filter).

  /** List Stem's chats, newest-updated first. Folder assignment is merged in by the caller. */
  async listThreads(): Promise<ChatSummary[]> {
    await this.ensureStarted();
    const result = (await this.request('thread/list', {
      cwd: this.options.workspaceRoot,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      limit: 200
    })) as { data?: RawThread[]; threads?: RawThread[] };
    const threads = result?.data ?? result?.threads ?? [];
    return threads.map((t) => ({
      threadId: t.id,
      title: (t.name || t.preview || 'New chat').trim() || 'New chat',
      folderId: null,
      createdAt: t.createdAt ?? 0,
      updatedAt: t.updatedAt ?? t.createdAt ?? 0
    }));
  }

  /** Read a chat's full history and flatten it into renderer messages. */
  async readThread(threadId: string): Promise<{ title: string; messages: ChatMessage[] }> {
    await this.ensureStarted();
    const result = (await this.request('thread/read', { threadId, includeTurns: true })) as {
      thread?: RawThread;
    };
    const thread = result?.thread;
    const title = (thread?.name || thread?.preview || 'New chat').trim() || 'New chat';
    const turnMeta = await this.readTurnMeta(thread?.path);
    return { title, messages: this.threadToMessages(thread, turnMeta) };
  }

  /**
   * Parse a rollout JSONL for per-turn model/effort. codex records these in
   * `turn_context` lines keyed by `turn_id` (service tier is NOT persisted). A
   * missing/unreadable file yields an empty map — history then shows no tooltip.
   */
  private async readTurnMeta(path: string | undefined): Promise<Map<string, MessageMeta>> {
    const map = new Map<string, MessageMeta>();
    if (!path) return map;
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return map;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: RolloutLine;
      try {
        parsed = JSON.parse(line) as RolloutLine;
      } catch {
        continue;
      }
      const type = parsed.type ?? parsed.payload?.type;
      if (type !== 'turn_context') continue;
      const p = parsed.payload;
      const turnId = p?.turn_id;
      if (!p || typeof turnId !== 'string') continue;
      map.set(turnId, {
        model: typeof p.model === 'string' ? p.model : undefined,
        effort: typeof p.effort === 'string' ? p.effort : undefined
      });
    }
    return map;
  }

  /** Resume a saved thread so the next turn continues it with full context. */
  async resumeThread(threadId: string): Promise<void> {
    await this.ensureStarted();
    await this.request('thread/resume', {
      threadId,
      cwd: this.options.workspaceRoot,
      baseInstructions: STEM_ASSISTANT_INSTRUCTIONS
    });
    this.subscribed.add(threadId);
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    await this.ensureStarted();
    await this.request('thread/name/set', { threadId, name });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.ensureStarted();
    await this.request('thread/delete', { threadId });
    this.subscribed.delete(threadId);
  }

  /** Read a thread's ordered turn ids (authoritative source for rollback counts). */
  private async readTurnIds(threadId: string): Promise<string[]> {
    const result = (await this.request('thread/read', { threadId, includeTurns: true })) as {
      thread?: RawThread;
    };
    return (result?.thread?.turns ?? []).map((t) => t.id ?? '');
  }

  /**
   * Drop `turnId` and every turn after it from the thread's history, in place.
   * Used by retry/edit: the renderer then re-sends the (possibly edited) prompt as
   * a fresh turn. `thread/rollback` counts turns from the END, so we map the turn
   * id to its index against the authoritative turn list.
   */
  async rollbackToTurn(threadId: string, turnId: string): Promise<void> {
    await this.ensureStarted();
    const turnIds = await this.readTurnIds(threadId);
    const index = turnIds.indexOf(turnId);
    if (index === -1) throw new Error(`Turn ${turnId} not found in thread ${threadId}.`);
    const numTurns = turnIds.length - index;
    if (numTurns < 1) return;
    await this.request('thread/rollback', { threadId, numTurns });
  }

  /**
   * Fork the thread into a new one, trimmed to end at `turnId` (keeps everything up
   * to and including that turn). Codex's `thread/fork` copies the whole thread, so
   * we trim the copy with a rollback. Returns the new thread id. The new thread is
   * persisted on disk and will appear in `thread/list`.
   */
  async forkThread(threadId: string, turnId: string): Promise<{ threadId: string }> {
    await this.ensureStarted();
    const turnIds = await this.readTurnIds(threadId);
    const index = turnIds.indexOf(turnId);
    if (index === -1) throw new Error(`Turn ${turnId} not found in thread ${threadId}.`);
    const result = (await this.request('thread/fork', { threadId })) as { thread?: { id?: string } };
    const newId = result?.thread?.id;
    if (!newId) throw new Error('Codex did not return a forked thread id.');
    // Forked turns keep their original order; trim everything after the chosen turn.
    const numToDrop = turnIds.length - 1 - index;
    if (numToDrop > 0) {
      await this.request('thread/rollback', { threadId: newId, numTurns: numToDrop });
    }
    return { threadId: newId };
  }

  /** Flatten codex turns/items into the renderer's flat user/assistant message list. */
  private threadToMessages(thread: RawThread | undefined, turnMeta: Map<string, MessageMeta>): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const turn of thread?.turns ?? []) {
      // Which model/effort produced this turn's reply (service tier unavailable).
      const meta = turn.id ? turnMeta.get(turn.id) : undefined;
      for (const item of turn.items ?? []) {
        if (item.type === 'userMessage') {
          const text = (item.content ?? [])
            .filter((p) => typeof p.text === 'string')
            .map((p) => p.text as string)
            .join('');
          if (text.trim()) messages.push({ id: `user-${item.id}`, role: 'user', content: text, turnId: turn.id });
        } else if (item.type === 'agentMessage') {
          const text = agentMessageText(item);
          if (text.trim())
            messages.push({ id: `assistant-${item.id}`, role: 'assistant', content: text, meta, turnId: turn.id });
        }
        // Other item types (reasoning, webSearch, commandExecution, mcpToolCall…)
        // aren't rendered in the conversation and are intentionally skipped.
      }
    }
    return messages;
  }

  // ---- internals ----

  private async startThread(model?: string): Promise<string> {
    const result = (await this.request('thread/start', {
      model,
      cwd: this.options.workspaceRoot,
      baseInstructions: STEM_ASSISTANT_INSTRUCTIONS
    })) as { thread?: { id?: string } };
    const threadId = result?.thread?.id;
    if (!threadId) {
      throw new Error('Codex did not return a thread id.');
    }
    return threadId;
  }

  /**
   * Unsubscribe every live thread (used on shutdown/restart). This lets codex
   * drain its background jobs — crucially the memory consolidation worker —
   * before we SIGTERM. Raced against a timeout so quit never hangs.
   */
  private async unsubscribeAll(timeoutMs = 5000): Promise<void> {
    const threadIds = [...this.subscribed];
    this.subscribed.clear();
    if (!threadIds.length || !this.proc || !this.initialized) return;

    const unsubscribe = Promise.all(
      threadIds.map((threadId) =>
        this.request('thread/unsubscribe', { threadId }).catch((error) => {
          this.emitEvent('process/stderr', { text: `thread/unsubscribe failed: ${error.message}` });
        })
      )
    );

    await Promise.race([
      unsubscribe,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  }

  private ensureStarted(): Promise<void> {
    if (this.proc && this.initialized) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    const codexPath = await findCodexPath();
    if (!codexPath) {
      throw new Error('codex was not found on PATH.');
    }

    this.startupError = null;
    this.mcpStatus.clear(); // statuses belong to this proc's connections
    const proc = spawn(codexPath, ['app-server'], {
      cwd: this.options.workspaceRoot,
      env: this.sanitizedEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.proc = proc;

    proc.on('error', (error) => {
      this.startupError = error.message;
      this.emitEvent('process/error', { message: error.message });
      this.rejectAll(error);
    });

    proc.on('exit', (code, signal) => {
      this.initialized = false;
      this.proc = null;
      this.subscribed.clear();
      this.emitEvent('process/exit', { code, signal });
      this.rejectAll(new Error(`codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'}).`));
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      this.emitEvent('process/stderr', { text: chunk.toString('utf8') });
    });

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => this.handleLine(line));

    await this.request('initialize', {
      clientInfo: { name: 'stem', title: 'Stem', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    });
    this.notify('initialized', {});
    this.initialized = true;
  }

  private handleLine(line: string): void {
    let message: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: string }; params?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      this.emitEvent('process/stdout', { text: line });
      return;
    }

    if ((typeof message.id === 'number' || typeof message.id === 'string') && typeof message.method === 'string') {
      this.handleServerRequest(message.id, message.method, message.params);
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'Codex JSON-RPC request failed.'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === 'string') {
      // Forward every notification, known or not. The UI decides what matters;
      // unknown methods are simply ignored downstream rather than crashing.
      this.observeNotification(message.method, message.params);
      this.emitEvent(message.method, message.params);
    }
  }

  /**
   * Side-effects driven by codex notifications (in addition to forwarding them):
   * (1) buffer the latest `stem-admin` tool-call args per thread so the approval
   * card can show what the assistant proposed; (2) after a turn that included an
   * approved MCP change, hot-reload so the new tools take effect (no thread reset).
   */
  private observeNotification(method: string, params: unknown): void {
    const p = params as
      | { threadId?: string; item?: { type?: string; server?: string; tool?: string; arguments?: unknown } }
      | undefined;
    if (
      (method === 'item/started' || method === 'item/updated') &&
      p?.item?.type === 'mcpToolCall' &&
      p.item.server === ADMIN_MCP_NAME &&
      p.threadId
    ) {
      this.adminToolArgsByThread.set(p.threadId, { tool: p.item.tool ?? '', arguments: p.item.arguments });
    }
    if (method === 'turn/completed' && this.pendingMcpReload) {
      this.pendingMcpReload = false;
      void this.configMcpServerReload()
        .then(() => this.emitEvent('mcp/changed'))
        .catch(() => {});
    }
    // Track which MCP servers actually connected (vs. failed, e.g. an expired
    // OAuth token). Surfaced to the Manage panel so a failed remote server can
    // prompt re-login instead of falsely showing "Signed in".
    if (method === 'mcpServer/startupStatus/updated') {
      const s = params as { name?: string; status?: string; error?: string | null } | undefined;
      if (s?.name) {
        const prev = this.mcpStatus.get(s.name);
        const next = { status: s.status ?? 'unknown', error: s.error ?? null };
        if (!prev || prev.status !== next.status || prev.error !== next.error) {
          this.mcpStatus.set(s.name, next);
          this.emitEvent('mcp/status', this.getMcpStatus());
        }
      }
    }
  }

  /**
   * Snapshot of the live MCP connection status per server name. `ready` means
   * the server handshook and its tools are available; `failed` (with an error)
   * means it dropped — for a remote OAuth server that almost always means the
   * stored token was rejected and the user must sign in again.
   */
  getMcpStatus(): Record<string, { status: string; error: string | null }> {
    return Object.fromEntries(this.mcpStatus);
  }

  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    this.emitEvent(method, params);

    switch (method) {
      case 'item/commandExecution/requestApproval':
        this.respond(id, { decision: 'decline' });
        return;
      case 'item/fileChange/requestApproval':
        this.respond(id, { decision: 'decline' });
        return;
      case 'execCommandApproval':
      case 'applyPatchApproval':
        this.respond(id, { decision: 'denied' });
        return;
      case 'mcpServer/elicitation/request': {
        // codex routes MCP tool-call approvals through elicitation.
        const p = params as
          | { serverName?: string; threadId?: string; _meta?: { codex_approval_kind?: string } }
          | null;
        const isToolCall = p?._meta?.codex_approval_kind === 'mcp_tool_call';
        // Stem's own trusted, read-only recall server (search_past_chats): always
        // accept so memory lookups never get silently rejected.
        if (p?.serverName === RECALL_MCP_NAME && isToolCall) {
          this.respond(id, { action: 'accept', content: null, _meta: null });
          return;
        }
        // Stem's self-management server (stem-admin): read-only list is auto-accepted;
        // add/remove surface an in-app confirm card and wait for the user.
        if (p?.serverName === ADMIN_MCP_NAME && isToolCall) {
          this.handleAdminApproval(id, p.threadId ?? '');
          return;
        }
        // No UI to surface arbitrary external elicitation/approvals — decline.
        this.respond(id, { action: 'decline', content: null, _meta: null });
        return;
      }
      case 'item/tool/requestUserInput':
        this.respond(id, { answers: {} });
        return;
      case 'item/tool/call':
        this.respond(id, {
          success: false,
          contentItems: [{ type: 'inputText', text: 'Stem does not support this client-side tool yet.' }]
        });
        return;
      default:
        this.respondError(id, -32601, `Stem does not support app-server request "${method}".`);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const proc = this.proc;
    if (!proc) {
      return Promise.reject(new Error('codex app-server is not running.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request "${method}" timed out after ${RPC_TIMEOUT_MS}ms.`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.proc?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.proc?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    this.proc?.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
  }

  private emitEvent(method: string, params?: unknown): void {
    const event: CodexEventEnvelope = { method, params, receivedAt: new Date().toISOString() };
    this.emit('event', event);
  }

  /**
   * Gate an assistant-initiated `add`/`remove` MCP tool call behind an in-app
   * confirm card: emit the proposal to the UI and hold the elicitation open until
   * the user decides (or a timeout declines). On accept, flag a reload for turn end.
   */
  private handleAdminApproval(id: JsonRpcId, threadId: string): void {
    const buffered = this.adminToolArgsByThread.get(threadId);
    this.adminToolArgsByThread.delete(threadId);
    const tool = buffered?.tool ?? '';
    // Read-only listing needs no confirmation.
    if (tool === 'list_mcp_servers') {
      this.respond(id, { action: 'accept', content: null, _meta: null });
      return;
    }
    const proposal = this.buildAdminProposal(id, threadId, tool, buffered?.arguments);
    let settled = false;
    const finish = (accept: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.adminApprovals.delete(id);
      if (accept) this.pendingMcpReload = true;
      this.respond(id, { action: accept ? 'accept' : 'decline', content: null, _meta: null });
    };
    const timer = setTimeout(() => finish(false), 120_000);
    this.adminApprovals.set(id, finish);
    this.emitEvent('mcp/admin/approvalRequest', proposal);
  }

  private buildAdminProposal(id: JsonRpcId, threadId: string, tool: string, args: unknown): McpAdminProposal {
    const a = (args ?? {}) as Record<string, unknown>;
    if (tool === 'remove_mcp_server') {
      return { id, threadId, action: 'remove', name: typeof a.name === 'string' ? a.name : undefined };
    }
    const input: McpServerInput = {
      name: typeof a.name === 'string' ? a.name : '',
      transport: a.transport === 'http' ? 'http' : 'stdio',
      command: typeof a.command === 'string' ? a.command : undefined,
      args: Array.isArray(a.args) ? a.args.map((x) => String(x)) : undefined,
      url: typeof a.url === 'string' ? a.url : undefined,
      env:
        a.env && typeof a.env === 'object' && !Array.isArray(a.env)
          ? (a.env as Record<string, string>)
          : undefined
    };
    return { id, threadId, action: 'add', input, name: input.name };
  }

  /** Approve/decline a pending assistant-proposed MCP change (from the confirm card). */
  resolveAdminApproval(id: JsonRpcId, accept: boolean): void {
    this.adminApprovals.get(id)?.(accept);
  }

  /**
   * Hot-reload MCP servers from config.toml into the live app-server with no full
   * restart (so the chat thread is not reset). Falls back to a restart if the
   * app-server doesn't support the reload RPC.
   */
  async configMcpServerReload(): Promise<void> {
    try {
      await this.request('config/mcpServer/reload', undefined);
    } catch {
      await this.restart();
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private run(bin: string, args: string[]): Promise<{ ok: true } | { ok: false; detail: string }> {
    return new Promise((resolve) => {
      const child = execFile(bin, args, { env: this.sanitizedEnv(), timeout: 6000 }, (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, detail: (stderr || stdout || error.message).trim() });
        } else {
          resolve({ ok: true });
        }
      });
      child.on('error', (error) => resolve({ ok: false, detail: error.message }));
    });
  }

  private loginCommand(codexPath: string): string {
    return `env CODEX_HOME="${this.options.codexHome}" "${codexPath}" login`;
  }

  /** Force subscription (ChatGPT) auth: drop API-key vars, pin the isolated home. */
  private sanitizedEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    env.CODEX_HOME = this.options.codexHome;
    return env;
  }
}
