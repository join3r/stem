import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { degrade } from '../degrade';
import { skillsRoot } from '../workspace/paths';
import { isRecallEnabled } from '../workspace/memory';
import type { LlmClient } from '../recall/llm';
import { DISABLED_MARKER, syncSkillsIgnore } from './ignore';
import { saveSkill } from './store';
import { mergeUsage, pruneUsage, readUsage, type SkillsUsage } from './usage';

// Level-2 cleanup for self-authored skills, mirroring recall/consolidate.ts for
// durable facts. The assistant only ever ADDS or updates skills via manage_skill,
// so over time the library accumulates narrow siblings of the same procedure and
// skills a better one has superseded. This pass periodically asks the LLM for
// merge/archive operations and applies them behind a drop-fraction guard.
//
// The two operations run on DIFFERENT postures, which is the correction recorded
// in SKILLS-UPKEEP.md ("Defect 2"). Merge is an umbrella-building pass: the bar is
// "would a maintainer write these as N skills, or one skill with N labeled
// subsections?", not "do they cover the same task". Archive keeps the cautious
// KEEP-by-default posture. The asymmetry is in the cost of being wrong — a bad
// merge preserves every skill's content inside the winner and is visible in
// Manage, while a bad archive silently stops a skill from ever being retrieved
// again. The prompt this replaces let the cautious posture govern both lists; it
// archived nothing in the library's whole recorded history, and let four skills
// for the same YouTube procedure accumulate before two of them merged.
//
// Retiring skills nobody uses is deliberately NOT this pass's job: the
// deterministic clock in skills/lifecycle.ts does that without a model call, which
// is why the prompt below tells the model not to read anything into a zero count.
//
// It used to also PATCH bodies, and no longer does. Body edits belong to the
// assistant at the moment it uses a skill and finds it wrong: that is when the
// evidence exists. A periodic pass rewriting bodies it has no failure evidence for
// can only degrade a working skill on the strength of how it reads — and it is the
// one mechanism that ran continuously over the library this rebuild deletes.
//
// It ONLY ever touches agent-authored skills (metadata.stem.source === 'agent').
// User-dropped and bundled skills are never read into the prompt nor modified.
// Archiving is reversible: it sets the same `.disabled` marker the Manage panel
// uses (see workspace/skills.ts) and republishes the ignore file (skills/ignore.ts),
// so pi stops loading the skill but the file stays.

// Below this many agent skills an automatic pass isn't worth a model call.
const MIN_SKILLS = 3;
// Reject the whole batch if it would retire more than this fraction of the set.
const MAX_DROP_FRACTION = 0.4;
// One-pass budget: skip (best effort) if the library is too large to fit one prompt.
const MAX_PROMPT_CHARS = 80_000;

export interface CurateResult {
  merged: number;
  archived: number;
}
const ZERO: CurateResult = { merged: 0, archived: 0 };

interface AgentSkill {
  slug: string;
  name: string;
  description: string;
  version: number;
  created: string;
  body: string;
  /** Consultations recorded since usage tracking began (0 = none recorded). */
  useCount: number;
  /** ISO timestamp of the most recent recorded use. */
  lastUsedAt?: string;
}

interface CurateOps {
  merge: { slugs: string[]; description: string; content: string }[];
  archive: string[];
}
const EMPTY_OPS: CurateOps = { merge: [], archive: [] };

