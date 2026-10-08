import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { host } from '../../server/host';
import { log } from '../../server/log';
import type { ComputerAccess, ComputerTarget, RecordedStep } from '../../shared/types';

// The Swift helper (native/mac/stem-computer) as a child process: one JSON
// line in, one out, plus the unsolicited human-input event while a run is
// watched. Packaged, the binary ships at Resources/bin/stem-computer (see
// electron-builder.yml extraResources); in development it is compiled on
// demand into the profile's state folder so a fresh checkout works without
// remembering a build step.

const CALL_TIMEOUT_MS = 30_000;

export interface HelperReply {
  ok: boolean;
  error?: string;
  screenshot?: {
    jpegBase64: string;
    width: number;
    height: number;
    scale?: number;
    zoomed?: boolean;
  };
  cursor?: { x: number; y: number };
  status?: ComputerAccess;
  /** list-windows / snapshot answer with text. */
  text?: string;
  /** The run's window after a select-window (null = whole screen); echoed on later replies. */
  target?: ComputerTarget | null;
}

export type HelperEvent =
  | { event: 'human-input'; kind: string }
  // Record mode (see native/mac/stem-computer/Record.swift and desktop/recorder/).
  | { event: 'rec-step'; step: RecordedStep }
  | { event: 'rec-seen'; seen: { t: number; app: string; window: string; url?: string; text: string; hash?: string } }
  | { event: 'rec-shot'; shot: { t: number; app: string; window: string; path: string } }
  | { event: 'rec-note'; note: string }
  | { event: 'rec-press'; x: number; y: number };

/** Where the helper binary is, building it first in development. Throws with a readable reason. */
export async function resolveHelperPath(): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('Computer control is only available on macOS.');
  const packaged = join(process.resourcesPath ?? '', 'bin', 'stem-computer');
  if (process.resourcesPath && (await exists(packaged))) return packaged;
  // Development: run the build script (the same one electron-builder's
  // beforePack runs) as a node child, keyed by a hash of the Swift sources so
  // an edit rebuilds and an unchanged tree does not. Spawned rather than
  // imported so the bundler never sees the script.
  const repo = resolve(__dirname, '..', '..');
  const script = join(repo, 'scripts', 'build-mac-helper.mjs');
  const sources = join(repo, 'native', 'mac', 'stem-computer');
  if (!(await exists(script, constants.R_OK))) {
    throw new Error(`The computer-control helper is missing (looked in ${packaged}).`);
  }
  const output = join(host().stateRoot(), 'native', `stem-computer-${await sourceHash(sources)}`);
  if (await exists(output)) return output;
  await mkdir(dirname(output), { recursive: true });
  log('computer-host', 'building the helper for development', { output });
  const { command, env } = host().nodeSpawn();
  await new Promise<void>((done, fail) => {
    const child = spawn(command, [script, '--output', output, '--host-arch'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let err = '';
    child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', fail);
    child.on('exit', (code) =>
      code === 0 ? done() : fail(new Error(`Building the helper failed (swiftc/Xcode needed): ${err.trim().slice(-400)}`))
    );
  });
  return output;
}

async function sourceHash(dir: string): Promise<string> {
  const h = createHash('sha256');
  for (const name of (await readdir(dir)).filter((f) => f.endsWith('.swift')).sort()) {
    h.update(await readFile(join(dir, name)));
  }
  return h.digest('hex').slice(0, 16);
}

async function exists(path: string, mode = constants.X_OK): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

interface Waiting {
  resolve(reply: HelperReply): void;
  timer: NodeJS.Timeout;
}

/** One running helper process. */
export class HelperProcess {
  private readonly proc: ChildProcess;
  private readonly waiting = new Map<number, Waiting>();
  private nextId = 1;
  private exited = false;
  private readonly listeners = new Set<(event: HelperEvent) => void>();

  constructor(binary: string) {
    this.proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: this.proc.stdout! });
    lines.on('line', (line) => this.onLine(line));
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      log('computer-host', 'helper stderr', {
        text: chunk.toString('utf8').trim().slice(0, 500)
      });
    });
    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      for (const [id, w] of this.waiting) {
        this.waiting.delete(id);
        clearTimeout(w.timer);
        w.resolve({
          ok: false,
          error: `The computer-control helper exited (${code ?? signal ?? 'unknown'}).`
        });
      }
    });
    this.proc.on('error', (e) => {
      log('computer-host', 'helper failed to start', { error: e.message });
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  onEvent(listener: (event: HelperEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onLine(line: string): void {
    let parsed: (HelperReply & { id?: number }) | HelperEvent;
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return;
    }
    if ('event' in parsed) {
      for (const l of this.listeners) l(parsed);
      return;
    }
    const w = typeof parsed.id === 'number' ? this.waiting.get(parsed.id) : undefined;
    if (!w) return;
    this.waiting.delete(parsed.id!);
    clearTimeout(w.timer);
    w.resolve(parsed);
  }

  call(cmd: string, fields: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<HelperReply> {
    if (this.exited)
      return Promise.resolve({
        ok: false,
        error: 'The computer-control helper is not running.'
      });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({
          ok: false,
          error: `The helper did not answer "${cmd}" within ${Math.round(timeoutMs / 1000)}s.`
        });
      }, timeoutMs);
      this.waiting.set(id, { resolve, timer });
      // The envelope goes last: `id` is how the reply finds its caller, and no
      // command field may overwrite it.
      this.proc.stdin?.write(`${JSON.stringify({ ...fields, id, cmd })}\n`, (e) => {
        if (!e) return;
        this.waiting.delete(id);
        clearTimeout(timer);
        resolve({
          ok: false,
          error: `Could not reach the helper: ${e.message}`
        });
      });
    });
  }

  kill(): void {
    if (this.exited) return;
    // `stop` lets it tear down the event tap; SIGKILL is the backstop.
    this.proc.stdin?.write('{"id":0,"cmd":"stop"}\n', () => undefined);
    const t = setTimeout(() => {
      if (!this.exited) this.proc.kill('SIGKILL');
    }, 1000);
    t.unref?.();
  }
}

/** A short-lived helper for one command (status, request-access). */
export async function oneShot(cmd: string, fields: Record<string, unknown> = {}): Promise<HelperReply> {
  const binary = await resolveHelperPath();
  const proc = new HelperProcess(binary);
  try {
    return await proc.call(cmd, fields);
  } finally {
    proc.kill();
  }
}
