// The skill contract: the single definition of what a well-formed SKILL.md is.
//
// Every authoring path funnels through `validateSkill` — the model asking to save
// one mid-turn (manage_skill), the end-of-turn pass, `/learn`, and the curator's
// merges. Nothing writes a SKILL.md without passing here first, so the library
// cannot drift the way the previous one did (a 79-character English sentence in a
// `name:` field that agentskills.io and pi both cap at 64 slug characters).
//
// The prose statement of the same rules lives in SKILL_CONTRACT_TEXT below and is
// what the model is shown. Rules and prose sit in one file on purpose: when a rule
// changes, the sentence describing it is on the adjacent screen. Both are exported
// with no interpolation so `scripts/skill-author-eval.mjs` can lift them verbatim
// from this source (the way memory-eval.mjs lifts DISTILL_INSTRUCTIONS) and grade
// the contract that actually ships.

/** Max length of `name:`, matching agentskills.io and pi's own cap. */
export const SKILL_NAME_MAX = 64;
/** Max length of `description:` — it is broadcast for every skill, every turn. */
export const SKILL_DESCRIPTION_MAX = 160;
/**
 * How a model-written description must open. "Use when …" names the situation that
 * should load the skill; "Use to …" / "Use for …" lists what it can do, and a list
 * of capabilities is exactly how one description came to cover four unrelated jobs
 * (2026-10-10: five of the six multi-job skills on the server opened that way, and
 * no single-job one did). Retrieval matches the message against this sentence
 * alone, so a description that covers several jobs matches each of them weakly.
 */
export const SKILL_DESCRIPTION_OPENING = 'Use when';
/** Max body size. Bodies are inlined into the turn, so this is a token budget. */
export const SKILL_BODY_MAX_BYTES = 4_096;
/** A skill name is its directory name: lowercase words joined by single hyphens. */
export const SKILL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Headings every body must carry, in this order. */
export const SKILL_REQUIRED_SECTIONS = ['## When to use', '## Steps', '## Verification'] as const;

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  /**
   * Tools whose calls this skill governs, as `server.tool` for an MCP tool (what
   * `invoke_tool` takes), `server.*` for every tool on a server, or a built-in
   * tool's own name. Stem hands the skill over the first time a turn calls one
   * (stem-mcp-extension.mjs `toolSkillHold`), whatever the request's wording
   * made the ranking pick. Absent on a patch means "keep what the skill had".
   */
  tools?: string[];
  /**
   * How often the task is expected to come up again (see SkillRecurrence).
   * Absent on a patch means "keep what the skill had".
   */
  recurs?: SkillRecurrence;
}

/**
 * How often a skill's task is expected to come up again: the writer's estimate,
 * which the user can change in Manage. The lifecycle clock (lifecycle.ts) reads
 * it to decide how long a skill may sit unused before it is switched off.
 *
 * It exists because one fixed window cannot be right. On 2026-11-17 the live
 * library held 86 skills and 40 had never been used, so a short window was the
 * obvious fix, and it would have retired the monthly invoice skill between two
 * invoices and every yearly task long before its second run. `occasional` is the
 * answer for work with no rhythm (it comes up when something breaks), and is
 * what a skill with no estimate counts as.
 */
export const SKILL_RECURRENCES = ['weekly', 'monthly', 'quarterly', 'yearly', 'occasional'] as const;
export type SkillRecurrence = (typeof SKILL_RECURRENCES)[number];

/** A recurrence read from model output, a tool call or a file; anything else is "not said". */
export function parseRecurrence(value: unknown): SkillRecurrence | undefined {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (SKILL_RECURRENCES as readonly string[]).includes(text) ? (text as SkillRecurrence) : undefined;
}

/** One `tools` entry: `server.tool`, `server.*`, or a bare tool name. */
export const SKILL_TOOL_RE = /^[A-Za-z0-9_-]+(?:\.(?:[A-Za-z0-9_.-]+|\*))?$/;
export const MAX_SKILL_TOOLS = 6;
/**
 * Built-in tools that a turn calls for any reason. A skill bound to one of them
 * held the first such call of every turn: on 2026-11-09 a Docker-cleanup skill
 * bound to `run_command` held a plain `gh repo list` in an unrelated chat. Such
 * an entry is refused when a skill is written, and ignored at hold time for the
 * skills that already have one. The same happened on 2026-11-09 with `browser`:
 * a Slack-outage recipe bound to it held an Apple form fill in a CarPlay chat.
 * The browser, the computer and the delegation tools serve any job, so a skill
 * cannot decide how all their calls are made.
 */
export const GENERAL_SKILL_TOOLS: ReadonlySet<string> = new Set([
  'run_command',
  'read',
  'write',
  'edit',
  'ls',
  'grep',
  'find',
  'bash',
  'fetch_content',
  'web_search',
  'get_search_content',
  'source_check',
  'invoke_tool',
  'find_tools',
  'describe_tool',
  'browser',
  'computer',
  'spawn_agent',
  'coding_agent',
  'read_past_chat',
  'read_notes'
]);

