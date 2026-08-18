import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { degrade } from '../degrade';

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

/** How much stderr to keep for the exit message (see stderrTail). */
const STDERR_TAIL_CHARS = 4_000;
/** How much of that tail is quoted back in the exit error itself. */
const STDERR_QUOTE_CHARS = 300;

/**
 * The reason a startup failure gives, distilled from the child's stderr: pi
 * prints its fatal ones there ("Unknown provider …", "Model … not found") and
 * then exits 1, so an exit message without them carries no cause at all. Colour
 * codes are stripped (pi paints fatals with chalk) and only the last couple of
 * non-empty lines are kept — the tail is where the fatal is.
 */
export function stderrReason(tail: string): string | null {
  const lines = tail
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const reason = lines.slice(-2).join(' ');
  return reason.length > STDERR_QUOTE_CHARS ? `${reason.slice(-STDERR_QUOTE_CHARS)}…` : reason;
}

export interface PiProcessOptions {
  /** argv[0]: a pi binary, or Electron's execPath when running the bundled cli.js. */
  command: string;
  /** Args before `--mode rpc` (bundled pi: the cli.js path). */
  prefixArgs?: string[];
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
  /** Rolling tail of the child's stderr — the only place a fatal explains itself. */
  private stderrTail = '';

  constructor(private readonly options: PiProcessOptions) {
    super();
  }

  get running(): boolean {
    return this.proc !== null;
  }

  /** The child's last stderr, for callers that report a failed startup. */
  get stderr(): string {
    return this.stderrTail;
  }

  start(): void {
    if (this.proc) return;
    const proc = spawn(
      this.options.command,
      [...(this.options.prefixArgs ?? []), '--mode', 'rpc', ...this.options.args],
      {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // GUI Electron on Windows otherwise flashes a console for each throwaway
        // complete()/judge child (runCommand already sets this).
        windowsHide: true
      }
    );
    this.proc = proc;

    this.attachJsonlReader(proc.stdout, (line) => this.handleLine(line));
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
      this.emit('stderr', text);
    });

    proc.on('error', (error) => {
      this.rejectAll(error);
      this.emit('exit', { code: null, signal: null, error: error.message });
    });
    proc.on('exit', (code, signal) => {
      this.proc = null;
      // Quote the child's own last words: an exit code alone ("code 1") is what a
      // fatal config error looks like from here, and it names nothing.
      const reason = stderrReason(this.stderrTail);
      this.rejectAll(
        new Error(`pi exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})${reason ? `: ${reason}` : '.'}`)
      );
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
    } catch (error) {
      // Nothing but framed JSONL belongs on stdout in rpc mode, so a line that
      // does not parse is a message lost: a response leaves its caller waiting
      // out the full two-minute timeout, and an event takes a piece of the turn —
      // assistant text, a tool call — off the screen with the turn still looking
      // healthy.
      degrade('pi.rpc', 'dropped an unparseable line from pi', error);
      return;
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
