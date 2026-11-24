// The skill file store: the single writer every authoring path now goes through.
// These cases pin the two things that used to differ between the three old
// writers — that nothing reaches disk without passing the contract, and that an
// update keeps the provenance the first write established — plus the side effects
// a write owes the rest of the system (the rev file, the usage sidecar, the
// ignore file).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skills-store-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import {
  composeSkillMd,
  listSkillRecords,
  parseSkillMd,
  readSkillRecord,
  removeSkill,
  saveSkill,
  setSkillRecurrence
} from '../../src/server/skills/store';
import { readUsage, recordUses } from '../../src/server/skills/usage';
import type { SkillDraft } from '../../src/server/skills/contract';

const revFile = join(skillsDir, '.skills-rev');

const BODY = ['## When to use', 'When the machine is cold.', '', '## Steps', '1. Fill the tank.', '', '## Verification', 'The cup is full.'].join('\n');

function draft(over: Partial<SkillDraft> = {}): SkillDraft {
  return {
    name: 'brew-coffee',
    description: 'Use this when the kitchen machine is cold and a guest is waiting.',
    body: BODY,
    ...over
  };
}

/** A skill written by hand rather than by Stem — no `metadata.stem` at all. */
function writeUserSkill(slug: string): void {
  mkdirSync(join(skillsDir, slug), { recursive: true });
  writeFileSync(join(skillsDir, slug, 'SKILL.md'), `---\nname: ${JSON.stringify(slug)}\ndescription: "hand written"\n---\n\n${BODY}\n`, 'utf8');
}

beforeEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
});
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