/** A skill's `tools` without the general ones, which never hold a call. */
export function holdableSkillTools(tools: readonly string[] | undefined): string[] {
  return (tools ?? []).map((t) => String(t ?? '').trim()).filter((t) => t && !GENERAL_SKILL_TOOLS.has(t));
}

export interface SkillViolation {
  field: 'name' | 'description' | 'body' | 'tools';
  message: string;
  /** Set on the size violation, which a shortening pass can repair on its own. */
  tooLong?: true;
}

/**
 * Derive a slug from free text. Used to repair a near-miss name (title case, a
 * stray space) — NOT to launder an arbitrary sentence into a slug, which is how
 * the old library ended up with names nobody could type. A draft whose name only
 * becomes valid after aggressive truncation still fails validation.
 */
export function slugifySkillName(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Words of a slug or free-text phrase, lowercased. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * True when the description opens by repeating the name. The description's whole
 * job is to say something the name does not — it is the only text ranked against
 * the user's message for every skill, so a restatement wastes the one signal
 * retrieval has. Deliberately literal: only a leading token-for-token repeat
 * counts, so "inspect-youtube-video" / "Inspect a YouTube video…" passes.
 */
export function restatesName(name: string, description: string): boolean {
  const nameWords = words(name);
  const descWords = words(description);
  if (nameWords.length === 0 || descWords.length < nameWords.length) return false;
  return nameWords.every((w, i) => descWords[i] === w);
}

/** True when the description opens with SKILL_DESCRIPTION_OPENING, case-insensitively. */
export function opensWithSituation(description: string): boolean {
  return description.trim().toLowerCase().startsWith(`${SKILL_DESCRIPTION_OPENING.toLowerCase()} `);
}

/** Rough sentence count — used only to hold the description to one sentence. */
function sentenceCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  // A terminator followed by whitespace and a letter starts another sentence.
  // "e.g." and "1." don't match (lowercase / digit before the terminator is fine,
  // but the following character must begin a word), so the check is forgiving.
  return 1 + (trimmed.slice(0, -1).match(/[.!?]\s+[A-Z]/g)?.length ?? 0);
}

/**
 * Check a draft against the contract. Returns every violation it finds, not just
 * the first: the authoring retry shows the model the whole list, so a second call
 * can fix everything at once rather than trading one failure for another.
 */
export function validateSkill(draft: SkillDraft, opts: { authored?: boolean } = {}): SkillViolation[] {
  const violations: SkillViolation[] = [];
  const name = String(draft.name ?? '').trim();
  const description = String(draft.description ?? '').trim();
  const body = String(draft.body ?? '').trim();

  if (!name) {
    violations.push({ field: 'name', message: 'name is empty.' });
  } else if (!SKILL_SLUG_RE.test(name)) {
    const suggestion = slugifySkillName(name);
    violations.push({
      field: 'name',
      message:
        `name must be lowercase words joined by single hyphens (a-z, 0-9), e.g. "extract-video-captions" — got ${JSON.stringify(name)}.` +
        (suggestion && suggestion.length <= SKILL_NAME_MAX && SKILL_SLUG_RE.test(suggestion)
          ? ` Try "${suggestion}".`
          : '')
    });
  } else if (name.length > SKILL_NAME_MAX) {
    violations.push({ field: 'name', message: `name is ${name.length} characters; the limit is ${SKILL_NAME_MAX}. Shorten it.` });
  }

  if (!description) {
    violations.push({ field: 'description', message: 'description is empty.' });
  } else {
    if (description.length > SKILL_DESCRIPTION_MAX) {
      violations.push({
        field: 'description',
        message: `description is ${description.length} characters; the limit is ${SKILL_DESCRIPTION_MAX}. Cut it to one sentence.`
      });
    }
    if (sentenceCount(description) > 1) {
      violations.push({ field: 'description', message: 'description must be a single sentence.' });
    }
    if (description.includes('\n')) {
      violations.push({ field: 'description', message: 'description must be one line.' });
    }
    // Model-written text only (`authored`). A person editing a description in the
    // app is not held to the phrasing: they are not the failure this guards, and
    // refusing their wording would cost a save over a style rule.
    if (opts.authored && !opensWithSituation(description)) {
      violations.push({
        field: 'description',
        message:
          `description must start with "${SKILL_DESCRIPTION_OPENING}" and name the ONE situation that calls for this procedure. ` +
          'If it needs "or" to cover two unrelated jobs, those are two skills.'
      });
    }
    if (name && restatesName(name, description)) {
      violations.push({
        field: 'description',
        message:
          'description just restates the name. It is the only text matched against the user\'s message, so it must add what the name cannot: the situation that should trigger this skill.'
      });
    }
  }

  if (!body) {
    violations.push({ field: 'body', message: 'body is empty.' });
  } else {
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > SKILL_BODY_MAX_BYTES) {
      // A concrete amount with headroom: told only the limit, a model trims a
      // few words and lands over it again.
      const cut = bytes - SKILL_BODY_MAX_BYTES + 300;
      violations.push({
        field: 'body',
        tooLong: true,
        message: `body is ${bytes} bytes; the limit is ${SKILL_BODY_MAX_BYTES}. Cut at least ${cut} bytes (about ${Math.ceil((cut / bytes) * 100)}%): drop narration and explanations, merge small steps, keep every action.`
      });
    }
    if (/^---\s*$/m.test(body.split('\n')[0] ?? '')) {
      violations.push({ field: 'body', message: 'body must not include front-matter; Stem writes the --- block itself.' });
    }
    const missing = SKILL_REQUIRED_SECTIONS.filter((h) => !bodyHasSection(body, h));
    if (missing.length > 0) {
      violations.push({ field: 'body', message: `body is missing ${missing.join(', ')}. All three headings are required, in that order.` });
    } else {
      const positions = SKILL_REQUIRED_SECTIONS.map((h) => sectionIndex(body, h));
      if (positions[0] > positions[1] || positions[1] > positions[2]) {
        violations.push({
          field: 'body',
          message: `body sections are out of order; they must appear as ${SKILL_REQUIRED_SECTIONS.join(', then ')}.`
        });
      }
    }
  }

  if (draft.tools !== undefined) {
    const bad = draft.tools.filter((t) => !SKILL_TOOL_RE.test(String(t ?? '').trim()));
    if (bad.length > 0) {
      violations.push({ field: 'tools', message: `each entry must be "server.tool", "server.*" or a tool's own name; not ${bad.map((t) => JSON.stringify(t)).join(', ')}.` });
    } else if (draft.tools.some((t) => GENERAL_SKILL_TOOLS.has(String(t ?? '').trim()))) {
      const general = draft.tools.filter((t) => GENERAL_SKILL_TOOLS.has(String(t ?? '').trim()));
      violations.push({
        field: 'tools',
        message: `${general.map((t) => JSON.stringify(t)).join(', ')} ${general.length > 1 ? 'are general tools' : 'is a general tool'} that almost every turn calls; list only tools whose calls this skill decides, or leave "tools" out.`
      });
    } else if (draft.tools.length > MAX_SKILL_TOOLS) {
      violations.push({ field: 'tools', message: `at most ${MAX_SKILL_TOOLS} tools; list only the ones whose calls this skill decides how to make.` });
    }
  }
  return violations;
}

