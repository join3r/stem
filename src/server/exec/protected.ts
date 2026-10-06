import { readFileSync, realpathSync } from 'node:fs';
import { win32 as pathWin32, posix as pathPosix } from 'node:path';
import type { HostShell } from '../../shared/types';
import { execWorkspaceDir, protectedRootsPath, workspaceRoot } from '../workspace/paths';
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
    // Not on disk (yet, or not on this machine): canonicalize the nearest
    // existing ancestor and append the missing tail, so a symlinked parent —
    // `scratch/link -> /run/secrets` with `link/key` never stat'ed — still
    // resolves to where it points rather than to where it was written.
  }
  const P = h.win ? pathWin32 : pathPosix;
  let head = resolved;
  const tail: string[] = [];
  for (;;) {
    const parent = P.dirname(head);
    if (parent === head) return resolved;
    tail.unshift(P.basename(head));
    head = parent;
    try {
      return P.join(realpathSync(head), ...tail);
    } catch {
      // keep climbing
    }
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
  /** The root that was hit, verbatim as given — for naming the folder in a refusal. */
  root?: string;
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

/**
 * The `read` list of the same gate: every folder the built-in read tools may
 * reach beyond pi's cwd (connected folders, mirrors, the exec scratch root).
 * Missing file = nothing granted; a gate written before the list existed = the
 * same; a corrupt file throws — the caller must fail closed.
 */
export function readGrantedReadRoots(
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
  const parsed = JSON.parse(raw) as { read?: unknown };
  if (parsed.read === undefined) return [];
  if (!Array.isArray(parsed.read)) throw new Error('protected-roots.json has a malformed read list');
  return parsed.read.filter((r): r is string => typeof r === 'string' && !!r).map((r) => canonicalish(r, h));
}

/**
 * The `mirrors` list of the same gate: the protected roots that are client
 * folders' server-side mirrors. Only refines a refusal's wording, so a missing
 * list (a gate from before it existed) is simply empty.
 */
export function readMirrorRoots(
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
  const parsed = JSON.parse(raw) as { mirrors?: unknown };
  if (!Array.isArray(parsed.mirrors)) return [];
  return parsed.mirrors.filter((r): r is string => typeof r === 'string' && !!r).map((r) => canonicalish(r, h));
}

/** The refusal for a command aimed at a mirror: the generic read-only advice can never help there. */
export function mirrorCommandRefusal(root: string): string {
  return (
    `The command touches "${root}", Stem's server copy (mirror) of a folder that lives on one of the ` +
    "user's computers. Commands never run against the mirror, whatever the folder's mode. Read it with " +
    "the built-in read/grep/find tools (read returns a PDF's text). To run a command against the folder " +
    "itself, pass run_command's `device` with the folder's path on that computer — the connected-folders " +
    'list names both; that computer allows it only while the folder is writable.'
  );
}

/**
 * Where a tier-1 READ (cat/ls/grep/… auto-run without a card) may point: the
 * same folders the dedicated file tools are confined to — pi's cwd, the exec
 * scratch root and the granted read roots. A corrupt gate yields only the two
 * app-owned folders, so an unreadable grant list narrows tier 1 rather than
 * widening it (the protected-roots scan ahead of this blocks outright anyway).
 */
export function execReadRoots(
  shell: HostShell = hostShellFromPlatform(),
  gatePath: string = protectedRootsPath()
): string[] {
  const h = host(shell);
  const own = [canonicalish(workspaceRoot(), h), canonicalish(execWorkspaceDir(), h)];
  try {
    return [...own, ...readGrantedReadRoots(gatePath, shell)];
  } catch {
    // quiet: a corrupt gate narrows tier 1 to the app's own folders, and the
    // protected-roots scan ahead of this refuses outright on the same file.
    return own;
  }
}

/** Sentinel for an argument that names a path nobody here can resolve (`~other`, `%UNSET%`). */
const UNRESOLVABLE = Symbol('unresolvable');

/**
 * A command argument that names a path, as the shell will see it. Plain words
 * and flags are null; a flag carrying a path (`--file=/etc/x`, `-f/etc/x`) is
 * the path. Shell-specific like the token scan above: under cmd a leading `/`
 * is a flag, `\` is the separator and `%VAR%` expands before parsing.
 */
function argPath(token: string, shell: HostShell, h: Host): string | null | typeof UNRESOLVABLE {
  if (!token) return null;
  if (h.win && shell === 'cmd') {
    let t = token;
    if (WINDOWS_ENV_RE.test(t)) {
      WINDOWS_ENV_RE.lastIndex = 0;
      let unknown = false;
      t = t.replace(WINDOWS_ENV_RE, (whole, name: string) => {
        const v = process.env[name];
        if (v === undefined) unknown = true;
        return v ?? whole;
      });
      if (unknown) return UNRESOLVABLE;
    }
    WINDOWS_ENV_RE.lastIndex = 0;
    if (/^~[\\/]?/.test(t)) return t;
    if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(t) || t.includes('\\') || t.includes('..')) return t;
    return null;
  }
  // POSIX tokens (zsh, Git Bash). A flag's value rides after `=` or, for short
  // flags, right behind the letter — only the part that looks like a path counts.
  let t = token;
  if (t.startsWith('-')) {
    const eq = t.indexOf('=');
    if (eq >= 0) t = t.slice(eq + 1);
    else {
      const i = t.search(/[/~]/);
      if (i < 0) return null;
      t = t.slice(i);
    }
  }
  if (t.startsWith('~') || t.includes('/') || t === '..') return t;
  return null;
}

