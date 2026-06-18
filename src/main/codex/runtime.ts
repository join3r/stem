import { EventEmitter } from 'node:events';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  CodexEventEnvelope,
  McpLoginResult,
  RuntimeStatus,
  StartTurnInput,
  StartTurnResult
} from '../../shared/types';
import { findCodexPath } from './locate';

const RPC_TIMEOUT_MS = 60_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RuntimeOptions {
  codexHome: string;
  workspaceRoot: string;
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
   * effect in place (no app quit). Waits for the old process to fully exit
   * before respawning so the old exit handler can't null out the new process.
   */
  async restart(): Promise<void> {
    const old = this.proc;
    if (old) {
      await new Promise<void>((resolve) => {
        old.once('exit', () => resolve());
        this.dispose();
      });
    }
    this.activeThreadId = null;
    await this.ensureStarted();
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    await this.ensureStarted();
    const threadId = input.threadId ?? this.activeThreadId ?? (await this.startThread(input.model));
    this.activeThreadId = threadId;

    const result = (await this.request('turn/start', {
      threadId,
      cwd: this.options.workspaceRoot,
      input: [{ type: 'text', text: input.input }]
    })) as { turn?: { id?: string } };

    return { threadId, turnId: result?.turn?.id };
  }

  async interruptTurn(turnId: string): Promise<void> {
    if (!this.proc) return;
    await this.request('turn/interrupt', { turnId });
  }

  /** Kill the child process. Called on app quit so we never orphan it. */
  dispose(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.initialized = false;
  }

  // ---- internals ----

  private async startThread(model?: string): Promise<string> {
    const result = (await this.request('thread/start', {
      model,
      cwd: this.options.workspaceRoot
    })) as { thread?: { id?: string } };
    const threadId = result?.thread?.id;
    if (!threadId) {
      throw new Error('Codex did not return a thread id.');
    }
    return threadId;
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
