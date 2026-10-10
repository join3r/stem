// The end-of-turn pass. Almost everything worth testing here is a refusal: three
// of the four skip reasons are about restraint rather than cost, and the order
// they are checked in decides what the log later says happened. The routing half
// is the other half of the same care — a turn that already loaded a skill must
// improve that one rather than grow a near-duplicate beside it.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skills-settle-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import { SKILL_GATE_MIN_TOOL_CALLS, decideSettle, routeReported, settleSkills } from '../../src/server/skills/settle';
import type { SettledTurnTrace, TraceEntry } from '../../src/server/pi/normalize';
import type { LlmClient } from '../../src/server/recall/llm';

const BODY = `## When to use
When the user asks what was said in a video that has captions.

## Steps
1. Open the watch URL with \`agent-browser open "<url>"\`.

## Verification
The transcript panel lists timestamped lines.`;

function trace(count: number): TraceEntry[] {
  return Array.from({ length: count }, (_, i) => ({ id: `c${i}`, name: 'run_command', args: '{}', result: 'ok' }));
}

function turn(over: Partial<SettledTurnTrace> = {}): SettledTurnTrace {
  return {
    threadId: 't',
    turnId: 'u',
    endedAt: 0,
    userText: 'what did the video say?',
    assistantText: 'Here is the transcript.',
    trace: trace(SKILL_GATE_MIN_TOOL_CALLS),
    skillsInjected: [],
    skillsGradedUsed: [],
    skillsReported: [],
    memoryTainted: false,
    isScheduled: false,
    ...over
  };
}

function writeSkill(slug: string, body = BODY, description = 'pull captions out of a video', origin?: string): void {
  mkdirSync(join(skillsDir, slug), { recursive: true });
  writeFileSync(
    join(skillsDir, slug, 'SKILL.md'),
    // The `source: agent` marker matters: the author is only ever offered skills
    // Stem wrote, so a fixture without it is invisible to the create path.
    `---\nname: ${JSON.stringify(slug)}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  stem:\n    source: agent\n${origin ? `    origin: ${origin}\n` : ''}---\n\n${body}\n`,
    'utf8'
  );
}

/** An LlmClient that returns each reply in turn and records the prompts it saw. */
function scriptedLlm(replies: string[]): LlmClient & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    complete: async (prompt: string) => {
      prompts.push(prompt);
      return replies[Math.min(i++, replies.length - 1)];
    }
  };
}

beforeEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
});
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

describe('decideSettle', () => {
  it('fires on a turn that did enough work', () => {
    expect(decideSettle(turn(), 'auto')).toEqual({ fire: true });
  });

  it('does not fire one tool call short of the gate', () => {
    // 73% of real turns call no tools at all, so the cheap deterministic gate is
    // free on nearly three turns in four and the model is only asked about the
    // ~12% where something actually happened.
    expect(decideSettle(turn({ trace: trace(SKILL_GATE_MIN_TOOL_CALLS - 1) }), 'auto')).toEqual({
      fire: false,
      reason: 'below-gate'
    });
    expect(decideSettle(turn({ trace: [] }), 'auto')).toMatchObject({ reason: 'below-gate' });
  });

  it('never fires with the mode off', () => {
    expect(decideSettle(turn(), 'off')).toEqual({ fire: false, reason: 'mode-off' });
  });

  it('refuses a tainted turn', () => {
    // The turn read inside a folder marked do-not-memorize. A skill written from it
    // would launder that content into a file injected on every later turn, which is
    // exactly what the flag exists to stop.
    expect(decideSettle(turn({ memoryTainted: true }), 'auto')).toEqual({ fire: false, reason: 'tainted' });
  });

  it('refuses a scheduled turn', () => {
    // Nobody is watching, so neither a card nor a silent write is honest.
    expect(decideSettle(turn({ isScheduled: true }), 'ask')).toEqual({ fire: false, reason: 'scheduled' });
  });

  it('reports the true reason when several apply', () => {
    // The reason is what lands in the log, and "below-gate" for a turn that was
    // actually tainted would send anyone tuning the threshold after a ghost.
    expect(decideSettle(turn({ memoryTainted: true, trace: [] }), 'auto')).toMatchObject({ reason: 'tainted' });
    expect(decideSettle(turn({ memoryTainted: true, isScheduled: true }), 'auto')).toMatchObject({ reason: 'tainted' });
    expect(decideSettle(turn({ isScheduled: true, trace: [] }), 'auto')).toMatchObject({ reason: 'scheduled' });
  });
});

