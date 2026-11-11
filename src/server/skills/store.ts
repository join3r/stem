import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { degrade } from '../degrade';
import { SKILLS_REV_FILE } from '../pi/protocol';
import { skillsRoot } from '../workspace/paths';
import { GENERAL_SKILL_TOOLS, SKILL_SLUG_RE, validateSkill, type SkillDraft, type SkillViolation } from './contract';
import { DISABLED_MARKER, syncSkillsIgnore } from './ignore';
import { pruneUsage } from './usage';
import { pruneCases } from './cases';

// The one place a SKILL.md is written.
//
// Before this module there were three writers with three different rule sets: the
// bridge extension (a separate .mjs subprocess that validated a slug and a byte
// cap and nothing else), the curator, and the distiller. Nothing reconciled them,
// so the contract was whatever the last writer happened to enforce — which is how
// the library ended up with a 79-character English sentence in a `name:` field.
//
// Every write now funnels through `saveSkill`, which runs `validateSkill` first and
// touches disk only if the draft is clean. The bridge keeps its tool but forwards
// the write here over the RPC it already has; it is no longer a writer.
//
// Reads and writes have deliberately opposite postures. A read of a malformed
// directory yields null rather than throwing — the Manage panel and the retrieval
// pass walk the whole folder and one bad file must not take the walk down. A write
// that cannot be completed returns `{ ok: false, error }`, because a silently
// dropped save is a skill the user believes exists.

const SKILL_FILE = 'SKILL.md';

/** Where a skill came from. Shown in the Manage panel and injected as a label. */
/**
 * Where a skill came from. The user's own: `user-requested` (they asked for it in
 * chat), `imported` (they handed over an existing skill to install as it is),
 * `learn`, `recorded`. Stem's own idea: `assistant` (saved silently in Auto mode),
 * `turn` (the end-of-turn pass in Auto mode), `approved` (Stem proposed it and the
 * user accepted the card — reviewed, but still Stem's idea). Only Stem's own ideas
 * are reshaped by the curator (skills/curate.ts).
 */
export type SkillOrigin = 'user-requested' | 'imported' | 'assistant' | 'approved' | 'learn' | 'recorded' | 'turn' | 'unknown';

const SKILL_ORIGINS: readonly string[] = ['user-requested', 'imported', 'assistant', 'approved', 'learn', 'recorded', 'turn', 'unknown'];

export interface SkillRecord {
  slug: string;
  name: string;
  description: string;
  /** The markdown below the front-matter, trimmed. */
  body: string;
  /** 'agent' = Stem wrote the file; 'user' = hand-dropped or bundled. */
  source: 'user' | 'agent';
  origin: SkillOrigin;
  version: number;
  created: string;
  updated: string;
  /** No `.disabled` marker (see skills/ignore.ts). */
  enabled: boolean;
  /** Tools whose calls hand this skill over (contract.ts SkillDraft.tools); [] = none. */
  tools: string[];
  /** Why this version was written, in one line, when the writer said (see SaveOptions.change). */
  change?: string;
}

export type WriteResult =
  | { ok: true; slug: string; record: SkillRecord; created: boolean }
  | { ok: false; error: string; violations?: SkillViolation[] };

/** The front-matter fields Stem writes, as read back off disk. */
export interface SkillFront {
  name?: string;
  description?: string;
  source?: 'user' | 'agent';
  origin?: SkillOrigin;
  version?: number;
  created?: string;
  updated?: string;
  tools?: string[];
  change?: string;
}

/** Longest change note kept in the front-matter. */
export const SKILL_CHANGE_MAX = 200;

/**
 * Compose a SKILL.md. Scalars are JSON-stringified, which is valid YAML for
 * strings (a double-quoted scalar) and escapes colons and quotes, so no YAML
 * writer is needed. `source` stays an unquoted token so the older files already on
 * disk — and the regexes elsewhere that still match `source: agent` — keep reading.
 */
export function composeSkillMd(input: {
  name: string;
  description: string;
  body: string;
  source: 'user' | 'agent';
  origin: SkillOrigin;
  version: number;
  created: string;
  /** Defaults to now; passed explicitly so a caller can report what it wrote. */
  updated?: string;
  tools?: readonly string[];
  change?: string;
}): string {
  const fm = [
    '---',
    `name: ${JSON.stringify(input.name)}`,
    `description: ${JSON.stringify(input.description)}`,
    'metadata:',
    '  stem:',
    `    source: ${input.source}`,
    `    origin: ${JSON.stringify(input.origin)}`,
    `    version: ${input.version}`,
    `    created: ${JSON.stringify(input.created)}`,
    `    updated: ${JSON.stringify(input.updated ?? new Date().toISOString())}`,
    ...(input.tools?.length ? [`    tools: ${JSON.stringify(input.tools)}`] : []),
    ...(input.change?.trim() ? [`    change: ${JSON.stringify(oneLine(input.change, SKILL_CHANGE_MAX))}`] : []),
    '---'
  ].join('\n');
  return `${fm}\n\n${input.body.trim()}\n`;
}

