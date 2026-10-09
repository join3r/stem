import type { ExecSettings, HostShell } from '../../shared/types';
import { compileCommandRegex, MAX_REGEX_SEGMENT_LENGTH } from '../../shared/exec-rules';
import { unixShell } from './executor';
import { hostShellFromPlatform, isCmdShell } from './host-shell';
import { firstPathOutside } from './protected';

export { hostShellFromPlatform };

/** Local HostShell, or a device's Node platform (win32 → cmd, anything else → POSIX). */
type ShellArg = HostShell | NodeJS.Platform;

function toHostShell(shell: ShellArg = hostShellFromPlatform()): HostShell {
  if (shell === 'cmd' || shell === 'git-bash' || shell === 'zsh') return shell;
  return hostShellFromPlatform(shell);
}

// The run_command auto-approve policy, kept pure so it is unit-testable:
//
//   tier 1  static safe allowlist + the user's learned prefixes → run immediately
//   tier 2  everything else → a one-word LLM judge classification
//   tier 3  judge said unsafe/unsure (or failed) → manual approval card
//
// Chains (`&&`, `||`, `|`, `;`, newline) are split into segments that are each
// matched on their own — the whole command auto-runs only when EVERY segment
// clears an allowlist (a compound like `git status && rm -rf /` must never
// auto-run on the strength of its head). Any other shell metacharacter outside
// quotes (redirects, substitution, background `&`, escapes) disqualifies tier 1
// entirely, and a command word containing a path separator never matches (an
// allowlisted `git` must not admit `./git`).
//
// The parse is SHELL-SPECIFIC because cmd.exe and POSIX shells disagree about
// quoting, and a parser that models the wrong one hands out tier 1 for commands
// the shell will happily split. See WINDOWS_HARD_META below. Git Bash is POSIX.

/** Read-only probes that mean the same thing on both host shells. */
// agent-browser is deliberately NOT here as a bare prefix (SEC-003): the CLI is
// mostly state-changing (click, fill, upload, eval, cookie mutation, auth and
// plugin management), so only the reviewed read-only actions below are tier 1
// — and even those fall to the judge when a privileged flag rides along (see
// AGENT_BROWSER_SAFE_FLAGS). Unknown/future subcommands fail closed to the judge.
const SHARED_ALLOWLIST = [
  'rg',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'agent-browser snapshot',
  'agent-browser get',
  'agent-browser is',
  'agent-browser skills'
];

/**
 * Flags a tier-1 `agent-browser` read may carry. Everything else — notably
 * --profile / --state / --auto-connect (attach to real login state),
 * --executable-path (run an arbitrary binary), --extension / --init-script /
 * --args / --enable (inject code), --allow-file-access, --proxy, --headers —
 * is privileged even next to a read-only action, so the segment is judged.
 * Fail closed: an unrecognized flag never auto-runs.
 */
const AGENT_BROWSER_SAFE_FLAGS = new Set([
  '-i',
  '--interactive',
  '-c',
  '--compact',
  '-d',
  '--depth',
  '-s',
  '--selector',
  '--session',
  '--json',
  '--full'
]);

/** True when an allowlisted agent-browser segment carries no privileged flag. */
function agentBrowserFlagsSafe(tokens: string[]): boolean {
  return tokens.every((t) => !t.startsWith('-') || AGENT_BROWSER_SAFE_FLAGS.has(t));
}

/**
 * POSIX (zsh) read-only probes. `find` is deliberately NOT here (H-01): its
 * -exec/-ok/-delete family turns a listing into arbitrary execution, and the
 * assistant has a dedicated find tool — so it is judged like any other command,
 * and screened by PRIVILEGED_FLAGS even when a user learns it.
 */
const POSIX_ALLOWLIST = ['ls', 'cat', 'pwd', 'head', 'tail', 'wc', 'grep', 'which', 'file', 'stat', 'date'];

/**
 * Flags that turn a read-only probe into execution or a write, whoever
 * allowlisted the command word: `find . -exec sh -c id ';'` is a shell, not a
 * listing, and `rg --pre` runs a program per file. Checked on every segment, so
 * a learned `find` does not reopen the hole. Long flags match exactly or with
 * `=value`; a short flag also matches with its value attached (`-snow`).
 */
const PRIVILEGED_FLAGS: Record<string, string[]> = {
  find: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'],
  rg: ['--pre', '--pre-glob'],
  date: ['-s', '--set'],
  git: ['--output']
};

