// The passes that act on the case file (startup/skills.ts): a correction patches
// the skill it corrected, a skill that keeps going wrong is diagnosed and
// rewritten from all of its uses, and both go through the check first.
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const skillsDir = join(tmpdir(), `stem-skills-revise-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import { initSkills, queueSkillRevisions } from '../../src/server/startup/skills';
import {
  applySkillOutcomes,
  casesAwaitingVerdict,
  correctionsToRoute,
  recordSkillCases,
  REWRITE_AFTER_FAILURES,
  skillsDueForRewrite
} from '../../src/server/skills/cases';
import { readSkillRecord, saveSkill } from '../../src/server/skills/store';
import { SKILL_REVIEW_INSTRUCTIONS } from '../../src/server/skills/review';
import { SKILL_DIAGNOSE_INSTRUCTIONS } from '../../src/server/skills/rewrite';
import { SKILL_CORRECTION_INSTRUCTIONS, SKILL_REWRITE_INSTRUCTIONS } from '../../src/server/skills/author';
import { logFlushed } from '../../src/server/log';
import type { LearnTurn } from '../../src/server/skills/thread-evidence';
import type { SettledTurnTrace } from '../../src/server/pi/normalize';
import type { ChatBackend } from '../../src/server/backend';

afterAll(() => rm(skillsDir, { recursive: true, force: true }));

const BODY = `## When to use
When the user asks for a reply to a mail.

## Steps
1. Draft the reply with \`fastmail.draft_email\`.
2. Sign it "On behalf of the user".

## Verification
The draft is in the Drafts folder.`;
const FIXED = BODY.replace('On behalf of the user', 'Stem, on behalf of the user');
const SKILL = { name: 'draft-mail-replies', description: 'Use when the user asks Stem to draft a reply to a mail they received.', body: BODY };

const evidence: LearnTurn[] = [
  { turnId: 'turn-0', userText: 'Reply to Peter that Friday works.', assistantText: 'Drafted.', trace: [{ id: 'c1', name: 'fastmail.draft_email' }], tainted: false },
  { turnId: 'turn-1', userText: 'No, sign it as Stem, on behalf of me.', assistantText: 'Re-signed.', trace: [{ id: 'c2', name: 'fastmail.draft_email' }], tainted: false }
];

let prompts: string[];
let verdict: string;
let authored: string;
let diagnosis: string;

function use(turnId: string, threadId = 'thread-mail'): SettledTurnTrace {
  return {
    threadId,
    turnId,
    endedAt: Date.now() - 60_000,
    userText: 'Reply to Peter that Friday works.',
    assistantText: 'Drafted.',
    trace: [],
    skillsInjected: [SKILL.name],
    skillsGradedUsed: [SKILL.name],
    skillsReported: [],
    memoryTainted: false,
    isScheduled: false
  };
}

/** One use of the skill, graded off the user's next message. */
function graded(turnId: string, outcome: 'corrected' | 'redone' | 'accepted', feedback?: string, threadId = 'thread-mail'): void {
  recordSkillCases(use(turnId, threadId), new Map([[SKILL.name, readSkillRecord(SKILL.name)?.version ?? 1]]));
  const { listed } = casesAwaitingVerdict([{ id: 1, threadId, turnId: `${turnId}-next`, role: 'user', ts: Date.now() / 1000 }], 6);
  applySkillOutcomes(listed, [{ key: 1, outcome, ...(feedback ? { feedback } : {}) }]);
}

beforeEach(async () => {
  await rm(skillsDir, { recursive: true, force: true });
  prompts = [];
  verdict = '{"keep": true, "reason": "it fixes the signature"}';
  authored = JSON.stringify({ skill: { ...SKILL, body: FIXED } });
  diagnosis = '{"problems":[{"step":"2","evidence":"uses 1 to 3","fix":"Sign as Stem, on behalf of the user."}],"keep":["the draft tool"]}';
  const runtime = {
    setSkillBridge: () => undefined,
    setTurnSettledHook: () => undefined,
    requestSkillApproval: async () => ({ approved: true }),
    learnEvidence: async () => evidence,
    recentTurnTrace: () => null,
    complete: async (prompt: string) => {
      prompts.push(prompt);
      if (prompt.startsWith(SKILL_REVIEW_INSTRUCTIONS)) return verdict;
      if (prompt.startsWith(SKILL_DIAGNOSE_INSTRUCTIONS)) return diagnosis;
      return authored;
    }
  } as unknown as ChatBackend;
  initSkills({ runtime, onChanged: () => undefined, busyWithin: () => false });
  saveSkill(SKILL, { origin: 'turn' });
});

describe('a correction', () => {
  it('patches the corrected skill from the conversation, after the check keeps it', async () => {
    graded('turn-0', 'corrected', 'Sign mail as Stem, on behalf of the user.');
    await queueSkillRevisions();
    const author = prompts.find((p) => p.includes(SKILL_CORRECTION_INSTRUCTIONS));
    expect(author).toBeDefined();
    expect(author).toContain('What the user said was wrong with the result:\nSign mail as Stem, on behalf of the user.');
    expect(author).toContain('No, sign it as Stem, on behalf of me.');
    expect(prompts.some((p) => p.startsWith(SKILL_REVIEW_INSTRUCTIONS))).toBe(true);
    expect(readSkillRecord(SKILL.name)).toMatchObject({ version: 2, change: 'Changed after your correction: Sign mail as Stem, on behalf of the user.' });
    expect(correctionsToRoute()).toEqual([]);
    await logFlushed();
    expect(await readFile(process.env.STEM_LOG_FILE!, 'utf8')).toMatch(/\[skills\] correction pass \{"skill":"draft-mail-replies".*"reason":"saved"/);
  });

  it('writes nothing when the check rejects the patch, and does not try again', async () => {
    verdict = '{"keep": false, "reason": "it drops the verification step"}';
    graded('turn-0', 'corrected', 'Sign mail as Stem.');
    await queueSkillRevisions();
    expect(readSkillRecord(SKILL.name)?.version).toBe(1);
    const calls = prompts.length;
    await queueSkillRevisions();
    expect(prompts).toHaveLength(calls);
  });

  it('never patches an imported skill', async () => {
    saveSkill({ ...SKILL, name: 'imported-skill' }, { origin: 'imported' });
    recordSkillCases({ ...use('turn-0'), skillsGradedUsed: ['imported-skill'] }, new Map([['imported-skill', 1]]));
    const { listed } = casesAwaitingVerdict([{ id: 1, threadId: 'thread-mail', turnId: 'next', role: 'user', ts: Date.now() / 1000 }], 6);
    applySkillOutcomes(listed, [{ key: 1, outcome: 'corrected', feedback: 'wrong' }]);
    await queueSkillRevisions();
    expect(prompts).toHaveLength(0);
    expect(correctionsToRoute()).toEqual([]);
  });
});

describe('a skill that keeps going wrong', () => {
  it(`is diagnosed and rewritten from all its uses after ${REWRITE_AFTER_FAILURES} failures`, async () => {
    for (let i = 0; i < REWRITE_AFTER_FAILURES; i++) graded(`turn-${i}`, i === 0 ? 'redone' : 'corrected', 'Sign as Stem.', `thread-${i}`);
    graded('turn-9', 'accepted', undefined, 'thread-9');
    expect(skillsDueForRewrite()).toEqual([SKILL.name]);
    await queueSkillRevisions();
    const diagnose = prompts.findIndex((p) => p.startsWith(SKILL_DIAGNOSE_INSTRUCTIONS));
    const rewrite = prompts.findIndex((p) => p.startsWith(SKILL_REWRITE_INSTRUCTIONS));
    expect(diagnose).toBeGreaterThanOrEqual(0);
    expect(rewrite).toBeGreaterThan(diagnose);
    expect(prompts[rewrite]).toContain('Fix: Sign as Stem, on behalf of the user.');
    expect(prompts[rewrite]).toContain('accepted');
    // One rewrite instead of three patches: the corrections are read by it.
    expect(prompts.filter((p) => p.includes(SKILL_CORRECTION_INSTRUCTIONS))).toHaveLength(0);
    expect(readSkillRecord(SKILL.name)?.change).toMatch(/^Rewritten from 4 recorded uses, 3 of which went wrong/);
    expect(skillsDueForRewrite()).toEqual([]);
    expect(correctionsToRoute()).toEqual([]);
  });

  it('stops after the diagnosis when the skill did not cause the failures', async () => {
    diagnosis = '{"problems":[],"keep":[]}';
    for (let i = 0; i < REWRITE_AFTER_FAILURES; i++) graded(`turn-${i}`, 'corrected', 'The mail server was down.', `thread-${i}`);
    await queueSkillRevisions();
    expect(prompts.filter((p) => p.startsWith(SKILL_REWRITE_INSTRUCTIONS))).toHaveLength(0);
    expect(readSkillRecord(SKILL.name)?.version).toBe(1);
    expect(skillsDueForRewrite()).toEqual([]);
  });
});
