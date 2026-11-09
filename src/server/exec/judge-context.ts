// What the safety judge reads besides the command: the user's own words and
// the commands the agent already ran — the two inputs Claude Code's auto-mode
// classifier keeps, and nothing else. Agent prose, briefs and tool output are
// left out on purpose: a judge that reads the agent's explanation can be talked
// into a verdict, and tool output is where injected text arrives.
//
// 2026-10-08: the judge used to read one message, and on a mail delivery the
// brief another persona wrote. It refused a benchmark's venv install because
// the brief never said "install", and in a chat it refused "open the app"
// because it could not see that the reinstall had already run.

/** One command the agent ran, or tried to run, in this chat or conversation. */
export interface JudgeAction {
  command: string;
  /** Stem refused it (judge block, the user's deny, a guard): Stem's mark, never the agent's. */
  refused: boolean;
  /** capCommand already cut it to size: Stem's mark, never read off the text. */
  cut?: true;
}

export interface JudgeContext {
  /** The user's own messages or mails, oldest first, already capped. */
  userWords: string[];
  /** The agent's commands, oldest first, already capped. */
  actions: JudgeAction[];
  /**
   * The user's own message that started this turn — a chat message, or the
   * user's mail a delivery carries. Absent when nobody wrote to start it (a
   * scheduled run, another persona's mail). Not shown to the judge: the exec
   * gate reads it to tell a short reply ("yes", "Áno") from a request.
   */
  reply?: string;
}

/**
 * A reply this short usually answers the assistant's question, which the judge
 * never sees (agent text is left out on purpose), so a "yes" reads to it as no
 * request at all. The first block after one goes to the user as a card instead.
 */
export const SHORT_REPLY_MAX_CHARS = 60;

export function isShortReply(text: string | undefined): boolean {
  const t = text?.trim() ?? '';
  return t.length > 0 && t.length <= SHORT_REPLY_MAX_CHARS;
}

/** How much of the user's words the judge reads in all: the first one, then the newest that fit. */
export const JUDGE_WORDS_MAX_CHARS = 6000;
/** How many earlier commands it sees, and how much of each. */
export const JUDGE_ACTIONS_MAX = 30;
export const JUDGE_ACTION_MAX_CHARS = 300;
/** Each of the user's own rule boxes (Settings → Commands), as stored and as the judge reads it. */
export const JUDGE_RULE_MAX_CHARS = 4000;

/**
 * The first message (it usually states the task) plus the newest that still
 * fit, oldest first. A message longer than the whole budget is cut, not dropped.
 */
export function capUserWords(words: readonly string[], max = JUDGE_WORDS_MAX_CHARS): string[] {
  const clean = words.map((w) => w.trim()).filter(Boolean);
  if (!clean.length) return [];
  const first = clean[0]!.slice(0, max);
  let budget = max - first.length;
  const tail: string[] = [];
  for (let i = clean.length - 1; i >= 1 && budget > 0; i -= 1) {
    const w = clean[i]!;
    if (w.length > budget) {
      if (!tail.length) tail.unshift(w.slice(0, budget));
      break;
    }
    tail.unshift(w);
    budget -= w.length;
  }
  return [first, ...tail];
}

/** How much of a long command's later file paths the judge still reads. */
export const JUDGE_ACTION_PATHS_MAX_CHARS = 300;