describe('saveSkill — create', () => {
  it('writes front-matter Stem can read back, and bumps the rev', () => {
    expect(existsSync(revFile)).toBe(false);

    const result = saveSkill(draft(), { origin: 'user-requested' });
    expect(result).toMatchObject({ ok: true, slug: 'brew-coffee', created: true });

    const record = readSkillRecord('brew-coffee');
    expect(record).toMatchObject({
      slug: 'brew-coffee',
      name: 'brew-coffee',
      description: 'Use this when the kitchen machine is cold and a guest is waiting.',
      body: BODY,
      source: 'agent',
      origin: 'user-requested',
      version: 1,
      enabled: true
    });
    expect(record?.created).toBe(record?.updated);
    // The runtime only reloads when this file moves, so a write nobody announced
    // is a skill that stays invisible until the next restart.
    expect(existsSync(revFile)).toBe(true);
  });

  it('takes the name as the slug rather than laundering it into one', () => {
    const result = saveSkill(draft({ name: 'Brew Coffee' }), { origin: 'assistant' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.violations?.[0].field).toBe('name');
    // The violation still carries the repair, so the retry has somewhere to go.
    expect(result.error).toContain('brew-coffee');
    expect(existsSync(join(skillsDir, 'Brew Coffee'))).toBe(false);
    expect(existsSync(join(skillsDir, 'brew-coffee'))).toBe(false);
  });

  it('touches nothing when the draft breaks the contract', () => {
    const result = saveSkill(draft({ body: 'Just do the thing.' }), { origin: 'turn' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.violations?.map((v) => v.field)).toEqual(['body']);
    expect(existsSync(join(skillsDir, 'brew-coffee'))).toBe(false);
    expect(existsSync(revFile)).toBe(false);
  });
});

describe('saveSkill — update', () => {
  it('bumps the version and keeps created and the original origin', () => {
    saveSkill(draft(), { origin: 'user-requested' });
    const first = readSkillRecord('brew-coffee');

    // A later automatic pass must not relabel a skill the user asked for.
    const result = saveSkill(draft({ body: BODY.replace('Fill the tank.', 'Fill the tank to the line.') }), { origin: 'turn' });
    expect(result).toMatchObject({ ok: true, created: false });

    const second = readSkillRecord('brew-coffee');
    expect(second).toMatchObject({ version: 2, origin: 'user-requested', created: first?.created });
    expect(second?.body).toContain('to the line');
  });

  it('replaces the body wholesale', () => {
    saveSkill(draft(), { origin: 'learn' });
    const replacement = BODY.replace('1. Fill the tank.', '1. Buy a coffee instead.');
    saveSkill(draft({ body: replacement }), { origin: 'learn' });
    expect(readSkillRecord('brew-coffee')?.body).toBe(replacement);
  });

  it('refuses to create when the caller expected an existing skill', () => {
    const result = saveSkill(draft(), { origin: 'turn', expectExisting: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.error).toContain('No skill "brew-coffee"');
    expect(existsSync(join(skillsDir, 'brew-coffee'))).toBe(false);
  });

  it('leaves a hand-written skill as the user\'s own when it patches one', () => {
    writeUserSkill('brew-coffee');
    saveSkill(draft(), { origin: 'turn', expectExisting: true });
    expect(readSkillRecord('brew-coffee')?.source).toBe('user');
  });
});

describe('removeSkill', () => {
  it('refuses a skill the user wrote when the caller is the model', () => {
    writeUserSkill('brew-coffee');
    const result = removeSkill('brew-coffee', { requireAgentAuthored: true });
    expect(result.ok).toBe(false);
    expect(existsSync(join(skillsDir, 'brew-coffee'))).toBe(true);
  });

  it('deletes an agent-authored skill and drops its usage entry', () => {
    saveSkill(draft(), { origin: 'assistant' });
    recordUses(['brew-coffee']);
    expect(readUsage().skills['brew-coffee']?.count).toBe(1);

    const result = removeSkill('brew-coffee', { requireAgentAuthored: true });
    expect(result).toMatchObject({ ok: true, slug: 'brew-coffee' });
    expect(existsSync(join(skillsDir, 'brew-coffee'))).toBe(false);
    // Otherwise the slug keeps showing up in the curator prompt with a use count
    // and no body to go with it.
    expect(readUsage().skills['brew-coffee']).toBeUndefined();
  });

  it('deletes a hand-written skill when the caller is not the model', () => {
    writeUserSkill('brew-coffee');
    // What the Skills tab's delete button relies on. The guard above is the
    // MODEL's — a person deleting their own file is the whole point of the
    // button, and on a server install this panel is their only way to that
    // folder. Adding `requireAgentAuthored` to the IPC handler would break it.
    expect(removeSkill('brew-coffee')).toMatchObject({ ok: true, slug: 'brew-coffee' });
    expect(existsSync(join(skillsDir, 'brew-coffee'))).toBe(false);
  });

  it('republishes the ignore file so a freed slug stops being hidden', () => {
    saveSkill(draft(), { origin: 'assistant' });
    writeFileSync(join(skillsDir, 'brew-coffee', '.disabled'), 'x', 'utf8');
    writeFileSync(join(skillsDir, '.gitignore'), 'brew-coffee/\n', 'utf8');

    removeSkill('brew-coffee');
    expect(existsSync(join(skillsDir, '.gitignore'))).toBe(false);
  });

  it('reports a missing skill and rejects a name that is not a slug', () => {
    expect(removeSkill('nope')).toMatchObject({ ok: false });
    expect(removeSkill('../../etc')).toMatchObject({ ok: false });
  });
});

describe('listSkillRecords', () => {
  it('includes disabled skills and skips directories that are not skills', () => {
    saveSkill(draft(), { origin: 'assistant' });
    saveSkill(draft({ name: 'answer-mail', description: 'Reach for this when the inbox has piled up over a weekend.' }), { origin: 'learn' });
    writeFileSync(join(skillsDir, 'brew-coffee', '.disabled'), 'x', 'utf8');
    mkdirSync(join(skillsDir, 'not-a-skill'), { recursive: true });

    const records = listSkillRecords();
    expect(records.map((r) => r.slug)).toEqual(['answer-mail', 'brew-coffee']);
    expect(records.find((r) => r.slug === 'brew-coffee')?.enabled).toBe(false);
    expect(records.find((r) => r.slug === 'answer-mail')?.enabled).toBe(true);
  });

  it('survives a missing skills directory', () => {
    rmSync(skillsDir, { recursive: true, force: true });
    expect(listSkillRecords()).toEqual([]);
  });
});

describe('parseSkillMd', () => {
  it('round-trips composeSkillMd', () => {
    const front = {
      name: 'brew-coffee',
      description: 'Use this when the kitchen machine is cold and a guest is waiting.',
      source: 'agent' as const,
      origin: 'user-requested' as const,
      version: 3,
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-02-02T00:00:00.000Z'
    };
    expect(parseSkillMd(composeSkillMd({ ...front, body: BODY }))).toEqual(front);
  });

  it('yields nothing for a file with no front-matter, rather than throwing', () => {
    expect(parseSkillMd('just a body\n')).toEqual({});
    expect(parseSkillMd('---\nname: [unclosed\n---\n\nbody\n')).toEqual({});
  });

  it('treats an unrecognised origin as unlabelled', () => {
    mkdirSync(join(skillsDir, 'brew-coffee'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'brew-coffee', 'SKILL.md'),
      '---\nname: "brew-coffee"\ndescription: "d"\nmetadata:\n  stem:\n    source: agent\n    origin: "whatever"\n---\n\nbody\n',
      'utf8'
    );
    expect(readSkillRecord('brew-coffee')?.origin).toBe('unknown');
    // …and an unlabelled skill picks up a label on the next write.
    saveSkill(draft(), { origin: 'learn' });
    expect(readSkillRecord('brew-coffee')?.origin).toBe('learn');
  });
});

describe('the file on disk', () => {
  it('stays greppable for the bridge, which still matches `source: agent`', () => {
    saveSkill(draft(), { origin: 'assistant' });
    const text = readFileSync(join(skillsDir, 'brew-coffee', 'SKILL.md'), 'utf8');
    expect(/\n\s*source:\s*agent\b/.test(text)).toBe(true);
  });
});

describe('how often a skill is needed', () => {
  it('writes the estimate with the skill and keeps it through a patch that does not say', () => {
    expect(saveSkill(draft({ recurs: 'monthly' }), { origin: 'turn' }).ok).toBe(true);
    expect(readFileSync(join(skillsDir, 'brew-coffee', 'SKILL.md'), 'utf8')).toContain('    recurs: monthly\n');
    expect(readSkillRecord('brew-coffee')?.recurs).toBe('monthly');

    saveSkill(draft({ description: 'Use when a guest is waiting and the machine is cold.' }), { origin: 'turn', expectExisting: true });
    expect(readSkillRecord('brew-coffee')).toMatchObject({ recurs: 'monthly', version: 2 });

    saveSkill(draft({ recurs: 'weekly' }), { origin: 'turn', expectExisting: true });
    expect(readSkillRecord('brew-coffee')?.recurs).toBe('weekly');
  });

  it('leaves it out of a skill nobody has estimated, and reads an unknown value as absent', () => {
    saveSkill(draft(), { origin: 'turn' });
    expect(readFileSync(join(skillsDir, 'brew-coffee', 'SKILL.md'), 'utf8')).not.toContain('recurs');
    expect(readSkillRecord('brew-coffee')?.recurs).toBeUndefined();
    expect(parseSkillMd('---\nname: "a"\nmetadata:\n  stem:\n    recurs: fortnightly\n---\n').recurs).toBeUndefined();
  });

  it('changes the estimate alone: same text, version, dates and origin', () => {
    saveSkill(draft(), { origin: 'user-requested' });
    const before = readSkillRecord('brew-coffee')!;
    const res = setSkillRecurrence('brew-coffee', 'yearly');
    expect(res.ok).toBe(true);
    // `updated` above all: the lifecycle clock anchors on it, so estimating a
    // whole library must not read as the whole library having just been worked on.
    expect(readSkillRecord('brew-coffee')).toEqual({ ...before, recurs: 'yearly' });
    setSkillRecurrence('brew-coffee', null);
    expect(readSkillRecord('brew-coffee')).toEqual(before);
    expect(setSkillRecurrence('no-such-skill', 'yearly').ok).toBe(false);
  });
});
