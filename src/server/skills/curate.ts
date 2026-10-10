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
import { SKILL_CONTRACT_TEXT, SKILL_SLUG_RE, formatViolations, opensWithSituation, validateSkill, type SkillDraft } from './contract';
import { DISABLED_MARKER, syncSkillsIgnore } from './ignore';
import { listSkillRecords, saveSkill, type SkillOrigin, type SkillRecord } from './store';
import { mergeUsage, pruneUsage, readUsage, type SkillsUsage } from './usage';
import { ensureSkillVectors } from './vectors';

// Level-2 cleanup for self-authored skills, mirroring recall/consolidate.ts for
// durable facts. Three operations, in this order:
//
//   split   — a skill whose sections are different jobs becomes one skill per job.
//   merge   — two write-ups of the SAME job become one.
//   archive — a skill another one has made redundant is switched off.
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
// The pass works on small groups, never the whole library at once. Splits look at
// one skill; merges look at one skill and its nearest neighbours by the same
// name+description vectors retrieval uses. The single whole-library prompt this
// replaces outgrew the completion timeout and failed every run from 2026-10-08.
// Only skills that changed since the last pass are looked at again (`.skills-curated.json`),
// so a quiet library costs no model call at all.
//
// Recorded skills (the user demonstrated them) and /learn skills (the user chose
// that chat as one lesson) are the user's own unit of work: never split, merged or
// archived. A merge group shows them read-only, so an agent-written duplicate of one
// can still be archived in its favour. A /learn description that breaks the
// authoring rules may be rewritten — the description only, never the body.
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
  /** Recorded or /learn: never split, merged or archived. */
  locked: boolean;
  useCount: number;
  lastUsedAt?: string;
  failCount: number;
  lastFailure?: { at: string; reason: string };
}

interface CurateOps {
  merge: { slugs: string[]; description: string; content: string }[];
  archive: string[];
}
const EMPTY_OPS: CurateOps = { merge: [], archive: [] };

type SplitVerdict =
  | { verdict: 'one'; description?: string }
  | { verdict: 'split'; skills: SkillDraft[] };

const LOCKED_ORIGINS: readonly SkillOrigin[] = ['recorded', 'learn'];

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

const LOCKED_DESCRIPTION_INSTRUCTIONS = `You review the description of ONE skill from an assistant's library of reusable procedures. The user made this skill themselves, so its body and name stay exactly as they are.

${RETRIEVAL_NOTE}

Return ONLY a JSON object (no prose, no markdown fences):
{"verdict": "one", "description": "<replacement description>"}
The replacement is ONE sentence of at most 160 characters, starting "Use when", naming the situation in which someone needs this procedure. Never restate the name. Do not return anything else.`;

const MERGE_INSTRUCTIONS = `You check a small group of skills from an assistant's library of reusable procedures for DUPLICATES.

${RETRIEVAL_NOTE}

Return ONLY a JSON object (no prose, no markdown fences) with this shape:
{
  "merge":   [{"slugs": ["winner-slug","loser-slug"], "description": "...", "content": "<combined body>"}],
  "archive": ["<slug>"]
}

merge — ONLY two or more write-ups of the SAME job:
- The test: would someone in the situation one skill describes follow the other skill's steps from start to finish? Then they are the same job written twice. Merge them.
- Sharing a tool, a service, a server, or a domain is NOT a reason to merge. Different jobs stay separate skills, each with its own description — that is what lets the right one be found.
- Mechanics: the FIRST slug in "slugs" is kept, keeps its name, and is rewritten with your "description" and "content"; the rest are retired. List at least two slugs. Keep every exact command, argument and trap from both; drop only what is said twice.
- The merged body must be under 4096 bytes with the headings "## When to use", "## Steps", "## Verification", in that order, and the description must start "Use when". A merge that breaks a rule is rejected.

archive — DEFAULT TO KEEP:
- Only a skill made redundant by another skill in this group: it does the same job, and the other does it as well or better.
- Never archive a skill merely to make the library smaller, and never because of its usage count: "never used since tracking began" is absence of evidence, not evidence.

Both lists:
- A skill marked READ-ONLY was made by the user (recorded or taught from a chat). Never list it in "merge" or "archive". An agent-written skill that duplicates it may be archived in its favour.
- Do NOT reword a body you are keeping.
- Use ONLY the slugs listed below. Never invent one.
- If nothing is a duplicate — the usual answer — return {"merge":[],"archive":[]}.`;

// ---- library state ----

function hashSkill(s: { name: string; description: string; body: string }): string {
  return createHash('sha1').update(`${s.name}\n${s.description}\n${s.body}`).digest('hex').slice(0, 16);
}

interface CuratedState {
  version: 1;
  /** slug → hash of the skill as last reviewed. A mismatch means "look again". */
  seen: Record<string, string>;
}

