import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { degrade } from '../degrade';
import { skillsRoot } from '../workspace/paths';
import { isRecallEnabled } from '../workspace/memory';
import type { LlmClient } from '../recall/llm';
import type { EmbeddingsClient } from '../recall/embeddings';
import { getEmbeddingsClient } from '../recall/retrieval';
import { dot, magnitude } from '../recall/vector';
import {
  MAX_SKILL_TOOLS,
  SKILL_CONTRACT_TEXT,
  SKILL_NAME_MAX,
  SKILL_SLUG_RE,
  formatViolations,
  holdableSkillTools,
  opensWithSituation,
  parseRecurrence,
  validateSkill,
  type SkillDraft,
  type SkillRecurrence
} from './contract';
import { DISABLED_MARKER, syncSkillsIgnore } from './ignore';
import { slowestRecurrence } from './lifecycle';
import { listSkillRecords, readSkillRecord, saveSkill, setSkillRecurrence, type SkillOrigin, type SkillRecord } from './store';
import { mergeUsage, pruneUsage, readUsage, type SkillsUsage } from './usage';
import { ensureSkillVectors } from './vectors';

// Level-2 cleanup for self-authored skills, mirroring recall/consolidate.ts for
// durable facts. Four operations, in this order:
//
//   estimate — a skill nobody has said a rhythm for gets one (see `estimateRecurrence`).
//   split    — a skill whose sections are different jobs becomes one skill per job.
//   merge    — two write-ups of the SAME job become one, and so does one procedure
//              written once per target (a "family", see below).
//   archive  — a skill another one has made redundant is switched off.
//
// One skill, one job (2026-10-10). This reverses the "umbrella" posture of
// SKILLS-UPKEEP.md's Defect 2, which merged by "would a maintainer write one skill
// with N labeled subsections?". That bar came from Hermes, where the model reads a
// skill index and opens the file it wants. Stem never lets the model choose: the
// user's message is ranked against each skill's one-sentence description, and only
// the winners are inlined. An umbrella's description has to cover every job inside
// it in 160 characters, so it matches each of them weakly and the wrong messages
// strongly. The server's library showed it: four umbrellas, each absorbing unrelated
// jobs ("trace claims, provenance, earliest evidence, or audience membership across
// studies, images, Slack, and authenticated applications"), behind both kinds of
// selection failure the 2026-10 audits found. Published work agrees: selection
// accuracy falls with semantic confusability between skills rather than with library
// size, and focused skills beat comprehensive ones (arXiv 2601.04748, 2602.12670).
//
// Families (2026-11-17). "One job" was read too narrowly by the merge prompt: it
// only merged a job written twice, so one procedure done for four apps stayed four
// skills. The server's library had `install-busycal-mcp-for-stem`,
// `connect-things-mcp-to-stem`, `install-davinci-resolve-mcp-for-stem` and
// `install-superwhisper-cli-for-stem` at 0.85 to 0.91 cosine to each other, the
// closest pairs in 86 skills, and five weeks of passes merged none of them. They
// are one job with a parameter, and the confusability the one-job rule exists to
// remove is highest exactly between such siblings. A family becomes one skill
// under a name for the general job, with what differs per target listed in it.
//
// The pass works on small groups, never the whole library at once. Splits look at
// one skill; merges look at one skill and its nearest neighbours by the same
// name+description vectors retrieval uses. The single whole-library prompt this
// replaces outgrew the completion timeout and failed every run from 2026-10-08.
// Only skills that changed since the last pass are looked at again (`.skills-curated.json`),
// so a quiet library costs no model call at all.
//
// Only Stem's own ideas are reshaped: skills saved in Auto mode (`assistant`, `turn`)
// and ones Stem proposed on a card the user accepted (`approved`). Everything the
// user brought or asked for — `user-requested`, `imported`, `learn`, `recorded` —
// is their unit of work and is never split, merged, archived or re-described. A
// merge group shows those read-only, so a Stem-written duplicate of one can still
// be archived in its favour.
//
// Body edits are otherwise not this pass's job. The assistant fixes a skill when it
// uses one and finds it wrong, which is when the evidence exists; a split or merge
// moves steps verbatim. Retiring unused skills is skills/lifecycle.ts's clock.
//
// Every skill a pass rewrites or deletes is copied first to
// `.curator-history/<run>/<slug>.md` (not SKILL.md, so pi never loads a backup).
// It ONLY ever touches agent-authored skills (metadata.stem.source === 'agent').

// Below this many agent skills an automatic pass isn't worth a model call.
const MIN_SKILLS = 3;
// Reject a run's retirements once they exceed this fraction of the set.
const MAX_DROP_FRACTION = 0.4;
/** Neighbours shown beside each changed skill in a merge group. */
const MERGE_NEIGHBOURS = 3;
/**
 * Neighbours below this cosine are not shown at all. Provisional: on the server's
 * library (EmbeddingGemma 2, 23 skills, no duplicates) the median pair sits at 0.64
 * and the closest at 0.755, so this admits each skill's few genuine neighbours and
 * keeps unrelated ones out of the prompt. A true duplicate scores far above it.
 */