function guardedCommandName(word: string, shell: HostShell): string {
  const name = word.split(isCmdShell(shell) ? /[\\/]/ : '/').pop() ?? word;
  return shell === 'zsh' ? name : name.toLowerCase().replace(/\.(?:com|exe|cmd|bat)$/i, '');
}

function carriesPrivilegedFlag(tokens: string[], commandName: string): boolean {
  const flags = PRIVILEGED_FLAGS[commandName];
  if (!flags) return false;
  return tokens.some((t) =>
    flags.some((f) => t === f || t.startsWith(`${f}=`) || (f.length === 2 && t.startsWith(f)))
  );
}

/**
 * Probes whose only justification for tier 1 is "it just reads": they auto-run
 * only while every path they name stays inside the folders the dedicated file
 * tools may read (H-01). `cat /run/secrets/x` or `ls ~/.ssh` is the same
 * disclosure whichever tool makes it, and the tool text asking the model to
 * prefer the file tools is advice, not enforcement.
 */
const PATH_READERS = new Set(['cat', 'ls', 'head', 'tail', 'wc', 'grep', 'rg', 'file', 'stat', 'find', 'type', 'dir']);

/**
 * cmd.exe equivalents. Deliberately NOT merged into one cross-platform set: the
 * POSIX names do not exist under cmd (they would auto-run straight into "not
 * recognized"), and `dir`/`type`/`echo` must not widen the zsh tier-1 surface
 * for a platform that never sees them.
 */
const WINDOWS_ALLOWLIST = ['dir', 'type', 'where', 'echo', 'cd'];

function staticAllowlist(shell: HostShell): Set<string> {
  // Git Bash is a POSIX shell: ls/cat/grep exist. cmd.exe is the only one that
  // gets dir/type — those names must not widen zsh or Git Bash tier 1.
  return new Set([...SHARED_ALLOWLIST, ...(isCmdShell(shell) ? WINDOWS_ALLOWLIST : POSIX_ALLOWLIST)]);
}

/** One chained command within a compound (or the whole thing when not chained). */
export interface ParsedSegment {
  /** Raw source for this segment, excluding its chain separator and outer whitespace. */
  raw: string;
  /** Command word + subcommand when one is present (e.g. `git status`). */
  prefix: string;
  /** The candidate prefixes to match against an allowlist, shortest first. */
  candidates: string[];
  /** Every token of the segment, for per-command flag screening. */
  tokens: string[];
}

export interface ParsedCommand {
  /** One entry per chained command; empty for a blank command. */
  segments: ParsedSegment[];
  /** A non-chaining shell metacharacter appeared outside single quotes → never tier 1. */
  hasShellMeta: boolean;
}

// Metacharacters that give a command shell semantics beyond "commands chained
// with plain arguments". Chain separators (&&, ||, |, ;, newline) are handled
// by the segment split instead. Backslash-escapes are treated as meta too —
// rare, and conservative is cheap.
const POSIX_HARD_META = new Set(['>', '<', '`', '$', '(', ')', '{', '}', '\\', '\r']);
// Inside double quotes only expansion characters stay live — `&`, `|`, `(` etc.
// are literal there, and flagging them threw every double-quoted URL/CSS selector
// (agent-browser's bread and butter) out of tier 1 and onto the judge.
const POSIX_DQUOTE_META = new Set(['$', '`', '\\']);

// cmd.exe is not zsh, and the differences are exactly the ones that decide
// whether a command can smuggle a second command past tier 1:
//   '   NOT a quote character. `cat 'a & whoami & rem '` reads as protected to a
//       POSIX parser, but cmd sees the bare `&` and runs whoami. Hard meta, and
//       single-quote *regions* are not honoured at all (see parseCommand).
//   %   %VAR% expands before the line is parsed, so a variable holding `& …`
//       injects a command. Hard meta.
//   ^   cmd's escape character — `^&` hides a separator from a naive scan.
//   \   NOT special: it is the path separator. Treating it as meta would push
//       every `type C:\…` onto the judge and make the Windows allowlist useless.
//   $ ` are ordinary characters under cmd; ( ) { } still group/parse, so they stay.
const WINDOWS_HARD_META = new Set(['>', '<', '(', ')', '{', '}', "'", '%', '^', '\r']);
// Double quotes in cmd suppress separators but NOT %VAR% expansion.
const WINDOWS_DQUOTE_META = new Set(['%']);

