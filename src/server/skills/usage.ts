import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { degrade } from '../degrade';
import { skillsRoot } from '../workspace/paths';

// Per-skill usage bookkeeping, kept in a sidecar JSON at the root of the skills
// dir (next to `.skills-rev` — pi's skill scanner only looks at directories with
// a SKILL.md, so top-level files are invisible to it). Deliberately NOT stored in
// SKILL.md front-matter: any SKILL.md write bumps `.skills-rev` and forces a
// backend reload, which a mere usage tick must never do. The Electron main
// process is the sole writer; the bridge subprocess never touches this file.
//
// Usage is advisory data for the Manage panel and the curator prompt — losing it
// (corrupt file, manual delete) costs nothing but history, so the reader is
// tolerant and simply starts over.

export const SKILLS_USAGE_FILE = '.skills-usage.json';

export interface SkillUsageEntry {
  count: number;
  lastUsedAt: string; // ISO
  /**
   * Times this skill was put in front of the model, and times the turn then
   * showed evidence of following it. Both feed the ranking blend (see
   * skills/inject.ts) the same way `times_injected`/`times_used` feed fact
   * ranking. Optional because entries written before the loop existed have
   * neither — a missing pair ranks exactly neutral, which is the right default
   * for a skill nobody has observed yet.
   */
  injected?: number;
  used?: number;
  /** Unix seconds of the last observation; the decay anchor for the usage rate. */
  lastGradedAt?: number;
}

export interface SkillsUsage {
  /** When tracking first ran here — a zero count only means "never since this". */
  trackingSince: string; // ISO
  skills: Record<string, SkillUsageEntry>;
}

function usageFile(): string {
  return join(skillsRoot(), SKILLS_USAGE_FILE);
}

function freshUsage(): SkillsUsage {
  return { trackingSince: new Date().toISOString(), skills: {} };
}

/** Tolerant read: a missing or corrupt file yields a fresh in-memory value
 *  (without writing — the next real write persists it). */
export function readUsage(): SkillsUsage {
  let raw: string;
  try {
    raw = readFileSync(usageFile(), 'utf8');
  } catch {
    // quiet: no sidecar yet is every install before the first tick, and
    // `ensureUsageTracking` writes one at startup.
    return freshUsage();
  }
  try {
    const data = JSON.parse(raw) as Partial<SkillsUsage> | null;
    if (!data || typeof data.trackingSince !== 'string') return freshUsage();
    const skills: Record<string, SkillUsageEntry> = {};
    for (const [slug, entry] of Object.entries(data.skills ?? {})) {
      if (!entry || typeof entry !== 'object') continue;
      const { count, lastUsedAt, injected, used, lastGradedAt } = entry as Partial<SkillUsageEntry>;
      const counted = typeof count === 'number' && Number.isInteger(count) && count > 0 && typeof lastUsedAt === 'string';
      const graded = typeof injected === 'number' && injected > 0;
      // An entry that has only ever been injected is still worth keeping — that is
      // the denominator of a skill nobody follows, which is exactly the signal the
      // ranking blend needs to demote it.
      if (!counted && !graded) continue;
      skills[slug] = {
        count: counted ? (count as number) : 0,
        lastUsedAt: counted ? (lastUsedAt as string) : '',
        ...(typeof injected === 'number' && injected >= 0 ? { injected } : {}),
        ...(typeof used === 'number' && used >= 0 ? { used } : {}),
        ...(typeof lastGradedAt === 'number' && lastGradedAt > 0 ? { lastGradedAt } : {})
      };
    }
    return { trackingSince: data.trackingSince, skills };
  } catch (error) {
    // Not recoverable: the next tick writes the fresh value over the file, so
    // every skill's injected/used history is gone and the ranking blend goes
    // neutral across the whole library with nothing to show for it.
    degrade('skills.usage', 'started skill usage history over', error);
    return freshUsage();
  }
}

function writeUsage(usage: SkillsUsage): void {
  try {
    writeFileSync(usageFile(), `${JSON.stringify(usage, null, 2)}\n`, 'utf8');
  } catch (error) {
    // Advisory data, so the tick is dropped rather than failing a turn — but a
    // write that keeps failing stops the injected-then-graded loop dead, and a
    // skill that is never observed can never be demoted.
    degrade('skills.usage', 'dropped a usage update', error);
  }
}

/** True when `slug` names a real skill directory (has a SKILL.md). */
function isSkillSlug(slug: string): boolean {
  return existsSync(join(skillsRoot(), slug, 'SKILL.md'));
}

