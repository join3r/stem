import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { degrade } from '../degrade';
import { filesRoot, skillsRoot } from '../workspace/paths';
import { SKILLS_REV_FILE } from '../pi/protocol';
import { listSkillRecords } from './store';
import { SKILLS_USAGE_FILE } from './usage';
import { SKILLS_VECTORS_FILE } from './vectors';
import { SKILLS_IGNORE_FILE } from './ignore';

// The one-time migration off the old library.
//
// Skills written before this rebuild cannot be carried forward. They were authored
// against no contract (names that are English sentences, no required sections),
// they were reconstructed from chat narration rather than from what the assistant
// actually did, and they were selected by being broadcast wholesale rather than
// ranked — so none of them carries the usage history the new ranking needs. Every
// one of them would now be inlined into turns as an instruction to follow.
//
// Migrating them individually is not worth building: measured on the local
// library, 23 of 25 had never been used once. So the pass is a clean break with an
// escape hatch — copy them into the user's Files folder as plain Markdown, where
// they are readable and can be re-saved by hand, then delete.
//
// Nothing here runs on its own. The renderer asks, the user answers, and this is
// what carries out either answer; a version marker keeps the question from being
// asked twice.

/** Bumped when a future change makes existing skills unusable again. */
export const SKILLS_SCHEMA_VERSION = 2;
/** Records the schema the on-disk library was written against. */
export const SKILLS_SCHEMA_FILE = '.skills-schema';

/** Sidecars that are meaningless once the library they describe is gone. */
const SIDECARS = [SKILLS_USAGE_FILE, SKILLS_VECTORS_FILE, SKILLS_IGNORE_FILE, SKILLS_REV_FILE];

export interface SkillsResetStatus {
  /** The user has not yet answered for this schema version. */
  needed: boolean;
  /** How many skills would be affected — 0 means nothing to ask about. */
  count: number;
}

function schemaFile(): string {
  return join(skillsRoot(), SKILLS_SCHEMA_FILE);
}

function storedSchema(): number {
  try {
    const n = Number.parseInt(readFileSync(schemaFile(), 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    // quiet: no marker is exactly the state it records — a library nobody has
    // answered for yet — and the answer is to ask.
    return 0;
  }
}

/** Record that the library on disk is current, so the dialog stops asking. */
export function markSkillsSchemaCurrent(): void {
  try {
    mkdirSync(skillsRoot(), { recursive: true });
    writeFileSync(schemaFile(), `${SKILLS_SCHEMA_VERSION}\n`, 'utf8');
  } catch {
    // quiet: the cost of a failed write is being asked once more, which is
    // strictly better than blocking startup over a marker file.
  }
}

/**
 * Whether to raise the one-time dialog. A fresh install has no skills, so it is
 * silently marked current and never asked — the question only makes sense to
 * someone who has a library to lose.
 */
export function skillsResetStatus(): SkillsResetStatus {
  if (storedSchema() >= SKILLS_SCHEMA_VERSION) return { needed: false, count: 0 };
  const count = listSkillRecords().length;
  if (count === 0) {
    markSkillsSchemaCurrent();
    return { needed: false, count: 0 };
  }
  return { needed: true, count };
}

/** "Saved skills 2026-08-03" — the folder the export lands in, under Files. */
function exportFolderName(at: Date): string {
  return `Saved skills ${at.toISOString().slice(0, 10)}`;
}

/**
 * Copy the library into the user's Files folder as plain Markdown, front-matter
 * and all. Deliberately not a Stem-readable format: these are keepsakes to read
 * or crib from, and anything that looked importable would imply we could import
 * it, which is the thing this migration is saying we cannot do.
 */
export function exportSkills(at: Date = new Date()): { count: number; folder: string } {
  const records = listSkillRecords();
  if (records.length === 0) return { count: 0, folder: '' };
  const folder = exportFolderName(at);
  const dir = join(filesRoot(), folder);
  mkdirSync(dir, { recursive: true });
  let count = 0;
  for (const record of records) {
    try {
      const source = join(skillsRoot(), record.slug, 'SKILL.md');
      writeFileSync(join(dir, `${record.slug}.md`), readFileSync(source, 'utf8'), 'utf8');
      count += 1;
    } catch (error) {
      // One unreadable file must not abandon the rest of the export — but this
      // is the copy the user asked for of a skill `resetSkills` deletes moments
      // later, and the count it reports back is the only other trace.
      degrade('skills.reset', 'deleted one skill without exporting it', error);
    }
  }
  return { count, folder };
}

export interface SkillsResetResult {
  exported: number;
  exportFolder: string;
  removed: number;
}

/**
 * Carry out the migration. Exports first when asked, so a failure to write the
 * copies happens before anything is deleted rather than after.
 */
export function resetSkills(opts: { export: boolean } = { export: true }): SkillsResetResult {
  const exported = opts.export ? exportSkills() : { count: 0, folder: '' };

  const root = skillsRoot();
  let removed = 0;
  for (const record of listSkillRecords()) {
    try {
      rmSync(join(root, record.slug), { recursive: true, force: true });
      removed += 1;
    } catch {
      // quiet: a leftover directory is visible in the Manage panel, where the
      // user can remove it by hand.
    }
  }
  for (const sidecar of SIDECARS) {
    try {
      if (existsSync(join(root, sidecar))) rmSync(join(root, sidecar), { force: true });
    } catch {
      // quiet: a sidecar that outlives the library it describes is pruned on the
      // next pass — usage entries by slug, vectors by hash.
    }
  }
  // Whatever else is in there stays: the user may have dropped their own files
  // beside the skills, and this migration has no business tidying those.
  try {
    readdirSync(root);
  } catch {
    // quiet: the read is the probe and the catch is the answer — no root, make one.
    mkdirSync(root, { recursive: true });
  }

  markSkillsSchemaCurrent();
  return { exported: exported.count, exportFolder: exported.folder, removed };
}