function readCurated(): CuratedState {
  try {
    const parsed = JSON.parse(readFileSync(join(skillsRoot(), SKILLS_CURATED_FILE), 'utf8')) as Partial<CuratedState>;
    if (parsed?.version === 1 && parsed.seen && typeof parsed.seen === 'object') return { version: 1, seen: parsed.seen };
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
      locked: LOCKED_ORIGINS.includes(r.origin),
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

class History {
  private dir: string | null = null;
  private saved = new Set<string>();

  /** Copy a skill's current SKILL.md aside before it is rewritten or removed. Throws when it cannot. */
  keep(slug: string): void {
    if (this.saved.has(slug)) return;
    const root = skillsRoot();
    if (!this.dir) {
      this.dir = join(root, HISTORY_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
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
  const lock = opts.readOnly ? ' · READ-ONLY (made by the user)' : '';
  return `## [${s.slug}] ${s.name}\n${s.description}\nCreated ${isoDay(s.created)} · ${usage}${failures}${lock}\n\n${s.body}`;
}

function buildSplitPrompt(skill: AgentSkill, taken: string[]): string {
  if (skill.locked) return `${LOCKED_DESCRIPTION_INSTRUCTIONS}\n\nThe skill:\n\n${skillBlock(skill)}`;
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
      const { slugs, description, content } = m as Record<string, unknown>;
      if (
        Array.isArray(slugs) &&
        slugs.every((s) => typeof s === 'string') &&
        slugs.length >= 2 &&
        typeof description === 'string' &&
        typeof content === 'string' &&
        content.trim()
      ) {
        // A merge never renames: the winner's slug IS its name, and a rename
        // would mean a new directory rather than a merge.
        merge.push({ slugs: slugs as string[], description, content });
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

function applyMerges(skills: AgentSkill[], ops: CurateOps, history: History): { merged: number; archived: number } {
  const bySlug = new Map(skills.map((s) => [s.slug, s]));
  let merged = 0;
  let archived = 0;

  for (const m of ops.merge) {
    const [winnerSlug, ...losers] = m.slugs;
    const winner = bySlug.get(winnerSlug);
    if (!winner) continue;
    const draft = { name: winnerSlug, description: m.description || winner.description, body: m.content };
    const violations = validateSkill(draft, { authored: true });
    if (violations.length) {
      // Said out loud: a rejected merge used to be indistinguishable from "nothing to merge".
      console.warn(`[skills curator] merge into "${winnerSlug}" rejected (losers: ${losers.join(', ')}): ${formatViolations(violations)}`);
      continue;
    }
    try {
      for (const slug of m.slugs) history.keep(slug);
    } catch (error) {
      degrade('skills.curate', `left "${winnerSlug}" unmerged because it could not be backed up first`, error);
      continue;
    }
    // Losers are only deleted once the winner is safely on disk.
    const written = saveSkill(draft, { expectExisting: true, origin: 'unknown' });
    if (!written.ok) {
      console.warn(`[skills curator] merge into "${winnerSlug}" rejected (losers: ${losers.join(', ')}): ${written.error}`);
      continue;
    }
    try {
      for (const loser of losers) rmSync(join(skillsRoot(), loser), { recursive: true, force: true });
    } catch {
      // quiet: a loser left behind is a duplicate, not a broken library, and the
      // next pass sees it beside the winner that now contains it.
    }
    // Proven utility survives the merge: the winner inherits the losers' counts.
    mergeUsage(winnerSlug, losers);
    merged += 1;
  }

  for (const slug of ops.archive) {
    try {
      archiveSkill(slug);
      archived += 1;
    } catch (error) {
      // A marker the filesystem refused looks exactly like a pass that kept everything.
      console.warn(`[skills curator] could not archive "${slug}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { merged, archived };
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
  if (!embeddings || skills.length < 2 || changed.size === 0) return [];
  try {
    if (!(await embeddings.available())) return [];
    const model = await embeddings.modelId();
    if (!model) return [];
    const vectors = await ensureSkillVectors(skills, { model, embed: (texts) => embeddings.embed(texts, 'passage') });
    const groups: AgentSkill[][] = [];
    const keys: Set<string>[] = [];
    for (const skill of skills) {
      if (!changed.has(skill.slug)) continue;
      const v = vectors.get(skill.slug);
      if (!v) continue;
      const mag = magnitude(v) || 1;
      const near = skills
        .filter((o) => o.slug !== skill.slug)
        .map((o) => {
          const w = vectors.get(o.slug);
          return { o, cos: w && w.length === v.length ? dot(v, w) / (mag * (magnitude(w) || 1)) : -1 };
        })
        .filter((x) => x.cos >= MERGE_MIN_COSINE)
        .sort((a, b) => b.cos - a.cos)
        .slice(0, MERGE_NEIGHBOURS)
        .map((x) => x.o);
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
    return [];
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

  // 1. Split. One skill per call.
  for (const skill of skills.filter((s) => isChanged(s) && splitCandidate(s))) {
    // A recording is the user's own words, edited on its card: not even its
    // description is rewritten. A /learn skill gets a description review only.
    if (skill.origin === 'recorded') continue;
    if (skill.locked && opensWithSituation(skill.description)) continue;
    const taken = listSkillRecords().map((r) => r.slug);
    const prompt = buildSplitPrompt(skill, taken);
    let verdict: SplitVerdict;
    let checked: ReturnType<typeof checkSplit> | null = null;
    try {
      verdict = parseSplit(await llm.complete(prompt));
      // One retry with the exact reasons, the way authoring retries: a split that
      // broke a rule is usually one bad name or one oversized part.
      if (verdict.verdict === 'split' && !skill.locked) {
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
  for (const group of await mergeGroups(skills, changed, opts.embeddings === undefined ? getEmbeddingsClient() : opts.embeddings)) {
    const live = group.filter((s) => !gone.has(s.slug));
    if (live.length < 2 || live.every((s) => s.locked)) continue;
    let ops: CurateOps;
    try {
      ops = parseCurate(await llm.complete(buildMergePrompt(live, usage.trackingSince)));
    } catch (error) {
      degrade('skills.curate', 'skipped one group of similar skills this pass', error);
      for (const s of live) if (changed.has(s.slug)) failed.add(s.slug);
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
    for (const m of clamped.merge) for (const s of m.slugs.slice(1)) gone.add(s);
    for (const s of clamped.archive) gone.add(s);
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
  writeCurated({ version: 1, seen });
  return result;
}