const MERGE_MIN_COSINE = 0.7;
/** Most parts a split may produce. More than this is a reading error, not a skill. */
const MAX_SPLIT_PARTS = 4;
/**
 * A skill this close to another one is looked at once for a family, even when
 * neither changed since the last pass: libraries reviewed under the old merge
 * rule hold families that no later pass would return to. On the server's library
 * 12 of 3,655 pairs reach it and every pair of the install family does.
 */
const FAMILY_RECHECK_COSINE = 0.8;
/** Skills per recurrence-estimate call. Name, description and a usage line each. */
const ESTIMATE_BATCH = 40;
/** Backup runs kept in `.curator-history`. */
const HISTORY_KEEP = 10;

export const SKILLS_CURATED_FILE = '.skills-curated.json';
const HISTORY_DIR = '.curator-history';

export interface CurateResult {
  merged: number;
  archived: number;
  split: number;
}
const ZERO: CurateResult = { merged: 0, archived: 0, split: 0 };

interface AgentSkill {
  slug: string;
  name: string;
  description: string;
  origin: SkillOrigin;
  created: string;
  body: string;
  /** Tools whose calls hand the skill over; a merge keeps every member's. */
  tools: string[];
  recurs?: SkillRecurrence;
  /** Not Stem's own idea (see CURATED_ORIGINS): never split, merged, archived or re-described. */
  locked: boolean;
  useCount: number;
  lastUsedAt?: string;
  failCount: number;
  lastFailure?: { at: string; reason: string };
}

interface CurateOps {
  /** `name`: a family merged under a new name for the general job; absent keeps the first slug's. */
  merge: { slugs: string[]; description: string; content: string; name?: string }[];
  archive: string[];
}
const EMPTY_OPS: CurateOps = { merge: [], archive: [] };

type SplitVerdict =
  | { verdict: 'one'; description?: string }
  | { verdict: 'split'; skills: SkillDraft[] };

/**
 * The origins the curator may reshape: Stem's own ideas. `unknown` is a file from
 * before origins were recorded; every skill Stem wrote then came from its own
 * end-of-turn pass, so it counts as one.
 */
export const CURATED_ORIGINS: readonly SkillOrigin[] = ['assistant', 'turn', 'approved', 'unknown'];

const RETRIEVAL_NOTE = `How these skills are used: before every reply, the assistant matches the user's message against each skill's one-sentence description, and only the best matches are loaded. The description is the ONLY text that decides whether a skill is used. A skill must therefore be ONE job — one situation a user is in, one procedure from start to finish — with a description naming that situation. A description that has to cover several jobs matches each of them badly and matches the wrong messages instead.`;

const SPLIT_INSTRUCTIONS = `You review ONE skill from an assistant's library of reusable procedures.

${RETRIEVAL_NOTE}

Decide whether this skill is one job or several jobs filed together.
- Subsections are fine when they are variants of the SAME job: one download procedure with a part for playlists and a part for single videos is one job.
- They are separate jobs when someone in one situation would never need the other's steps: diagnosing a container's port mismatch and upgrading the container's image are two jobs, even on the same server with the same tools.

Return ONLY a JSON object (no prose, no markdown fences), one of:
{"verdict": "one"}
{"verdict": "one", "description": "<replacement description>"}
{"verdict": "split", "skills": [{"name": "...", "description": "...", "content": "<body>"}]}

"one" with a description: only when the current description breaks the rules below — it does not start with "Use when", or it describes more than the one job. Otherwise omit "description".

"split":
- 2 to ${MAX_SPLIT_PARTS} skills, one per job.
- The FIRST skill keeps the existing name, so put first the job that name describes best. Its "name" is ignored.
- Every other skill gets a new name, never one listed under "Names already taken".
- Each body stands alone: the three required headings, the steps of that one job, and its own verification. Copy a shared setup step (a login, a connection, a "this only works on the Mac" line) into every part that needs it.
- Move steps VERBATIM. Keep every exact command, argument, URL, path and trap. Do not improve, reword, or add steps: you cannot see whether they work.
- When unsure, answer "one". A wrong split is two half-skills; a missed one is fixed on a later pass.

The rules every skill follows:

${SKILL_CONTRACT_TEXT}`;

