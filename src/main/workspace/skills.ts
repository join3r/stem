import { access, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SkillSummary } from '../../shared/types';
import { skillsRoot } from './paths';

const DISABLED_MARKER = '.disabled';

interface FrontMatter {
  name?: string;
  description?: string;
}

/** Parse the leading `---` YAML front-matter block of a SKILL.md. */
function parseFrontMatter(text: string): FrontMatter {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  try {
    const data = parseYaml(match[1]) as Record<string, unknown> | null;
    return {
      name: typeof data?.name === 'string' ? data.name : undefined,
      description: typeof data?.description === 'string' ? data.description : undefined
    };
  } catch {
    return {};
  }
}

export async function listSkills(): Promise<SkillSummary[]> {
  let entries: string[];
  try {
    entries = (await readdir(skillsRoot(), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

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
        path: dir
      });
    } catch {
      // No SKILL.md — not a skill directory; skip.
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
  return listSkills();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