// A learnable subcommand must be the token immediately after the command word
// and look like a bare word. A URL, path, format string, or flag value
// (`--session yt-npc6`, `https://…`, `title=%(title)s`) must never end up in a
// learned prefix — those are one-shot values that will not match again.
const BARE_WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

function makeSegment(tokens: string[], raw: string): ParsedSegment {
  const word = tokens[0] ?? '';
  const sub = tokens[1] && BARE_WORD.test(tokens[1]) ? tokens[1] : undefined;
  // Candidates are matched by exact string only, so `/usr/local/bin/foo` or `./git`
  // can be user-allowlisted verbatim but can never match an allowlisted bare `git`.
  const candidates = word ? (sub ? [word, `${word} ${sub}`] : [word]) : [];
  return { raw, prefix: candidates[candidates.length - 1] ?? '', candidates, tokens };
}

/**
 * Quote-aware parse of a shell command string into allowlist-matchable segments.
 * Not a full shell parser — anything with shell semantics beyond "commands
 * chained with plain arguments" comes back `hasShellMeta` and is left to the judge.
 *
 * `shell` selects which quoting rules to model; it must match the shell
 * `shellInvocation()` will actually spawn, or tier 1 is decided against a
 * grammar the host does not use.
 */
export function parseCommand(command: string, shell: HostShell = hostShellFromPlatform()): ParsedCommand {
  const cmd = isCmdShell(shell);
  const hardMeta = cmd ? WINDOWS_HARD_META : POSIX_HARD_META;
  const dquoteMeta = cmd ? WINDOWS_DQUOTE_META : POSIX_DQUOTE_META;
  const segments: ParsedSegment[] = [];
  let tokens: string[] = [];
  let current = '';
  let inToken = false;
  let hasShellMeta = false;
  let quote: "'" | '"' | null = null;
  let segmentStart = 0;

  const endToken = (): void => {
    if (inToken) {
      tokens.push(current);
      current = '';
      inToken = false;
    }
  };
  const endSegment = (end: number, nextStart: number): void => {
    endToken();
    if (tokens.length) segments.push(makeSegment(tokens, command.slice(segmentStart, end).trim()));
    tokens = [];
    segmentStart = nextStart;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      inToken = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else {
        if (dquoteMeta.has(ch)) hasShellMeta = true;
        current += ch;
      }
      inToken = true;
      continue;
    }
    // Under cmd.exe `'` opens nothing — it falls through to the hard-meta check
    // below, so a single-quoted region can never hide a separator. Git Bash and
    // zsh honour single quotes.
    if (ch === '"' || (ch === "'" && !cmd)) {
      quote = ch as "'" | '"';
      inToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endToken();
      continue;
    }
    if (ch === ';' || ch === '\n') {
      endSegment(i, i + 1);
      continue;
    }
    if (ch === '&') {
      if (command[i + 1] === '&') {
        const separatorStart = i;
        i += 1;
        endSegment(separatorStart, i + 1);
      } else hasShellMeta = true; // lone `&` backgrounds the command — not a chain
      continue;
    }
    if (ch === '|') {
      const separatorStart = i;
      if (command[i + 1] === '|') i += 1;
      endSegment(separatorStart, i + 1); // both `|` and `||` join two plain commands
      continue;
    }
    if (hardMeta.has(ch)) hasShellMeta = true;
    current += ch;
    inToken = true;
  }
  if (quote) hasShellMeta = true; // unterminated quote — not a plain command
  endSegment(command.length, command.length);

  return { segments, hasShellMeta };
}

export interface Classification {
  /** 'run' = tier 1 (auto-run now); 'judge' = needs the LLM judge (tier 2). */
  tier: 'run' | 'judge';
  /**
   * What "Always allow" should persist: the learnable prefix of every segment not
   * already covered by an allowlist. Empty when the command has shell semantics
   * tier 1 can never match — learning a prefix there would change nothing, so the
   * approval card should not offer it.
   */
  prefixes: string[];
  hasShellMeta: boolean;
  /**
   * Set when an otherwise tier-1 read was judged for naming a path (or cwd)
   * outside the readable roots — the argument that did it, for the card.
   */
  outside?: string;
}

/**
 * Where a tier-1 read may point. `cwd` null = unknown folder (a device's own
 * scratch): absolute paths are still checked against `roots`, relative ones
 * pass unless they climb. The default — no roots, no cwd — is the zero-trust
 * posture: any absolute, `~` or climbing path sends the read to the judge.
 */
export interface ReadConfinement {
  cwd: string | null;
  roots: string[];
}