const MERGE_INSTRUCTIONS = `You check a small group of skills from an assistant's library of reusable procedures for skills that are ONE job written more than once.

${RETRIEVAL_NOTE}

Return ONLY a JSON object (no prose, no markdown fences) with this shape:
{
  "merge":   [{"slugs": ["winner-slug","loser-slug"], "description": "...", "content": "<combined body>"}],
  "archive": ["<slug>"]
}

merge — ONLY in these two cases:

1. Two or more write-ups of the SAME job.
- The test: would someone in the situation one skill describes follow the other skill's steps from start to finish? Then they are the same job written twice. Merge them.

2. One procedure written once per target (a family).
- The steps are the same from start to finish and only the particulars differ: which app, server, account, device or site. The test: put one skill's particulars into the other skill's steps. If that would have worked, they are one job with a parameter.
- Merge a family into ONE skill that gives the steps once, with the target as its input, and lists under the steps what differs per target: the exact commands, package names, ids, paths and traps of each one.
- Add "name" to the merge: a name for the general job, because no member's name fits it. Lowercase words joined by single hyphens, at most 64 characters, not the name of a skill listed below. The description names the general situation, not one target.
- When what differs per target does not fit beside the steps in 4096 bytes, do not merge.

Both cases:
- Sharing a tool, a service, a server, or a domain is NOT a reason to merge. Different jobs stay separate skills, each with its own description — that is what lets the right one be found. Installing an app and diagnosing that app are two jobs.
- Mechanics: the FIRST slug in "slugs" is kept, keeps its name, and is rewritten with your "description" and "content"; the rest are retired. With a "name", the merged skill is saved under that name and every slug listed is retired. List at least two slugs. Keep every exact command, argument and trap from all of them; drop only what is said twice.
- The merged body must be under 4096 bytes with the headings "## When to use", "## Steps", "## Verification", in that order, and the description must start "Use when". A merge that breaks a rule is rejected.

archive — DEFAULT TO KEEP:
- Only a skill made redundant by another skill in this group: it does the same job, and the other does it as well or better.
- Never archive a skill merely to make the library smaller, and never because of its usage count: "never used since tracking began" is absence of evidence, not evidence.

Both lists:
- A skill marked READ-ONLY is the user's own (they asked for it, imported it, taught it or recorded it). Never list it in "merge" or "archive". An agent-written skill that duplicates it may be archived in its favour.
- Do NOT reword a body you are keeping.
- Use ONLY the slugs listed below. Never invent one.
- If nothing is one job written more than once — the usual answer — return {"merge":[],"archive":[]}.`;

const ESTIMATE_INSTRUCTIONS = `You estimate, for each skill in an assistant's library of reusable procedures, how often its task comes up again. The assistant keeps an unused skill for several such periods before switching it off, so the estimate decides whether a slow task survives until its next run.

One answer per skill:
- "weekly": every week or more often.
- "monthly"
- "quarterly": a few times a year.
- "yearly": tied to the calendar, such as a tax return, an annual renewal or a yearly report.
- "occasional": no rhythm. It comes up when something breaks or the need arises.

Go by the description and the recorded use. A period named in the task itself (a monthly invoice, a quarterly statement) decides. Several uses spread over time show the rhythm. Answer "occasional" when nothing shows one; a longer period is not the safe guess.

Return ONLY a JSON object (no prose, no markdown fences), with every name listed below:
{"recurs": {"<skill name>": "<one of the five>"}}`;

// ---- library state ----

/** Over the text AND the origin: a relabel changes what the curator may do, so it is a change to review. */
function hashSkill(s: { name: string; description: string; body: string; origin: string }): string {
  return createHash('sha1').update(`${s.origin}\n${s.name}\n${s.description}\n${s.body}`).digest('hex').slice(0, 16);
}

interface CuratedState {
  version: 1;
  /** slug → hash of the skill as last reviewed. A mismatch means "look again". */
  seen: Record<string, string>;
  /** The one look at close neighbours for families has run (see FAMILY_RECHECK_COSINE). */
  families?: true;
}

function readCurated(): CuratedState {
  try {
    const parsed = JSON.parse(readFileSync(join(skillsRoot(), SKILLS_CURATED_FILE), 'utf8')) as Partial<CuratedState>;
    if (parsed?.version === 1 && parsed.seen && typeof parsed.seen === 'object') {
      return { version: 1, seen: parsed.seen, ...(parsed.families === true ? { families: true as const } : {}) };
    }
  } catch {
    // quiet: no state means every skill is reviewed once, which is the right answer for a first pass.
  }
  return { version: 1, seen: {} };
}

function writeCurated(state: CuratedState): void {
  try {
    writeFileSync(join(skillsRoot(), SKILLS_CURATED_FILE), JSON.stringify(state), 'utf8');
  } catch (error) {
    // The cost is reviewing the same skills again next pass — model calls, not damage.
    degrade('skills.curate', 'will review the same skills again next pass', error);
  }
}

/** Agent-authored, enabled skills. User-dropped and bundled ones are never read. */
function loadAgentSkills(usage: SkillsUsage): AgentSkill[] {
  return listSkillRecords()
    .filter((r) => r.source === 'agent' && r.enabled)
    .map((r: SkillRecord) => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      origin: r.origin,
      created: r.created,
      body: r.body,
      tools: r.tools,
      ...(r.recurs ? { recurs: r.recurs } : {}),
      locked: !CURATED_ORIGINS.includes(r.origin),
      useCount: usage.skills[r.slug]?.count ?? 0,
      lastUsedAt: usage.skills[r.slug]?.lastUsedAt,
      failCount: usage.skills[r.slug]?.failed ?? 0,
      lastFailure: usage.skills[r.slug]?.lastFailure
    }));
}