/** Parse the leading `---` block. A missing or garbled one yields `{}`, never a throw. */
export function parseSkillMd(text: string): SkillFront {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  let stem: Record<string, unknown>;
  let data: Record<string, unknown> | null;
  try {
    data = parseYaml(match[1]) as Record<string, unknown> | null;
    stem = ((data?.metadata as Record<string, unknown> | undefined)?.stem ?? {}) as Record<string, unknown>;
  } catch (error) {
    // The description is the entire retrieval surface, so a skill that loses its
    // front-matter still sits in the library and still shows in Manage, but can
    // never be matched by anything again.
    degrade('skills.store', 'read a skill with no name or description', error);
    return {};
  }
  return {
    name: str(data?.name),
    description: str(data?.description),
    source: stem.source === 'agent' || stem.source === 'user' ? stem.source : undefined,
    origin: typeof stem.origin === 'string' && SKILL_ORIGINS.includes(stem.origin) ? (stem.origin as SkillOrigin) : undefined,
    version: typeof stem.version === 'number' ? stem.version : undefined,
    created: str(stem.created),
    updated: str(stem.updated),
    tools: Array.isArray(stem.tools) ? stem.tools.filter((t): t is string => typeof t === 'string') : undefined,
    change: str(stem.change)
  };
}

/** Strip the leading front-matter block, returning just the body. */
function stripFront(text: string): string {
  const match = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read one skill directory. Returns null when it holds no readable SKILL.md — the
 * skills root also contains Stem's own sidecars and whatever else the user has
 * dropped there. Front-matter that fails to parse is NOT a rejection: the file is
 * still a skill the backend will load, and hiding it from the panel that exists to
 * delete it would be the wrong kind of strict.
 */
function readRecordIn(root: string, slug: string): SkillRecord | null {
  let raw: string;
  try {
    raw = readFileSync(join(root, slug, SKILL_FILE), 'utf8');
  } catch (error) {
    // A missing file is the ordinary case — most of what sits in the skills root
    // is not a skill. An unreadable one is a skill the library will behave, from
    // here on, as if it never had.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('skills.store', 'dropped one skill from the library', error);
    }
    return null;
  }
  const fm = parseSkillMd(raw);
  return {
    slug,
    name: fm.name ?? slug,
    description: fm.description ?? '',
    body: stripFront(raw),
    // Absent bookkeeping means nobody here wrote it, so it is the user's file and
    // the curator and the model must both keep their hands off it.
    source: fm.source ?? 'user',
    origin: fm.origin ?? 'unknown',
    version: fm.version ?? 1,
    created: fm.created ?? '',
    updated: fm.updated ?? fm.created ?? '',
    enabled: !existsSync(join(root, slug, DISABLED_MARKER)),
    tools: fm.tools ?? [],
    ...(fm.change ? { change: fm.change } : {})
  };
}