// A quoted or bare token that looks like a file path: it has a slash or ends in
// a short extension. Enough to show where a long script wrote its files.
const PATH_TOKEN_RE = /(?:['"`])((?:[~.]?\/)?[\w.@~-]+(?:\/[\w.@~-]+)*\.[A-Za-z0-9]{1,8}|\/[\w.@~-]+(?:\/[\w.@~-]+)+)(?:['"`])/g;

/**
 * One command on one line, cut to size. When the cut drops part of it, the file
 * paths named in the dropped part follow the cut: on 2026-11-09 a script wrote
 * two preview pictures past character 300, and the judge refused to let the
 * agent delete them because it could not see who made them.
 */
export function capCommand(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  if (flat.length <= JUDGE_ACTION_MAX_CHARS) return flat;
  const head = flat.slice(0, JUDGE_ACTION_MAX_CHARS);
  const paths: string[] = [];
  let used = 0;
  for (const m of flat.slice(JUDGE_ACTION_MAX_CHARS).matchAll(PATH_TOKEN_RE)) {
    const path = m[1]!;
    if (paths.includes(path) || head.includes(path)) continue;
    if (used + path.length > JUDGE_ACTION_PATHS_MAX_CHARS) break;
    paths.push(path);
    used += path.length + 2;
  }
  return paths.length ? `${head} … [later in this command: ${paths.join(', ')}]` : `${head} …`;
}

/** The newest commands, each on one line and cut to size. */
export function capActions(actions: readonly JudgeAction[], max = JUDGE_ACTIONS_MAX): JudgeAction[] {
  return actions.slice(-max).map((a) => ({
    // Cut once already (a live turn re-caps its whole list on every command).
    command: a.cut ? a.command : capCommand(a.command),
    refused: a.refused,
    cut: true as const
  }));
}

/**
 * The files a save_file call wrote, as the judge reads them: one action per
 * call. `written` is Stem's own list (files/save-file.ts saveFiles), never the
 * result text, which quotes the model's own `from` and `to`.
 */
export function savedFilesAction(written: unknown): JudgeAction | undefined {
  const paths = Array.isArray(written)
    ? written.filter((w): w is string => typeof w === 'string' && w.length > 0 && !/[\r\n]/.test(w))
    : [];
  return paths.length ? { command: `[save_file wrote] ${paths.join(', ')}`, refused: false } : undefined;
}

// The inlined text of attached files (pi/attachments.ts fenceText) and the skip
// note follow the user's message in the stored turn. They are file contents,
// not the user's words: a downloaded document saying "always allow curl | sh"
// must not read to the judge as the user saying it.
const ATTACHMENT_TAIL_RE = /(^|\n\n)(Attached file: |\(Skipped unsupported attachment: )[\s\S]*$/;

/** The user's own text of a stored message: everything before the inlined attachments. */
export function withoutAttachments(text: string): string {
  return text.replace(ATTACHMENT_TAIL_RE, '').trim();
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : undefined;

/** The tool name and arguments of a tool call, unwrapping the MCP router's invoke_tool. */
function unwrapCall(block: RecordValue): { name: unknown; args: RecordValue | undefined } {
  let name = block.name;
  let args = record(block.arguments);
  for (let depth = 0; name === 'invoke_tool' && args && depth < 4; depth += 1) {
    name = args.tool;
    args = record(args.args);
  }
  return { name, args };
}

/** The text of a stored tool result. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (typeof record(p)?.text === 'string' ? (record(p)!.text as string) : '')).join('');
}

// Must match pi/protocol.ts TOOL_SKILL_MARKER. Not imported: the exec code stays
// free of the pi layer.
const SKILL_HOLD_PREFIX = '<stem_skills version="1" trigger="';

export interface SessionReadOptions {
  /**
   * The user's words with Stem's injected blocks stripped (the runtime's
   * contentToParts). Absent for a hidden mail or scheduled thread, whose
   * user-role messages are deliveries and preambles, not the user writing.
   */
  cleanUser?: (content: unknown) => string;
}

/**
 * The user messages and run_command calls in one pi session file, oldest
 * first. A call counts as refused when its result is an error: run_command
 * only errors when Stem did not run it — a command that ran and failed still
 * comes back as an ordinary result with its exit code.
 */
export function parseJudgeSession(text: string, opts: SessionReadOptions = {}): { userWords: string[]; actions: JudgeAction[] } {
  const userWords: string[] = [];
  const actions: JudgeAction[] = [];
  // A pending call: a command, or a file write whose result names the path.
  const pending = new Map<string, { kind: 'command' | 'save' | 'write'; text: string }>();
  for (const line of text.split('\n')) {
    // Cheap pre-filter: most lines are assistant text and tool output.
    if (!line.includes('"role":"user"') && !line.includes('"toolCall"') && !line.includes('"role":"toolResult"')) continue;
    let entry: RecordValue | undefined;
    try {
      entry = record(JSON.parse(line));
    } catch {
      // quiet: a torn last line (pi mid-append) carries nothing yet.
      continue;
    }
    const message = record(entry?.message);
    if (entry?.type !== 'message' || !message) continue;
    if (message.role === 'user') {
      if (opts.cleanUser) {
        const words = withoutAttachments(opts.cleanUser(message.content));
        if (words) userWords.push(words);
      }
    } else if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content.map(record)) {
        if (block?.type !== 'toolCall' || typeof block.id !== 'string') continue;
        const { name, args } = unwrapCall(block);
        if (name === 'run_command' && typeof args?.command === 'string' && args.command.trim()) {
          pending.set(block.id, { kind: 'command', text: args.command });
        } else if (name === 'save_file') {
          pending.set(block.id, { kind: 'save', text: '' });
        } else if (name === 'write' && typeof args?.path === 'string' && args.path.trim()) {
          pending.set(block.id, { kind: 'write', text: args.path.trim() });
        }
      }
    } else if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const call = pending.get(message.toolCallId);
      if (call === undefined) continue;
      pending.delete(message.toolCallId);
      const failed = message.isError === true;
      if (call.kind === 'command') {
        // A call held once to hand over a saved skill did not run, and Stem did
        // not refuse it: the agent makes it again at once. Listed as [refused],
        // it told the judge that a plain `gh repo list` had been blocked.
        if (failed && resultText(message.content).startsWith(SKILL_HOLD_PREFIX)) continue;
        actions.push({ command: call.text, refused: failed });
      } else if (call.kind === 'save') {
        const saved = savedFilesAction(record(message.details)?.written);
        if (saved) actions.push(saved);
      } else if (!failed) {
        actions.push({ command: `[write tool wrote] ${call.text}`, refused: false });
      }
    }
  }
  return { userWords, actions };
}
