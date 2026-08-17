import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { HostShell } from '../../shared/types';
import { hostShellFromPlatform } from './host-shell';

// Spawns approved run_command commands. Runs in main (the privileged process).
// On macOS/Linux: the host shell (see unixShell) `-c`, with the user's
// LOGIN-shell PATH — a GUI app's environment lacks Homebrew/npm bin dirs, so
// without this `agent-browser` & co. would be "command not found" even when
// installed.
// On Windows: `cmd.exe /d /s /c` by default (no AutoRun; avoids a broken
// PowerShell profile.ps1). Opt-in Git Bash is `bash.exe --noprofile --norc -c`
// (same idea: skip .bashrc). PATH comes from the process environment, plus
// Git's usr\bin when Git Bash is the host shell.

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 300_000;
/** Per-stream capture cap; past it the child keeps running but output is dropped. */
export const OUTPUT_CAP_BYTES = 64 * 1024;

export interface ExecOutcome {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

/** How STEM invokes the host shell for run_command (exported for unit tests). */
export interface ShellInvocation {
  command: string;
  args: string[];
  /** POSIX process-group kill via negative PID; false on Windows (taskkill). */
  detached: boolean;
  /**
   * Node must not rewrite quotes. True only for cmd's `/c "..."` form;
   * Git Bash and zsh use normal argv quoting.
   */
  verbatimArguments: boolean;
}

/**
 * Unix shells STEM will run commands under, best first, and whether each one
 * understands `-l` (a login shell, which is how the PATH probe below picks up
 * Homebrew/nvm). dash — which IS `/bin/sh` on Debian — does not, and passing it
 * `-lc` fails the probe rather than the command.
 */
const UNIX_SHELLS: readonly { path: string; login: boolean }[] = [
  { path: '/bin/zsh', login: true },
  { path: '/bin/bash', login: true },
  { path: '/usr/bin/bash', login: true },
  { path: '/bin/sh', login: false }
];

let resolvedShell: (typeof UNIX_SHELLS)[number] | undefined;

/**
 * The shell run_command uses on macOS/Linux, resolved once.
 *
 * zsh stays first: it is macOS's default, and it is the shell the allowlist, the
 * command parser and the judge prompt were all written against. But it is not a
 * given — a Linux server has bash and dash and usually no zsh at all, and the
 * Docker image is `node:24-bookworm-slim`, which has neither. Hardcoding
 * `/bin/zsh` meant that on a server deployment EVERY command died with
 * `spawn /bin/zsh ENOENT`, including the ones the assistant runs to work out why
 * something else is broken. Falling back keeps `run_command` a real tool
 * wherever Stem's server happens to run.
 *
 * The last entry is `/bin/sh`, which a Unix has by definition, so the fallback
 * cannot itself run out — and if even that is missing, spawning it produces the
 * same ENOENT as before rather than a silent no-op.
 */
export function unixShell(): { path: string; login: boolean } {
  return (resolvedShell ??= UNIX_SHELLS.find((s) => existsSync(s.path)) ?? UNIX_SHELLS[UNIX_SHELLS.length - 1]);
}

/** Test seam: forget the resolved shell so a test can re-probe. */
export function resetShellCacheForTests(): void {
  resolvedShell = undefined;
}

/**
 * Build the argv used to run one user command. Pure so Mac CI can assert the
 * Windows shape without needing cmd.exe or bash.exe.
 */
export function shellInvocation(
  command: string,
  shell: HostShell = hostShellFromPlatform(),
  gitBashPath?: string | null
): ShellInvocation {
  if (shell === 'git-bash' && gitBashPath) {
    // --noprofile --norc skips .bashrc / /etc/profile (mirrors cmd /d). PATH for
    // unix tools is prepended by gitBashPathEnv, not by a login shell.
    return {
      command: gitBashPath,
      args: ['--noprofile', '--norc', '-c', command],
      detached: false,
      verbatimArguments: false
    };
  }
  if (shell === 'cmd' || shell === 'git-bash') {
    // git-bash without a path falls back to cmd — never spawn a missing bash.
    // /d = no AutoRun (registry hooks that mirror a broken profile). /s /c + a
    // quoted payload is the CreateProcess-safe form: cmd strips one outer quote
    // pair and runs the rest as-is (inner " and | stay intact for PowerShell).
    // Pair with windowsVerbatimArguments so Node does not turn " into \".
    const comspec = process.env.ComSpec || 'cmd.exe';
    return { command: comspec, args: ['/d', '/s', '/c', `"${command}"`], detached: false, verbatimArguments: true };
  }
  return { command: unixShell().path, args: ['-c', command], detached: true, verbatimArguments: false };
}

const loginPathCache = new Map<NodeJS.Platform, Promise<string>>();

/** Test seam: clear the cached PATH so unit tests can re-probe. */
export function resetLoginPathCacheForTests(): void {
  loginPathCache.clear();
}

/**
 * Resolve the PATH exec children should use once and cache it.
 * Unix: the host shell as a login shell (`-lc`) so Homebrew/npm bins are
 * visible — or a plain `-c` where the shell has no login mode (dash).
 * Windows: process Path/PATH (GUI apps already inherit the user environment;
 * there is no shell to probe). Falls back to an empty string if unset.
 *
 * Cached per platform, not globally: one cache would hand a caller passing
 * 'win32' whatever the first caller resolved, which makes the parameter a seam
 * that only works once.
 */
export function resolveLoginPath(platform: NodeJS.Platform = process.platform): Promise<string> {
  const cached = loginPathCache.get(platform);
  if (cached) return cached;
  const promise = platform === 'win32' ? Promise.resolve(windowsPath()) : probeShellLoginPath();
  loginPathCache.set(platform, promise);
  return promise;
}

function windowsPath(): string {
  return process.env.Path || process.env.PATH || '';
}

function probeShellLoginPath(): Promise<string> {
  return new Promise<string>((resolve) => {
    const fallback = (): void => resolve(process.env.PATH ?? '');
    try {
      const shell = unixShell();
      const probe = spawn(shell.path, [shell.login ? '-lc' : '-c', 'printf %s "$PATH"'], {
        stdio: ['ignore', 'pipe', 'ignore']
      });
      let out = '';
      const timer = setTimeout(() => {
        probe.kill('SIGKILL');
        fallback();
      }, 5000);
      probe.stdout.on('data', (chunk: Buffer) => {
        if (out.length < 32_768) out += chunk.toString('utf8');
      });
      probe.on('error', () => {
        clearTimeout(timer);
        fallback();
      });
      probe.on('exit', () => {
        clearTimeout(timer);
        resolve(out.trim() || (process.env.PATH ?? ''));
      });
    } catch {
      fallback();
    }
  });
}

/**
 * The environment exec children get: the user's env minus Stem/pi internals.
 * Deliberately NOT the pi runtime's sanitizedEnv — that one is pi-oriented and
 * injects PI_CODING_AGENT_DIR etc., none of which a user command should see.
 *
 * Environment names are case-insensitive on Windows but the object we build is
 * not, so the copy is made without whichever casing of PATH the host used and
 * the platform's own spelling is written back — otherwise the child inherits
 * both `Path` and `PATH` and which one wins is anyone's guess.
 */
export function execEnv(loginPath: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('STEM_') || key.startsWith('PI_') || key === 'ELECTRON_RUN_AS_NODE') continue;
    if (key.toUpperCase() === 'PATH') continue;
    env[key] = value;
  }
  env[platform === 'win32' ? 'Path' : 'PATH'] = loginPath;
  return env;
}

