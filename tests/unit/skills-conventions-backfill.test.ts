// Preferences memory learned before the convention pass existed reach the skill
// author once, a batch per distill pass, on every install, not only on the one
// someone ran a script against.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const skillsDir = join(tmpdir(), `stem-skills-backfill-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import { recallStore } from '../../src/server/recall/store';
import { backfillConventions } from '../../src/server/startup/recall-tasks';
import { initSkills } from '../../src/server/startup/skills';
import { updateSkillsSettings } from '../../src/server/workspace/settings';
import type { ChatBackend } from '../../src/server/backend';

afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

const STATE = join(skillsDir, '.conventions-backfill.json');
const evidence = (threadId: string) => [
  { messageId: null, threadId, role: 'user' as const, timestamp: Math.floor(Date.now() / 1000), excerpt: 'x', origin: 'user_message' as const, folderId: null, relPath: null }
];

describe('backfillConventions', () => {
  let prompts: string[];
  let approvals: Array<{ ctx?: { threadId?: string } }>;

  beforeEach(() => {
    mkdirSync(process.env.STEM_STATE_DIR!, { recursive: true });
    prompts = [];
    approvals = [];
    const runtime = {
      setSkillBridge: () => undefined,
      setTurnSettledHook: () => undefined,
      requestSkillApproval: async (_proposal: unknown, ctx?: { threadId?: string }) => {
        approvals.push({ ctx });
        return { approved: false };
      },
      learnEvidence: async () => [{ userText: 'Make the invoice, no kros.sk.', assistantText: 'Done.', trace: [], tainted: false }],
      recentTurnTrace: () => null,
      complete: async (prompt: string) => {
        prompts.push(prompt);
        return JSON.stringify({ skill: null, reason: 'a taste' });
      }
    } as unknown as ChatBackend;
    initSkills({ runtime, onChanged: () => undefined, busyWithin: () => false });
  });

  it('skips while skills are off, then works through old preferences in batches and stops at the pinned boundary', async () => {
    // 25 preferences in 25 chats, plus facts the pass must leave alone.
    for (let i = 0; i < 25; i++) {
      recallStore.upsertFact(`The user wants report ${i} to include the downtime.`, { source: 'distilled', category: 'preference', evidence: evidence(`thread-old-${i}`) });
    }
    recallStore.upsertFact('The user lives in Bratislava.', { source: 'distilled', category: 'location', evidence: evidence('thread-loc') });
    recallStore.upsertFact('The user prefers window seats.', { source: 'explicit', category: 'preference', evidence: evidence('thread-explicit') });

    await updateSkillsSettings({ mode: 'off' });
    await backfillConventions();
    expect(prompts).toHaveLength(0);

    await updateSkillsSettings({ mode: 'ask' });
    await backfillConventions();
    expect(prompts).toHaveLength(20);
    const first = JSON.parse(readFileSync(STATE, 'utf8'));
    expect(first.done).toBe(false);

    // Learned after the boundary was pinned: the forward pass's, not this one's.
    recallStore.upsertFact('The user wants invoices filed by month.', { source: 'distilled', category: 'preference', evidence: evidence('thread-new') });
    await backfillConventions();
    expect(prompts).toHaveLength(25);
    expect(prompts.some((p) => p.includes('filed by month'))).toBe(false);
    expect(JSON.parse(readFileSync(STATE, 'utf8'))).toMatchObject({ done: true, upTo: first.upTo });

    await backfillConventions();
    expect(prompts).toHaveLength(25);
  });
});
