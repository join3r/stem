import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { degrade } from '../degrade';
import { skillsRoot } from '../workspace/paths';
import type { SettledTurnTrace, TraceEntry } from '../pi/normalize';

// The case file: what happened each time a skill was used, and how the user took
// the result.
//
// Before this, Stem knew only that a skill was used (a tool-overlap proxy,
// grade.ts) and, rarely, that the model itself called a step wrong (17 reports in
// 527 loads on the server, 2026-11). It never knew whether the user accepted
// what came out. Every change to a skill was therefore judged on one turn, and a
// change that fixed today's case could break the last five without anyone
// noticing. Published work on self-changing skills says the same thing from the
// other side: most automatic rewrites are not better than the text they replace
// (55 of 388 in arXiv 2608.02636), and the ones that are better were chosen by a
// check against stored cases, built from failures as well as successes.
//
// So each use leaves a case: the request, what the assistant did, the start of
// its reply, and later an outcome read off the user's next message. The outcome
// rides on the memory distill call that reads that message anyway (distill.ts),
// so it costs no model call of its own. Three things read the cases:
//
//   - a correction routes a patch to the skill that was corrected (startup/skills.ts);
//   - every automatic change is checked against them before it is written (review.ts);
//   - a skill that keeps going wrong is rewritten from all of them at once.
//
// Sidecar, not front-matter, for the reasons usage.ts gives: a SKILL.md write
// reloads the backend, and this changes on most turns that use a skill.
//
// Privacy follows memory. A case holds the user's words, so it is written only
// where memory would keep the turn: not for a private chat, a memorize:false
// folder, a persona without memory, a scheduled run, or with memory off (the
// caller checks that). Deleting a chat drops its cases.

export const SKILLS_CASES_FILE = '.skills-cases.json';
const CASES_VERSION = 1;

/** Cases kept per skill, newest last. Enough to check a change against; old ones stop being evidence. */
export const CASES_KEPT = 12;
/** Failed uses since the last rewrite that make a skill due for one. */
export const REWRITE_AFTER_FAILURES = 3;
/** A use with no next message after this long will never get one. */
export const CASE_PENDING_MAX_MS = 14 * 86_400_000;

const REQUEST_MAX = 500;
const REPLY_MAX = 500;
const DID_MAX = 600;
const DID_ENTRY_MAX = 140;
export const FEEDBACK_MAX = 400;

/**
 * How a use ended.
 *   pending   — no next message read yet.
 *   accepted  — the user went on without complaint, or approved.
 *   corrected — the user said what was wrong or should be done differently.
 *   redone    — the user asked for the same thing again because it did not work.
 *   reported  — the model itself said a loaded step was wrong (grade.ts).
 *   unclear   — the next message said nothing about the result.
 *   expired   — no next message came.
 */
export type CaseOutcome = 'pending' | 'accepted' | 'corrected' | 'redone' | 'reported' | 'unclear' | 'expired';
export const FAILED_OUTCOMES: ReadonlySet<CaseOutcome> = new Set(['corrected', 'redone', 'reported']);

export interface SkillCase {
  threadId: string;
  turnId: string;
  /** When the turn ended, ISO. */
  at: string;
  /** The skill's version when it was used. */
  version: number;
  request: string;
  /** The tool calls, one short line each. */
  did: string;
  /** The start of the reply. */
  reply: string;
  outcome: CaseOutcome;
  /** What the user (or the model's report) said was wrong, in English. */
  feedback?: string;
  gradedAt?: string;
  /** A correction already sent to the patch path, so it is sent once. */
  routed?: true;
}

interface SkillCaseMeta {
  /** The last rewrite from all cases; failures before it are spent. */
  rewrittenAt?: string;
}

interface CasesFile {
  version: number;
  skills: Record<string, SkillCase[]>;
  meta: Record<string, SkillCaseMeta>;
}

function casesPath(): string {
  return join(skillsRoot(), SKILLS_CASES_FILE);
}

function empty(): CasesFile {
  return { version: CASES_VERSION, skills: {}, meta: {} };
}

const OUTCOMES: ReadonlySet<string> = new Set(['pending', 'accepted', 'corrected', 'redone', 'reported', 'unclear', 'expired']);

