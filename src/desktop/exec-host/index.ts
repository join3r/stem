import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../../server/log';
import { clampTimeout, execEnv, resolveLoginPath, runCommand } from '../../server/exec/executor';
import { host } from '../../server/host';
import type { DeviceExecRequest, DeviceExecResult, ExecHostLocalState } from '../../shared/types';
import { readExecHostEnabled, writeExecHostEnabled } from './store';

// The client half of run_command's `device` target: THIS machine, running a
// command its Stem server sent over the addressed frame (shared/types.ts,
// EXEC_REQUEST_FRAME).
//
// What this file trusts and what it does not: the request arrived over this
// client's own authenticated stream, and the POLICY — allowlist, judge,
// approval card — already ran on the server. What it never delegates is the
// one decision that belongs to the person at this machine: whether it accepts
// commands at all. The switch is read fresh on every request, from a file on
// this disk that never goes on the wire (see store.ts) — a server that was
// told "yes" last week and compromised today still meets it.
//
// The executor is deliberately run_command's own (server/exec/executor.ts),
// the same reuse mcp-host/clients.ts already leans on: same shell resolution,
// same login PATH, same output caps and kill semantics, so a command behaves
// here the way it would have anywhere else.

/**
 * How long a scratch folder survives without being touched. The server's
 * sweeper keys off chat deletion too; this machine never learns of that, so
 * mtime is the whole signal — an honest limitation, not an oversight.
 */
const SCRATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type { ExecHostLocalState };

export interface ExecHostDeps {
  /** Call a server channel through the proxy (late-bound, like the MCP host's). */
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  /**
   * A command finished running here, however it ended. The mirror host listens
   * so a command that wrote into a mirrored folder is pushed up in seconds
   * rather than waiting for the watcher or the reconcile timer.
   */
  commandFinished?(request: DeviceExecRequest): void;
}

export interface ExecHost {
  /** Announce on launch (and sweep old scratch). */
  start(): Promise<void>;
  /** Re-announce — the stream reconnected, and the server may have restarted. */
  refresh(): Promise<void>;
  /** A command arrived on the event stream. Never throws; answers over RPC. */
  onRequest(request: DeviceExecRequest): void;
  localState(): Promise<ExecHostLocalState>;
  /** The switch. Persists locally, then tells the server. */
  setEnabled(enabled: boolean): Promise<ExecHostLocalState>;
}

export function createExecHost(deps: ExecHostDeps): ExecHost {
  const platform = (
    process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux'
  ) as 'darwin' | 'linux' | 'win32';

  async function announce(): Promise<void> {
    const enabled = await readExecHostEnabled();
    await deps.invoke('execHost:announce', [{ enabled, platform }]).catch((e) => {
      // An older server has no such channel; this machine simply cannot be a
      // target there, which is also what the server will say if asked.
      log('exec-host', 'could not announce', { error: e instanceof Error ? e.message : String(e) });
    });
  }

  function scratchRoot(): string {
    return join(host().stateRoot(), 'exec-scratch');
  }

  /** This chat's scratch folder here, mirroring the server's per-thread concept. */
  async function ensureScratch(threadId: string): Promise<string> {
    // Same shape rule the server's isScratchId enforces: anything that could
    // walk the filesystem falls back to a shared bucket.
    const safe = /^[A-Za-z0-9_-]{1,128}$/.test(threadId) ? threadId : 'unfiled';
    const dir = join(scratchRoot(), safe);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** TTL sweep by mtime, once per launch. Failure to sweep never blocks anything. */
  async function sweepScratch(): Promise<void> {
    try {
      const root = scratchRoot();
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(root, entry.name);
        const info = await stat(dir).catch(() => null);
        if (info && now - info.mtimeMs > SCRATCH_TTL_MS) {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    } catch {
      // A sweep that cannot run costs disk, not correctness.
    }
  }

  async function execute(request: DeviceExecRequest): Promise<DeviceExecResult> {
    // The gate, read fresh from this disk on every request. The server refuses
    // these before sending under normal operation; this is the authoritative
    // copy of the answer, held by the machine the command would run on.
    if (!(await readExecHostEnabled())) {
      return {
        ok: false,
        error:
          'This computer does not accept commands from Stem. The switch is in Settings → Chat → ' +
          'Command execution, on this computer.'
      };
    }
    let cwd: string;
    if (request.cwd) {
      const info = await stat(request.cwd).catch(() => null);
      if (!info?.isDirectory()) {
        return {
          ok: false,
          error: `The requested cwd "${request.cwd}" does not exist on this computer or is not a directory.`
        };
      }
      cwd = request.cwd;
    } else {
      cwd = await ensureScratch(request.threadId);
    }
    const timeoutMs = clampTimeout(request.timeoutMs);
    const loginPath = await resolveLoginPath();
    const outcome = await runCommand({
      command: request.command,
      cwd,
      timeoutMs,
      env: execEnv(loginPath)
    });
    // The same result block the local executor produces, built HERE, so the
    // model reads one format wherever a command ran.
    const parts = [
      outcome.timedOut
        ? `Timed out after ${timeoutMs} ms (process group killed).`
        : `Exit code: ${outcome.exitCode ?? `signal ${outcome.signal ?? 'unknown'}`}`,
      `stdout:\n${outcome.stdout.trim() || '(no output)'}`,
      `stderr:\n${outcome.stderr.trim() || '(no output)'}`
    ];
    return { ok: true, text: parts.join('\n\n') };
  }

  return {
    async start() {
      await announce();
      void sweepScratch();
    },

    refresh: () => announce(),

    onRequest(request) {
      void (async () => {
        let result: DeviceExecResult;
        try {
          result = await execute(request);
        } catch (e) {
          result = {
            ok: false,
            error: `The command could not be started: ${e instanceof Error ? e.message : String(e)}`
          };
        }
        // The answer goes back as an ordinary RPC whenever it is ready — the
        // server holds the correlation id and its own timeout.
        await deps.invoke('execHost:result', [request.requestId, result]).catch((e) => {
          log('exec-host', 'could not deliver a command result', {
            error: e instanceof Error ? e.message : String(e)
          });
        });
        deps.commandFinished?.(request);
      })();
    },

    localState: async () => ({ enabled: await readExecHostEnabled() }),

    async setEnabled(enabled) {
      await writeExecHostEnabled(enabled);
      await announce();
      return { enabled };
    }
  };
}
