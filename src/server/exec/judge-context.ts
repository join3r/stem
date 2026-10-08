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
}

export interface JudgeContext {
  /** The user's own messages or mails, oldest first, already capped. */
  userWords: string[];
  /** The agent's commands, oldest first, already capped. */
  actions: JudgeAction[];
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

/** The newest commands, each on one line and cut to size. */
export function capActions(actions: readonly JudgeAction[], max = JUDGE_ACTIONS_MAX): JudgeAction[] {
  return actions.slice(-max).map((a) => ({
    command: a.command.replace(/\s+/g, ' ').trim().slice(0, JUDGE_ACTION_MAX_CHARS),
    refused: a.refused
  }));
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : undefined;

/** The run_command arguments of a tool call, unwrapping the MCP router's invoke_tool. */
function runCommandArgs(block: RecordValue): RecordValue | undefined {
  let name = block.name;
  let args = record(block.arguments);
  for (let depth = 0; name === 'invoke_tool' && args && depth < 4; depth += 1) {
    name = args.tool;
    args = record(args.args);
  }
  return name === 'run_command' ? args : undefined;
}

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
  const pending = new Map<string, string>();
  for (const line of text.split('\n')) {
    // Cheap pre-filter: most lines are assistant text and tool output.
    if (!line.includes('"role":"user"') && !line.includes('run_command') && !line.includes('"role":"toolResult"')) continue;
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
        const words = opts.cleanUser(message.content).trim();
        if (words) userWords.push(words);
      }
    } else if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content.map(record)) {
        if (block?.type !== 'toolCall' || typeof block.id !== 'string') continue;
        const args = runCommandArgs(block);
        if (args && typeof args.command === 'string' && args.command.trim()) pending.set(block.id, args.command);
      }
    } else if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const command = pending.get(message.toolCallId);
      if (command === undefined) continue;
      pending.delete(message.toolCallId);
      actions.push({ command, refused: message.isError === true });
    }
  }
  return { userWords, actions };
}
