import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  clampTimeout,
  DEFAULT_TIMEOUT_MS,
  execEnv,
  MAX_TIMEOUT_MS,
  OUTPUT_CAP_BYTES,
  resetLoginPathCacheForTests,
  resetShellCacheForTests,
  resolveLoginPath,
  runCommand,
  shellInvocation,
  unixShell
} from '../../src/server/exec/executor';

// The run_command spawn layer: real shell children with output caps, timeouts,
// and process-tree kills. Spawn tests are gated on the host shell being present
// (some POSIX shell on Unix — /bin/sh always is; cmd.exe on Windows).

const isWin = process.platform === 'win32';
const canSpawn = isWin || existsSync(unixShell().path);

describe('clampTimeout', () => {
  it('defaults, clamps, and floors', () => {
    expect(clampTimeout(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(clampTimeout(Number.NaN)).toBe(DEFAULT_TIMEOUT_MS);
    expect(clampTimeout(10)).toBe(1000);
    expect(clampTimeout(5000)).toBe(5000);
    expect(clampTimeout(10 * MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS);
  });
});

describe('unixShell', () => {
  afterEach(() => resetShellCacheForTests());

  it('picks a shell that exists, preferring zsh', () => {
    const shell = unixShell();
    expect(existsSync(shell.path)).toBe(true);
    if (existsSync('/bin/zsh')) expect(shell.path).toBe('/bin/zsh');
    // Only a shell with a login mode may be probed with -lc; dash (/bin/sh) has none.
    expect(shell.login).toBe(shell.path.endsWith('zsh') || shell.path.endsWith('bash'));
  });

  it('is resolved once and reused', () => {
    expect(unixShell()).toBe(unixShell());
  });
});

describe('shellInvocation', () => {
  it('uses the host shell with -c on Unix platforms', () => {
    // Never a hardcoded /bin/zsh: a Linux server (the Docker image included) has
    // no zsh, and every command there died with `spawn /bin/zsh ENOENT`.
    const expected = {
      command: unixShell().path,
      args: ['-c', 'echo hi'],
      detached: true,
      verbatimArguments: false
    };
    expect(shellInvocation('echo hi', 'zsh')).toEqual(expected);
  });

  it('uses cmd.exe /d /s /c on cmd (no AutoRun)', () => {
    const inv = shellInvocation('echo hi', 'cmd');
    // Quoted /c payload so cmd /s strips one outer pair; inner quotes stay intact.
    expect(inv.args).toEqual(['/d', '/s', '/c', '"echo hi"']);
    expect(inv.detached).toBe(false);
    expect(inv.verbatimArguments).toBe(true);
    // ComSpec may be set; otherwise the default is cmd.exe.
    expect(inv.command.toLowerCase()).toMatch(/cmd\.exe$/);
  });

  it('uses bash --noprofile --norc -c for Git Bash (no login profile)', () => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(shellInvocation('echo hi', 'git-bash', bash)).toEqual({
      command: bash,
      args: ['--noprofile', '--norc', '-c', 'echo hi'],
      detached: false,
      verbatimArguments: false
    });
  });

  it('falls back to cmd when Git Bash is selected without a path', () => {
    const inv = shellInvocation('echo hi', 'git-bash', null);
    expect(inv.args).toEqual(['/d', '/s', '/c', '"echo hi"']);
    expect(inv.verbatimArguments).toBe(true);
  });
});

describe('resolveLoginPath', () => {
  afterEach(() => resetLoginPathCacheForTests());

  it('caches per platform, so the parameter keeps working after the first call', async () => {
    process.env.STEM_TEST_WINPATH = 'x';
    try {
      const win = await resolveLoginPath('win32');
      expect(win).toBe(process.env.Path || process.env.PATH || '');
      // A single cache would hand this back the win32 answer.
      const posix = await resolveLoginPath('darwin');
      expect(posix).toContain('/');
    } finally {
      delete process.env.STEM_TEST_WINPATH;
    }
  });
});

describe('execEnv', () => {
  it('strips Stem/pi internals and applies the login PATH', () => {
    process.env.STEM_TEST_SECRET = 'x';
    process.env.PI_TEST_DIR = 'y';
    try {
      const env = execEnv('/opt/homebrew/bin:/usr/bin', 'darwin');
      expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
      expect(env.STEM_TEST_SECRET).toBeUndefined();
      expect(env.PI_TEST_DIR).toBeUndefined();
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      if (process.platform !== 'win32') {
        expect(env.HOME).toBe(process.env.HOME);
      }
    } finally {
      delete process.env.STEM_TEST_SECRET;
      delete process.env.PI_TEST_DIR;
    }
  });

  it('writes PATH under one casing only', () => {
    // Windows env names are case-insensitive but a plain object is not: setting
    // both Path and PATH leaves the child with two entries and no rule for which
    // of them wins.
    const win = execEnv('C:\\tools;C:\\Windows', 'win32');
    expect(win.Path).toBe('C:\\tools;C:\\Windows');
    expect(Object.keys(win).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path']);
    const posix = execEnv('/usr/bin', 'darwin');
    expect(Object.keys(posix).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['PATH']);
  });
});

describe.skipIf(!canSpawn)('runCommand', () => {
  const pathEnv = process.env.Path || process.env.PATH || '';
  const base = { cwd: tmpdir(), timeoutMs: 10_000, env: execEnv(pathEnv) };

  it('captures stdout, stderr, and the exit code', async () => {
    const command = isWin
      ? 'echo hello& echo oops 1>&2& exit /b 3'
      : 'printf hello; printf oops >&2; exit 3';
    const outcome = await runCommand({ ...base, command });
    expect(outcome.stdout.trim()).toBe('hello');
    expect(outcome.stderr).toContain('oops');
    expect(outcome.exitCode).toBe(3);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.truncated).toBe(false);
  });

  it('kills a hung command at the timeout', async () => {
    const command = isWin ? 'ping -n 30 127.0.0.1 >nul' : 'sleep 30';
    const outcome = await runCommand({ ...base, command, timeoutMs: 1000 });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).not.toBe(0);
  }, 15_000);

  it('caps runaway output with a truncation marker', async () => {
    const command = isWin
      ? // ~200KB of repeated 'x' via a short PowerShell one-liner — NoProfile so
        // a blocked profile.ps1 cannot abort the spawn used only for this test.
        'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Write-Output (\'x\' * 200000)"'
      : 'head -c 200000 /dev/zero | tr "\\0" "x"';
    const outcome = await runCommand({ ...base, command, timeoutMs: 30_000 });
    expect(outcome.truncated).toBe(true);
    expect(outcome.stdout).toContain(`truncated at ${OUTPUT_CAP_BYTES} bytes`);
    expect(outcome.stdout.length).toBeLessThan(OUTPUT_CAP_BYTES + 200);
  }, 45_000);

  it('an abort kills the process tree', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const command = isWin ? 'ping -n 30 127.0.0.1 >nul' : 'sleep 30';
    const outcome = await runCommand({ ...base, command, signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.exitCode).not.toBe(0);
  }, 15_000);
});

// Windows-only: quoted PowerShell -Command and pipes through cmd /d /s /c.
describe.skipIf(!isWin)('runCommand Windows quoting', () => {
  const pathEnv = process.env.Path || process.env.PATH || '';
  const base = { cwd: tmpdir(), timeoutMs: 15_000, env: execEnv(pathEnv) };

  it('evaluates PowerShell -Command "1+1" (not a string literal)', async () => {
    const command =
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "1+1"';
    const outcome = await runCommand({ ...base, command });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.trim()).toBe('2');
  });

  it('runs a quoted PowerShell pipeline (pipe stays inside -Command)', async () => {
    const command =
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"Write-Output 'hi' | ForEach-Object { $_ }\"";
    const outcome = await runCommand({ ...base, command });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('hi');
    // Must evaluate, not echo the script text back.
    expect(outcome.stdout).not.toContain('Write-Output');
  });

  it('still runs a native cmd pipeline', async () => {
    const outcome = await runCommand({ ...base, command: 'echo hi | findstr hi' });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('hi');
  });
});
