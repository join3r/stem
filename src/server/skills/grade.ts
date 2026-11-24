import type { TraceEntry } from '../pi/normalize';
import { SKILL_ISSUE_MARKER } from './inject';

// Did the turn actually follow the skills it was given?
//
// This is the numerator of the injected-then-graded loop, and it is deliberately
// NOT a model call. Recall can afford to grade fact usage with an LLM because it
// rides along on the distill pass that was going to run anyway; there is no such
// free ride here — a per-turn judge would add a model call to every turn in the
// app to answer a question worth a fraction of one.
//
// So the signal is a proxy: a skill counts as used when the turn ran a tool that
// the skill's Steps section names. That is a weak signal in both directions. It
// misses a skill followed as pure advice with no tools, and it can credit a skill
// for a tool the model would have reached for regardless. What makes it good
// enough is what the number is FOR: it is a small reordering term inside a cosine
// gate (SKILL_USAGE_WEIGHT = 0.1), never an admission or rejection on its own, and
// it decays. A proxy that is right more often than chance and cannot let anything
// through the gate is worth more than a judge nobody can afford to run.
//
// The failure we care about is the opposite one anyway: a skill injected turn
// after turn that never coincides with any of its own tools is almost certainly
// dead weight, and that is exactly the case this catches.
//
// Two corrections, 2026-08-11, after a false credit in the live library.
//
// First, generic tools no longer earn credit (GENERIC_TOOLS below). Nearly every
// skill's Steps mention `run_command` or `fetch_content`, and nearly every gated
// turn calls one, so "ran a tool this skill names" had degenerated toward "did the
// turn use a tool at all": `identify-youtube-trailer-music` was credited on a turn
// that fetched an unrelated URL, because its step 7 says `fetch_content`. A proxy
// that fires on almost every turn is not right more often than chance; it is a
// constant, and a constant reordering term is just noise with a cost.
//
// Second, removing them alone would have made the entire live library ungradeable
// — a source-check found `fetch_content` and `get_search_content` are the only
// real tool names any live skill's Steps mention. So the same tokens are matched
// a second way, against the ARGUMENTS of the turn's tool calls rather than the
// tool names: a skill that says `yt-dlp --skip-download` is credited when a
// command this turn actually ran `yt-dlp`. That restores the coverage the first
// change removed, and it restores it with more precision than the original rule
// had — running `yt-dlp` is following the procedure, and unlike "called a tool"
// it is not satisfiable by reaching for any tool for any reason.
//
// A skill whose Steps yield no distinctive tokens at all stays ungradeable and
// ranks neutral. That is correct: there is no evidence to be had.

/**
 * Tools callable for any reason on any turn, so naming one in Steps carries no
 * evidence that the turn followed the skill. Matching them was the whole of the
 * 08-11 false credit.
 *
 * `read` and `write` are deliberately NOT here: the token regex below requires a
 * separator and at least 5 characters, so neither can ever be extracted in the
 * first place — listing them would be a dead letter that reads like a live rule.
 */
export const GENERIC_TOOLS = new Set(['run_command', 'fetch_content', 'web_search', 'get_search_content']);

/**
 * The distinctive tokens a skill's Steps section names, lowercased: tool names,
 * CLI binaries, flags, subcommands. One extraction feeds both signals — an exact
 * match against the turn's tool names, and a substring match against its tool
 * arguments — because a `yt-dlp` in Steps is the same claim either way: this turn
 * should have touched that specific thing.
 */