/**
 * Tolerant read, like the usage sidecar: a missing file is an empty one, and a
 * corrupt one is kept aside and started over (the cases are evidence, not state
 * anything depends on to run).
 */
function readFile(): CasesFile {
  let raw: string;
  try {
    raw = readFileSync(casesPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') degrade('skills.cases', 'read no skill cases', error);
    return empty();
  }
  try {
    const data = JSON.parse(raw) as Partial<CasesFile> | null;
    if (!data || data.version !== CASES_VERSION || typeof data.skills !== 'object' || !data.skills) return empty();
    const skills: Record<string, SkillCase[]> = {};
    for (const [slug, list] of Object.entries(data.skills)) {
      if (!Array.isArray(list)) continue;
      const clean = list.filter(
        (c): c is SkillCase =>
          !!c && typeof c === 'object' && typeof c.threadId === 'string' && typeof c.turnId === 'string' &&
          typeof c.at === 'string' && OUTCOMES.has(c.outcome)
      );
      if (clean.length > 0) skills[slug] = clean;
    }
    const meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
    return { version: CASES_VERSION, skills, meta };
  } catch (error) {
    try {
      writeFileSync(`${casesPath()}.corrupt`, raw, 'utf8');
    } catch (writeError) {
      degrade('skills.cases', 'kept no copy of the corrupt cases file', writeError);
    }
    degrade('skills.cases', 'started the skill cases over', error);
    return empty();
  }
}

function writeFile(file: CasesFile): void {
  const path = casesPath();
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 1)}\n`, 'utf8');
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    degrade('skills.cases', 'dropped a skill case update', error);
  }
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The tool calls as short lines: name, the start of the arguments, a FAILED mark. */
export function describeTrace(trace: readonly TraceEntry[]): string {
  if (trace.length === 0) return '(no tool calls)';
  const lines: string[] = [];
  let total = 0;
  for (const [i, entry] of trace.entries()) {
    const line = clip(`${i + 1}. ${entry.name ?? 'tool'}${entry.args ? ` ${entry.args}` : ''}${entry.isError ? ' → FAILED' : ''}`, DID_ENTRY_MAX);
    if (total + line.length > DID_MAX) {
      lines.push(`… ${trace.length - i} more`);
      break;
    }
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join('\n');
}

/** Close pending cases that waited too long for a next message. Mutates `file`. */
function expireStale(file: CasesFile, now: number): void {
  for (const list of Object.values(file.skills)) {
    for (const c of list) {
      if (c.outcome === 'pending' && now - Date.parse(c.at) > CASE_PENDING_MAX_MS) c.outcome = 'expired';
    }
  }
}

/**
 * Record one case per skill the settled turn followed or reported. `versions`
 * gives each skill's current version (the caller reads the records, so this
 * module stays free of the store).
 *
 * Followed skills start `pending`; a reported one is already a failure, with the
 * model's own words as the feedback.
 */
export function recordSkillCases(turn: SettledTurnTrace, versions: ReadonlyMap<string, number>, now = Date.now()): number {
  if (turn.memoryTainted || turn.isScheduled || turn.noRecall) return 0;
  const reported = new Map((turn.skillsReported ?? []).map((i) => [i.slug, i.reason]));
  const slugs = [...new Set([...turn.skillsGradedUsed, ...reported.keys()])].filter((s) => versions.has(s));
  if (slugs.length === 0) return 0;
  const file = readFile();
  expireStale(file, now);
  const at = new Date(turn.endedAt || now).toISOString();
  const base = {
    threadId: turn.threadId,
    turnId: turn.turnId,
    at,
    request: clip(turn.userText, REQUEST_MAX),
    did: describeTrace(turn.trace),
    reply: clip(turn.assistantText, REPLY_MAX)
  };
  for (const slug of slugs) {
    const list = (file.skills[slug] ?? []).filter((c) => !(c.threadId === turn.threadId && c.turnId === turn.turnId));
    const reason = reported.get(slug);
    list.push({
      ...base,
      version: versions.get(slug) ?? 1,
      ...(reason !== undefined
        ? { outcome: 'reported' as const, feedback: clip(reason || 'a step was wrong', FEEDBACK_MAX), gradedAt: new Date(now).toISOString() }
        : { outcome: 'pending' as const })
    });
    file.skills[slug] = list.slice(-CASES_KEPT);
  }
  writeFile(file);
  return slugs.length;
}

/** Every kept case of one skill, oldest first. */
export function casesFor(slug: string): SkillCase[] {
  return readFile().skills[slug] ?? [];
}

/** Counts per outcome, for Manage. */
export function caseCounts(slug: string, file: CasesFile = readFile()): Partial<Record<CaseOutcome, number>> {
  const counts: Partial<Record<CaseOutcome, number>> = {};
  for (const c of file.skills[slug] ?? []) counts[c.outcome] = (counts[c.outcome] ?? 0) + 1;
  return counts;
}

/** Counts for every skill in one read (listSkills calls this once per panel load). */
export function allCaseCounts(): Map<string, Partial<Record<CaseOutcome, number>>> {
  const file = readFile();
  return new Map(Object.keys(file.skills).map((slug) => [slug, caseCounts(slug, file)]));
}

// ---- outcomes, read off the next user message (distill.ts) ----

/** The fields of a stored message this module needs. */
export interface CaseMessage {
  id: number;
  threadId: string;
  turnId: string | null;
  role: string;
  /** Unix seconds. */
  ts: number;
}

/** One case put to the distill model, keyed by a small number the prompt cites. */
export interface ListedCase {
  key: number;
  slug: string;
  threadId: string;
  turnId: string;
  request: string;
  reply: string;
  /** The user's next message in the thread, as it appears in the transcript. */
  nextMessageId: number;
}

/**
 * The pending cases whose next user message is in this batch of messages.
 *
 * The next message is the first user message in the same thread, from another
 * turn, captured after the case's turn ended. A case is always written at the
 * end of its turn, before the next message can be captured, and the distiller
 * reads messages in order, so the first such message it sees is the right one.
 * Cases past `max` are returned as `overflow`: their next message is in this
 * batch too, so they will never meet it again, and they close as unclear.
 */
export function casesAwaitingVerdict(
  messages: readonly CaseMessage[],
  max: number
): { listed: ListedCase[]; overflow: Array<{ slug: string; threadId: string; turnId: string }> } {
  const users = messages.filter((m) => m.role === 'user').sort((a, b) => a.id - b.id);
  if (users.length === 0) return { listed: [], overflow: [] };
  const file = readFile();
  const listed: ListedCase[] = [];
  const overflow: Array<{ slug: string; threadId: string; turnId: string }> = [];
  for (const [slug, list] of Object.entries(file.skills)) {
    for (const c of list) {
      if (c.outcome !== 'pending') continue;
      const ended = Date.parse(c.at);
      // `ts` is whole seconds, so allow the second it was rounded down from.
      const next = users.find((m) => m.threadId === c.threadId && m.turnId !== c.turnId && m.ts * 1000 >= ended - 1000);
      if (!next) continue;
      if (listed.length < max) {
        listed.push({ key: listed.length + 1, slug, threadId: c.threadId, turnId: c.turnId, request: c.request, reply: c.reply, nextMessageId: next.id });
      } else {
        overflow.push({ slug, threadId: c.threadId, turnId: c.turnId });
      }
    }
  }
  return { listed, overflow };
}

export interface SkillOutcomeGrade {
  key: number;
  outcome: 'accepted' | 'corrected' | 'redone' | 'unclear';
  feedback?: string;
}

/**
 * Store the distill model's verdicts. A listed case the model left out, and
 * every overflow case, closes as `unclear`: its next message has been read, so
 * waiting longer would only pair it with a later, unrelated one.
 * Returns how many cases ended as failures.
 */
export function applySkillOutcomes(
  listed: readonly ListedCase[],
  grades: readonly SkillOutcomeGrade[],
  overflow: ReadonlyArray<{ slug: string; threadId: string; turnId: string }> = [],
  now = Date.now()
): { graded: number; failed: number } {
  if (listed.length === 0 && overflow.length === 0) return { graded: 0, failed: 0 };
  const byKey = new Map(grades.map((g) => [g.key, g]));
  const file = readFile();
  const iso = new Date(now).toISOString();
  let graded = 0;
  let failed = 0;
  const close = (slug: string, threadId: string, turnId: string, grade?: SkillOutcomeGrade) => {
    const c = file.skills[slug]?.find((x) => x.threadId === threadId && x.turnId === turnId && x.outcome === 'pending');
    if (!c) return;
    c.outcome = grade?.outcome ?? 'unclear';
    c.gradedAt = iso;
    if (grade?.feedback && (c.outcome === 'corrected' || c.outcome === 'redone')) c.feedback = clip(grade.feedback, FEEDBACK_MAX);
    if (grade) graded += 1;
    if (FAILED_OUTCOMES.has(c.outcome)) failed += 1;
  };
  for (const l of listed) close(l.slug, l.threadId, l.turnId, byKey.get(l.key));
  for (const o of overflow) close(o.slug, o.threadId, o.turnId);
  expireStale(file, now);
  writeFile(file);
  return { graded, failed };
}

// ---- routing: corrections to patches, repeated failures to a rewrite ----

export interface CaseCorrection {
  slug: string;
  threadId: string;
  turnId: string;
  outcome: 'corrected' | 'redone';
  feedback: string;
}

/** Corrections not yet sent to the patch path, oldest first. */
export function correctionsToRoute(): CaseCorrection[] {
  const out: Array<CaseCorrection & { at: string }> = [];
  for (const [slug, list] of Object.entries(readFile().skills)) {
    for (const c of list) {
      if ((c.outcome === 'corrected' || c.outcome === 'redone') && !c.routed) {
        out.push({ slug, threadId: c.threadId, turnId: c.turnId, outcome: c.outcome, feedback: c.feedback ?? '', at: c.at });
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).map(({ at: _at, ...rest }) => rest);
}

/** Mark corrections as sent, so a restart or the next pass does not send them again. */
export function markRouted(refs: ReadonlyArray<{ slug: string; turnId: string }>): void {
  if (refs.length === 0) return;
  const file = readFile();
  for (const r of refs) {
    for (const c of file.skills[r.slug] ?? []) if (c.turnId === r.turnId) c.routed = true;
  }
  writeFile(file);
}

/** Failed uses of `slug` since its last rewrite. */
export function failuresSinceRewrite(slug: string, file: CasesFile = readFile()): SkillCase[] {
  const since = file.meta[slug]?.rewrittenAt ?? '';
  return (file.skills[slug] ?? []).filter((c) => FAILED_OUTCOMES.has(c.outcome) && c.at > since);
}

/** Skills with REWRITE_AFTER_FAILURES or more failed uses since their last rewrite. */
export function skillsDueForRewrite(): string[] {
  const file = readFile();
  return Object.keys(file.skills).filter((slug) => failuresSinceRewrite(slug, file).length >= REWRITE_AFTER_FAILURES);
}

/**
 * Spend the failures behind a rewrite, whether it was written or not. A rewrite
 * the check refused, or that the author declined, is a verdict on these cases
 * too; asking again needs new failures, not the same ones.
 */
export function markRewritten(slug: string, now = Date.now()): void {
  const file = readFile();
  file.meta[slug] = { ...file.meta[slug], rewrittenAt: new Date(now).toISOString() };
  writeFile(file);
}

// ---- upkeep ----

/** Drop every case from one chat. Called when the chat is deleted. */
export function dropThreadCases(threadId: string): void {
  const file = readFile();
  let changed = false;
  for (const [slug, list] of Object.entries(file.skills)) {
    const kept = list.filter((c) => c.threadId !== threadId);
    if (kept.length === list.length) continue;
    changed = true;
    if (kept.length > 0) file.skills[slug] = kept;
    else delete file.skills[slug];
  }
  if (changed) writeFile(file);
}

/** Drop the cases of skills that no longer exist on disk. */
export function pruneCases(): void {
  if (!existsSync(casesPath())) return;
  const file = readFile();
  let changed = false;
  for (const slug of Object.keys(file.skills)) {
    if (existsSync(join(skillsRoot(), slug, 'SKILL.md'))) continue;
    delete file.skills[slug];
    delete file.meta[slug];
    changed = true;
  }
  if (changed) writeFile(file);
}