describe('routing', () => {
  it('routes to a patch carrying the skill\'s current text', () => {
    writeSkill('extract-video-captions');
    const decision = decideSettle(turn({ skillsGradedUsed: ['extract-video-captions'] }), 'auto');
    expect(decision).toMatchObject({
      fire: true,
      existing: { name: 'extract-video-captions', description: 'pull captions out of a video', body: BODY }
    });
  });

  it('falls back to a create when the graded skill is gone from disk', () => {
    // Slugs come off the turn context, and a skill can be removed or merged
    // between injection and settle. Failing the whole pass over a stale name would
    // lose a skill that has nothing to do with the missing one.
    expect(decideSettle(turn({ skillsGradedUsed: ['deleted-since'] }), 'auto')).toEqual({ fire: true });
  });

  it('takes the first skill that still exists', () => {
    // Several may have graded used; the first ranked highest against the message,
    // so it is the one the turn was most likely working from.
    writeSkill('second-skill');
    const decision = decideSettle(turn({ skillsGradedUsed: ['gone', 'second-skill'] }), 'auto');
    expect(decision).toMatchObject({ existing: { name: 'second-skill' } });
  });

  it('routes a reported failure to that skill, with the reason, ahead of grading', () => {
    // The model said a loaded step was wrong. That is its own verdict, naming the
    // skill — stronger than tool overlap, which can credit a skill the model then
    // found wrong. Both signals present: the report wins.
    writeSkill('extract-video-captions');
    writeSkill('other-skill');
    const decision = decideSettle(
      turn({
        skillsGradedUsed: ['other-skill'],
        skillsReported: [{ slug: 'extract-video-captions', reason: 'the transcript button moved' }]
      }),
      'auto'
    );
    expect(decision).toMatchObject({
      fire: true,
      existing: { name: 'extract-video-captions' },
      issue: 'the transcript button moved'
    });
  });

  it('fires on a reported failure below the tool gate', () => {
    // The gate keeps the author off turns where nothing happened. A skill that
    // misled the model is something that happened, however few tools it took.
    writeSkill('extract-video-captions');
    const decision = decideSettle(
      turn({ trace: trace(1), skillsReported: [{ slug: 'extract-video-captions', reason: 'step 1 is stale' }] }),
      'auto'
    );
    expect(decision).toMatchObject({ fire: true, existing: { name: 'extract-video-captions' } });
    // But never past the reasons that are about restraint rather than cost.
    expect(
      decideSettle(
        turn({ trace: trace(1), memoryTainted: true, skillsReported: [{ slug: 'extract-video-captions', reason: 'x' }] }),
        'auto'
      )
    ).toEqual({ fire: false, reason: 'tainted' });
  });

  it('ignores a report about a skill that is gone from disk', () => {
    expect(routeReported({ skillsReported: [{ slug: 'deleted-since', reason: 'x' }] })).toBeUndefined();
    expect(decideSettle(turn({ trace: trace(1), skillsReported: [{ slug: 'deleted-since', reason: 'x' }] }), 'auto')).toEqual({
      fire: false,
      reason: 'below-gate'
    });
  });

  it('leaves an imported skill alone: no patch, and no duplicate beside it', () => {
    // The user installed it as it is; a wrong step is for its upstream to fix or
    // for the user to ask about, never for the end-of-turn pass.
    writeSkill('agent-browser-vercel', BODY, 'Use when driving a browser', 'imported');
    expect(decideSettle(turn({ skillsGradedUsed: ['agent-browser-vercel'] }), 'auto')).toEqual({ fire: false, reason: 'imported' });
    expect(
      decideSettle(turn({ trace: trace(1), skillsReported: [{ slug: 'agent-browser-vercel', reason: 'flag renamed' }] }), 'auto')
    ).toEqual({ fire: false, reason: 'imported' });
  });

  it('never routes on injection alone', () => {
    // The signal that matters is affirmative. Injection is the top-2 of a cosine
    // ranking against the user's message — on 2026-08-11 both inlined skills were
    // the wrong ones — and `authorSkill` force-renames a draft to whatever it was
    // routed at, so a blind fallback writes one procedure into another skill's
    // file. Inlined skills reach the author as candidates instead, never as a
    // decided target.
    writeSkill('identify-trailer-music');
    const decision = decideSettle(turn({ skillsInjected: ['identify-trailer-music'] }), 'auto');
    expect(decision).toEqual({ fire: true });
  });
});

