import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// One `pi --mode rpc` child process and its JSONL transport.
//
// Two protocol facts from the pi docs that this class enforces:
//  - Framing is strict JSONL with LF as the ONLY delimiter. Node's `readline`
//    also splits on U+2028/U+2029, which are valid inside JSON strings, so it is
//    explicitly non-compliant — we use a StringDecoder + manual `\n` split.
//  - The wire is a `type`-discriminated command/response/event protocol, not
//    JSON-RPC. Commands carry an optional `id`; responses echo it as
//    `{type:"response", command, success, data?, error?, id?}`; events have no id.

export interface PiResponse {
  type: 'response';
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Any non-response message on stdout (agent events + extension_ui_request). */
export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

interface Pending {
  resolve: (value: PiResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 120_000;

export interface PiProcessOptions {
  piPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Extra CLI args after `--mode rpc` (e.g. provider/model/session flags). */
  args: string[];
}

/**
 * Emits:
 *  - `'event'` (PiEvent): every non-response stdout message (agent events,
 *    extension_ui_request). The consumer normalizes/handles these.
 *  - `'exit'` ({code, signal}): the child exited.
 *  - `'stderr'` (string): stderr text.
 */
export class PiProcess extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<string, Pending>();

  constructor(private readonly options: PiProcessOptions) {
    super();
  }

  get running(): boolean {
    return this.proc !== null;
  }

  start(): void {
    if (this.proc) return;
    const proc = spawn(this.options.piPath, ['--mode', 'rpc', ...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.proc = proc;

    this.attachJsonlReader(proc.stdout, (line) => this.handleLine(line));
    proc.stderr.on('data', (chunk: Buffer) => this.emit('stderr', chunk.toString('utf8')));

    proc.on('error', (error) => {
      this.rejectAll(error);
      this.emit('exit', { code: null, signal: null, error: error.message });
    });
    proc.on('exit', (code, signal) => {
      this.proc = null;
      this.rejectAll(new Error(`pi exited (code ${code ?? 'null'}, signal ${signal ?? 'null'}).`));
      this.emit('exit', { code, signal });
    });
  }

  /** Send a command and resolve with its matching response (by id). */
  request(command: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<PiResponse> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error('pi is not running.'));
    const id = `r${this.nextId++}`;
    return new Promise<PiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command "${String(command.type)}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  /** Fire-and-forget command (e.g. extension_ui_response, abort). */
  send(command: Record<string, unknown>): void {
    this.proc?.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async dispose(timeoutMs = 8000): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    await new Promise<void>((resolve) => {
      const backstop = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
      proc.once('exit', () => {
        clearTimeout(backstop);
        resolve();
      });
      proc.kill('SIGTERM');
    });
  }

  private handleLine(line: string): void {
    let msg: PiResponse | PiEvent;
    try {
      msg = JSON.parse(line) as PiResponse | PiEvent;
    } catch {
      return; // non-JSON (shouldn't happen on stdout in rpc mode)
    }
    if (msg.type === 'response') {
      const res = msg as PiResponse;
      const id = res.id;
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.resolve(res);
      }
      return;
    }
    this.emit('event', msg as PiEvent);
  }

  private rejectAll(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  // LF-only JSONL reader (pi docs: do NOT use readline). Strips an optional
  // trailing \r so CRLF input is tolerated.
  private attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    stream.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      while (true) {
        const i = buffer.indexOf('\n');
        if (i === -1) break;
        let line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.trim()) onLine(line);
      }
    });
  }
}
