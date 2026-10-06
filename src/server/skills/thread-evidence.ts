import { toolCallActivity, traceArgs, type TraceEntry } from '../pi/normalize';

// `/learn`'s evidence: the whole conversation, read back from pi's session file.
//
// The end-of-turn pass authors from the live trace of the turn that just ended,
// and `/learn` used to borrow that trace from the runtime's in-memory ring. That
// fails the case /learn exists for. A procedure the user wants kept is usually
// spread over several turns — the attempt, the user's correction, the fix — and
// the ring held only the newest turn on the thread, with every command cut to 600
// characters, for three turns across every chat at once. The Cloudfarms invoice
// chat (2026-10-06) is the case: the invoice was made one turn before the last,
// by a 4 KB script the author saw 600 characters of, and /learn read only the
// two-command follow-up after it.
//
// The session file has all of it — every turn, every argument whole — and it
// survives a restart. It is still evidence, not a summary: the author is shown
// what was actually run, which is what made the ring-only rule worth having.

/** Per-call argument cap. The ring keeps 600; a script that did the work runs to a few KB. */
export const LEARN_ARGS_MAX_CHARS = 8_000;
/** Results stay at the ring's size: the argument is the procedure, the result only confirms it. */
export const LEARN_RESULT_MAX_CHARS = 2_000;
/** A user message or a reply, each. */
export const LEARN_TEXT_MAX_CHARS = 4_000;
/** One turn's tool payloads. Past it, calls keep their name and errors their result. */
export const LEARN_TURN_MAX_CHARS = 40_000;
/** The whole conversation as shown to the author. Newest turns win. */
export const LEARN_EVIDENCE_MAX_CHARS = 60_000;

/** One turn of a saved conversation, reduced to what the skill author is shown. */
export interface LearnTurn {
  /** The runtime turn id stamped into the user message, when it has one. */
  turnId?: string;
  userText: string;
  assistantText: string;
  trace: TraceEntry[];
  /**
   * The turn read inside a memorize:false folder, or was handed documents from
   * one: the same rule that keeps its reply out of Recall keeps it out of a skill.
   */
  tainted: boolean;
}

export interface ThreadEvidenceOptions {
  /** The user's own words, with Stem's injected blocks and markers stripped. */
  cleanUser: (content: unknown) => string;
  /** The runtime turn id a user message carries, if any. */
  turnIdOf: (content: unknown) => string | undefined;
  /** Inside a folder connected with memorize:false. */
  isPrivatePath: (path: string) => boolean;
  /** Labels of memorize:false folders, which name the documents Recall injected. */
  privateFolderLabels: ReadonlySet<string>;
  /** Turns the runtime itself flagged while they ran (still in its ring). */
  taintedTurnIds: ReadonlySet<string>;
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : undefined;

const textContent = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map(record)
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block!.text as string)
          .join('')
      : '';

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

/** The same argument keys the runtime's live taint check reads (TOOL_PATH_KEYS). */
const PATH_KEYS = ['path', 'file_path', 'filename'] as const;

/** Every path a call names, the MCP router's inner arguments included. */
function callPaths(args: unknown): string[] {
  const out: string[] = [];
  let current = record(args);
  for (let depth = 0; current && depth < 8; depth += 1) {
    for (const key of PATH_KEYS) {
      const value = current[key];
      if (typeof value === 'string' && value.trim()) out.push(value);
    }
    current = typeof current.tool === 'string' ? record(current.args) : undefined;
  }
  return out;
}

// The opener Recall writes, attribute included. The bare tag name is not one: the
// skills preamble names `<stem_memory_data>` in prose on every turn it loads
// skills, and counting that as an unread payload tainted every such turn.
const MEMORY_DATA_OPEN_RE = /<stem_memory_data version=/g;
const MEMORY_DATA_RE = /<stem_memory_data version="\d+">\n([\s\S]*?)\n<\/stem_memory_data>/g;

/**
 * Recall handed this turn a document from a memorize:false folder — the live
 * `privateDocsInjected` taint, worked out again from the payload the user
 * message still carries (for turns from before the runtime recorded it). Every
 * doubt counts as tainted, because guessing wrong the other way is the one that
 * leaks: a payload that will not parse, or one this pattern cannot even find.
 */