describe('settleSkills', () => {
  it('makes no model call when the gate says no', async () => {
    // The whole point of a deterministic gate is that the expensive question is
    // never asked on the turns it would waste.
    const llm = scriptedLlm(['{"skill":null}']);
    const res = await settleSkills(turn({ trace: [] }), 'auto', llm);
    expect(res).toEqual({ decision: { fire: false, reason: 'below-gate' } });
    expect(llm.prompts).toHaveLength(0);
  });

  it('makes no model call with the mode off', async () => {
    const llm = scriptedLlm(['{"skill":null}']);
    await settleSkills(turn(), 'off', llm);
    expect(llm.prompts).toHaveLength(0);
  });

  it('returns the authored draft without writing anything', async () => {
    // Writing is the bridge's job, so the mode, the card and the validator behave
    // identically whichever surface proposed the skill.
    const llm = scriptedLlm([
      JSON.stringify({
        skill: { name: 'extract-video-captions', description: 'Use when the user asks about the captions of a video.', body: BODY }
      })
    ]);
    const res = await settleSkills(turn(), 'auto', llm);
    expect(res.decision).toEqual({ fire: true });
    expect(res.author).toMatchObject({ ok: true, patched: false, attempts: 1 });
    expect(llm.prompts).toHaveLength(1);
  });

  it('passes a decline straight back', async () => {
    const llm = scriptedLlm(['{"skill":null,"reason":"one-off errand"}']);
    const res = await settleSkills(turn(), 'auto', llm);
    expect(res.author).toMatchObject({ ok: false, reason: 'declined', detail: 'one-off errand' });
  });

  it('hands the author the existing skill when the turn graded as using one', async () => {
    writeSkill('extract-video-captions');
    const llm = scriptedLlm(['{"skill":null,"reason":"the skill did its job"}']);
    const res = await settleSkills(turn({ skillsGradedUsed: ['extract-video-captions'] }), 'auto', llm);
    expect(res.decision).toMatchObject({ existing: { name: 'extract-video-captions' } });
    expect(llm.prompts[0]).toContain('The skill this turn used:');
    expect(llm.prompts[0]).toContain('The transcript panel lists timestamped lines.');
    // The routed patch is decided before the model sees anything, so there is no
    // library to browse and no second shot to pay for.
    expect(llm.prompts[0]).not.toContain('Every skill in the library');
    expect(llm.prompts).toHaveLength(1);
  });

  it('tells the author what the model reported as wrong', async () => {
    writeSkill('extract-video-captions');
    const llm = scriptedLlm(['{"skill":null,"reason":"fine"}']);
    await settleSkills(
      turn({ skillsReported: [{ slug: 'extract-video-captions', reason: 'the transcript button moved' }] }),
      'auto',
      llm
    );
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]).toContain('The skill this turn used');
    expect(llm.prompts[0]).toContain('What the assistant reported as wrong with it this turn:\nthe transcript button moved');
  });

  it('shows the whole library on the create path', async () => {
    // Both halves, and this is why: the inlined body is the one the author can
    // judge properly, but on 2026-08-11 the skill that actually matched was
    // name-only in the index. Neither list alone resolves that turn.
    writeSkill('identify-trailer-music', BODY, 'work out which track a trailer used');
    writeSkill('extract-youtube-transcript', BODY, 'pull the transcript out of a YouTube video');
    const llm = scriptedLlm(['{"skill":null}']);
    await settleSkills(turn({ skillsInjected: ['identify-trailer-music'] }), 'auto', llm);
    expect(llm.prompts[0]).toContain('Skills already loaded in this turn, in full:');
    expect(llm.prompts[0]).toContain('The transcript panel lists timestamped lines.');
    expect(llm.prompts[0]).toContain('- extract-youtube-transcript — pull the transcript out of a YouTube video');
  });

  it('patches the skill the author names from the index, in a second shot', async () => {
    // The 08-11 shape end to end: nothing graded used, the right skill known only
    // by name, and the author recognizing it. The second shot is the ordinary
    // patch path entered late — same force-rename, now correct by construction
    // because the model chose the target itself.
    writeSkill('extract-youtube-transcript', BODY, 'pull the transcript out of a YouTube video');
    const llm = scriptedLlm([
      '{"target":"extract-youtube-transcript"}',
      JSON.stringify({ skill: { name: 'extract-video-details', description: 'Use when the user wants the transcript of a video.', body: BODY } })
    ]);
    const res = await settleSkills(turn(), 'auto', llm);
    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toContain('You named the skill below');
    expect(llm.prompts[1]).toContain('The transcript panel lists timestamped lines.');
    expect(res.author).toMatchObject({ ok: true, patched: true, target: 'extract-youtube-transcript', attempts: 2 });
    // The draft is renamed onto the target, so the bridge write lands on that
    // skill with expect_existing rather than creating a third one.
    expect((res.author as { draft: { name: string } }).draft.name).toBe('extract-youtube-transcript');
  });

  it('writes nothing when the named skill vanishes before the second shot', async () => {
    // A curator merge can delete the very skill the author just chose. The author
    // said this was not a new skill; inventing one now would answer a question
    // nobody asked, so the pass ends with no write.
    writeSkill('extract-youtube-transcript');
    const llm: LlmClient & { calls: number } = {
      calls: 0,
      complete: async () => {
        llm.calls += 1;
        rmSync(join(skillsDir, 'extract-youtube-transcript'), { recursive: true, force: true });
        return '{"target":"extract-youtube-transcript"}';
      }
    };
    const res = await settleSkills(turn(), 'auto', llm);
    expect(llm.calls).toBe(1);
    expect(res.author).toMatchObject({ ok: false, reason: 'target', target: 'extract-youtube-transcript' });
  });

  it('leaves the user\'s own skills out of what the author may target', async () => {
    // Hand-written skills are out of scope for automatic writes — the store keeps
    // the curator and the model off them — so they are not offered as targets and
    // an author that names one anyway gets the retry, not the patch.
    mkdirSync(join(skillsDir, 'hand-written'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'hand-written', 'SKILL.md'),
      `---\nname: "hand-written"\ndescription: "something the user wrote"\n---\n\n${BODY}\n`,
      'utf8'
    );
    const llm = scriptedLlm(['{"target":"hand-written"}', '{"skill":null,"reason":"nothing durable"}']);
    const res = await settleSkills(turn(), 'auto', llm);
    expect(llm.prompts[0]).not.toContain('hand-written');
    expect(llm.prompts[1]).toContain('which is not one of the skills listed above');
    expect(res.author).toMatchObject({ ok: false, reason: 'declined' });
  });

  it('carries the /learn focus through to the prompt', async () => {
    const llm = scriptedLlm(['{"skill":null}']);
    await settleSkills(turn(), 'auto', llm, { focus: 'how to get captions' });
    expect(llm.prompts[0]).toContain('how to get captions');
  });
});
