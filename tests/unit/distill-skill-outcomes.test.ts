// The third duty of the distill call: how the user took each skill use, read off
// their next message (skills/cases.ts). It must cost no call of its own, leave
// every other distill prompt as it was, and close each case exactly once.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-distill-outcomes-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;
mkdirSync(skillsDir, { recursive: true });

import { recallStore as store } from '../../src/server/recall/store';
import * as distill from '../../src/server/recall/distill';
import { casesFor, recordSkillCases } from '../../src/server/skills/cases';
import type { SettledTurnTrace } from '../../src/server/pi/normalize';

afterAll(() => {
  store.close();
  rmSync(skillsDir, { recursive: true, force: true });
});

function useOf(threadId: string, turnId: string): SettledTurnTrace {
  return {
    threadId,
    turnId,
    endedAt: Date.now() - 60_000,
    userText: 'Reply to Peter that Friday works.',
    assistantText: 'The draft is in your Drafts folder.',
    trace: [],
    skillsInjected: ['draft-mail-replies'],
    skillsGradedUsed: ['draft-mail-replies'],
    skillsReported: [],
    memoryTainted: false,
    isScheduled: false
  };
}

describe('skill outcomes on the distill call', () => {
  it('sends no skill section when no use waits for a verdict', async () => {
    store.recordMessage({ threadId: 'A', turnId: 'a1', role: 'user', text: 'What is the weather like in Bratislava?' });
    const prompts: string[] = [];
    await distill.distillNewMessages({ complete: async (p) => (prompts.push(p), '{"claims":[]}') });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('THIRD DUTY');
    expect(prompts[0].startsWith(distill.DISTILL_INSTRUCTIONS)).toBe(true);
  });

  it('grades a use from the next user message and stores the correction', async () => {
    recordSkillCases(useOf('B', 'b1'), new Map([['draft-mail-replies', 2]]));
    store.recordMessage({ threadId: 'B', turnId: 'b2', role: 'user', text: 'No, sign it as Stem, on behalf of me.' });
    const prompts: string[] = [];
    const reply = JSON.stringify({ claims: [], skillOutcomes: [{ case: 1, outcome: 'corrected', feedback: 'Sign mail as Stem, on behalf of the user.' }] });
    await distill.distillNewMessages({ complete: async (p) => (prompts.push(p), reply) });
    expect(prompts[0]).toContain('Skill uses to grade:');
    expect(prompts[0]).toMatch(/\[case:1\] the skill "draft-mail-replies"/);
    expect(casesFor('draft-mail-replies')).toMatchObject([
      { threadId: 'B', outcome: 'corrected', feedback: 'Sign mail as Stem, on behalf of the user.', version: 2 }
    ]);
  });

  it('closes a use as unclear when the segment is given up, so it never meets a later message', async () => {
    recordSkillCases(useOf('C', 'c1'), new Map([['draft-mail-replies', 2]]));
    store.recordMessage({ threadId: 'C', turnId: 'c2', role: 'user', text: 'Thanks!' });
    // Garbage replies strike the segment until it is abandoned.
    for (let i = 0; i < distill.MAX_PARSE_STRIKES; i++) await distill.distillNewMessages({ complete: async () => 'garbage' });
    expect(casesFor('draft-mail-replies').find((c) => c.threadId === 'C')?.outcome).toBe('unclear');

    store.recordMessage({ threadId: 'C', turnId: 'c3', role: 'user', text: 'That was wrong, do it again.' });
    const prompts: string[] = [];
    await distill.distillNewMessages({ complete: async (p) => (prompts.push(p), '{"claims":[]}') });
    expect(prompts[0]).not.toContain('Skill uses to grade:');
  });
});
