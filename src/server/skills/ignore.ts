import { readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { degrade } from '../degrade';
import { skillsRoot } from '../workspace/paths';

// Turning a skill off writes a `.disabled` marker inside its folder — and, on its
// own, that does nothing. The backend's skill scanner returns as soon as it finds
// a SKILL.md in a directory (`dist/core/skills.js`, loadSkillsFromDirInternal), so
// it never looks at sibling dotfiles; its only exclusion mechanism is an ignore
// file, `IGNORE_FILE_NAMES = ['.gitignore', '.ignore', '.fdignore']`. Disabled and
// curator-archived skills therefore stayed in the prompt.
//
// So `.disabled` remains the source of truth the Manage panel reads, and this
// module projects that state into the one file the backend actually honours. The
// scanner calls addIgnoreRules() at the root of its walk and tests each directory
// entry as `<name>/`, so a root-level .gitignore listing `<slug>/` is enough.
//
// Rebuilt wholesale from the markers on every change rather than appended to, so
// a hand-edited or half-written file self-heals on the next toggle.

export const DISABLED_MARKER = '.disabled';
export const SKILLS_IGNORE_FILE = '.gitignore';

const HEADER = [
  '# Written by Stem. Do not edit — this file is rebuilt from the .disabled',
  '# markers whenever a skill is turned off or archived.',
  '#',
  '# The agent backend has no notion of a disabled skill; an ignore file is the',
  '# only way to keep one out of the prompt.'
];

/** Slugs of every skill directory carrying a `.disabled` marker. */
export function disabledSlugs(root = skillsRoot()): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (error) {
    // No root yet means nothing is disabled either. Any other failure is worse
    // than it looks: `syncSkillsIgnore` reads an empty list as "nothing to hide"
    // and deletes the ignore file, putting every archived skill back in the prompt.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('skills.ignore', 'found no disabled skills to hide', error);
    }
    return [];
  }
  return entries.filter((slug) => existsSync(join(root, slug, DISABLED_MARKER))).sort();
}

/**
 * Rewrite `<skillsRoot>/.gitignore` so it hides exactly the disabled skills, and
 * remove it when none are. Returns the slugs now hidden.
 *
 * Best-effort: a failed write leaves a skill visible to the backend, which is the
 * status quo ante and never worth failing a toggle over.
 */
export function syncSkillsIgnore(root = skillsRoot()): string[] {
  const slugs = disabledSlugs(root);
  const file = join(root, SKILLS_IGNORE_FILE);
  try {
    if (slugs.length === 0) {
      rmSync(file, { force: true });
    } else {
      writeFileSync(file, `${[...HEADER, '', ...slugs.map((s) => `${s}/`)].join('\n')}\n`, 'utf8');
    }
  } catch (error) {
    // The toggle in Manage reports success off the `.disabled` marker alone, so
    // without this the user turns a skill off, sees it turn off, and the backend
    // keeps loading it.
    degrade('skills.ignore', 'left a disabled skill loaded by the backend', error);
  }
  return slugs;
}
