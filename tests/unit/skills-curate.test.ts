// Skills curator regression suite. Exercises the pure parse/clamp helpers and the
// real curateSkills() against a throwaway skills dir (STEM_SKILLS_DIR), with a
// fake LlmClient so no backend is needed — mirroring the recall probe style.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skills-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import { clampCurate, curateSkills, parseCurate } from '../../src/main/skills/curate';
import type { LlmClient } from '../../src/main/recall/llm';

function fakeLlm(reply: string): LlmClient {
  return { complete: async () => reply };
}

function writeSkill(slug: string, opts: { source?: 'agent' | 'user'; version?: number; body?: string }): void {
  const src = opts.source ?? 'agent';
  const fm = [
    '---',
    `name: ${JSON.stringify(slug)}`,
    `description: ${JSON.stringify(`does ${slug}`)}`,
    'metadata:',
    '  stem:',
    `    source: ${src}`,
    `    version: ${opts.version ?? 1}`,
    '    created: "2026-01-01T00:00:00.000Z"',
    '    updated: "2026-01-01T00:00:00.000Z"',
    '---'
  ].join('\n');
  mkdirSync(join(skillsDir, slug), { recursive: true });
  writeFileSync(join(skillsDir, slug, 'SKILL.md'), `${fm}\n\n${opts.body ?? `Step 1 for ${slug}.`}\n`, 'utf8');
}

beforeEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
});
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

describe('parseCurate', () => {
  it('parses merge/patch/archive and tolerates fences/prose', () => {
    const ops = parseCurate('here you go:\n{"merge":[{"slugs":["a","b"],"name":"A","description":"d","content":"x"}],"patch":[{"slug":"c","content":"y"}],"archive":["d"]}');
    expect(ops.merge).toHaveLength(1);
    expect(ops.merge[0].slugs).toEqual(['a', 'b']);
    expect(ops.patch[0].slug).toBe('c');
    expect(ops.archive).toEqual(['d']);
  });

  it('drops malformed ops (merge needs >=2 slugs, content non-empty)', () => {
    const ops = parseCurate('{"merge":[{"slugs":["a"],"name":"A","description":"d","content":"x"}],"patch":[{"slug":"c","content":"  "}],"archive":[1]}');
    expect(ops.merge).toHaveLength(0);
    expect(ops.patch).toHaveLength(0);
    expect(ops.archive).toHaveLength(0);
  });

  it('returns empty ops on non-JSON', () => {
    expect(parseCurate('no json here')).toEqual({ merge: [], patch: [], archive: [] });
  });
});

describe('clampCurate', () => {
  it('drops ops naming unknown slugs', () => {
    const known = new Set(['a', 'b']);
    const ops = clampCurate(
      { merge: [{ slugs: ['a', 'zzz'], name: 'A', description: 'd', content: 'x' }], patch: [{ slug: 'nope', content: 'y' }], archive: ['b', 'ghost'] },
      known,
      4
    );
    expect(ops.merge).toHaveLength(0); // 'a' alone after filtering 'zzz' → <2 slugs
    expect(ops.patch).toHaveLength(0);
    expect(ops.archive).toEqual(['b']);
  });

  it('rejects a batch that would retire more than 40% of the set', () => {
    const known = new Set(['a', 'b', 'c', 'd', 'e']);
    const ops = clampCurate({ merge: [], patch: [], archive: ['a', 'b', 'c'] }, known, 5); // 3/5 = 60%
    expect(ops).toEqual({ merge: [], patch: [], archive: [] });
  });
});

describe('curateSkills', () => {
  it('merges duplicate agent skills and never touches user skills', async () => {
    writeSkill('make-coffee', { source: 'agent' });
    writeSkill('brew-coffee', { source: 'agent' });
    writeSkill('user-thing', { source: 'user' });

    const llm = fakeLlm(
      JSON.stringify({
        merge: [{ slugs: ['make-coffee', 'brew-coffee'], name: 'make-coffee', description: 'brew coffee', content: 'Step 1. Boil water.' }],
        patch: [],
        archive: []
      })
    );
    const res = await curateSkills(llm, { force: true });
    expect(res.merged).toBe(1);
    expect(existsSync(join(skillsDir, 'make-coffee', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'brew-coffee'))).toBe(false); // loser removed
    expect(existsSync(join(skillsDir, 'user-thing', 'SKILL.md'))).toBe(true); // untouched
    const winner = readFileSync(join(skillsDir, 'make-coffee', 'SKILL.md'), 'utf8');
    expect(winner).toContain('Boil water');
    expect(winner).toMatch(/version:\s*2/); // bumped
  });

  it('archives a stale skill with the .disabled marker (reversible)', async () => {
    writeSkill('old-way', { source: 'agent' });
    writeSkill('keep-a', { source: 'agent' });
    writeSkill('keep-b', { source: 'agent' });

    const llm = fakeLlm(JSON.stringify({ merge: [], patch: [], archive: ['old-way'] }));
    const res = await curateSkills(llm, { force: true });
    expect(res.archived).toBe(1);
    expect(existsSync(join(skillsDir, 'old-way', '.disabled'))).toBe(true);
    expect(existsSync(join(skillsDir, 'old-way', 'SKILL.md'))).toBe(true); // not deleted
  });

  it('does not call the model when there are fewer than two agent skills', async () => {
    writeSkill('lonely', { source: 'agent' });
    writeSkill('a-user-skill', { source: 'user' });
    let called = false;
    const llm: LlmClient = {
      complete: async () => {
        called = true;
        return '{}';
      }
    };
    const res = await curateSkills(llm, { force: true });
    expect(called).toBe(false);
    expect(res).toEqual({ merged: 0, patched: 0, archived: 0 });
  });
});