/** Every skill on disk, disabled ones included, ordered by display name. */
export function listSkillRecords(): SkillRecord[] {
  const root = skillsRoot();
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (error) {
    // No root yet is a fresh install. Any other failure reads out as a library
    // with nothing in it — which is what Manage draws and what the turn injects.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('skills.store', 'reported an empty skill library', error);
    }
    return [];
  }
  const records: SkillRecord[] = [];
  for (const slug of dirs) {
    const record = readRecordIn(root, slug);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkillRecord(slug: string): SkillRecord | null {
  const clean = String(slug ?? '').trim();
  if (!SKILL_SLUG_RE.test(clean)) return null;
  return readRecordIn(skillsRoot(), clean);
}

/**
 * Touch the revision file so PiRuntime notices the library changed and reloads at
 * the end of the turn. Best-effort: worst case the write activates on the next
 * backend restart, which is not worth failing a save over.
 */
function bumpSkillsRev(root: string): void {
  try {
    writeFileSync(join(root, SKILLS_REV_FILE), String(Date.now()), 'utf8');
  } catch (error) {
    degrade('skills.store', 'left the backend loading the previous skill library', error);
  }
}

/**
 * Create or update `<skillsRoot>/<name>/SKILL.md`, decided by whether that file
 * already exists.
 *
 * `draft.name` IS the directory name. It is not slugified on the way in: the
 * contract already requires a valid slug, and quietly laundering a sentence into
 * one is exactly how names nobody could type got into the old library. A near-miss
 * fails validation and the caller retries with the suggestion the violation carries.
 *
 * An update replaces the body wholesale — there is no old_string/new_string
 * surgery here. It bumps `version`, refreshes `updated`, and keeps `created`,
 * `source` and the ORIGINAL `origin`: a later automatic touch of a skill the user
 * asked for must not relabel it as something Stem thought of on its own.
 */
export interface SaveOptions {
  origin: SkillOrigin;
  expectExisting?: boolean;
  /**
   * Why this version exists, in one line ("Changed after your correction: …").
   * Kept in the front-matter, so every kept version carries its own reason and
   * Manage can say what each one was for. Omitted: the version has no note.
   */
  change?: string;
}

export function saveSkill(draft: SkillDraft, opts: SaveOptions): WriteResult {
  const violations = validateSkill(draft);
  if (violations.length > 0) {
    return { ok: false, error: violations.map((v) => v.message).join(' '), violations };
  }

  const slug = draft.name.trim();
  const root = skillsRoot();
  const existing = readRecordIn(root, slug);
  // The patch path must not silently become a create: the model asking to patch a
  // skill that isn't there has misremembered its own library, and inventing it
  // from a patch-shaped draft is how a half-written skill lands.
  if (opts.expectExisting && !existing) {
    return { ok: false, error: `No skill "${slug}" to update. Create it instead.` };
  }

  const now = new Date().toISOString();
  const record: SkillRecord = {
    slug,
    name: slug,
    description: draft.description.trim(),
    body: draft.body.trim(),
    source: existing?.source ?? 'agent',
    // 'unknown' is the absence of a label, not a label, so a first write that
    // knows where it came from is free to fill it in.
    origin: existing && existing.origin !== 'unknown' ? existing.origin : opts.origin,
    version: existing ? existing.version + 1 : 1,
    created: existing?.created || now,
    updated: now,
    enabled: existing?.enabled ?? true,
    // A patch that does not mention tools keeps the skill's; the author is shown
    // them, so leaving them out is not a decision to drop them. A kept general
    // tool is dropped: it never holds a call, and the next write cleans the file.
    tools: draft.tools ? draft.tools.map((t) => t.trim()) : (existing?.tools ?? []).filter((t) => !GENERAL_SKILL_TOOLS.has(t)),
    ...(opts.change?.trim() ? { change: oneLine(opts.change, SKILL_CHANGE_MAX) } : {})
  };

  // The text this write replaces is kept first. An automatic change that turns
  // out worse than what it replaced is only a mistake if it can be undone.
  if (existing) keepVersion(root, slug, existing.version);
  try {
    mkdirSync(join(root, slug), { recursive: true });
    writeAtomic(join(root, slug, SKILL_FILE), composeSkillMd(record));
  } catch (error) {
    // quiet: the message goes back to whoever asked for the write and is shown —
    // a save that vanished would be a skill the user believes exists.
    return { ok: false, error: `Could not write skill "${slug}": ${message(error)}` };
  }
  bumpSkillsRev(root);
  return { ok: true, slug, record, created: !existing };
}

/**
 * Change only a skill's `origin`, leaving its text, version and dates as they are.
 * The one write that may relabel: the provenance migration (skills/provenance.ts),
 * correcting labels an older Stem got wrong. Every other writer keeps the original.
 */
export function relabelSkill(slug: string, origin: SkillOrigin): WriteResult {
  const root = skillsRoot();
  const existing = readRecordIn(root, slug);
  if (!existing) return { ok: false, error: `No skill "${slug}".` };
  const record = { ...existing, origin };
  try {
    writeAtomic(join(root, slug, SKILL_FILE), composeSkillMd(record));
  } catch (error) {
    // quiet: the caller gets the reason; the old label stays and the pass runs again.
    return { ok: false, error: `Could not relabel skill "${slug}": ${message(error)}` };
  }
  bumpSkillsRev(root);
  return { ok: true, slug, record, created: false };
}

/**
 * Delete a skill directory. `requireAgentAuthored` is the guard the model's own
 * tool runs under: it may retire what it wrote, never a file the user put there.
 */
export function removeSkill(slug: string, opts: { requireAgentAuthored?: boolean } = {}): WriteResult {
  const clean = String(slug ?? '').trim();
  if (!SKILL_SLUG_RE.test(clean)) return { ok: false, error: `"${clean}" is not a skill name.` };

  const root = skillsRoot();
  const record = readRecordIn(root, clean);
  if (!record) return { ok: false, error: `No skill "${clean}".` };
  if (opts.requireAgentAuthored && record.source !== 'agent') {
    return {
      ok: false,
      error: `"${clean}" is not an auto-created skill, so it can't be removed this way — remove it from the app instead.`
    };
  }

  try {
    rmSync(join(root, clean), { recursive: true, force: true });
  } catch (error) {
    // quiet: same as saveSkill — the caller gets the reason and shows it.
    return { ok: false, error: `Could not remove skill "${clean}": ${message(error)}` };
  }
  // The kept versions go with the skill: there is no way to restore a skill that
  // is gone, and old text of a deleted skill is text the user asked to be rid of.
  try {
    rmSync(join(root, SKILL_VERSIONS_DIR, clean), { recursive: true, force: true });
  } catch (error) {
    degrade('skills.store', 'kept the old versions of a deleted skill', error);
  }
  bumpSkillsRev(root);
  // The usage sidecar and the ignore file both key off directories that no longer
  // exist; leaving either stale would resurrect the slug in the curator prompt or
  // keep hiding a name that is now free to reuse.
  pruneUsage();
  pruneCases();
  syncSkillsIgnore(root);
  return { ok: true, slug: clean, record, created: false };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Write through a temporary file and a rename, so a crash or a full disk never
 * leaves a half-written SKILL.md. The temporary name does not end in `.md`, so
 * the backend's scanner never reads it as a skill.
 */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

// ---- kept versions ----
//
// Every update keeps the text it replaces under `.skill-versions/<slug>/v<N>.md`.
// A dot folder, so the backend's scanner skips it, and no file in it is named
// SKILL.md, so `listSkillRecords` never reads one as a skill. The curator keeps
// its own run backups in `.curator-history`; this is per skill and per write,
// whoever the writer was, so Manage can roll any one skill back.

export const SKILL_VERSIONS_DIR = '.skill-versions';
/** Earlier versions kept per skill. Older ones are dropped on the next write. */
export const SKILL_VERSIONS_KEPT = 10;

export interface SkillVersion {
  version: number;
  /** When that version was written (its own `updated`). */
  updated: string;
  description: string;
  change?: string;
}

function versionsDir(root: string, slug: string): string {
  return join(root, SKILL_VERSIONS_DIR, slug);
}

/** Copy the current SKILL.md aside as `v<version>.md`. Best-effort: a failed copy never blocks the write. */
function keepVersion(root: string, slug: string, version: number): void {
  try {
    const raw = readFileSync(join(root, slug, SKILL_FILE), 'utf8');
    const dir = versionsDir(root, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `v${version}.md`), raw, 'utf8');
    const kept = versionNumbers(dir);
    for (const old of kept.slice(SKILL_VERSIONS_KEPT)) rmSync(join(dir, `v${old}.md`), { force: true });
  } catch (error) {
    degrade('skills.store', 'changed a skill without keeping its previous text', error);
  }
}

/** The version numbers kept in `dir`, newest first. */
function versionNumbers(dir: string): number[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') degrade('skills.store', 'listed no earlier versions of a skill', error);
    return [];
  }
  return names
    .map((n) => /^v(\d+)\.md$/.exec(n)?.[1])
    .filter((v): v is string => !!v)
    .map(Number)
    .sort((a, b) => b - a);
}