function injectedPrivateDocs(content: unknown, labels: ReadonlySet<string>): boolean {
  if (labels.size === 0) return false;
  const text = textContent(content);
  const opened = [...text.matchAll(MEMORY_DATA_OPEN_RE)].length;
  const blocks = [...text.matchAll(MEMORY_DATA_RE)].map((m) => m[1]);
  if (blocks.length < opened) return true;
  return blocks.some((block) => {
    try {
      const docs = (JSON.parse(block) as { folderDocuments?: Array<{ folder?: unknown }> }).folderDocuments ?? [];
      return docs.some((doc) => typeof doc.folder !== 'string' || labels.has(doc.folder));
    } catch {
      // quiet: the answer is the signal — an unreadable payload taints the turn.
      return true;
    }
  });
}

/**
 * The conversation in a pi session file, one entry per user turn, oldest first.
 *
 * Read linearly, the way the chat view reads it. Tool payloads are capped per
 * call and per turn; past the turn cap a call keeps its name, and a failed one its
 * error, because the dead end is the part a skill most needs to warn about.
 */
export function parseThreadEvidence(text: string, opts: ThreadEvidenceOptions): LearnTurn[] {
  const turns: LearnTurn[] = [];
  let current: (LearnTurn & { chars: number; replies: string[] }) | undefined;
  const finish = () => {
    if (!current) return;
    turns.push({
      ...(current.turnId ? { turnId: current.turnId } : {}),
      userText: current.userText,
      assistantText: clip(current.replies.join('\n\n').trim(), LEARN_TEXT_MAX_CHARS),
      trace: current.trace,
      tainted: current.tainted
    });
    current = undefined;
  };

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: RecordValue | undefined;
    try {
      entry = record(JSON.parse(line));
    } catch {
      // quiet: a torn last line (pi still appending) is a turn still being written;
      // the rest of the conversation is whole.
      continue;
    }
    const message = entry?.type === 'message' ? record(entry.message) : undefined;
    if (!message) continue;

    if (message.role === 'user') {
      finish();
      const turnId = opts.turnIdOf(message.content);
      current = {
        ...(turnId ? { turnId } : {}),
        userText: clip(opts.cleanUser(message.content).trim(), LEARN_TEXT_MAX_CHARS),
        assistantText: '',
        trace: [],
        tainted:
          (turnId !== undefined && opts.taintedTurnIds.has(turnId)) ||
          injectedPrivateDocs(message.content, opts.privateFolderLabels),
        chars: 0,
        replies: []
      };
      continue;
    }
    if (!current) continue;

    if (message.role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content.map(record) : [];
      const reply = textContent(message.content).trim();
      if (reply) current.replies.push(reply);
      for (const [index, block] of blocks.entries()) {
        if (block?.type !== 'toolCall') continue;
        const id = typeof block.id === 'string' ? block.id : `call-${current.trace.length}-${index}`;
        if (current.trace.some((t) => t.id === id)) continue;
        const raw = record(block.arguments);
        if (callPaths(raw).some(opts.isPrivatePath)) current.tainted = true;
        const name = toolCallActivity(id, typeof block.name === 'string' ? block.name : undefined, raw).name;
        const args = current.chars < LEARN_TURN_MAX_CHARS ? traceArgs(raw, LEARN_ARGS_MAX_CHARS) : undefined;
        current.chars += args?.length ?? 0;
        current.trace.push({ id, ...(name ? { name } : {}), ...(args ? { args } : {}) });
      }
      continue;
    }

    if (message.role === 'toolResult') {
      const traced = current.trace.find((t) => t.id === message.toolCallId);
      if (!traced) continue;
      traced.isError = message.isError === true;
      const result = textContent(message.content).trim();
      if (result && (traced.isError || current.chars < LEARN_TURN_MAX_CHARS)) {
        traced.result = clip(result, LEARN_RESULT_MAX_CHARS);
        current.chars += traced.result.length;
      }
    }
  }
  finish();
  return turns;
}

/** Roughly what a turn costs in the prompt, for the budget below. */
export function turnSize(turn: LearnTurn): number {
  return (
    turn.userText.length +
    turn.assistantText.length +
    turn.trace.reduce((sum, t) => sum + (t.name?.length ?? 0) + (t.args?.length ?? 0) + (t.result?.length ?? 0), 0)
  );
}

/**
 * The newest turns that fit the budget, oldest first. The newest is always kept:
 * it is the one the user just watched, and /learn is sent right after it.
 */
export function pickLearnTurns(turns: LearnTurn[], budget = LEARN_EVIDENCE_MAX_CHARS): { kept: LearnTurn[]; dropped: number } {
  const kept: LearnTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const size = turnSize(turns[i]);
    if (kept.length > 0 && used + size > budget) break;
    kept.unshift(turns[i]);
    used += size;
  }
  return { kept, dropped: turns.length - kept.length };
}
