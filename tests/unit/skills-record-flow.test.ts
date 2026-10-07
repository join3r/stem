// A recording's draft card on the server: written from the example, rewritten
// with a second one, saved through the bridge as the user's own request, and
// stopped before it quietly replaces or duplicates a skill already there.
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const skillsDir = join(tmpdir(), `stem-skills-record-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import { initSkills } from '../../src/server/startup/skills';
import {
  answerRecordingDraft,
  discardRecordingDraft,
  practiceSkillFor,
  practiceStarted,
  recordSkill,
  recordingDrafts,
  saveRecordingDraft,
  setRecordingDraftPush
} from '../../src/server/startup/record-skills';
import { setChatPrivate } from '../../src/server/workspace/chats';
import type { ChatBackend } from '../../src/server/backend';
import { userDataRoot } from '../../src/server/workspace/paths';
import type { RecordingDraft, RecordingExample } from '../../src/shared/types';

beforeAll(() => mkdir(userDataRoot(), { recursive: true }));
afterAll(() => rm(skillsDir, { recursive: true, force: true }));

const BODY = `## When to use
When a supplier email confirms a delivery date for an agrisys order.

## Steps
1. Find the order number in the email subject and open the order in agrisys.
2. Set "Delivery date" to the confirmed date as DD.MM.YYYY and press Save.

## Verification
The order shows the new delivery date.`;

const example = (value: string): RecordingExample => ({
  id: `ex-${value}`,
  recordedAt: '2026-10-06T10:00:00.000Z',
  durationMs: 60_000,
  steps: [{ kind: 'type', t: 10, app: 'Arc', window: 'agrisys', field: 'Delivery date', value }],
  links: [],
  unmatched: [{ step: 0, value, shots: [] }]
});

describe('recording drafts', () => {
  let prompts: string[];
  let answer: Record<string, unknown>;
  let pushed: RecordingDraft[];

  beforeEach(() => {
    prompts = [];
    pushed = [];
    answer = {
      skill: { name: 'set-agrisys-delivery-date', description: 'Copy a confirmed delivery date from a supplier email into its agrisys order.', body: BODY },
      variables: [{ name: 'Delivery date', from: 'the confirmed date in the supplier email' }],
      questions: ['Is the order number always in the subject?']
    };
    const runtime = {
      setSkillBridge: () => undefined,
      setTurnSettledHook: () => undefined,
      requestSkillApproval: async () => ({ approved: true }),
      complete: async (prompt: string) => {
        prompts.push(prompt);
        return JSON.stringify(answer);
      }
    } as unknown as ChatBackend;
    initSkills({ runtime, onChanged: () => undefined, busyWithin: () => false });
    setRecordingDraftPush((d) => pushed.push(d));
  });

  it('writes a draft, rewrites it with another example, and saves it', async () => {
    const draft = await recordSkill(undefined, 'thread-rec', example('14.10.2026'));
    expect(draft).toMatchObject({ status: 'ready', variables: [{ name: 'Delivery date' }], questions: ['Is the order number always in the subject?'] });
    expect(pushed.map((d) => d.status)).toEqual(['drafting', 'ready']);

    const again = await recordSkill(undefined, 'thread-rec', example('21.10.2026'), draft.id);
    expect(again.id).toBe(draft.id);
    expect(again.examples).toHaveLength(2);
    expect(prompts[1]).toContain('--- Recording 2 of 2');
    expect(prompts[1]).toContain('Your current draft of this skill');

    const answered = await answerRecordingDraft(draft.id, [{ question: 'Is the order number always in the subject?', answer: 'Yes, as PO-nnnn.' }]);
    expect(prompts[2]).toContain('A: Yes, as PO-nnnn.');
    expect(answered?.answers).toHaveLength(1);

    const saved = await saveRecordingDraft(draft.id, null);
    expect(saved).toMatchObject({ ok: true, draft: { status: 'saved', savedSlug: 'set-agrisys-delivery-date' } });
    const file = await readFile(join(skillsDir, 'set-agrisys-delivery-date', 'SKILL.md'), 'utf8');
    expect(file).toContain('origin: "recorded"');
    expect((await recordingDrafts('thread-rec'))[0].status).toBe('saved');
  });

  it('asks before replacing a skill of the same name, then updates it', async () => {
    const draft = await recordSkill(undefined, 'thread-dup', example('1.1.2027'));
    const edited = { ...draft.skill!, body: BODY.replace('press Save', 'press Save and close the tab') };
    const first = await saveRecordingDraft(draft.id, edited);
    expect(first.ok).toBe(false);
    expect(first.message).toMatch(/looks like the skill "set-agrisys-delivery-date"/);
    expect(first.draft?.duplicateOf).toBe('set-agrisys-delivery-date');
    const second = await saveRecordingDraft(draft.id, null);
    expect(second.ok).toBe(true);
    expect(await readFile(join(skillsDir, 'set-agrisys-delivery-date', 'SKILL.md'), 'utf8')).toContain('close the tab');
  });

  it('keeps a failed draft as a card with the reason', async () => {
    answer = { skill: null, reason: 'only window switching' };
    const draft = await recordSkill(undefined, 'thread-empty', example('x'));
    expect(draft).toMatchObject({ status: 'failed', message: expect.stringMatching(/only window switching/) });
    expect((await discardRecordingDraft(draft.id))?.status).toBe('discarded');
  });

  it('hands a practice turn only a ready draft of its own chat, and marks where the run began', async () => {
    const draft = await recordSkill(undefined, 'thread-practice', example('5.5.2027'));
    expect(await practiceSkillFor('thread-practice', draft.id)).toMatchObject({ name: 'set-agrisys-delivery-date' });
    expect(await practiceSkillFor('thread-other', draft.id)).toBeNull();
    expect(await practiceSkillFor('thread-practice', 'no-such-draft')).toBeNull();
    expect(await practiceSkillFor('thread-practice', undefined)).toBeNull();
    await practiceStarted(draft.id, 'turn-1');
    expect((await recordingDrafts('thread-practice'))[0].practice).toEqual({ startTurnId: 'turn-1', turns: 0 });
    await discardRecordingDraft(draft.id);
    expect(await practiceSkillFor('thread-practice', draft.id)).toBeNull();
  });

  it('refuses private chats and other threads’ drafts', async () => {
    await setChatPrivate('thread-private-rec');
    await expect(recordSkill(undefined, 'thread-private-rec', example('x'))).rejects.toThrow(/private chat/);
    const draft = await recordSkill(undefined, 'thread-a', example('x'));
    await expect(recordSkill(undefined, 'thread-b', example('y'), draft.id)).rejects.toThrow(/gone/);
  });
});