export function toolsNamedIn(body: string): Set<string> {
  const steps = sectionText(body, 'Steps');
  const names = new Set<string>();
  // Tool names appear as bare identifiers or in backticks: `manage_skill`,
  // agent-browser, yt-dlp. Underscored or hyphenated words of a decent
  // length, which keeps ordinary English out without needing a tool registry
  // here (one would have to be threaded through and kept in sync).
  for (const match of steps.matchAll(/[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+/gi)) {
    const word = match[0].toLowerCase();
    if (word.length >= 5 && !GENERIC_TOOLS.has(word)) names.add(word);
  }
  return names;
}

/**
 * The text under `## <heading>`, up to the next heading of any level. Exported
 * for dedup.ts, which compares two bodies' Steps sections and has to mean exactly
 * the same span of text by "Steps" that grading does.
 */
export function sectionText(body: string, heading: string): string {
  const start = body.search(new RegExp(`^##\\s+${heading}\\s*$`, 'im'));
  if (start === -1) return body;
  const rest = body.slice(start).replace(/^[^\n]*\n/, '');
  const end = rest.search(/^#{1,6}\s/m);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Which of the injected skills the turn shows evidence of following. `skills` is
 * what was inlined this turn — a skill listed by name only was never given its
 * steps, so it can neither be followed nor fairly graded.
 */
export function gradeSkillUse(
  skills: { slug: string; body: string }[],
  trace: TraceEntry[],
  assistantText = ''
): string[] {
  if (skills.length === 0) return [];
  const called = new Set(trace.map((t) => (t.name ?? '').toLowerCase()).filter(Boolean));
  // `args` is already the serialized, redacted, truncated JSON the trace keeps
  // (see normalize.ts): the same text skill authoring reads, so a token found in
  // it is a thing the turn demonstrably passed to a tool. Joined per entry rather
  // than concatenated so no token can be matched across a call boundary.
  const argsText = trace
    .map((t) => t.args ?? '')
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  // Where a quoted phrase can show up: the arguments (a draft saved through a
  // tool) and the reply (a draft written into the chat). JSON escapes newlines
  // and quotes in the arguments, so both sides are compared squeezed.
  const written = squeeze(`${argsText}\n${assistantText}`);
  if (called.size === 0 && !written.trim()) return [];
  const used: string[] = [];
  for (const skill of skills) {
    let hit = false;
    for (const token of toolsNamedIn(skill.body)) {
      // Either signal is enough. Substring rather than word match on the args:
      // the token sits inside a JSON string next to quotes, flags and paths
      // (`{"command":"yt-dlp --skip-download …"}`), and it is distinctive enough
      // by construction — generic tool names are already out of the set — that
      // an incidental substring hit is not the failure mode worth guarding.
      if (called.has(token) || argsText.includes(token)) {
        hit = true;
        break;
      }
    }
    if (!hit) hit = phrasesQuotedIn(skill.body).some((phrase) => written.includes(squeeze(phrase)));
    if (hit) used.push(skill.slug);
  }
  return used;
}

/**
 * Smallest quoted phrase that counts as evidence. Shorter ones match by accident:
 * every polite reply contains "Best regards," whatever skill it followed.
 */
const MIN_QUOTED_CHARS = 12;
const MIN_QUOTED_WORDS = 3;

/**
 * The exact wording a skill's Steps quote: text in backticks or quotation marks,
 * at least three words.
 *
 * Tool overlap cannot see a writing skill. "Sign as `On behalf of Vladimír
 * Schmotzer`" names no tool, so a turn that followed it to the letter graded as
 * unused, and the lifecycle clock would archive a skill in daily use. Its quoted
 * wording turning up in the draft is the same claim tool overlap makes: this turn
 * did what the skill says.
 */
export function phrasesQuotedIn(body: string): string[] {
  const steps = sectionText(body, 'Steps');
  const phrases: string[] = [];
  for (const match of steps.matchAll(/`([^`\n]+)`|"([^"\n]+)"|“([^”\n]+)”|„([^“”\n]+)[“”]/g)) {
    const phrase = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (phrase.length >= MIN_QUOTED_CHARS && phrase.split(/\s+/).length >= MIN_QUOTED_WORDS) phrases.push(phrase);
  }
  return phrases;
}

/** Lowercase, JSON escapes and markdown emphasis out, whitespace runs to one space. */
function squeeze(text: string): string {
  return text
    .toLowerCase()
    .replace(/\\[nrt"]/g, ' ')
    .replace(/[\s*_]+/g, ' ');
}

/** One reported failure of a loaded skill: which one, and what the model said was wrong. */
export interface SkillIssue {
  slug: string;
  reason: string;
}

/** Longest reason kept; the rest of the sentence is in the chat for the user. */
export const SKILL_ISSUE_REASON_MAX = 240;

/**
 * The failures the model REPORTED this turn, parsed off its reply.
 *
 * This is the one outcome signal that costs nothing: the per-turn block already
 * tells the model to say so when a loaded step is wrong, because a bad auto-saved
 * skill has to become visible to the user. Until now nobody read that sentence
 * back. The block asks for it on a line starting with `SKILL_ISSUE_MARKER
 * [<name>]:`, and this reads exactly that line — so unlike `gradeSkillUse`, which
 * infers use from tool overlap, this is the model's own verdict on the skill.
 *
 * Only skills whose bodies were inlined this turn can be reported: a name-only
 * entry was never given its steps, so it cannot have been wrong, and a slug that
 * matches nothing inlined is a hallucinated or forged name and is dropped. One
 * issue per skill — a reply that reports two wrong steps of one skill collapses
 * to the first, since routing patches the whole skill either way.
 */
export function reportedSkillIssues(assistantText: string, inlined: { slug: string }[]): SkillIssue[] {
  if (!assistantText || inlined.length === 0) return [];
  const known = new Map(inlined.map((s) => [s.slug.toLowerCase(), s.slug]));
  const seen = new Set<string>();
  const issues: SkillIssue[] = [];
  const marker = SKILL_ISSUE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The name may come back backticked, and the model may be tempted to add bold
  // around the whole line; both are tolerated so the signal survives formatting.
  const re = new RegExp(`^[\\s*_>-]*${marker}\\s*\\[\\s*\`?([a-z0-9][a-z0-9-]*)\`?\\s*\\]\\s*:\\s*(.*)$`, 'gim');
  for (const match of assistantText.matchAll(re)) {
    const slug = known.get(match[1].toLowerCase());
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const reason = match[2].replace(/^[*_`\s]+|[*_`\s]+$/g, '').trim().slice(0, SKILL_ISSUE_REASON_MAX);
    issues.push({ slug, reason });
  }
  return issues;
}
