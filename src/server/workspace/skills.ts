import { access, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SkillSummary } from '../../shared/types';
import { degrade } from '../degrade';
import { DISABLED_MARKER, syncSkillsIgnore } from '../skills/ignore';
import { readUsage } from '../skills/usage';
import { skillsRoot } from './paths';

interface FrontMatter {
  name?: string;
  description?: string;
  source?: 'agent' | 'user';
  version?: number;
  updated?: string;
}

/** Parse the leading `---` YAML front-matter block of a SKILL.md. */
function parseFrontMatter(text: string): FrontMatter {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  try {
    const data = parseYaml(match[1]) as Record<string, unknown> | null;
    // `metadata.stem` carries Stem's own bookkeeping for auto-authored skills.
    const stem = ((data?.metadata as Record<string, unknown> | undefined)?.stem ?? {}) as Record<string, unknown>;
    return {
      name: typeof data?.name === 'string' ? data.name : undefined,
      description: typeof data?.description === 'string' ? data.description : undefined,
      source: stem.source === 'agent' ? 'agent' : 'user',
      version: typeof stem.version === 'number' ? stem.version : undefined,
      updated: typeof stem.updated === 'string' ? stem.updated : undefined
    };
  } catch (error) {
    // Front matter that will not parse leaves the skill in the panel under its
    // slug with an empty description, which reads as a skill somebody wrote
    // carelessly rather than one whose SKILL.md needs a fix.
    degrade('skills', 'listed a skill without its name or description', error);
    return {};
  }
}

export async function listSkills(): Promise<SkillSummary[]> {
  let entries: string[];
  try {
    entries = (await readdir(skillsRoot(), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (error) {
    // No skills folder yet is the ordinary first launch. An unreadable one is
    // "you have no skills" said to somebody who has some.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('skills', 'reported no skills', error);
    }
    return [];
  }

  const usage = readUsage();
  const skills: SkillSummary[] = [];
  for (const slug of entries) {
    const dir = join(skillsRoot(), slug);
    const skillMd = join(dir, 'SKILL.md');
    try {
      const text = await readFile(skillMd, 'utf8');
      const fm = parseFrontMatter(text);
      skills.push({
        slug,
        name: fm.name ?? slug,
        description: fm.description ?? '',
        enabled: !(await exists(join(dir, DISABLED_MARKER))),
        path: dir,
        source: fm.source ?? 'user',
        version: fm.version,
        updatedAt: fm.updated,
        // Explicit 0 (not undefined) so the UI can say "never used" plainly.
        useCount: usage.skills[slug]?.count ?? 0,
        lastUsedAt: usage.skills[slug]?.lastUsedAt
      });
    } catch (error) {
      // No SKILL.md — not a skill directory; skip. A SKILL.md that is there and
      // will not read is a skill the backend still loads into every prompt and
      // the panel cannot show, so there is nowhere to turn it off.
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        degrade('skills', 'skipped one skill', error);
      }
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function setSkillEnabled(slug: string, enabled: boolean): Promise<SkillSummary[]> {
  const marker = join(skillsRoot(), slug, DISABLED_MARKER);
  if (enabled) {
    await rm(marker, { force: true });
  } else if (!(await exists(marker))) {
    await writeFile(marker, 'disabled by Stem\n', 'utf8');
  }
  // The marker is what the UI reads; the ignore file is what the backend reads.
  syncSkillsIgnore();
  return listSkills();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    // quiet: access() failing is the answer this asks for.
    return false;
  }
}
