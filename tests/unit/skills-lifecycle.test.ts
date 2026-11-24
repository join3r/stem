// The skills lifecycle clock's decision core. Pure — no filesystem, no model — so
// every case here is a table of timestamps against a fixed `now`. STEM_SKILLS_DIR
// is still set before the import because lifecycle.ts pulls in the store/usage
// modules, which resolve the skills root at module load.
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STEM_SKILLS_DIR = join(tmpdir(), `stem-skills-lifecycle-${process.pid}`);

import {
  ARCHIVE_AFTER_DAYS,
  archiveAfterDays,
  skillsToExpire,
  slowestRecurrence,
  type LifecycleSkill
} from '../../src/server/skills/lifecycle';
import type { SkillsUsage } from '../../src/server/skills/usage';

const NOW = new Date('2026-08-11T12:00:00.000Z');

/** An ISO timestamp `days` before NOW. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function skill(slug: string, over: Partial<LifecycleSkill> = {}): LifecycleSkill {
  return { slug, source: 'agent', enabled: true, created: daysAgo(1), updated: daysAgo(1), ...over };
}

function usage(skills: SkillsUsage['skills'] = {}): SkillsUsage {
  return { trackingSince: daysAgo(200), skills };
}

describe('skillsToExpire', () => {
  it('keeps a fresh skill', () => {
    expect(skillsToExpire([skill('brand-new')], usage(), NOW)).toEqual([]);
  });

  it('archives an agent skill created 100 days ago, never used and never updated', () => {
    const old = skill('one-afternoon', { created: daysAgo(100), updated: daysAgo(100) });
    expect(skillsToExpire([old], usage(), NOW)).toEqual(['one-afternoon']);
  });

  it('keeps an old skill that was patched recently — a patch is evidence of live use', () => {
    // The anchor is max(created, updated, lastUsedAt), not `lastUsedAt ?? created`.
    // With the naive anchor this skill expires while the assistant is actively
    // fixing it, which is how the whole library would age out on one fuse.
    const patched = skill('still-tended', { created: daysAgo(100), updated: daysAgo(5) });
    expect(skillsToExpire([patched], usage(), NOW)).toEqual([]);
  });

  it('keeps an old skill the usage sidecar says was used 10 days ago', () => {
    const used = skill('seasonal', { created: daysAgo(100), updated: daysAgo(100) });
    expect(skillsToExpire([used], usage({ seasonal: { count: 3, lastUsedAt: daysAgo(10) } }), NOW)).toEqual([]);
  });

  it("treats a blank lastUsedAt as missing, not as the epoch", () => {
    // usage.ts writes '' for an entry that has only ever been injected. Read as a
    // date it is either NaN or 1970 — both wrong; it must fall through to
    // created/updated.
    const entry = { count: 0, lastUsedAt: '', injected: 4 };
    const fresh = skill('offered-never-followed');
    expect(skillsToExpire([fresh], usage({ 'offered-never-followed': entry }), NOW)).toEqual([]);

    const stale = skill('stale-and-unfollowed', { created: daysAgo(100), updated: daysAgo(100) });
    expect(skillsToExpire([stale], usage({ 'stale-and-unfollowed': entry }), NOW)).toEqual(['stale-and-unfollowed']);
  });

  it('never touches a user skill, however old', () => {
    const theirs = skill('users-own', { source: 'user', created: daysAgo(999), updated: daysAgo(999) });
    expect(skillsToExpire([theirs], usage(), NOW)).toEqual([]);
  });

  it('never touches an already-disabled skill', () => {
    const off = skill('turned-off', { enabled: false, created: daysAgo(999), updated: daysAgo(999) });
    expect(skillsToExpire([off], usage(), NOW)).toEqual([]);
  });

  it('keeps a skill whose timestamps are all unparseable — unknown age is not old age', () => {
    const mangled = skill('hand-edited', { created: '', updated: 'not a date' });
    expect(skillsToExpire([mangled], usage(), NOW)).toEqual([]);
  });

  it('holds the line exactly at the cutoff', () => {
    const inside = skill('just-inside', { created: daysAgo(ARCHIVE_AFTER_DAYS - 1), updated: daysAgo(ARCHIVE_AFTER_DAYS - 1) });
    const outside = skill('just-outside', { created: daysAgo(ARCHIVE_AFTER_DAYS + 1), updated: daysAgo(ARCHIVE_AFTER_DAYS + 1) });
    expect(skillsToExpire([inside, outside], usage(), NOW)).toEqual(['just-outside']);
  });

  it('reports every expiry in one batch', () => {
    const old = { created: daysAgo(120), updated: daysAgo(120) };
    const skills = [skill('a', old), skill('b'), skill('c', old)];
    expect(skillsToExpire(skills, usage(), NOW)).toEqual(['a', 'c']);
  });
});

describe('the window follows how often the task is expected', () => {
  const idle = (slug: string, days: number, recurs?: LifecycleSkill['recurs']): LifecycleSkill =>
    skill(slug, { created: daysAgo(days), updated: daysAgo(days), ...(recurs ? { recurs } : {}) });

  it('keeps a monthly skill through 100 idle days and a yearly one through 500', () => {
    // The two cases a single short window gets wrong: an invoice sent every
    // month or two, and a task that comes round once a year.
    const skills = [idle('monthly-invoice', 100, 'monthly'), idle('tax-return', 500, 'yearly'), idle('no-estimate', 100)];
    expect(skillsToExpire(skills, usage(), NOW)).toEqual(['no-estimate']);
  });

  it('retires a weekly skill sooner than one with no rhythm', () => {
    const skills = [idle('weekly-report', 70, 'weekly'), idle('now-and-then', 70, 'occasional')];
    expect(skillsToExpire(skills, usage(), NOW)).toEqual(['weekly-report']);
  });

  it('still retires a slow skill once several of its periods have passed', () => {
    const skills = [idle('monthly-gone', 160, 'monthly'), idle('yearly-gone', 801, 'yearly'), idle('quarterly-kept', 399, 'quarterly')];
    expect(skillsToExpire(skills, usage(), NOW)).toEqual(['monthly-gone', 'yearly-gone']);
  });

  it('counts a use against the same window', () => {
    const used = idle('monthly-used', 300, 'monthly');
    expect(skillsToExpire([used], usage({ 'monthly-used': { count: 4, lastUsedAt: daysAgo(140) } }), NOW)).toEqual([]);
    expect(skillsToExpire([used], usage({ 'monthly-used': { count: 4, lastUsedAt: daysAgo(151) } }), NOW)).toEqual(['monthly-used']);
  });

  it('gives no estimate and "occasional" the window every skill had before', () => {
    expect(archiveAfterDays(undefined)).toBe(ARCHIVE_AFTER_DAYS);
    expect(archiveAfterDays('occasional')).toBe(ARCHIVE_AFTER_DAYS);
  });

  it('picks the slowest rhythm of a merged group', () => {
    expect(slowestRecurrence(['weekly', undefined, 'yearly', 'monthly'])).toBe('yearly');
    expect(slowestRecurrence(['weekly', 'occasional'])).toBe('occasional');
    expect(slowestRecurrence([undefined])).toBeUndefined();
  });
});
