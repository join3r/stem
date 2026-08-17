import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { win32 as pathWin32 } from 'node:path';
import type { ExecSettings, HostShell } from '../../shared/types';

// Git Bash detection and PATH helpers. Filesystem-first: never spawn PowerShell.
// where.exe / reg.exe are optional last resorts and fail closed if AppLocker
// blocks them. Existence of the file is enough to pre-fill Settings; we do not
// run `bash --version` here (that spawn can fail under WDAC even when the file
// is present).
//
// GIT FOR WINDOWS ONLY, and the layout is the test — not the filename. A machine
// with WSL enabled has C:\Windows\System32\bash.exe, which is the Linux VM
// launcher: commands there run against /mnt/c paths that our protected-roots
// translation (msysToWindows, `/c/…` → `C:\…`) does not recognise, so the
// read-only folder guard would silently stop matching. MSYS2 and Cygwin are out
// for the same reason — gitBashPathEnv's usr\bin / mingw64\bin prepend and that
// same path translation are Git's layout, not theirs.

const BASH_EXE = 'bash.exe';
const LOOKUP_TIMEOUT_MS = 2000;

export interface DetectGitBashDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
}

/**
 * The Git install a candidate belongs to: `…\Git\bin\bash.exe` → `…\Git`, the
 * root gitBashPathEnv derives PATH from. Null when the shape is not Git's — the
 * parent directory must be `bin`, which already excludes System32 and Git's own
 * `usr\bin\bash.exe` (whose root would be one level off).
 */
function gitRootFor(bashPath: string): string | null {
  const binDir = pathWin32.dirname(bashPath);
  if (pathWin32.basename(binDir).toLowerCase() !== 'bin') return null;
  const root = pathWin32.dirname(binDir);
  return root && root !== binDir ? root : null;
}

/** `git.exe` / `libexec\git-core` beside the shell — the proof it is Git's bash. */
function hasGitBeside(root: string, exists: (p: string) => boolean): boolean {
  return exists(pathWin32.join(root, 'cmd', 'git.exe')) || exists(pathWin32.join(root, 'libexec', 'git-core'));
}

/** True when `path` is a Git for Windows bash.exe that is on disk. */
export function isUsableGitBashPath(
  path: string | null | undefined,
  exists: (p: string) => boolean = existsSync
): boolean {
  if (!path || typeof path !== 'string') return false;
  const trimmed = path.trim();
  if (!trimmed.toLowerCase().endsWith(BASH_EXE)) return false;
  const root = gitRootFor(trimmed);
  if (!root) return false;
  try {
    return exists(trimmed) && hasGitBeside(root, exists);
  } catch {
    return false;
  }
}

/**
 * Usual Git for Windows install locations. Built with win32 joins so Mac CI can
 * assert the same strings Windows would see.
 */
export function wellKnownGitBashCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA || pathWin32.join(homedir(), 'AppData', 'Local');
  const home = env.USERPROFILE || homedir();
  return [
    pathWin32.join(pf, 'Git', 'bin', BASH_EXE),
    pathWin32.join(pf86, 'Git', 'bin', BASH_EXE),
    pathWin32.join(local, 'Programs', 'Git', 'bin', BASH_EXE),
    pathWin32.join(home, 'scoop', 'apps', 'git', 'current', 'bin', BASH_EXE)
  ];
}

/** `Git\\cmd\\git.exe` → `Git\\bin\\bash.exe` (the default Git for Windows layout). */
export function bashBesideGit(gitExe: string, exists: (p: string) => boolean = existsSync): string | null {
  const cmdDir = pathWin32.dirname(gitExe);
  const gitRoot = pathWin32.dirname(cmdDir);
  const bash = pathWin32.join(gitRoot, 'bin', BASH_EXE);
  return isUsableGitBashPath(bash, exists) ? bash : null;
}

function bashFromPathEnv(pathEnv: string, exists: (p: string) => boolean): string | null {
  for (const dir of pathEnv.split(';')) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const bash = pathWin32.join(trimmed, BASH_EXE);
    if (isUsableGitBashPath(bash, exists)) return bash;
    const git = pathWin32.join(trimmed, 'git.exe');
    if (exists(git)) {
      const beside = bashBesideGit(git, exists);
      if (beside) return beside;
    }
  }
  return null;
}

/**
 * Detect Git Bash without spawning anything: well-known paths, then PATH.
 * Safe on administered machines where PowerShell (and even where.exe) is blocked.
 */
export function detectGitBashFromDisk(deps: DetectGitBashDeps = {}): string | null {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  for (const candidate of wellKnownGitBashCandidates(env)) {
    if (isUsableGitBashPath(candidate, exists)) return candidate;
  }
  return bashFromPathEnv(env.Path || env.PATH || '', exists);
}

