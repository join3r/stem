import { readFileSync, realpathSync } from 'node:fs';
import { win32 as pathWin32, posix as pathPosix } from 'node:path';
import type { HostShell } from '../../shared/types';
import { protectedRootsPath } from '../workspace/paths';
import { hostShellFromPlatform } from './host-shell';

// Main-side twin of the bridge extension's protected-roots gate (which cannot be
// imported — it lives in the pi child's .mjs). Enforces read-only connected
// folders against run_command with the same fail-closed stance as the MCP path
// guard: we can't tell whether a command would read or write inside a protected
// root, so any reference to one blocks the command. Defense-in-depth, not a
// sandbox — the assistant can still read those folders with its read/grep tools.
//
// Path shapes are host-specific, so the scan is too: a POSIX-only pathish match
// sees nothing in `type C:\folder\secrets.txt`, which would leave the gate off
// entirely on Windows for exactly the read-only commands that reach tier 1.

/** Absolute-path-looking tokens under zsh (plain or ~-prefixed). */
const POSIX_PATHISH_RE = /(?:~|\/)[^\s'"`;|&<>]+/g;
// The same under cmd.exe: drive-absolute (`C:\…` or `C:/…`), UNC (`\\server\…`),
// or `~\…`. Deliberately no bare-`/` alternative — on Windows that is how flags
// are written (`dir /b`, `del /q`), and matching those would block commands on
// paths that were never mentioned.
const WINDOWS_PATHISH_RE = /(?:[A-Za-z]:[\\/]|\\\\|~[\\/])[^\s'"`;|&<>]*/g;
/** `%APPDATA%\…` — cmd expands these before it parses the line, so we must too. */
const WINDOWS_ENV_RE = /%([A-Za-z_][A-Za-z0-9_()]*)%/g;

interface Host {
  win: boolean;
  resolve: (p: string) => string;
  sep: string;
  homeVar: string;
}

function host(shell: HostShell): Host {
  // Git Bash still runs on NTFS with Windows cwd/roots; only the *tokens* we
  // pull out of the command line are POSIX-shaped.
  const win = shell !== 'zsh';
  const p = win ? pathWin32 : pathPosix;
  return {
    win,
    resolve: (raw) => p.resolve(raw),
    sep: p.sep,
    homeVar: win ? 'USERPROFILE' : 'HOME'
  };
}

/** `/c/Users/foo` → `C:\Users\foo`. A bare `/b` is a flag, not drive B:. */
export function msysToWindows(p: string): string | null {
  const m = /^\/([a-zA-Z])\/(.+)$/.exec(p);
  if (!m) return null;
  return `${m[1]!.toUpperCase()}:\\${m[2]!.replace(/\//g, '\\')}`;
}

function canonicalish(p: string, h: Host): string {
  const resolved = h.resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** NTFS is case-insensitive; a `c:\foo` reference must still hit a `C:\foo` root. */
function comparable(p: string, h: Host): string {
  return h.win ? p.toLowerCase() : p;
}

function isInside(path: string, root: string, h: Host): boolean {
  const a = comparable(path, h);
  const b = comparable(root, h);
  return a === b || a.startsWith(b + h.sep);
}

export interface ProtectedScanResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Read the protected roots published by main (protected-roots.json under the pi
 * home). Missing file = no read-only folders (the normal state before the first
 * publish); a present-but-corrupt file throws — the caller must fail closed.
 */
export function readProtectedRoots(
  path: string = protectedRootsPath(),
  shell: HostShell = hostShellFromPlatform()
): string[] {
  const h = host(shell);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const parsed = JSON.parse(raw) as { roots?: unknown };
  if (!Array.isArray(parsed.roots)) throw new Error('protected-roots.json has no roots array');
  return parsed.roots.filter((r): r is string => typeof r === 'string' && !!r).map((r) => canonicalish(r, h));
}

/** Every path-looking token in a command, with ~ and (on Windows) %VAR% expanded. */
function pathTokens(command: string, shell: HostShell, h: Host): string[] {
  const home = process.env[h.homeVar] ?? '';
  const text = h.win
    ? command.replace(WINDOWS_ENV_RE, (whole, name: string) => process.env[name] ?? whole)
    : command;
  const out: string[] = [];
  const push = (raw: string): void => {
    out.push(raw.startsWith('~') ? home + raw.slice(1).replace(/\//g, h.sep) : raw);
  };
  if (shell === 'zsh') {
    for (const match of text.match(POSIX_PATHISH_RE) ?? []) push(match);
    return out;
  }
  // cmd.exe: Windows shapes only. Git Bash: those plus MSYS `/c/Users/...`.
  for (const match of text.match(WINDOWS_PATHISH_RE) ?? []) push(match);
  if (shell === 'git-bash') {
    for (const match of text.match(POSIX_PATHISH_RE) ?? []) {
      if (match.startsWith('~')) {
        push(match);
        continue;
      }
      const converted = msysToWindows(match);
      if (converted) out.push(converted);
    }
  }
  return out;
}

/**
 * Fail-closed scan of a command + its resolved cwd against the read-only
 * connected-folder roots. Any hit (or unreadable gate state) blocks.
 */
export function scanProtected(
  command: string,
  cwd: string,
  rootsPath: string = protectedRootsPath(),
  shell: HostShell = hostShellFromPlatform()
): ProtectedScanResult {
  const h = host(shell);
  let roots: string[];
  try {
    roots = readProtectedRoots(rootsPath, shell);
  } catch {
    return {
      blocked: true,
      reason: 'The read-only folder list could not be read, so the command was blocked to be safe.'
    };
  }
  if (!roots.length) return { blocked: false };

  const targets = [cwd, ...pathTokens(command, shell, h)];
  for (const target of targets) {
    const canonical = canonicalish(target, h);
    const hit = roots.find((root) => isInside(canonical, root, h));
    if (hit) {
      return {
        blocked: true,
        reason:
          `The command touches "${hit}", a folder connected to Stem read-only. Commands cannot run ` +
          'against read-only folders (Stem cannot tell reads from writes). Use the built-in read/grep/find ' +
          'tools there instead, or ask the user to switch the folder to read & write in the Folders tab.'
      };
    }
  }
  return { blocked: false };
}