/** Labeled subsections under `## Steps` — the shape every umbrella on the server had. */
export function stepSubsections(body: string): number {
  // Not grade.ts's sectionText: that stops at the first heading of any level, so it
  // would end the Steps section at the very subsections being counted here.
  const start = body.search(/^##\s+Steps\s*$/im);
  if (start === -1) return 0;
  const rest = body.slice(start).replace(/^[^\n]*\n/, '');
  const end = rest.search(/^#{1,2}\s/m);
  return ((end === -1 ? rest : rest.slice(0, end)).match(/^###\s+\S/gm) ?? []).length;
}

/** Whether a skill is worth a split review: several labeled parts, or a description that breaks the rules. */
export function splitCandidate(skill: { body: string; description: string }): boolean {
  return stepSubsections(skill.body) >= 2 || !opensWithSituation(skill.description);
}

// ---- backups ----

export class History {
  private dir: string | null = null;
  private saved = new Set<string>();

  /** `label` names the run apart from the curator's own, e.g. "relabel". */
  constructor(private readonly label?: string) {}

  /** Copy a skill's current SKILL.md aside before it is rewritten or removed. Throws when it cannot. */
  keep(slug: string): void {
    if (this.saved.has(slug)) return;
    const root = skillsRoot();
    if (!this.dir) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      this.dir = join(root, HISTORY_DIR, this.label ? `${stamp}-${this.label}` : stamp);
      mkdirSync(this.dir, { recursive: true });
    }
    writeFileSync(join(this.dir, `${slug}.md`), readFileSync(join(root, slug, 'SKILL.md'), 'utf8'), 'utf8');
    this.saved.add(slug);
  }

  prune(): void {
    try {
      const base = join(skillsRoot(), HISTORY_DIR);
      const runs = readdirSync(base).sort();
      for (const old of runs.slice(0, Math.max(0, runs.length - HISTORY_KEEP))) rmSync(join(base, old), { recursive: true, force: true });
    } catch {
      // quiet: no history yet, or an old run that would not go — it is kept one more pass.
    }
  }
}

// ---- prompts and parsing ----

function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

function skillBlock(s: AgentSkill, opts: { readOnly?: boolean } = {}): string {
  const usage = s.useCount ? `used ${s.useCount}×, last ${isoDay(s.lastUsedAt ?? '')}` : 'never used since tracking began';
  // A reported failure is the assistant's own verdict on the body — the one thing
  // here that IS evidence about content, worth knowing when two write-ups overlap.
  const failures = s.failCount ? ` · reported wrong ${s.failCount}×${s.lastFailure ? `, last: ${s.lastFailure.reason}` : ''}` : '';
  const lock = opts.readOnly ? " · READ-ONLY (the user's own)" : '';
  return `## [${s.slug}] ${s.name}\n${s.description}\nCreated ${isoDay(s.created)} · ${usage}${failures}${lock}\n\n${s.body}`;
}

function buildSplitPrompt(skill: AgentSkill, taken: string[]): string {
  return `${SPLIT_INSTRUCTIONS}\n\nNames already taken: ${taken.join(', ')}\n\nThe skill:\n\n${skillBlock(skill)}`;
}

function buildMergePrompt(group: AgentSkill[], trackingSince: string): string {
  const header =
    `Today is ${isoDay(new Date().toISOString())}. Usage has been tracked since ${isoDay(trackingSince)} — ` +
    'a skill created before that date may have earlier uses that were never recorded.';
  const blocks = group.map((s) => skillBlock(s, { readOnly: s.locked })).join('\n\n---\n\n');
  return `${MERGE_INSTRUCTIONS}\n\n${header}\n\nSkills:\n\n${blocks}`;
}

function jsonObject(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch (error) {
    // A model that answered in prose produces the same "nothing to do" as a clean
    // library, and it will keep producing it every cycle.
    degrade('skills.curate', 'discarded the curator reply and made no changes', error);
    return null;
  }
}

/** Parse a split review. Anything malformed reads as "one job, leave it". */
export function parseSplit(output: string): SplitVerdict {
  const obj = jsonObject(output);
  if (obj?.verdict === 'split' && Array.isArray(obj.skills)) {
    const skills: SkillDraft[] = [];
    for (const s of obj.skills) {
      if (!s || typeof s !== 'object') continue;
      const { name, description, content } = s as Record<string, unknown>;
      if (typeof name === 'string' && typeof description === 'string' && typeof content === 'string' && content.trim()) {
        skills.push({ name: name.trim(), description: description.trim(), body: content.trim() });
      }
    }
    if (skills.length >= 2 && skills.length <= MAX_SPLIT_PARTS) return { verdict: 'split', skills };
    return { verdict: 'one' };
  }
  const description = typeof obj?.description === 'string' && obj.description.trim() ? obj.description.trim() : undefined;
  return description ? { verdict: 'one', description } : { verdict: 'one' };
}

/** Parse the model's reply into merge ops. Defensive: any malformation → no-op. */
export function parseCurate(output: string): CurateOps {
  const obj = jsonObject(output);
  if (!obj) return { ...EMPTY_OPS };
  const merge: CurateOps['merge'] = [];
  if (Array.isArray(obj.merge)) {
    for (const m of obj.merge) {
      if (!m || typeof m !== 'object') continue;
      const { slugs, description, content, name } = m as Record<string, unknown>;
      if (
        Array.isArray(slugs) &&
        slugs.every((s) => typeof s === 'string') &&
        slugs.length >= 2 &&
        typeof description === 'string' &&
        typeof content === 'string' &&
        content.trim()
      ) {
        // Only a family is renamed (MERGE_INSTRUCTIONS case 2); a same-job merge
        // keeps the winner's slug, which IS its name.
        merge.push({
          slugs: slugs as string[],
          description,
          content,
          ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {})
        });
      }
    }
  }
  const archive: string[] = [];
  if (Array.isArray(obj.archive)) {
    for (const s of obj.archive) if (typeof s === 'string') archive.push(s);
  }
  return { merge, archive };
}

/**
 * Drop ops that name slugs outside `known` (the group's writable skills), then
 * reject the whole batch if it would retire more than `budget` skills.
 */
export function clampCurate(ops: CurateOps, known: Set<string>, budget: number): CurateOps {
  const merge = ops.merge
    .map((m) => ({ ...m, slugs: [...new Set(m.slugs.filter((s) => known.has(s)))] }))
    .filter((m) => m.slugs.length >= 2);
  const merging = new Set(merge.flatMap((m) => m.slugs));
  const archive = [...new Set(ops.archive.filter((s) => known.has(s) && !merging.has(s)))];
  const wouldRetire = archive.length + merge.reduce((n, m) => n + (m.slugs.length - 1), 0);
  if (wouldRetire > budget) return { ...EMPTY_OPS };
  return { merge, archive };
}

/** Bound on what one run may retire: a fraction of the library, but always at least one. */
export function retireBudget(total: number): number {
  return Math.max(1, Math.floor(MAX_DROP_FRACTION * total));
}

// ---- applying ----

/** Validate every part of a split before anything is written. Returns the parts to write, or why not. */
export function checkSplit(
  original: { slug: string },
  parts: SkillDraft[],
  taken: Set<string>
): { ok: true; parts: SkillDraft[] } | { ok: false; why: string } {
  const named = parts.map((p, i) => (i === 0 ? { ...p, name: original.slug } : p));
  const seen = new Set<string>();
  for (const [i, part] of named.entries()) {
    if (i > 0 && (!SKILL_SLUG_RE.test(part.name) || taken.has(part.name) || seen.has(part.name))) {
      return { ok: false, why: `part name "${part.name}" is invalid or already taken` };
    }
    seen.add(part.name);
    const violations = validateSkill(part, { authored: true });
    if (violations.length) return { ok: false, why: `"${part.name}": ${formatViolations(violations)}` };
  }
  return { ok: true, parts: named };
}

function applySplit(skill: AgentSkill, parts: SkillDraft[], history: History): boolean {
  try {
    history.keep(skill.slug);
  } catch (error) {
    degrade('skills.curate', `left "${skill.slug}" unsplit because it could not be backed up first`, error);
    return false;
  }
  // New parts first: if a write fails partway, the original is still whole and the
  // worst case is a part that also exists inside it — a duplicate, not a loss.
  for (const part of parts.slice(1)) {
    const written = saveSkill(part, { origin: skill.origin });
    if (!written.ok) {
      console.warn(`[skills curator] split of "${skill.slug}" stopped at "${part.name}": ${written.error}`);
      return false;
    }
  }
  const first = saveSkill(parts[0], { origin: skill.origin, expectExisting: true });
  if (!first.ok) {
    console.warn(`[skills curator] split of "${skill.slug}" wrote its new parts but could not narrow the original: ${first.error}`);
    return false;
  }
  return true;
}

function applyDescription(skill: AgentSkill, description: string, history: History): boolean {
  const draft = { name: skill.slug, description, body: skill.body };
  const violations = validateSkill(draft, { authored: true });
  if (violations.length) {
    console.warn(`[skills curator] new description for "${skill.slug}" rejected: ${formatViolations(violations)}`);
    return false;
  }
  try {
    history.keep(skill.slug);
  } catch (error) {
    degrade('skills.curate', `kept the description of "${skill.slug}" because it could not be backed up first`, error);
    return false;
  }
  const written = saveSkill(draft, { origin: skill.origin, expectExisting: true });
  if (!written.ok) console.warn(`[skills curator] could not rewrite the description of "${skill.slug}": ${written.error}`);
  return written.ok;
}

/** Disable a skill (reversible) by writing the `.disabled` marker the app uses. */
function archiveSkill(slug: string): void {
  writeFileSync(join(skillsRoot(), slug, DISABLED_MARKER), 'archived by Stem curator\n', 'utf8');
}

function applyMerges(
  skills: AgentSkill[],
  ops: CurateOps,
  history: History
): { merged: number; archived: number; gone: string[] } {
  const bySlug = new Map(skills.map((s) => [s.slug, s]));
  let merged = 0;
  let archived = 0;
  const gone: string[] = [];

  for (const m of ops.merge) {
    const winner = bySlug.get(m.slugs[0]);
    if (!winner) continue;
    const members = m.slugs.map((slug) => bySlug.get(slug)).filter((x): x is AgentSkill => !!x);
    // A family is saved under a name for the general job. A name that is not a
    // free slug is dropped rather than refused: the merge is still right, and the
    // first member's name is a worse label, not a broken skill.
    const wanted = m.name && m.name !== winner.slug ? m.name : '';
    const renamed = !!wanted && SKILL_SLUG_RE.test(wanted) && wanted.length <= SKILL_NAME_MAX && !readSkillRecord(wanted);
    if (wanted && !renamed) console.warn(`[skills curator] merge into "${winner.slug}" kept that name: "${wanted}" is taken or not a valid name.`);
    const target = renamed ? wanted : winner.slug;
    const retired = renamed ? m.slugs : m.slugs.slice(1);
    // What the members carried besides their text goes with the merged skill:
    // every tool that handed one of them over, and the slowest rhythm among them.
    const tools = [...new Set(members.flatMap((s) => holdableSkillTools(s.tools)))].slice(0, MAX_SKILL_TOOLS);
    const recurs = slowestRecurrence(members.map((s) => s.recurs));
    const draft: SkillDraft = {
      name: target,
      description: m.description || winner.description,
      body: m.content,
      ...(tools.length ? { tools } : {}),
      ...(recurs ? { recurs } : {})
    };
    const violations = validateSkill(draft, { authored: true });
    if (violations.length) {
      // Said out loud: a rejected merge used to be indistinguishable from "nothing to merge".
      console.warn(`[skills curator] merge into "${target}" rejected (from: ${m.slugs.join(', ')}): ${formatViolations(violations)}`);
      continue;
    }
    try {
      for (const slug of m.slugs) history.keep(slug);
    } catch (error) {
      degrade('skills.curate', `left "${winner.slug}" unmerged because it could not be backed up first`, error);
      continue;
    }
    // The retired skills are only deleted once the merged one is safely on disk.
    const change = `Merged ${renamed ? 'from' : 'with'} ${retired.join(', ')}`;
    const written = renamed
      ? saveSkill(draft, { origin: winner.origin, change })
      : saveSkill(draft, { expectExisting: true, origin: 'unknown', change });
    if (!written.ok) {
      console.warn(`[skills curator] merge into "${target}" rejected (from: ${m.slugs.join(', ')}): ${written.error}`);
      continue;
    }
    try {
      for (const slug of retired) rmSync(join(skillsRoot(), slug), { recursive: true, force: true });
    } catch {
      // quiet: a skill left behind is a duplicate, not a broken library, and the
      // next pass sees it beside the one that now contains it.
    }
    // Proven utility survives the merge: the merged skill inherits the counts.
    mergeUsage(target, retired);
    gone.push(...retired);
    merged += 1;
  }

  for (const slug of ops.archive) {
    try {
      archiveSkill(slug);
      gone.push(slug);
      archived += 1;
    } catch (error) {
      // A marker the filesystem refused looks exactly like a pass that kept everything.
      console.warn(`[skills curator] could not archive "${slug}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { merged, archived, gone };
}

// ---- recurrence estimates ----

function buildEstimatePrompt(batch: AgentSkill[]): string {
  const lines = batch.map((s) => {
    const usage = s.useCount ? `used ${s.useCount}×, last ${isoDay(s.lastUsedAt ?? '')}` : 'never used';
    return `- ${s.slug}: ${s.description} (created ${isoDay(s.created)}, ${usage})`;
  });
  return `${ESTIMATE_INSTRUCTIONS}\n\nToday is ${isoDay(new Date().toISOString())}.\n\nSkills:\n${lines.join('\n')}`;
}

/** Read an estimate reply: name → rhythm. Null when the reply is not the JSON shape at all. */
export function parseEstimates(output: string): Map<string, SkillRecurrence> | null {
  const obj = jsonObject(output);
  if (!obj) return null;
  const out = new Map<string, SkillRecurrence>();
  const recurs = obj.recurs;
  if (recurs && typeof recurs === 'object') {
    for (const [slug, value] of Object.entries(recurs as Record<string, unknown>)) {
      const estimate = parseRecurrence(value);
      if (estimate) out.set(slug, estimate);
    }
  }
  return out;
}

/**
 * Give every skill without a rhythm an estimate of one (contract.ts
 * SkillRecurrence), so the lifecycle clock can wait as long as the task needs.
 *
 * New skills get theirs from whoever writes them (author.ts). This is for the
 * ones that have none: everything saved before the field existed, and writers
 * that left it out. It reads names, descriptions and usage only, a few calls for
 * a whole library, and writes Stem's own bookkeeping, never the skill's text —
 * which is why it also covers skills the user asked for or imported, which no
 * other step here touches. The user's own estimate, set in Manage, is never
 * asked about again: only an absent one is.
 *
 * A reply that answers for only some skills leaves the rest at `occasional`, the
 * window an absent estimate already had, so a model that cannot do this is asked
 * once per skill and not every night. A call that fails outright is tried again.
 */
async function estimateRecurrence(llm: LlmClient, skills: AgentSkill[]): Promise<number> {
  const missing = skills.filter((s) => !s.recurs);
  let written = 0;
  for (let at = 0; at < missing.length; at += ESTIMATE_BATCH) {
    const batch = missing.slice(at, at + ESTIMATE_BATCH);
    let estimates: Map<string, SkillRecurrence> | null;
    try {
      estimates = parseEstimates(await llm.complete(buildEstimatePrompt(batch)));
    } catch (error) {
      degrade('skills.curate', 'left some skills without an estimate of how often they are needed', error);
      continue;
    }
    if (!estimates) continue;
    for (const skill of batch) {
      const recurs = estimates.get(skill.slug) ?? 'occasional';
      if (setSkillRecurrence(skill.slug, recurs).ok) {
        skill.recurs = recurs;
        written += 1;
      }
    }
  }
  return written;
}

// ---- merge groups ----

/**
 * One group per changed skill: it and its nearest neighbours above
 * MERGE_MIN_COSINE. Groups with nothing writable to decide, and groups another
 * group already contains, are dropped. No embeddings → no groups (the merge step
 * waits for a pass that has them; create-time dedup in dedup.ts is the first net).
 */
export async function mergeGroups(
  skills: AgentSkill[],
  changed: Set<string>,
  embeddings: EmbeddingsClient | null = getEmbeddingsClient()
): Promise<AgentSkill[][]> {
  return (await rankedGroups(skills, changed, embeddings)) ?? [];
}

/**
 * `mergeGroups`, told apart from "could not rank": null when there were no
 * embeddings to rank with, so the caller knows the look did not happen.
 *
 * `familyFloor` widens the pass for the one family look (FAMILY_RECHECK_COSINE):
 * a skill that did not change still gets its group when its nearest neighbour is
 * at least that close.
 */
async function rankedGroups(
  skills: AgentSkill[],
  changed: Set<string>,
  embeddings: EmbeddingsClient | null,
  opts: { familyFloor?: number } = {}
): Promise<AgentSkill[][] | null> {
  if (!embeddings) return null;
  if (skills.length < 2 || (changed.size === 0 && opts.familyFloor === undefined)) return [];
  try {
    if (!(await embeddings.available())) return null;
    const model = await embeddings.modelId();
    if (!model) return null;
    const vectors = await ensureSkillVectors(skills, { model, embed: (texts) => embeddings.embed(texts, 'passage') });
    const groups: AgentSkill[][] = [];
    const keys: Set<string>[] = [];
    for (const skill of skills) {
      if (!changed.has(skill.slug) && opts.familyFloor === undefined) continue;
      const v = vectors.get(skill.slug);
      if (!v) continue;
      const mag = magnitude(v) || 1;
      const ranked = skills
        .filter((o) => o.slug !== skill.slug)
        .map((o) => {
          const w = vectors.get(o.slug);
          return { o, cos: w && w.length === v.length ? dot(v, w) / (mag * (magnitude(w) || 1)) : -1 };
        })
        .filter((x) => x.cos >= MERGE_MIN_COSINE)
        .sort((a, b) => b.cos - a.cos)
        .slice(0, MERGE_NEIGHBOURS);
      if (!changed.has(skill.slug) && !((ranked[0]?.cos ?? -1) >= (opts.familyFloor ?? Infinity))) continue;
      const near = ranked.map((x) => x.o);
      const group = [skill, ...near];
      if (group.length < 2 || group.filter((s) => !s.locked).length === 0) continue;
      const key = new Set(group.map((s) => s.slug));
      if (keys.some((k) => [...key].every((s) => k.has(s)))) continue;
      groups.push(group);
      keys.push(key);
    }
    return groups;
  } catch (error) {
    degrade('skills.curate', 'skipped looking for duplicate skills this pass', error);
    return null;
  }
}

// ---- the pass ----

/**
 * Run one curation pass over the agent-authored skills. Returns counts of what
 * changed (all zero when nothing ran or nothing needed changing). The caller
 * reloads the backend when any count is non-zero so pi picks up the new files.
 * `force` (the Tidy up button) reviews every skill, not only the changed ones.
 */
export async function curateSkills(
  llm: LlmClient,
  opts: { force?: boolean; embeddings?: EmbeddingsClient | null } = {}
): Promise<CurateResult> {
  if (!isRecallEnabled()) return ZERO;
  const usage = readUsage();
  let skills = loadAgentSkills(usage);
  if (skills.length < (opts.force ? 1 : MIN_SKILLS)) return ZERO;

  const state = readCurated();
  const isChanged = (s: AgentSkill): boolean => opts.force === true || state.seen[s.slug] !== hashSkill(s);
  // Slugs whose review failed (the model call threw) stay unseen, so the next pass tries again.
  const failed = new Set<string>();
  const history = new History();
  const result: CurateResult = { ...ZERO };
  let budget = retireBudget(skills.length);

  // 0. Estimate. Bookkeeping only, so it does not count as a change to review.
  const estimated = await estimateRecurrence(llm, skills);
  if (estimated) console.info(`[skills curator] estimated how often ${estimated} skill${estimated === 1 ? ' is' : 's are'} needed`);

  // 1. Split. One skill per call.
  for (const skill of skills.filter((s) => isChanged(s) && splitCandidate(s))) {
    if (skill.locked) continue;
    const taken = listSkillRecords().map((r) => r.slug);
    const prompt = buildSplitPrompt(skill, taken);
    let verdict: SplitVerdict;
    let checked: ReturnType<typeof checkSplit> | null = null;
    try {
      verdict = parseSplit(await llm.complete(prompt));
      // One retry with the exact reasons, the way authoring retries: a split that
      // broke a rule is usually one bad name or one oversized part.
      if (verdict.verdict === 'split') {
        checked = checkSplit(skill, verdict.skills, new Set(taken));
        if (!checked.ok) {
          verdict = parseSplit(await llm.complete(`${prompt}\n\n---\n\nYour previous answer was rejected: ${checked.why}\nFix it and reply again with the same JSON shape.`));
          checked = verdict.verdict === 'split' ? checkSplit(skill, verdict.skills, new Set(taken)) : null;
        }
      }
    } catch (error) {
      degrade('skills.curate', `left "${skill.slug}" as it is this pass`, error);
      failed.add(skill.slug);
      continue;
    }
    if (verdict.verdict === 'split' && checked) {
      if (!checked.ok) {
        console.warn(`[skills curator] split of "${skill.slug}" rejected: ${checked.why}`);
        continue;
      }
      if (applySplit(skill, checked.parts, history)) result.split += 1;
    } else if (verdict.verdict === 'one' && verdict.description && verdict.description !== skill.description) {
      applyDescription(skill, verdict.description, history);
    }
  }

  // 2. Merge and archive, on the library as the splits left it.
  skills = loadAgentSkills(readUsage());
  const changed = new Set(skills.filter(isChanged).map((s) => s.slug));
  const gone = new Set<string>();
  // The one look for families among skills earlier passes already reviewed. It is
  // marked done only when it ran in full: no embeddings, or a call that failed,
  // leaves it for the next pass.
  const familyLook = !state.families && !opts.force;
  let familiesDone = state.families === true;
  const groups = await rankedGroups(
    skills,
    changed,
    opts.embeddings === undefined ? getEmbeddingsClient() : opts.embeddings,
    familyLook ? { familyFloor: FAMILY_RECHECK_COSINE } : {}
  );
  if (groups && (familyLook || opts.force)) familiesDone = true;
  for (const group of groups ?? []) {
    const live = group.filter((s) => !gone.has(s.slug));
    if (live.length < 2 || live.every((s) => s.locked)) continue;
    let ops: CurateOps;
    try {
      ops = parseCurate(await llm.complete(buildMergePrompt(live, usage.trackingSince)));
    } catch (error) {
      degrade('skills.curate', 'skipped one group of similar skills this pass', error);
      for (const s of live) if (changed.has(s.slug)) failed.add(s.slug);
      if (familyLook) familiesDone = false;
      continue;
    }
    const writable = new Set(live.filter((s) => !s.locked).map((s) => s.slug));
    const clamped = clampCurate(ops, writable, budget);
    if (ops.merge.length + ops.archive.length > 0 && clamped.merge.length + clamped.archive.length === 0) {
      console.warn('[skills curator] a group\'s changes were refused: they named read-only skills or would retire too much.');
    }
    const applied = applyMerges(live, clamped, history);
    result.merged += applied.merged;
    result.archived += applied.archived;
    for (const s of applied.gone) gone.add(s);
    budget -= clamped.archive.length + clamped.merge.reduce((n, m) => n + m.slugs.length - 1, 0);
  }

  // Republish the ignore file once: merges delete losers and archives add markers.
  if (result.merged || result.archived) syncSkillsIgnore();
  // Drop usage entries for skills deleted above or removed out-of-band.
  pruneUsage();
  history.prune();

  // Everything now on disk counts as reviewed, apart from what a failed call left unread.
  const seen: Record<string, string> = {};
  for (const s of loadAgentSkills(readUsage())) {
    if (!failed.has(s.slug)) seen[s.slug] = hashSkill(s);
  }
  writeCurated({ version: 1, seen, ...(familiesDone ? { families: true as const } : {}) });
  return result;
}