/**
 * Decide whether a command may auto-run (tier 1) or must be judged.
 *
 * `includeBuiltins: false` is the remote-target posture: a command aimed at a
 * paired computer starts from zero trust, so its tier 1 is exactly that
 * device's learned prefixes—no local regex rules or static list entries.
 */
export function classify(
  command: string,
  settings: Pick<ExecSettings, 'allowlist'> & Partial<Pick<ExecSettings, 'allowRegex'>>,
  shell: ShellArg = hostShellFromPlatform(),
  opts: { includeBuiltins?: boolean; confine?: ReadConfinement } = {}
): Classification {
  const host = toHostShell(shell);
  const parsed = parseCommand(command, host);
  if (parsed.hasShellMeta || !parsed.segments.length) {
    return { tier: 'judge', prefixes: [], hasShellMeta: parsed.hasShellMeta };
  }
  const user = new Set(settings.allowlist);
  const regexRules = opts.includeBuiltins === false
    ? []
    : (settings.allowRegex ?? []).map(compileCommandRegex).filter((rule): rule is RegExp => rule !== null);
  // includeBuiltins: false is the remote-target posture — that machine's tier 1
  // is only its learned allowlist, never ls/dir/git status from this host.
  const allowed = opts.includeBuiltins === false ? new Set<string>() : staticAllowlist(host);
  const uncovered = parsed.segments.filter((seg) => {
    const commandName = guardedCommandName(seg.tokens[0] ?? '', host);
    return (
      (!seg.candidates.some((c) => allowed.has(c) || user.has(c)) &&
        !(seg.raw.length <= MAX_REGEX_SEGMENT_LENGTH && regexRules.some((rule) => rule.test(seg.raw)))) ||
      // Even an allowlisted (or user-learned) agent-browser action falls to the
      // judge when a privileged flag rides along — --executable-path next to
      // `get text` is arbitrary code, not a read (SEC-003).
      (commandName === 'agent-browser' && !agentBrowserFlagsSafe(seg.tokens)) ||
      // Likewise a read-only probe carrying its execution flag (H-01).
      carriesPrivilegedFlag(seg.tokens, commandName)
    );
  });
  const prefixes = [...new Set(uncovered.map((seg) => seg.prefix).filter(Boolean))];
  if (uncovered.length) return { tier: 'judge', prefixes, hasShellMeta: false };
  // Every segment is allowlisted. A reader still only auto-runs inside the
  // readable roots; outside them it is judged, and no prefix is offered —
  // learning `cat` would not change the answer.
  const confine = opts.confine ?? { cwd: null, roots: [] };
  for (const seg of parsed.segments) {
    const commandName = guardedCommandName(seg.tokens[0] ?? '', host);
    if (!PATH_READERS.has(commandName)) continue;
    const outside = firstPathOutside(seg.tokens.slice(1), confine.cwd, confine.roots, host);
    if (outside !== null) return { tier: 'judge', prefixes: [], hasShellMeta: false, outside };
  }
  return { tier: 'run', prefixes, hasShellMeta: false };
}

/**
 * How to describe the host shell to the judge — one shell, the one that will run.
 *
 * "The machine Stem runs on" rather than "the user's machine": with the server
 * on a VPS those are different computers, and the judge is being asked about the
 * first one.
 */
export function hostShellLabel(shell: ShellArg = hostShellFromPlatform()): string {
  const host = toHostShell(shell);
  if (host === 'cmd') return 'a Windows machine, under cmd.exe';
  if (host === 'git-bash') return 'a Windows machine, under Git Bash';
  const name = unixShell().path.split('/').pop() || 'sh';
  return `the machine Stem runs on, under ${name}`;
}

/**
 * The same sentence for a command aimed at a paired computer. The shell is named
 * from the target's platform rather than probed — the server cannot look at that
 * machine's /bin — and macOS's default has been zsh since Catalina, which is
 * also the shell the client's executor prefers.
 */
export function deviceShellLabel(platform: 'darwin' | 'linux' | 'win32', label: string): string {
  if (platform === 'win32') return `the user's own Windows computer ${label}, under cmd.exe`;
  return `the user's own computer ${label}, under ${platform === 'darwin' ? 'zsh' : 'its default shell'}`;
}

