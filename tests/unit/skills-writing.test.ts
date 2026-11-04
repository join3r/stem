// Writing skills: how the user wants a recurring kind of message written (the
// signature on their email drafts, the address it goes out from). Three pieces
// make them possible, and each had a reason to never happen before: the
// end-of-turn gate counted tool calls and a draft takes few, tool-overlap grading
// could not see a skill that names no tool, and a skill listed by name only could
// not be read at all.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skills-writing-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import { decideSettle, settleSkills, wroteMessageDraft } from '../../src/server/skills/settle';
import { gradeSkillUse, phrasesQuotedIn } from '../../src/server/skills/grade';
import { SkillBridge } from '../../src/server/skills/bridge';
import { SKILL_WRITING_INSTRUCTIONS } from '../../src/server/skills/author';
import type { SettledTurnTrace, TraceEntry } from '../../src/server/pi/normalize';

const DRAFT_BODY = `## When to use
When drafting an email reply for Vladimír to review and send.

## Steps
1. Save the draft with fastmail draft_email from join3r@gmail.com for private mail.
2. End with "Best regards," then \`Stem · Scheduling & coordination\` and \`On behalf of Vladimír Schmotzer\`.

## Verification
The draft is saved unsent and ends with the signature lines.`;

function turn(over: Partial<SettledTurnTrace> = {}): SettledTurnTrace {
  return {
    threadId: 't',
    turnId: 'u',
    endedAt: 0,
    userText: 'sign it as Stem on behalf of me',
    assistantText: 'Done.',
    trace: [],
    skillsInjected: [],
    skillsGradedUsed: [],
    skillsReported: [],
    memoryTainted: false,
    isScheduled: false,
    ...over
  };
}

const invokeDraft: TraceEntry = {
  id: 'c1',
  name: 'invoke_tool',
  args: '{"server":"fastmail","tool":"draft_email","args":{"body":"Dobrý deň,\\n\\nBest regards,\\nStem · Scheduling & coordination\\nOn behalf of Vladimír Schmotzer"}}'
};

function writeSkill(slug: string, body: string, enabled = true): void {
  mkdirSync(join(skillsDir, slug), { recursive: true });
  writeFileSync(
    join(skillsDir, slug, 'SKILL.md'),
    `---\nname: ${JSON.stringify(slug)}\ndescription: "Use when drafting an email reply for the user."\nmetadata:\n  stem:\n    source: agent\n    origin: user-requested\n---\n\n${body}\n`,
    'utf8'
  );
  if (!enabled) writeFileSync(join(skillsDir, slug, '.disabled'), '', 'utf8');
}

beforeEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
});
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

describe('wroteMessageDraft', () => {
  it('sees an MCP draft routed through invoke_tool', () => {
    expect(wroteMessageDraft(turn({ trace: [invokeDraft] }))).toBe(true);
  });

  it('sees a draft tool called by its own name', () => {
    expect(wroteMessageDraft(turn({ trace: [{ id: 'c', name: 'slack_send_message_draft' }] }))).toBe(true);
  });

  it('sees a draft written into the reply, by its To and Subject lines', () => {
    const assistantText = '**To:** Mikael Kirk <kirk@agrisys.dk>\n**Subject:** Re: PigInsight\n\nHi Mikael,';
    expect(wroteMessageDraft(turn({ assistantText }))).toBe(true);
  });

  it('ignores a turn that only read mail', () => {
    const trace: TraceEntry[] = [{ id: 'c', name: 'invoke_tool', args: '{"server":"fastmail","tool":"search_email","args":{"query":"draft"}}' }];
    expect(wroteMessageDraft(turn({ trace, assistantText: 'Subject: nothing new' }))).toBe(false);
  });
});

describe('the end-of-turn gate on writing turns', () => {
  it('fires below the tool gate when the turn saved a draft', () => {
    expect(decideSettle(turn({ trace: [invokeDraft] }), 'auto')).toEqual({ fire: true, writing: true });
  });

  it('still skips a short turn that wrote nothing', () => {
    const trace: TraceEntry[] = [{ id: 'c', name: 'web_search', args: '{}' }];
    expect(decideSettle(turn({ trace }), 'auto')).toEqual({ fire: false, reason: 'below-gate' });
  });

  it('still refuses scheduled runs', () => {
    expect(decideSettle(turn({ trace: [invokeDraft], isScheduled: true }), 'auto')).toEqual({ fire: false, reason: 'scheduled' });
  });

  it('hands the author the writing framing', async () => {
    const prompts: string[] = [];
    const llm = { complete: async (p: string) => (prompts.push(p), '{"skill": null, "reason": "one-off"}') };
    await settleSkills(turn({ trace: [invokeDraft] }), 'auto', llm);
    expect(prompts[0]).toContain(SKILL_WRITING_INSTRUCTIONS);
  });
});

describe('grading a skill that names no tool', () => {
  it('reads the quoted wording out of Steps', () => {
    expect(phrasesQuotedIn(DRAFT_BODY)).toEqual(['Stem · Scheduling & coordination', 'On behalf of Vladimír Schmotzer']);
  });

  it('credits a turn whose saved draft carries the quoted signature', () => {
    const trace: TraceEntry[] = [{ id: 'c', name: 'invoke_tool', args: '{"tool":"compose","args":{"text":"...\\nOn behalf of Vladimír Schmotzer"}}' }];
    expect(gradeSkillUse([{ slug: 'draft-email-reply', body: DRAFT_BODY }], trace)).toEqual(['draft-email-reply']);
  });

  it('credits a draft written into the reply with no tool calls', () => {
    const reply = 'Best regards,  \n**Stem · Scheduling & coordination**  \nOn behalf of Vladimír Schmotzer';
    expect(gradeSkillUse([{ slug: 'draft-email-reply', body: DRAFT_BODY }], [], reply)).toEqual(['draft-email-reply']);
  });

  it('does not credit a reply without the wording', () => {
    expect(gradeSkillUse([{ slug: 'draft-email-reply', body: DRAFT_BODY }], [], 'Regards, Vladimír')).toEqual([]);
  });
});

describe('manage_skill view', () => {
  const bridge = new SkillBridge({
    mode: async () => 'ask',
    requestApproval: async () => ({ approved: false }),
    onChanged: () => {}
  });

  it('returns the full body of a listed skill, with the issue-report line', async () => {
    writeSkill('draft-email-reply', DRAFT_BODY);
    const res = await bridge.handleRequest({ op: 'view', name: 'draft-email-reply' }, { isScheduled: false });
    expect(res.ok).toBe(true);
    expect(res.text).toContain('On behalf of Vladimír Schmotzer');
    expect(res.text).toContain('Skill issue [draft-email-reply]:');
    expect(res.loaded?.slug).toBe('draft-email-reply');
  });

  it('names the saved skills when the slug is wrong', async () => {
    writeSkill('draft-email-reply', DRAFT_BODY);
    const res = await bridge.handleRequest({ op: 'view', name: 'email-drafts' }, { isScheduled: false });
    expect(res.ok).toBe(false);
    expect(res.text).toContain('draft-email-reply');
  });

  it('keeps an archived skill unreadable', async () => {
    writeSkill('draft-email-reply', DRAFT_BODY, false);
    const res = await bridge.handleRequest({ op: 'view', name: 'draft-email-reply' }, { isScheduled: false });
    expect(res.ok).toBe(false);
  });
});
