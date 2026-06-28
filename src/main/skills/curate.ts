import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { skillsRoot } from '../workspace/paths';
import { isRecallEnabled } from '../workspace/memory';
import type { LlmClient } from '../recall/llm';

// Level-2 cleanup for self-authored skills, mirroring recall/consolidate.ts for
// durable facts. The assistant only ever ADDS or patches skills via manage_skill,
// so over time the library accumulates near-duplicate procedures and stale ones.
// This pass periodically asks the LLM for merge/patch/archive operations, then
// applies them with the same KEEP-by-default posture and a drop-fraction guard.
//
// It ONLY ever touches agent-authored skills (metadata.stem.source === 'agent').
// User-dropped and bundled skills are never read into the prompt nor modified.
// Archiving is reversible: it sets the same `.disabled` marker the Manage panel
// uses (see workspace/skills.ts), so pi stops loading the skill but the file stays.

const DISABLED_MARKER = '.disabled';
// Below this many agent skills an automatic pass isn't worth a model call.
const MIN_SKILLS = 3;
// Reject the whole batch if it would retire more than this fraction of the set.
const MAX_DROP_FRACTION = 0.4;
// One-pass budget: skip (best effort) if the library is too large to fit one prompt.
const MAX_PROMPT_CHARS = 80_000;

export interface CurateResult {
  merged: number;
  patched: number;
  archived: number;
}
const ZERO: CurateResult = { merged: 0, patched: 0, archived: 0 };

interface AgentSkill {
  slug: string;
  name: string;
  description: string;
  version: number;
  created: string;
  body: string;
}

interface CurateOps {
  merge: { slugs: string[]; name: string; description: string; content: string }[];
  patch: { slug: string; content: string }[];
  archive: string[];
}
const EMPTY_OPS: CurateOps = { merge: [], patch: [], archive: [] };

const INSTRUCTIONS = `You maintain a library of an assistant's self-authored SKILL files. Each skill is a reusable procedure with a name, a one-line description (what it does and when to use it), and a step-by-step body. Over time the library accumulates near-duplicate skills, skills superseded by a better one, and skills with sloppy or incomplete bodies.

Return ONLY a JSON object (no prose, no markdown fences) with this shape:
{
  "merge":   [{"slugs": ["winner-slug","loser-slug"], "name": "...", "description": "...", "content": "<combined body>"}],
  "patch":   [{"slug": "<slug>", "content": "<improved full body>"}],
  "archive": ["<slug of a stale/superseded/useless skill>"]
}

Rules:
- DEFAULT TO KEEP. Only act on skills you are confident are duplicates, superseded, or clearly wrong. If unsure, leave a skill out of all three lists.
- merge: combine skills that cover the SAME task. The FIRST slug in "slugs" is kept and rewritten with your "name"/"description"/"content"; the rest are retired. List at least two slugs.
- patch: only to fix a clearly wrong or incomplete body; return the FULL improved body (no front-matter, no fences).
- archive: only a skill made redundant or obsolete by another, or one that is clearly not a reusable procedure.
- Use ONLY the slugs listed below. Never invent a skill or a slug.
- If nothing needs changing, return {"merge":[],"patch":[],"archive":[]}.`;

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
    return {};
  }
}

