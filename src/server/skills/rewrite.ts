import type { LlmClient } from '../recall/llm';
import { authorSkill, type AuthorOutcome } from './author';
import type { SkillCase } from './cases';
import { renderCase } from './review';

// The rewrite from all cases: for a skill that went wrong REWRITE_AFTER_FAILURES
// times since its last rewrite (skills/cases.ts).
//
// A patch after one turn sees one case, and a skill patched that way, one turn
// at a time, drifts into a log of incidents. The methods that improve skills
// reliably share two things (survey, arXiv 2606.11435): they read a batch of
// uses, failures and successes together, and they keep the diagnosis apart from
// the rewrite. So this is two calls. The first says what in the skill caused
// the failures and what the accepted uses relied on, and writes no skill. The
// second rewrites from that diagnosis. The result then goes through the same
// check as every other automatic change (review.ts, via the bridge).

export const SKILL_DIAGNOSE_INSTRUCTIONS = `You review how a saved skill worked in practice. A skill is a procedure that an assistant follows for one kind of work. Below are the skill and its recorded uses: the request, what the assistant did, the start of its reply, and how the result ended.

Find what in the skill caused the uses that went wrong (corrected, asked again, or reported as wrong). For each problem, name the step, the uses that show it, and what the step should say instead. Then list what the accepted uses relied on, which a fix must keep. Do not write the new skill.

A failure is not always the skill's fault: the user may have wanted other work, or a tool may have been down. Report no problems when that is the case.

Reply with ONLY a JSON object, no prose and no markdown fences:
{"problems": [{"step": "...", "evidence": "uses 2 and 5", "fix": "..."}], "keep": ["..."]}`;

export interface SkillDiagnosis {
  problems: Array<{ step: string; evidence: string; fix: string }>;
  keep: string[];
}

/** Uses shown to the diagnosis, newest kept: all of CASES_KEPT. */
const DIAGNOSE_CASES = 12;

export function buildDiagnosePrompt(skill: { name: string; description: string; body: string }, cases: readonly SkillCase[]): string {
  const shown = cases.filter((c) => c.outcome !== 'pending' && c.outcome !== 'expired').slice(-DIAGNOSE_CASES);
  return [
    SKILL_DIAGNOSE_INSTRUCTIONS,
    '---',
    `The skill:\nname: ${skill.name}\ndescription: ${skill.description}\n\n${skill.body.trim()}`,
    `Recorded uses, oldest first:\n${shown.map((c, i) => renderCase(c, i + 1)).join('\n\n')}`
  ].join('\n\n');
}

export function parseDiagnosis(output: string): SkillDiagnosis | null {
  const trimmed = String(output ?? '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { problems?: unknown; keep?: unknown };
    if (!Array.isArray(parsed.problems)) return null;
    const text = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
    const problems = parsed.problems.flatMap((p) => {
      if (!p || typeof p !== 'object') return [];
      const r = p as Record<string, unknown>;
      const fix = text(r.fix);
      return fix ? [{ step: text(r.step), evidence: text(r.evidence), fix }] : [];
    });
    const keep = Array.isArray(parsed.keep) ? parsed.keep.map(text).filter(Boolean) : [];
    return { problems, keep };
  } catch {
    // quiet: null is "no diagnosis", which the caller logs and spends the cases on.
    return null;
  }
}

export function renderDiagnosis(d: SkillDiagnosis): string {
  const lines = d.problems.map((p, i) => `${i + 1}. ${p.step ? `Step: ${p.step}. ` : ''}${p.evidence ? `Shown by ${p.evidence}. ` : ''}Fix: ${p.fix}`);
  if (d.keep.length > 0) lines.push('', 'The accepted uses relied on:', ...d.keep.map((k) => `- ${k}`));
  return lines.join('\n');
}

export type RewriteOutcome =
  | AuthorOutcome
  | { ok: false; reason: 'healthy' | 'no-diagnosis'; detail: string; attempts: number };

/**
 * Diagnose, then rewrite. `healthy` when the diagnosis finds no problem in the
 * skill; the draft that comes back still has to pass the bridge's check.
 */
export async function rewriteSkill(
  llm: LlmClient,
  skill: { name: string; description: string; body: string },
  cases: readonly SkillCase[],
  machine?: string
): Promise<RewriteOutcome> {
  let reply: string;
  try {
    reply = await llm.complete(buildDiagnosePrompt(skill, cases));
  } catch (error) {
    // quiet: the outcome carries the reason to the caller's log line.
    return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error), attempts: 1 };
  }
  const diagnosis = parseDiagnosis(reply);
  if (!diagnosis) return { ok: false, reason: 'no-diagnosis', detail: 'the diagnosis did not return the JSON shape', attempts: 1 };
  if (diagnosis.problems.length === 0) return { ok: false, reason: 'healthy', detail: 'the failures were not caused by the skill', attempts: 1 };
  const outcome = await authorSkill(llm, {
    trace: [],
    userText: '',
    assistantText: '',
    existing: skill,
    rewrite: true,
    cases,
    diagnosis: renderDiagnosis(diagnosis),
    machine
  });
  return { ...outcome, attempts: outcome.attempts + 1 };
}