function execFileQuiet(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { windowsHide: true, timeout: LOOKUP_TIMEOUT_MS }, (error, stdout) => {
        if (error) resolve(null);
        else resolve(typeof stdout === 'string' ? stdout : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function firstWhereLine(stdout: string): string | null {
  const first = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return first ?? null;
}

async function bashFromWhere(exists: (p: string) => boolean): Promise<string | null> {
  const gitOut = await execFileQuiet('where.exe', ['git']);
  if (gitOut) {
    const git = firstWhereLine(gitOut);
    if (git) {
      const beside = bashBesideGit(git, exists);
      if (beside) return beside;
    }
  }
  const bashOut = await execFileQuiet('where.exe', ['bash']);
  if (bashOut) {
    const bash = firstWhereLine(bashOut);
    if (bash && isUsableGitBashPath(bash, exists)) return bash;
  }
  return null;
}

/** `reg query` output: `InstallPath    REG_SZ    C:\Program Files\Git` */
function installPathFromReg(stdout: string): string | null {
  const match = stdout.match(/InstallPath\s+REG_\w+\s+(.+)/i);
  const value = match?.[1]?.trim();
  return value || null;
}

async function bashFromRegistry(exists: (p: string) => boolean): Promise<string | null> {
  const keys = [
    'HKLM\\SOFTWARE\\GitForWindows',
    'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows',
    'HKCU\\SOFTWARE\\GitForWindows'
  ];
  for (const key of keys) {
    const out = await execFileQuiet('reg.exe', ['query', key, '/v', 'InstallPath']);
    if (!out) continue;
    const install = installPathFromReg(out);
    if (!install) continue;
    const bash = pathWin32.join(install, 'bin', BASH_EXE);
    if (isUsableGitBashPath(bash, exists)) return bash;
  }
  return null;
}

/**
 * Full detection: disk, then PATH, then optional where.exe / reg.exe.
 * where/reg never run on non-Windows, and a blocked binary is treated as
 * "keep looking", never as "Git Bash is absent".
 */
export async function detectGitBash(deps: DetectGitBashDeps = {}): Promise<string | null> {
  const fromDisk = detectGitBashFromDisk(deps);
  if (fromDisk) return fromDisk;
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return null;
  const exists = deps.exists ?? existsSync;
  try {
    const fromWhere = await bashFromWhere(exists);
    if (fromWhere) return fromWhere;
  } catch {
    // AppLocker / missing where.exe — keep going.
  }
  try {
    return await bashFromRegistry(exists);
  } catch {
    return null;
  }
}

/**
 * Prepend Git's unix-tool dirs so `ls`/`cat`/`grep` work without a login shell
 * (`--noprofile --norc` skips /etc/profile, which is what would otherwise set PATH).
 */
export function gitBashPathEnv(bashPath: string, windowsPath: string): string {
  const gitRoot = pathWin32.dirname(pathWin32.dirname(bashPath));
  const extras = [
    pathWin32.join(gitRoot, 'usr', 'bin'),
    pathWin32.join(gitRoot, 'bin'),
    pathWin32.join(gitRoot, 'cmd'),
    pathWin32.join(gitRoot, 'mingw64', 'bin'),
    pathWin32.join(gitRoot, 'mingw32', 'bin')
  ];
  return [...extras, windowsPath].join(';');
}

/**
 * bash.exe Stem will spawn: the saved path if it is still on disk, else a
 * well-known Git for Windows install. Null means fall back to cmd.exe.
 */
export function resolveGitBashExecutable(
  settings: Pick<ExecSettings, 'gitBashPath'>,
  exists: (p: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (isUsableGitBashPath(settings.gitBashPath, exists)) return settings.gitBashPath!.trim();
  return detectGitBashFromDisk({ exists, env });
}

/** The shell run_command will spawn, and the bash.exe that answer was based on. */
export interface HostShellTarget {
  shell: HostShell;
  /** The executable for 'git-bash'; null for every other shell. */
  gitBashPath: string | null;
}

/**
 * The shell run_command will actually spawn, together with the executable the
 * decision rests on. Git Bash when the user wants it (the Windows default) AND
 * bash.exe is on disk — saved path or auto-detected. Otherwise cmd.exe.
 *
 * Resolve this ONCE per request and pass the whole thing around: this touches the
 * filesystem, so asking twice can give two answers, and the parser and the spawn
 * disagreeing about the shell is a safety bug (see shared/types.ts, HostShell).
 */
export function resolveHostShellTarget(
  settings: Pick<ExecSettings, 'windowsShell' | 'gitBashPath'>,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync
): HostShellTarget {
  if (platform !== 'win32') return { shell: 'zsh', gitBashPath: null };
  const bash = settings.windowsShell === 'git-bash' ? resolveGitBashExecutable(settings, exists) : null;
  return bash ? { shell: 'git-bash', gitBashPath: bash } : { shell: 'cmd', gitBashPath: null };
}

/** Just the shell, for callers with nothing to spawn (the per-turn agent hint). */
export function resolveHostShell(
  settings: Pick<ExecSettings, 'windowsShell' | 'gitBashPath'>,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync
): HostShell {
  return resolveHostShellTarget(settings, platform, exists).shell;
}