/**
 * Whether a shell command drives a computer's GUI from the outside — AppleScript
 * at System Events or at an app, synthetic clicks and keystrokes, SendKeys on
 * Windows. This is what the `computer` tool exists for, and a persona without
 * a computer pin used it as a way around that tool's refusal (2026-09-21: the
 * Secretary switched a Mac to dark mode with `osascript ... appearance
 * preferences` after `computer` told it the task belonged to a pinned persona).
 * The ExecService turns this into a hand-off refusal when some persona IS
 * pinned to the target computer; with nobody pinned it stays the escape hatch.
 *
 * Deliberately narrow: `open -a`, `defaults`, files, git and scripts are shell
 * work the computer brief itself sends to run_command.
 */
export function drivesGui(command: string): boolean {
  const text = command.trim();
  if (!text) return false;
  if (/(^|[\s;&|(])(cliclick|xdotool|ydotool|wtype|xdo|AutoHotkey(?:64|32|U64|U32)?(?:\.exe)?)(\s|$)/i.test(text)) return true;
  if (/\bSendKeys\b|\bAppActivate\b|\bSendInput\b|\bmouse_event\b/i.test(text)) return true;
  if (/(^|[\s;&|(])osascript(\s|$)/i.test(text)) {
    // An AppleScript that talks to System Events or to an application's UI.
    return /System Events|appearance preferences|\btell\s+app(?:lication)?\b|\bkeystroke\b|\bkey code\b|\bclick\b|\bactivate\b|\bUI element\b|\bmenu (?:bar )?item\b/i.test(
      text
    );
  }
  return false;
}

/**
 * The one-shot classification prompt for the safety judge. Safety is judged
 * relative to the user's request when it is available — a download the user
 * asked for is expected; the same download out of nowhere is not.
 *
 * The prompt names the one shell that will actually run the command: what is
 * destructive in cmd is not what is destructive in zsh, and asking about both
 * at once only invites the model to hedge.
 */
export function buildJudgePrompt(
  command: string,
  cwd: string,
  userIntent?: string,
  shell: ShellArg = hostShellFromPlatform(),
  shellLabel?: string
): string {
  const intent = (userIntent ?? '').trim().slice(0, 800);
  return [
    `An AI assistant working on a request from its user wants to run a shell command on`,
    `${shellLabel ?? hostShellLabel(shell)}. Classify whether the`,
    'command is safe to run without asking the user first. Reply with exactly one word',
    '— safe, unsafe, or unsure — optionally followed on the same line by a very short reason.',
    '',
    "- safe: the command plausibly serves the user's request and does not destroy data,",
    '  change system or account state, or install software the user did not ask for.',
    '  Reading files, fetching or downloading content, opening pages or apps, and',
    '  writing inside the working directory or a system temp folder are all safe when',
    "  the request calls for them. Sending the user's own files or data somewhere is",
    '  safe only when the request asks for exactly that.',
    '- unsafe: deletes or overwrites data unrelated to the request or outside the',
    '  working directory and temp folders, changes system or account state, sends local',
    '  files, secrets, or personal data anywhere the user did not ask for, installs',
    "  software unprompted, or clearly does not serve the user's request.",
    '- unsure: you cannot tell.',
    '',
    intent
      ? `The user's request the assistant is working on:\n${intent}`
      : "The user's request is not available — judge the command on its own.",
    '',
    `Working directory: ${cwd}`,
    `Command: ${command}`
  ].join('\n');
}

export interface JudgeVerdict {
  verdict: 'safe' | 'unsafe' | 'unsure';
  reason?: string;
}

/**
 * Parse the judge's reply. Order matters ("unsafe" contains "safe"); anything
 * unrecognized escalates as `unsure` — the fail-safe direction.
 */
export function parseJudgeVerdict(text: string): JudgeVerdict {
  const firstLine = (text ?? '').trim().split('\n')[0] ?? '';
  const lower = firstLine.toLowerCase();
  const verdict = /\bunsafe\b/.test(lower)
    ? 'unsafe'
    : /\bunsure\b/.test(lower)
      ? 'unsure'
      : /\bsafe\b/.test(lower)
        ? 'safe'
        : 'unsure';
  const reason = firstLine
    .replace(/^[^a-zA-Z]*(unsafe|unsure|safe)\b[\s:,.—–-]*/i, '')
    .trim();
  return reason ? { verdict, reason } : { verdict };
}

// Re-exported so exec's own callers (and its tests) keep one import for the
// policy surface. The rule itself lives in shared/ because Settings now shows
// what "Auto" resolves to, and the renderer has to agree with the server.
export { resolveJudgeModel } from '../../shared/modelRoles';