function sectionRe(heading: string): RegExp {
  return new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im');
}

function bodyHasSection(body: string, heading: string): boolean {
  return sectionRe(heading).test(body);
}

function sectionIndex(body: string, heading: string): number {
  return body.search(sectionRe(heading));
}

/** One line per violation, for the retry prompt and for the tool's error reply. */
export function formatViolations(violations: SkillViolation[]): string {
  return violations.map((v) => `- ${v.field}: ${v.message}`).join('\n');
}

/**
 * The contract as the model reads it. Kept free of interpolation so the eval can
 * lift it verbatim; every number in it is duplicated from the constants above, so
 * changing a constant means changing the sentence directly below it here.
 */
export const SKILL_CONTRACT_TEXT = `A skill is a procedure you can follow again later, written for a reader who has forgotten everything except that the task needs doing.

name: lowercase words joined by single hyphens, at most 64 characters. It is also the folder name. Name the task, not the conversation — "extract-video-captions", not "help-with-that-youtube-thing".

description: ONE sentence, at most 160 characters, on one line, starting "Use when". This is the only text matched against a future message to decide whether to load the skill, so it must name the one situation that calls for it, not list what it can do. Never restate the name.

One skill is one job. Two jobs on the same tool or service — debugging a container's ports and upgrading its image — are two skills, each with its own description. A description that needs "or" to join unrelated tasks is a sign the skill should be split.

body: at most 4096 bytes, with exactly these three headings in this order:

## When to use
One or two lines naming the situation, and the situations that look similar but are not it.

## Steps
Numbered, imperative, concrete. Name the exact tool and the exact arguments that worked — real URLs, real flags, real file paths. Include the dead ends worth avoiding and say why they failed. Do not narrate what happened in a conversation; write what to do next time.

If the procedure only works on one machine, say which and why, in its own line before the steps. A skill outlives the machine it was written on: the user may move Stem to a server, and steps that quietly assumed their own computer — a program only it has, an address on their home network, a site that treats a home connection differently from a datacenter — then fail with nothing to explain them. Name the way in that worked (\`run_command\` with its \`device\` parameter, an MCP server pinned to that computer), not just the machine's nickname. Say which computer by what it is ("the user's Mac"), not by its current name: the user renames computers, and a step that passes yesterday's name as \`device\` fails; the assistant always has the current names of the paired computers to pick from. A procedure that runs anywhere needs no such line: this is for the ones that do not.

## Verification
How to tell it worked — the specific output, file, or state to check for. Not "confirm success".

Write no front-matter; Stem adds the --- block. Write nothing outside those three sections.`;