/** Strip the leading front-matter block, returning just the body. */
function stripFront(text: string): string {
  const match = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

/** Recompose a SKILL.md (agent-authored), bumping version and refreshing `updated`. */
function composeSkillMd(s: { name: string; description: string; body: string; version: number; created: string }): string {
  const fm = [
    '---',
    `name: ${JSON.stringify(s.name)}`,
    `description: ${JSON.stringify(s.description)}`,
    'metadata:',
    '  stem:',
    '    source: agent',
    `    version: ${s.version}`,
    `    created: ${JSON.stringify(s.created)}`,
    `    updated: ${JSON.stringify(new Date().toISOString())}`,
    '---'
  ].join('\n');
  return `${fm}\n\n${s.body.trim()}\n`;
}

/** Load only the agent-authored skills (never user/bundled ones). */
function loadAgentSkills(): AgentSkill[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: AgentSkill[] = [];
  for (const slug of entries) {
    let raw: string;
    try {
      raw = readFileSync(join(skillsRoot(), slug, 'SKILL.md'), 'utf8');
    } catch {
      continue; // not a skill directory
    }
    const fm = parseFront(raw);
    if (fm.source !== 'agent') continue; // never touch user/bundled skills
    out.push({
      slug,
      name: fm.name ?? slug,
      description: fm.description ?? '',
      version: fm.version ?? 1,
      created: fm.created ?? new Date().toISOString(),
      body: stripFront(raw)
    });
  }
  return out;
}

function buildPrompt(skills: AgentSkill[]): string {
  const blocks = skills
    .map((s) => `## [${s.slug}] ${s.name}\n${s.description}\n\n${s.body}`)
    .join('\n\n---\n\n');
  return `${INSTRUCTIONS}\n\nSkills:\n\n${blocks}`;
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
  } catch {
    return { ...EMPTY_OPS };
  }
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY_OPS };
  const obj = parsed as Record<string, unknown>;

  const merge: CurateOps['merge'] = [];
  if (Array.isArray(obj.merge)) {
    for (const m of obj.merge) {
      if (!m || typeof m !== 'object') continue;
      const slugs = (m as { slugs?: unknown }).slugs;
      const name = (m as { name?: unknown }).name;
      const description = (m as { description?: unknown }).description;
      const content = (m as { content?: unknown }).content;
      if (
        Array.isArray(slugs) &&
        slugs.every((s) => typeof s === 'string') &&
        slugs.length >= 2 &&
        typeof name === 'string' &&
        typeof description === 'string' &&
        typeof content === 'string' &&
        content.trim()
      ) {
        merge.push({ slugs: slugs as string[], name, description, content });
      }
    }
  }
  const patch: CurateOps['patch'] = [];
  if (Array.isArray(obj.patch)) {
    for (const p of obj.patch) {
      if (!p || typeof p !== 'object') continue;
      const slug = (p as { slug?: unknown }).slug;
      const content = (p as { content?: unknown }).content;
      if (typeof slug === 'string' && typeof content === 'string' && content.trim()) {
        patch.push({ slug, content });
      }
    }
  }
  const archive: string[] = [];
  if (Array.isArray(obj.archive)) {
    for (const s of obj.archive) if (typeof s === 'string') archive.push(s);
  }
  return { merge, patch, archive };
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
  const patch = ops.patch.filter((p) => known.has(p.slug));
  const archive = ops.archive.filter((s) => known.has(s));

  // Bound the model's blast radius, but always allow at least one retirement —
  // otherwise a tiny library (e.g. one duplicate pair) could never be deduped,
  // since merging 1 of 2 already exceeds the fraction.
  const mergeLosers = merge.reduce((n, m) => n + (m.slugs.length - 1), 0);
  const wouldRetire = archive.length + mergeLosers;
  const limit = Math.max(1, Math.floor(MAX_DROP_FRACTION * total));
  if (wouldRetire > limit) return { ...EMPTY_OPS };

  return { merge, patch, archive };
}

/** Disable a skill (reversible) by writing the `.disabled` marker the app uses. */
function archiveSkill(slug: string): void {
  writeFileSync(join(skillsRoot(), slug, DISABLED_MARKER), 'archived by Stem curator\n', 'utf8');
}

function applyCurate(skills: AgentSkill[], ops: CurateOps): CurateResult {
  const bySlug = new Map(skills.map((s) => [s.slug, s]));
  let merged = 0;
  let patched = 0;
  let archived = 0;

  for (const m of ops.merge) {
    const [winnerSlug, ...losers] = m.slugs;
    const winner = bySlug.get(winnerSlug);
    if (!winner) continue;
    try {
      writeFileSync(
        join(skillsRoot(), winnerSlug, 'SKILL.md'),
        composeSkillMd({
          name: m.name || winner.name,
          description: m.description || winner.description,
          body: m.content,
          version: winner.version + 1,
          created: winner.created
        }),
        'utf8'
      );
      for (const loser of losers) {
        if (loser === winnerSlug) continue;
        rmSync(join(skillsRoot(), loser), { recursive: true, force: true });
      }
      merged += 1;
    } catch {
      // best-effort; leave this group for a later cycle
    }
  }

  for (const p of ops.patch) {
    const s = bySlug.get(p.slug);
    if (!s) continue;
    try {
      writeFileSync(
        join(skillsRoot(), p.slug, 'SKILL.md'),
        composeSkillMd({ name: s.name, description: s.description, body: p.content, version: s.version + 1, created: s.created }),
        'utf8'
      );
      patched += 1;
    } catch {
      // best-effort
    }
  }

  for (const slug of ops.archive) {
    try {
      archiveSkill(slug);
      archived += 1;
    } catch {
      // best-effort
    }
  }

  return { merged, patched, archived };
}

/**
 * Run one curation pass over the agent-authored skills. Returns counts of what
 * changed (all zero when nothing ran or nothing needed changing). The caller
 * reloads the backend when any count is non-zero so pi picks up the new files.
 */
export async function curateSkills(llm: LlmClient, opts: { force?: boolean } = {}): Promise<CurateResult> {
  if (!isRecallEnabled()) return ZERO;
  const skills = loadAgentSkills();
  // The automatic pass skips small sets; a manual trigger still needs two to merge.
  if (skills.length < (opts.force ? 2 : MIN_SKILLS)) return ZERO;

  const prompt = buildPrompt(skills);
  if (prompt.length > MAX_PROMPT_CHARS) {
    console.warn(`[skills curator] ${skills.length} skills exceed the single-pass budget; skipping.`);
    return ZERO;
  }

  let ops: CurateOps;
  try {
    ops = parseCurate(await llm.complete(prompt));
  } catch {
    return ZERO; // model error — retry next cycle
  }

  const known = new Set(skills.map((s) => s.slug));
  return applyCurate(skills, clampCurate(ops, known, skills.length));
}