/** The earlier versions of a skill that can be restored, newest first. */
export function listSkillVersions(slug: string): SkillVersion[] {
  const clean = String(slug ?? '').trim();
  if (!SKILL_SLUG_RE.test(clean)) return [];
  const dir = versionsDir(skillsRoot(), clean);
  const out: SkillVersion[] = [];
  for (const version of versionNumbers(dir)) {
    try {
      const fm = parseSkillMd(readFileSync(join(dir, `v${version}.md`), 'utf8'));
      out.push({ version, updated: fm.updated ?? fm.created ?? '', description: fm.description ?? '', ...(fm.change ? { change: fm.change } : {}) });
    } catch (error) {
      degrade('skills.store', 'skipped one earlier version of a skill', error);
    }
  }
  return out;
}

/** How many earlier versions of `slug` are kept. */
export function countSkillVersions(slug: string): number {
  return versionNumbers(versionsDir(skillsRoot(), slug)).length;
}

/**
 * Put an earlier version back. It is written as a new version, so the text it
 * replaces is kept in turn and a restore can itself be undone. The restored text
 * must still meet the contract; an old version that no longer does is refused
 * with the reason, rather than written around the validator.
 */
export function restoreSkillVersion(slug: string, version: number): WriteResult {
  const clean = String(slug ?? '').trim();
  const root = skillsRoot();
  const current = readRecordIn(root, clean);
  if (!current) return { ok: false, error: `No skill "${clean}".` };
  let raw: string;
  try {
    raw = readFileSync(join(versionsDir(root, clean), `v${Math.trunc(version)}.md`), 'utf8');
  } catch (error) {
    // quiet: the caller shows the reason; nothing was changed.
    return { ok: false, error: `Version ${version} of "${clean}" is not kept: ${message(error)}` };
  }
  const fm = parseSkillMd(raw);
  return saveSkill(
    { name: clean, description: fm.description ?? current.description, body: stripFront(raw), tools: fm.tools ?? [] },
    { origin: current.origin, expectExisting: true, change: `Restored version ${version}` }
  );
}