const INSTRUCTIONS = `You maintain a library of an assistant's self-authored SKILL files. Each skill is a reusable procedure with a name, a one-line description (what it does and when to use it), and a step-by-step body.

This is a CONSOLIDATION pass, not a duplicate-hunt and not a passive audit. A library where each skill records one afternoon's specific problem has failed at its job: the assistant finds a skill by matching its description, and one broad skill with labeled subsections is easier to match — and easier to keep correct — than five narrow siblings.

Return ONLY a JSON object (no prose, no markdown fences) with this shape:
{
  "merge":   [{"slugs": ["winner-slug","loser-slug"], "description": "...", "content": "<combined body>"}],
  "archive": ["<slug of a stale/superseded/useless skill>"]
}

The two lists have OPPOSITE postures, deliberately. A merge you get wrong is recoverable: every skill's content is still there inside the winner, and a person can see it and split it again. An archive you get wrong is silent — the skill stays on disk but is never retrieved again, and nobody finds out. So: be aggressive about merging, cautious about archiving.

merge — the bar is NOT "these cover the same task":
- Ask instead: would a human maintainer write these as N separate skills, or as ONE skill with N labeled subsections? When the answer is one skill, merge them.
- Pairwise distinctness is the WRONG test. "Each one has a different trigger" is not a reason to leave them apart; a labeled subsection can have its own trigger.
- Scan the whole list for CLUSTERS before deciding anything: skills sharing a domain, a service, a tool, or a keyword in their names or descriptions. Work cluster by cluster, not pair by pair. For each cluster ask what class of work it serves and which member is already broad enough to be the umbrella.
- Look for skills whose NAME is too narrow to be a class of work — a specific error message, a one-off project or device or feature name, one investigation. Those almost always belong as a subsection under a broader skill rather than as an entry of their own.
- Iterate. After forming one umbrella, scan what is left for the next one. Do not stop at the first merge.
- Mechanics: the FIRST slug in "slugs" is kept, keeps its name, and is rewritten with your "description" and "content"; the rest are retired. List at least two slugs.
- SIZE LIMIT, and it is enforced: the merged body must be under 4096 bytes and must carry the headings "## When to use", "## Steps", "## Verification", in that order. A body that breaks either rule is rejected outright and the merge does not happen. So compress as you merge: give each absorbed skill a short labeled subsection under "## Steps" (e.g. "### Playlists"), keep the exact commands, arguments and traps, and drop restated prose. Keep any line saying a step has to run on a particular machine and why — that is a trap, not prose, and it is invisible until it fails. If a cluster will not fit, do TWO smaller merges instead of one that overflows.

archive — DEFAULT TO KEEP:
- Only archive a skill made redundant or obsolete by another one, or a skill that is clearly not a reusable procedure at all. If you are unsure, leave it out of both lists.
- Never archive a skill merely to make the library smaller. Merging is how the library gets smaller.

Both lists:
- Do NOT improve, tidy, or reword a body you are keeping. You cannot see whether it works; the assistant fixes a skill when it uses one and finds it wrong.
- Usage counts are NEVER a reason to skip a merge — judge overlap on content alone. And "never used since tracking began" is absence of evidence, not evidence of absence: some procedures are legitimately ungradeable, and some are seasonal. A separate automatic clock retires skills that go untouched for long enough, so you do not need to do that from the counters.
- Use ONLY the slugs listed below. Never invent a skill or a slug.
- If nothing needs changing, return {"merge":[],"archive":[]}.`;

/** Parse the leading `---` YAML front-matter; tolerant of a missing/garbled block. */
function parseFront(text: string): { name?: string; description?: string; source?: string; version?: number; created?: string } {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  try {
    const data = parseYaml(match[1]) as Record<string, unknown> | null;
    const stem = ((data?.metadata as Record<string, unknown> | undefined)?.stem ?? {}) as Record<string, unknown>;
    return {
      name: typeof data?.name === 'string' ? data.name : undefined,
      description: typeof data?.description === 'string' ? data.description : undefined,
      source: typeof stem.source === 'string' ? stem.source : undefined,
      version: typeof stem.version === 'number' ? stem.version : undefined,
      created: typeof stem.created === 'string' ? stem.created : undefined
    };
  } catch {
    // quiet: an unreadable `source` reads as not-'agent' below, and leaving a
    // skill alone is the posture this pass takes for everything it cannot place.
    return {};
  }
}