/** Expand a leading `~`; `~other` is somebody else's home — unresolvable, so outside. */
function expandHome(p: string, h: Host): string | typeof UNRESOLVABLE {
  if (!p.startsWith('~')) return p;
  const home = process.env[h.homeVar] ?? '';
  if (!home) return UNRESOLVABLE;
  if (p === '~') return home;
  if (p[1] === '/' || (h.win && p[1] === '\\')) return home + p.slice(1).replace(/\//g, h.sep);
  return UNRESOLVABLE;
}

/**
 * The first argument of a parsed command that names a path outside every root —
 * or the cwd itself when that is what lies outside. null = everything stays
 * inside. `cwd` null means the folder is unknown (a device's own scratch): then
 * only absolute paths can be checked, and a relative one that climbs (`..`) is
 * taken as outside. Relative paths otherwise resolve against the cwd through
 * symlinks, so a link planted in scratch cannot point a tier-1 read elsewhere.
 */
export function firstPathOutside(
  tokens: string[],
  cwd: string | null,
  rawRoots: string[],
  shell: HostShell
): string | null {
  const h = host(shell);
  const roots = rawRoots.map((r) => canonicalish(r, h));
  const inside = (p: string): boolean => {
    const canonical = canonicalish(p, h);
    return roots.some((root) => isInside(canonical, root, h));
  };
  if (cwd !== null && !inside(cwd)) return cwd;
  for (const token of tokens) {
    const arg = argPath(token, shell, h);
    if (arg === null) continue;
    if (arg === UNRESOLVABLE) return token;
    let p: string | typeof UNRESOLVABLE = arg;
    if (shell === 'git-bash' && !p.startsWith('~')) p = msysToWindows(p) ?? p;
    p = expandHome(p, h);
    if (p === UNRESOLVABLE) return token;
    const absolute = h.win ? pathWin32.isAbsolute(p) : pathPosix.isAbsolute(p);
    if (cwd === null) {
      if (!absolute) {
        if (p.split(/[\\/]/).includes('..')) return token;
        continue;
      }
      if (!inside(p)) return token;
      continue;
    }
    const resolved = h.win ? pathWin32.resolve(cwd, p) : pathPosix.resolve(cwd, p);
    if (!inside(resolved)) return token;
  }
  return null;
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
 * Fail-closed scan of a command (+ optionally its cwd) against an explicit set
 * of read-only roots. The roots may belong to ANOTHER machine — a client
 * folder's path on its own device — so they are resolved shape-only when they
 * do not exist on this disk, which canonicalish already does. Any hit blocks.
 */
export function scanCommandAgainstRoots(
  command: string,
  cwd: string | null,
  rawRoots: string[],
  shell: HostShell
): ProtectedScanResult {
  if (!rawRoots.length) return { blocked: false };
  const h = host(shell);
  const roots = rawRoots.map((r) => ({ raw: r, canonical: canonicalish(r, h) }));
  const targets = [...(cwd ? [cwd] : []), ...pathTokens(command, shell, h)];
  for (const target of targets) {
    const canonical = canonicalish(target, h);
    const hit = roots.find((root) => isInside(canonical, root.canonical, h));
    if (hit) {
      return {
        blocked: true,
        root: hit.raw,
        reason:
          `The command touches "${hit.raw}", a folder connected to Stem read-only. Commands cannot run ` +
          'against read-only folders (Stem cannot tell reads from writes). Use the built-in read/grep/find ' +
          'tools there instead, or ask the user to switch the folder to read & write in the Folders tab.'
      };
    }
  }
  return { blocked: false };
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
  let roots: string[];
  try {
    roots = readProtectedRoots(rootsPath, shell);
  } catch {
    // quiet: the refusal is the signal — the caller hands this reason to the assistant.
    return {
      blocked: true,
      reason: 'The read-only folder list could not be read, so the command was blocked to be safe.'
    };
  }
  const scan = scanCommandAgainstRoots(command, cwd, roots, shell);
  if (scan.blocked && scan.root) {
    let mirrors: string[] = [];
    try {
      mirrors = readMirrorRoots(rootsPath, shell);
    } catch {
      // quiet: wording only — the block itself already stands.
    }
    if (mirrors.includes(scan.root)) return { ...scan, reason: mirrorCommandRefusal(scan.root) };
  }
  return scan;
}