/** Clamp a requested timeout into [1s, MAX]; undefined → the default. */
export function clampTimeout(requested: number | undefined): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(requested)));
}

export interface RunCommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  shell?: HostShell;
  gitBashPath?: string | null;
}

/**
 * Kill a hung/aborted child and its descendants.
 * Unix: process-group SIGKILL (child was spawned detached).
 * Windows: taskkill /T tree kill, then child.kill() as fallback.
 */
function killChildTree(child: ReturnType<typeof spawn>, detached: boolean): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true
      }).unref();
    } catch {
      // fall through
    }
    try {
      child.kill();
    } catch {
      // already gone
    }
    return;
  }
  try {
    if (detached) process.kill(-pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Run one shell command to completion with output caps and a process-group /
 * process-tree kill on timeout/abort. On Unix, `detached: true` puts the child
 * in its own group so killing `-pid` also reaches grandchildren; a true daemon
 * that double-forks into its own session intentionally escapes this. On
 * Windows, taskkill /T covers the tree without relying on POSIX process groups.
 */
export function runCommand(opts: RunCommandOptions): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve, reject) => {
    const shell = shellInvocation(opts.command, opts.shell, opts.gitBashPath);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell.command, shell.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: shell.detached,
        windowsHide: true,
        // Keep the /c "..." quotes we built for cmd; Node's default Windows
        // quoting would escape inner " as \" and break PowerShell -Command "...".
        // Git Bash uses normal argv quoting (verbatimArguments is false).
        windowsVerbatimArguments: shell.verbatimArguments
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const capture = (current: Buffer, chunk: Buffer): Buffer => {
      if (current.length >= OUTPUT_CAP_BYTES) {
        truncated = true;
        return current;
      }
      const room = OUTPUT_CAP_BYTES - current.length;
      if (chunk.length > room) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, room)]);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = capture(stderr, chunk);
    });

    const killGroup = (): void => killChildTree(child, shell.detached);

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);
    const onAbort = (): void => killGroup();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const decode = (buf: Buffer, name: string): string => {
        let text = buf.toString('utf8');
        if (truncated) text += `\n…[${name} truncated at ${OUTPUT_CAP_BYTES} bytes]`;
        return text;
      };
      resolve({
        exitCode,
        signal,
        stdout: decode(stdout, 'stdout'),
        stderr: decode(stderr, 'stderr'),
        timedOut,
        truncated
      });
    };

    child.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    // Prefer 'close' (streams flushed), but a grandchild inheriting our pipes can
    // hold them open past the child's exit (a daemonizing CLI) — so also settle a
    // beat after 'exit' with whatever output has arrived by then.
    child.on('close', (code, signal) => finish(code, signal));
    child.on('exit', (code, signal) => {
      setTimeout(() => finish(code, signal), 500);
    });
  });
}