/** Strip the leading front-matter block, returning just the body. */
function stripFront(text: string): string {
  const match = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

/** Load only the agent-authored skills (never user/bundled ones). */
function loadAgentSkills(usage: SkillsUsage): AgentSkill[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (error) {
    // An empty list means the pass reports 0 merged, 0 archived — the same
    // answer as a library that needed nothing, which is the confusion the merge
    // warning below exists to prevent.
    degrade('skills.curate', 'curated nothing and reported no changes', error);
    return [];
  }
  const out: AgentSkill[] = [];
  for (const slug of entries) {
    let raw: string;
    try {
      raw = readFileSync(join(skillsRoot(), slug, 'SKILL.md'), 'utf8');
    } catch {
      continue; // quiet: not a skill directory
    }
    const fm = parseFront(raw);
    if (fm.source !== 'agent') continue; // never touch user/bundled skills
    out.push({
      slug,
      name: fm.name ?? slug,
      description: fm.description ?? '',
      version: fm.version ?? 1,
      created: fm.created ?? new Date().toISOString(),
      body: stripFront(raw),
      useCount: usage.skills[slug]?.count ?? 0,
      lastUsedAt: usage.skills[slug]?.lastUsedAt
    });
  }
  return out;
}

/** "2026-07-23" from an ISO timestamp (the prompt doesn't need the time part). */
function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

function buildPrompt(skills: AgentSkill[], trackingSince: string): string {
  const header =
    `Today is ${isoDay(new Date().toISOString())}. Usage has been tracked since ${isoDay(trackingSince)} — ` +
    'a skill created before that date may have earlier uses that were never recorded.';
  const blocks = skills
    .map((s) => {
      const usage = s.useCount
        ? `used ${s.useCount}×, last ${isoDay(s.lastUsedAt ?? '')}`
        : 'never used since tracking began';
      return `## [${s.slug}] ${s.name}\n${s.description}\nCreated ${isoDay(s.created)} · ${usage}\n\n${s.body}`;
    })
    .join('\n\n---\n\n');
  return `${INSTRUCTIONS}\n\n${header}\n\nSkills:\n\n${blocks}`;
}

/** Parse the model's reply into curate ops. Defensive: any malformation → no-op. */
export function parseCurate(output: string): CurateOps {
  const trimmed = output.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return { ...EMPTY_OPS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch (error) {
    // A model that answered in prose produces the same 0/0 the caller shows for
    // a library with nothing to merge, and it will keep producing it every cycle.
    degrade('skills.curate', 'discarded the curator reply and made no changes', error);
    return { ...EMPTY_OPS };
  }
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY_OPS };
  const obj = parsed as Record<string, unknown>;

  const merge: CurateOps['merge'] = [];
  if (Array.isArray(obj.merge)) {
    for (const m of obj.merge) {
      if (!m || typeof m !== 'object') continue;
      const slugs = (m as { slugs?: unknown }).slugs;
      const description = (m as { description?: unknown }).description;
      const content = (m as { content?: unknown }).content;
      if (
        Array.isArray(slugs) &&
        slugs.every((s) => typeof s === 'string') &&
        slugs.length >= 2 &&
        typeof description === 'string' &&
        typeof content === 'string' &&
        content.trim()
      ) {
        // A merge never renames: the winner's slug IS its name, and a rename
        // would mean a new directory rather than a merge. Any `name` the model
        // sends is dropped here rather than silently half-applied.
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
 * Drop ops that name unknown slugs, then reject the whole batch if it would retire
 * (archive + merge losers) more than MAX_DROP_FRACTION of the set. `known` is the
 * set of agent-authored slugs the model is allowed to touch.
 */
export function clampCurate(ops: CurateOps, known: Set<string>, total: number): CurateOps {
  const merge = ops.merge
    .map((m) => ({ ...m, slugs: m.slugs.filter((s) => known.has(s)) }))
    .filter((m) => m.slugs.length >= 2);
  const archive = ops.archive.filter((s) => known.has(s));

  // Bound the model's blast radius, but always allow at least one retirement —
  // otherwise a tiny library (e.g. one duplicate pair) could never be deduped,
  // since merging 1 of 2 already exceeds the fraction.
  const mergeLosers = merge.reduce((n, m) => n + (m.slugs.length - 1), 0);
  const wouldRetire = archive.length + mergeLosers;
  const limit = Math.max(1, Math.floor(MAX_DROP_FRACTION * total));
  if (wouldRetire > limit) return { ...EMPTY_OPS };

  return { merge, archive };
}

/** Disable a skill (reversible) by writing the `.disabled` marker the app uses. */
function archiveSkill(slug: string): void {
  writeFileSync(join(skillsRoot(), slug, DISABLED_MARKER), 'archived by Stem curator\n', 'utf8');
}

function applyCurate(skills: AgentSkill[], ops: CurateOps): CurateResult {
  const bySlug = new Map(skills.map((s) => [s.slug, s]));
  let merged = 0;
  let archived = 0;

  for (const m of ops.merge) {
    const [winnerSlug, ...losers] = m.slugs;
    const winner = bySlug.get(winnerSlug);
    if (!winner) continue;
    // Through saveSkill, so a merged body meets the same contract as every other
    // write — and, more importantly, so a merge that would produce an invalid
    // skill writes nothing rather than half of one. Losers are only deleted once
    // the winner is safely on disk; the group is left for a later cycle otherwise.
    const written = saveSkill(
      { name: winnerSlug, description: m.description || winner.description, body: m.content },
      { expectExisting: true, origin: 'unknown' }
    );
    if (!written.ok) {
      // Say so. A rejected merge used to be indistinguishable from "nothing to
      // merge" — the pass reported zero and the caller told the user there were no
      // duplicates. The 4096-byte cap is the likeliest cause now that the prompt
      // asks for umbrellas, and how often it is what stops a merge is the evidence
      // SKILLS-UPKEEP.md's open question 1 wants before touching the cap.
      const why = written.violations?.map((v) => v.message).join(' ') ?? written.error;
      console.warn(`[skills curator] merge into "${winnerSlug}" rejected (losers: ${losers.join(', ') || 'none'}): ${why}`);
      continue;
    }
    try {
      for (const loser of losers) {
        if (loser === winnerSlug) continue;
        rmSync(join(skillsRoot(), loser), { recursive: true, force: true });
      }
    } catch {
      // quiet: a loser left behind is a duplicate, not a broken library, and the
      // next pass sees it beside the winner that now contains it.
    }
    // Proven utility survives the merge: winner inherits the losers' counts.
    mergeUsage(winnerSlug, losers);
    merged += 1;
  }

  for (const slug of ops.archive) {
    try {
      archiveSkill(slug);
      archived += 1;
    } catch (error) {
      // Best-effort, but not silent — same reason as the merge above: a marker the
      // filesystem refused looks exactly like a pass that decided to keep everything.
      console.warn(`[skills curator] could not archive "${slug}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Republish the ignore file once for the whole batch — merges delete losers and
  // archives add markers, and both change what the backend should stop loading.
  if (merged || archived) syncSkillsIgnore();

  return { merged, archived };
}

/**
 * Run one curation pass over the agent-authored skills. Returns counts of what
 * changed (all zero when nothing ran or nothing needed changing). The caller
 * reloads the backend when any count is non-zero so pi picks up the new files.
 */
export async function curateSkills(llm: LlmClient, opts: { force?: boolean } = {}): Promise<CurateResult> {
  if (!isRecallEnabled()) return ZERO;
  const usage = readUsage();
  const skills = loadAgentSkills(usage);
  // The automatic pass skips small sets; a manual trigger still needs two to merge.
  if (skills.length < (opts.force ? 2 : MIN_SKILLS)) return ZERO;

  const prompt = buildPrompt(skills, usage.trackingSince);
  if (prompt.length > MAX_PROMPT_CHARS) {
    console.warn(`[skills curator] ${skills.length} skills exceed the single-pass budget; skipping.`);
    return ZERO;
  }

  let ops: CurateOps;
  try {
    ops = parseCurate(await llm.complete(prompt));
  } catch (error) {
    // Retried next cycle, but until then the caller reports 0 merged and 0
    // archived, which is what it also says when the library is already clean.
    degrade('skills.curate', 'made no changes', error);
    return ZERO;
  }

  const known = new Set(skills.map((s) => s.slug));
  const result = applyCurate(skills, clampCurate(ops, known, skills.length));
  // Hygiene: drop usage entries for skills deleted by merges above — and for
  // dirs removed out-of-band (manage_skill "remove" runs in the bridge
  // subprocess, which cannot touch the sidecar itself).
  pruneUsage();
  return result;
}
