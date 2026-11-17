import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillsRoot } from '../workspace/paths';
import type { SkillRecurrence } from './contract';
import { DISABLED_MARKER, syncSkillsIgnore } from './ignore';
import { listSkillRecords } from './store';
import { readUsage, type SkillsUsage } from './usage';

// The deterministic half of skill upkeep: a clock, no model call.
//
// Some procedures are worth keeping forever (extracting a transcript — every video
// from now on). Some are a transcript of one afternoon (wiring up one dashboard,
// identifying one host). Nothing in Stem told them apart, at authoring time or
// after, and the curator was never going to: it is KEEP-by-default on archive for
// good reasons (see skills/curate.ts) and in the library's whole recorded history
// it has volunteered exactly zero archives. So the routine retirements move here,
// where they cost nothing and cannot hallucinate. A one-time skill retires itself
// by having nothing happen to it. See SKILLS-UPKEEP.md, "Defect 3".
//
// Ported from Hermes' apply_automatic_transitions() (agent/curator.py:276), minus
// its `stale` intermediate state — Stem has one enabled/disabled boolean that the
// Manage panel already renders, and a warning state nobody would see is bookkeeping
// for its own sake.
//
// Two invariants this must not break:
//
//   - `source: 'user'` skills are never touched. The user's own files are not ours
//     to retire, same rule the curator runs under.
//   - Archiving is the reversible marker, never a delete: the same `.disabled` file
//     the Manage toggle writes, plus one republish of the ignore file (skills/
//     ignore.ts) so the backend actually stops loading it.
//
// What it deliberately does NOT do: reactivate. Hermes moves a skill back to active
// when activity resumes, but a disabled skill in Stem is excluded from retrieval
// entirely — it can never be inlined, so it can never earn the use that would
// revive it. An archive here is permanent until a person flips the toggle in
// Manage. That one-way door is why the cutoff is a long 90 days rather than
// Hermes' 30-day first warning: the failure mode we are protecting against is
// retiring a skill for having been unlucky, and the cost of retiring one too late
// is a line in a list.
//
// The window is not one number. A skill carries an estimate of how often its task
// comes up again (`recurs`, contract.ts), written by whoever wrote the skill and
// correctable by the user in Manage, and the clock waits several of those periods
// before it gives up: a yearly task is not retired between two years, and a
// weekly one that has sat for two months was estimated wrong or is dead. No
// estimate reads as `occasional`, the 90 days every skill had before.
//
// It is also NOT gated on `isRecallEnabled()` or on the library being large enough
// to be worth a model call. Those are the curator's gates, and they belong to the
// thing that spends money. A lifecycle that stops running when the memory toggle
// is off is not a lifecycle; the callers therefore run this before, and outside,
// curateSkills' own early returns.

/**
 * Untouched for this long → archived, for a skill with no rhythm or no estimate.
 * See the header for why it is not shorter.
 */
export const ARCHIVE_AFTER_DAYS = 90;

/**
 * Days without anything happening before a skill is archived, by how often its
 * task is expected. Each is several missed periods, never one: the estimate is a
 * guess, a holiday is a month, and an archive is a one-way door (see the header).
 * `weekly` is the only one shorter than the old fixed window.
 */
export const ARCHIVE_AFTER_DAYS_BY_RECURRENCE: Readonly<Record<SkillRecurrence, number>> = {
  weekly: 60,
  monthly: 150,
  quarterly: 400,
  yearly: 800,
  occasional: ARCHIVE_AFTER_DAYS
};

/** How long a skill with this estimate may sit untouched. */
export function archiveAfterDays(recurs: SkillRecurrence | undefined): number {
  return recurs ? ARCHIVE_AFTER_DAYS_BY_RECURRENCE[recurs] : ARCHIVE_AFTER_DAYS;
}

/**
 * The estimate with the longest window. A merge keeps this one: the merged skill
 * serves every job it absorbed, and the slowest of them sets how long it waits.
 */
