import type { LlmClient } from '../recall/llm';
import type { SkillDraft } from './contract';
import type { SkillCase } from './cases';

// The check in front of every change Stem makes to a skill on its own.
//
// A patch used to be written as soon as the author returned one. Nothing asked
// whether it was better than the text it replaced, and the evidence says that
// question matters more than how the patch was produced: in a controlled study of
// self-changing skills, 55 of 388 rewrites set a new best, and a check against
// stored cases chose a better skill in 9 of 14 settings (arXiv 2608.02636).
// Hermes writes patches unchecked too; its own GEPA tool, which does check, is a
// separate manual run that ends in a human-reviewed pull request.
//
// So the check reads the current text, the proposed text, why it was changed,
// and the recorded uses of the skill (cases.ts), and answers keep or reject.
// It is one model call, and only on a change: a turn that changes no skill pays
// nothing. The user's own requests are never checked (bridge.ts): they decided.

export const SKILL_REVIEW_INSTRUCTIONS = `You check a proposed change to a saved skill before it is written. A skill is a procedure that an assistant follows for one kind of work. The change was made automatically, and most automatic changes make a skill worse, so keep it only when the evidence supports it.

Keep the change only if ALL of these hold:
- It fixes a real problem: the reason given, a use below that went wrong, or a step that is plainly wrong in the current text.
- Every step that an accepted use below relied on still works the same way, unless the change says why that step no longer applies.
- It keeps the skill's job. It does not widen the skill to other work, and it does not narrow it to one case with names, dates or numbers that will be different next time.
- It writes instructions, not a history of what happened.

Reply with ONLY a JSON object, no prose and no markdown fences:
{"keep": true, "reason": "<one short clause>"}
or
{"keep": false, "reason": "<one short clause that names what the change breaks or lacks>"}`;

/** Recorded uses shown to the check, newest kept. */
const REVIEW_CASES = 8;

export interface ReviewInput {
  before: { name: string; description: string; body: string };
  after: SkillDraft;
  /** Why the change was made, when the caller knows (a correction, a report, a rewrite). */
  why?: string;
  cases: readonly SkillCase[];
}

export type ReviewVerdict = { keep: boolean; reason: string };

const OUTCOME_TEXT: Record<SkillCase['outcome'], string> = {
  pending: 'not known yet',
  accepted: 'accepted',
  corrected: 'the user corrected it',
  redone: 'the user asked again',
  reported: 'the assistant reported a wrong step',
  unclear: 'unclear',
  expired: 'not known'
};

/** One recorded use as evidence lines. Exported for the rewrite path (author.ts). */
export function renderCase(c: SkillCase, n: number): string {
  const lines = [`Use ${n} (${c.at.slice(0, 10)}, version ${c.version}) — ${OUTCOME_TEXT[c.outcome]}`];
  if (c.request) lines.push(`  Request: ${c.request}`);
  if (c.did) lines.push(`  What the assistant did:\n    ${c.did.replace(/\n/g, '\n    ')}`);
  if (c.reply) lines.push(`  Reply began: ${c.reply}`);
  if (c.feedback) lines.push(`  What was wrong: ${c.feedback}`);
  return lines.join('\n');
}

function renderSkill(s: { name: string; description: string; body: string }): string {
  return `name: ${s.name}\ndescription: ${s.description}\n\n${s.body.trim()}`;
}

export function buildReviewPrompt(input: ReviewInput): string {
  const parts = [SKILL_REVIEW_INSTRUCTIONS, '---', `The current skill:\n${renderSkill(input.before)}`, `The proposed skill:\n${renderSkill(input.after)}`];
  if (input.why?.trim()) parts.push(`Why it was changed:\n${input.why.trim()}`);
  const cases = input.cases.filter((c) => c.outcome !== 'pending' && c.outcome !== 'expired').slice(-REVIEW_CASES);
  parts.push(
    cases.length > 0
      ? `Recorded uses of the current skill, oldest first:\n${cases.map((c, i) => renderCase(c, i + 1)).join('\n\n')}`
      : 'Recorded uses of the current skill: none yet. Judge the change on the text alone.'
  );
  return parts.join('\n\n');
}

/** Parse the verdict. Anything but a clear keep or reject is no answer (null). */
export function parseReviewReply(output: string): ReviewVerdict | null {
  const trimmed = String(output ?? '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { keep?: unknown; reason?: unknown };
    if (typeof parsed.keep !== 'boolean') return null;
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.replace(/\s+/g, ' ').trim().slice(0, 240) : parsed.keep ? 'the change is supported' : 'the change is not supported by the evidence';
    return { keep: parsed.keep, reason };
  } catch {
    // quiet: null is the answer "could not judge", which the bridge handles.
    return null;
  }
}

/**
 * Ask the model. Null when it could not answer (an error, or a reply that is
 * neither keep nor reject): the bridge decides what an unchecked change means
 * for each mode.
 */
export async function reviewSkillChange(llm: LlmClient, input: ReviewInput): Promise<ReviewVerdict | null> {
  let reply: string;
  try {
    reply = await llm.complete(buildReviewPrompt(input));
  } catch {
    // quiet: the caller logs the null outcome with the skill name.
    return null;
  }
  return parseReviewReply(reply);
}