/**
 * Anchor `trackingSince` by creating the sidecar if absent (never resets an
 * existing one) and drop entries for since-deleted skills. Called at startup.
 */
export function ensureUsageTracking(): void {
  try {
    mkdirSync(skillsRoot(), { recursive: true });
  } catch (error) {
    degrade('skills.usage', 'ran with no usage tracking at all', error);
    return;
  }
  if (!existsSync(usageFile())) writeUsage(freshUsage());
  pruneUsage();
}

/**
 * Count one use of each slug (callers dedupe per turn). Slugs without a SKILL.md
 * are ignored — this is the backstop that keeps top-level files (`.skills-rev`)
 * and stray directories out of the ledger. Returns how many slugs were counted;
 * writes only when non-zero.
 */
export function recordUses(slugs: string[], at: Date = new Date()): number {
  const real = slugs.filter(isSkillSlug);
  if (real.length === 0) return 0;
  const usage = readUsage();
  const iso = at.toISOString();
  for (const slug of real) {
    const entry = usage.skills[slug];
    usage.skills[slug] = { ...entry, count: (entry?.count ?? 0) + 1, lastUsedAt: iso };
  }
  writeUsage(usage);
  return real.length;
}

/**
 * Record that these skills were put in front of the model this turn — the
 * denominator of the injected-then-graded loop. Called once per turn from the
 * message builder; `recordGrades` supplies the numerator at turn end.
 */
export function recordInjections(slugs: string[]): number {
  const real = slugs.filter(isSkillSlug);
  if (real.length === 0) return 0;
  const usage = readUsage();
  for (const slug of real) {
    const entry = usage.skills[slug] ?? { count: 0, lastUsedAt: '' };
    usage.skills[slug] = { ...entry, injected: (entry.injected ?? 0) + 1 };
  }
  writeUsage(usage);
  return real.length;
}

/**
 * Record the outcome of a graded turn: `used` slugs get their numerator bumped,
 * and every injected slug gets its decay anchor moved so a skill that keeps being
 * offered and keeps being ignored actually falls in the ranking. Without touching
 * the anchor on a miss, a demoted skill's penalty would decay back to neutral on
 * the strength of nothing having happened.
 */
export function recordGrades(injected: string[], used: string[], at: Date = new Date()): void {
  const real = injected.filter(isSkillSlug);
  if (real.length === 0) return;
  const usage = readUsage();
  const hit = new Set(used);
  const seconds = Math.floor(at.getTime() / 1000);
  for (const slug of real) {
    const entry = usage.skills[slug] ?? { count: 0, lastUsedAt: '' };
    usage.skills[slug] = {
      ...entry,
      used: (entry.used ?? 0) + (hit.has(slug) ? 1 : 0),
      lastGradedAt: seconds
    };
  }
  writeUsage(usage);
}

/**
 * Fold merge losers' usage into the winner (summed count, latest lastUsedAt) so
 * proven utility survives curator merges. No-op when nothing was tracked.
 */
export function mergeUsage(winner: string, losers: string[]): void {
  const usage = readUsage();
  const tracked = losers.filter((slug) => slug !== winner && usage.skills[slug]);
  if (tracked.length === 0) return;
  const win = usage.skills[winner];
  let count = win?.count ?? 0;
  let lastUsedAt = win?.lastUsedAt ?? '';
  let injected = win?.injected ?? 0;
  let used = win?.used ?? 0;
  let lastGradedAt = win?.lastGradedAt ?? 0;
  for (const slug of tracked) {
    const entry = usage.skills[slug];
    count += entry.count;
    injected += entry.injected ?? 0;
    used += entry.used ?? 0;
    if (entry.lastUsedAt > lastUsedAt) lastUsedAt = entry.lastUsedAt;
    if ((entry.lastGradedAt ?? 0) > lastGradedAt) lastGradedAt = entry.lastGradedAt ?? 0;
    delete usage.skills[slug];
  }
  usage.skills[winner] = {
    count,
    lastUsedAt,
    ...(injected ? { injected } : {}),
    ...(used ? { used } : {}),
    ...(lastGradedAt ? { lastGradedAt } : {})
  };
  writeUsage(usage);
}

/** Drop entries whose skill directory is gone (manage_skill remove, merges). */
export function pruneUsage(): void {
  const usage = readUsage();
  const stale = Object.keys(usage.skills).filter((slug) => !isSkillSlug(slug));
  if (stale.length === 0) return;
  for (const slug of stale) delete usage.skills[slug];
  writeUsage(usage);
}