export function slowestRecurrence(estimates: ReadonlyArray<SkillRecurrence | undefined>): SkillRecurrence | undefined {
  let slowest: SkillRecurrence | undefined;
  for (const recurs of estimates) {
    if (recurs && (!slowest || archiveAfterDays(recurs) > archiveAfterDays(slowest))) slowest = recurs;
  }
  return slowest;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The subset of SkillRecord the clock reads. `SkillRecord` satisfies it as-is. */
export interface LifecycleSkill {
  slug: string;
  source: 'user' | 'agent';
  enabled: boolean;
  created: string;
  updated: string;
  recurs?: SkillRecurrence;
}

/** Epoch ms for an ISO string, or null for absent/blank/unparseable. */
function at(iso: string | undefined): number | null {
  // `''` is not a timestamp: readUsage() writes an empty `lastUsedAt` as a
  // placeholder for an entry that has only ever been injected. Date.parse('') is
  // NaN, so this catches it — but it is worth naming, because reading '' as an
  // epoch-0 date would archive every injected-but-never-followed skill on the
  // first pass.
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The pure decision: which agent-authored skills have gone quiet long enough to
 * retire. `now` is injectable so the tests do not have to move the filesystem's
 * clock.
 *
 * The anchor is `max(created, updated, lastUsedAt)` — the latest moment anything
 * happened to this skill, not just the latest recorded *use*:
 *
 *   - `updated` counts because a patch is evidence of live use. The assistant
 *     rewrites a skill at the moment it follows one and finds it wrong, which is a
 *     stronger signal than the use counter and is recorded even when grading
 *     misses. Hermes anchors the same way, on max(last_used_at, last_viewed_at,
 *     last_patched_at) (tools/skill_usage.py:146-163).
 *   - `created` counts so a brand-new skill with no history at all is not born
 *     already expired, and so we need no migration to seed records for the skills
 *     that predate usage tracking.
 *
 * The first draft of this plan anchored on `lastUsedAt ?? created` and that is a
 * trap worth remembering: grading credits are getting rarer by design, so
 * `lastUsedAt` freezes for skills that are still being followed — and the whole
 * library would then age out together, on a fixed fuse lit at creation.
 *
 * A skill with no parseable timestamp anywhere (hand-mangled front-matter) is
 * KEPT. We know nothing about its age, and "unknown" must not read as "ancient".
 */
export function skillsToExpire(
  skills: readonly LifecycleSkill[],
  usage: SkillsUsage,
  now: Date = new Date()
): string[] {
  const expired: string[] = [];
  for (const skill of skills) {
    if (skill.source !== 'agent') continue; // never the user's own files
    if (!skill.enabled) continue; // already off, by hand or by an earlier pass
    const anchors = [at(skill.created), at(skill.updated), at(usage.skills[skill.slug]?.lastUsedAt)];
    let latest: number | null = null;
    for (const ms of anchors) if (ms !== null && (latest === null || ms > latest)) latest = ms;
    if (latest === null) continue; // see the doc comment: unknown age keeps the skill
    if (latest < now.getTime() - archiveAfterDays(skill.recurs) * DAY_MS) expired.push(skill.slug);
  }
  return expired;
}

/**
 * Run the clock over the library on disk. Returns how many skills it retired.
 *
 * Thin IO around `skillsToExpire`: read the records and the usage sidecar, write a
 * `.disabled` marker per expiry, then republish the ignore file ONCE for the whole
 * batch — the marker alone is invisible to the backend (skills/ignore.ts explains
 * why). Every step is best-effort, and a missing skills directory yields 0 rather
 * than a throw: this runs from a background timer whose caller can do nothing
 * useful with an exception.
 */
export function applyAutomaticTransitions(now: Date = new Date()): number {
  const records = listSkillRecords();
  if (records.length === 0) return 0;
  const expired = skillsToExpire(records, readUsage(), now);
  if (expired.length === 0) return 0;

  const bySlug = new Map(records.map((r) => [r.slug, r]));
  const root = skillsRoot();
  let archived = 0;
  for (const slug of expired) {
    try {
      writeFileSync(
        join(root, slug, DISABLED_MARKER),
        `archived by the Stem skills lifecycle clock: untouched for over ${archiveAfterDays(bySlug.get(slug)?.recurs)} days\n`,
        'utf8'
      );
      archived += 1;
    } catch (error) {
      console.warn(`[skills lifecycle] could not archive "${slug}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (archived) syncSkillsIgnore(root);
  return archived;
}
