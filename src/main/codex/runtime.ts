import { EventEmitter } from 'node:events';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type {
  ChatMessage,
  ChatSummary,
  CodexEventEnvelope,
  CodexItem,
  McpLoginResult,
  MessageMeta,
  ModelSummary,
  RuntimeStatus,
  StartTurnInput,
  StartTurnResult
} from '../../shared/types';
import { agentMessageText } from '../../shared/types';
import { PLAIN_MD_DIRECTIVE, STEM_ASSISTANT_INSTRUCTIONS } from '../workspace/bootstrap';
import { buildMemoryContext, captureMemoryFromUserInput } from '../workspace/memory';
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
  private activeThreadId: string | null = null;
  private startupError: string | null = null;

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
    this.activeThreadId = null;
    await this.ensureStarted();
  }

  async newConversation(): Promise<void> {
    await this.unsubscribeActiveThread();
    this.activeThreadId = null;
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
    await this.unsubscribeActiveThread(1500);
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
    const threadId = input.threadId ?? this.activeThreadId ?? (await this.startThread(input.model));
    this.activeThreadId = threadId;

    const memoryContext = await buildMemoryContext();
    // Assemble per-turn additional context: memory notes (when present) plus a
    // plain-Markdown directive when the user picked .md for this prompt.
    const additionalContext: Record<string, { value: string; kind: string }> = {};
    if (memoryContext) {
      additionalContext['stem-memory-notes'] = { value: memoryContext, kind: 'application' };
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

    return { threadId, turnId: result?.turn?.id };
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
    this.activeThreadId = threadId;
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    await this.ensureStarted();
    await this.request('thread/name/set', { threadId, name });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.ensureStarted();
    await this.request('thread/delete', { threadId });
    if (this.activeThreadId === threadId) this.activeThreadId = null;
  }

  getActiveThreadId(): string | null {
    return this.activeThreadId;
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
          if (text.trim()) messages.push({ id: `user-${item.id}`, role: 'user', content: text });
        } else if (item.type === 'agentMessage') {
          const text = agentMessageText(item);
          if (text.trim()) messages.push({ id: `assistant-${item.id}`, role: 'assistant', content: text, meta });
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

  private async unsubscribeActiveThread(timeoutMs = 5000): Promise<void> {
    const threadId = this.activeThreadId;
    if (!threadId || !this.proc || !this.initialized) return;

    const unsubscribe = this.request('thread/unsubscribe', { threadId }).catch((error) => {
      this.emitEvent('process/stderr', { text: `thread/unsubscribe failed: ${error.message}` });
    });

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
      this.activeThreadId = null;
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
      this.emitEvent(message.method, message.params);
    }
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
      case 'mcpServer/elicitation/request':
        this.respond(id, { action: 'decline', content: null, _meta: null });
        return;
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
