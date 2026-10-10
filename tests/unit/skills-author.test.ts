// The authoring one-shot. What matters here is the control flow around the model,
// not the model itself: declining must be cheap and terminal, an invalid draft must
// come back once with the exact violations attached, and a patch must not be
// allowed to quietly become a new skill under a different name.
import { describe, expect, it } from 'vitest';
import {
  SKILL_AUTHORING_INSTRUCTIONS,
  SKILL_LIBRARY_INSTRUCTIONS,
  SKILL_TARGET_PATCH_INSTRUCTIONS,
  authorSkill,
  buildAuthorPrompt,
  parseAuthorReply,
  renderEvidence
} from '../../src/server/skills/author';
import type { LlmClient } from '../../src/server/recall/llm';
import type { TraceEntry } from '../../src/server/pi/normalize';

const GOOD_BODY = `## When to use
When a YouTube page has auto-generated captions and you need the text.

## Steps
1. Open the watch URL with \`agent-browser open "<url>"\`.
2. Click the "..." menu, then "Show transcript".

## Verification
The transcript panel lists timestamped lines.`;

const GOOD_SKILL = {
  name: 'extract-video-captions',
  description: 'Use when the user asks what was said in a YouTube video.',
  body: GOOD_BODY
};

const TRACE: TraceEntry[] = [
  { id: 'c1', name: 'run_command', args: '{"command":"agent-browser open \\"https://y/watch?v=1\\""}', result: 'opened' },
  { id: 'c2', name: 'run_command', args: '{"command":"agent-browser click Transcript"}', result: 'no such element', isError: true }
];

function input(over: Record<string, unknown> = {}) {
  return { trace: TRACE, userText: 'what did the video say?', assistantText: 'Here is the transcript.', ...over } as Parameters<
    typeof buildAuthorPrompt
  >[0];
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

describe('parseAuthorReply', () => {
  it('reads a skill through surrounding prose and fences', () => {
    const parsed = parseAuthorReply('Sure:\n```json\n{"skill":{"name":"a-b","description":"d","body":"x"}}\n```');
    expect(parsed).toMatchObject({ kind: 'skill', draft: { name: 'a-b', description: 'd', body: 'x' } });
  });

  it('accepts "content" as an alias for the body', () => {
    // manage_skill has always called it `content`; a model primed on that schema
    // should not be punished for consistency.
    const parsed = parseAuthorReply('{"skill":{"name":"a-b","description":"d","content":"x"}}');
    expect(parsed).toMatchObject({ kind: 'skill', draft: { body: 'x' } });
  });

  it('reads a decline with its reason', () => {
    expect(parseAuthorReply('{"skill":null,"reason":"one-off errand"}')).toEqual({ kind: 'declined', reason: 'one-off errand' });
  });

  it('treats a missing skill key as a decline', () => {
    expect(parseAuthorReply('{}')).toMatchObject({ kind: 'declined' });
  });

  it('rejects a half-formed skill object', () => {
    expect(parseAuthorReply('{"skill":{"name":"a-b"}}')).toEqual({ kind: 'unparseable' });
  });

  it('rejects non-JSON', () => {
    expect(parseAuthorReply('I would save this as a skill about videos.')).toEqual({ kind: 'unparseable' });
  });
});

describe('renderEvidence', () => {
  it('shows the arguments and the failures, not a summary', () => {
    const text = renderEvidence(input());
    expect(text).toContain('agent-browser open');
    expect(text).toContain('FAILED');
    expect(text).toContain('no such element');
  });

  it('says so plainly when there were no tool calls', () => {
    expect(renderEvidence(input({ trace: [] }))).toContain('(no tool calls)');
  });

  it('leads with the user\'s focus when /learn supplied one', () => {
    expect(renderEvidence(input({ focus: 'how to get captions' }))).toMatch(/^What the user asked to be captured/);
  });

  it('names the machine the turn ran on, ahead of the evidence', () => {
    // Without this the author writes every procedure as though there were only
    // ever one machine, and a step that worked on the user's Mac is followed on
    // a server that cannot reach the same files, network, or sites.
    const text = renderEvidence(input({ machine: 'Stem is running on a server the user owns (Linux).' }));
    expect(text).toContain('Where this turn ran:\nStem is running on a server');
    expect(text.indexOf('Where this turn ran')).toBeLessThan(text.indexOf('What the assistant did'));
  });

  it('says nothing about machines when the caller did not say', () => {
    expect(renderEvidence(input())).not.toContain('Where this turn ran');
  });
});

describe('authorSkill', () => {
  it('returns the draft when the first answer is valid', async () => {
    const llm = scriptedLlm([JSON.stringify({ skill: GOOD_SKILL })]);
    const res = await authorSkill(llm, input());
    expect(res).toMatchObject({ ok: true, patched: false, attempts: 1 });
    expect(llm.prompts).toHaveLength(1);
  });

  it('stops immediately on a decline', async () => {
    // Declining is the common case; it must never cost a second call.
    const llm = scriptedLlm(['{"skill":null,"reason":"one-off errand"}']);
    const res = await authorSkill(llm, input());
    expect(res).toMatchObject({ ok: false, reason: 'declined', detail: 'one-off errand', attempts: 1 });
    expect(llm.prompts).toHaveLength(1);
  });

  it('retries once with the exact violations attached', async () => {
    const llm = scriptedLlm([
      JSON.stringify({ skill: { ...GOOD_SKILL, name: 'Extract Video Captions' } }),
      JSON.stringify({ skill: GOOD_SKILL })
    ]);
    const res = await authorSkill(llm, input());
    expect(res).toMatchObject({ ok: true, attempts: 2 });
    expect(llm.prompts[1]).toContain('name must be lowercase');
    expect(llm.prompts[1]).toContain('Extract Video Captions');
  });

  it('gives up after a second invalid draft rather than looping', async () => {
    const bad = JSON.stringify({ skill: { ...GOOD_SKILL, body: 'just some prose' } });
    const llm = scriptedLlm([bad, bad]);
    const res = await authorSkill(llm, input());
    expect(res).toMatchObject({ ok: false, reason: 'invalid', attempts: 2 });
    expect(llm.prompts).toHaveLength(2);
  });

  it('retries an unparseable reply, then gives up', async () => {
    const llm = scriptedLlm(['no idea', 'still no idea']);
    const res = await authorSkill(llm, input());
    expect(res).toMatchObject({ ok: false, reason: 'unparseable', attempts: 2 });
  });

  it('surfaces a model error without retrying', async () => {
    const llm: LlmClient = {
      complete: async () => {
        throw new Error('backend down');
      }
    };
    expect(await authorSkill(llm, input())).toMatchObject({ ok: false, reason: 'error', detail: 'backend down', attempts: 1 });
  });

  it('keeps a patch on the skill it is patching', async () => {
    // A renamed "patch" is a new skill by another name — exactly the duplication
    // this path exists to prevent.
    const existing = { name: 'extract-video-captions', description: 'old desc', body: GOOD_BODY };
    const llm = scriptedLlm([JSON.stringify({ skill: { ...GOOD_SKILL, name: 'extract-captions-v2' } })]);
    const res = await authorSkill(llm, input({ existing }));
    expect(res).toMatchObject({ ok: true, patched: true });
    expect((res as { draft: { name: string } }).draft.name).toBe('extract-video-captions');
  });

  it('tells the model to fix the skill rather than add one when patching', async () => {
    const existing = { name: 'extract-video-captions', description: 'old desc', body: GOOD_BODY };
    const llm = scriptedLlm(['{"skill":null,"reason":"the skill worked"}']);
    await authorSkill(llm, input({ existing }));
    expect(llm.prompts[0]).toContain('whether that one needs fixing');
    expect(llm.prompts[0]).toContain('The skill this turn used:');
  });
});

// The third answer, and the reason it exists: Stem decides create-vs-patch before
// the model sees anything, so when nothing graded used there is no evidence to
// route on. Rather than guess, the author is handed the library and asked. Its
// answer comes back as a redirect the caller resolves, never as a write.
describe('authorSkill: choosing an existing skill', () => {
  const CANDIDATE = {
    slug: 'extract-video-captions',
    name: 'extract-video-captions',
    description: 'Pull the caption text out of a video.',
    body: GOOD_BODY
  };
  const INDEX = [
    { slug: 'extract-video-captions', description: 'Pull the caption text out of a video.' },
    { slug: 'find-prior-request-email', description: 'Find the email where the user asked for something before.' }
  ];

  it('returns the target when it names a skill it was shown in full', async () => {
    const llm = scriptedLlm(['{"target":"extract-video-captions"}']);
    const res = await authorSkill(llm, input({ candidates: [CANDIDATE], libraryIndex: INDEX }));
    expect(res).toMatchObject({ ok: false, reason: 'target', target: 'extract-video-captions', attempts: 1 });
    expect(llm.prompts).toHaveLength(1);
  });

  it('returns the target when it recognizes one from the index alone', async () => {
    // This is the 2026-08-11 case. The caller sees the same outcome either way and
    // loads the body for a second shot; nothing here writes.
    const llm = scriptedLlm(['{"target":"find-prior-request-email"}']);
    const res = await authorSkill(llm, input({ candidates: [CANDIDATE], libraryIndex: INDEX }));
    expect(res).toMatchObject({ ok: false, reason: 'target', target: 'find-prior-request-email' });
  });

  it('shows the loaded bodies and the whole index, and asks for a choice', async () => {
    const llm = scriptedLlm(['{"skill":null}']);
    await authorSkill(llm, input({ candidates: [CANDIDATE], libraryIndex: INDEX }));
    expect(llm.prompts[0]).toContain('Skills already loaded in this turn, in full:');
    expect(llm.prompts[0]).toContain('Click the "..." menu'); // the candidate's body, not just its name
    expect(llm.prompts[0]).toContain('- find-prior-request-email — Find the email');
    expect(llm.prompts[0]).toContain('{"target":');
  });

  it('does not ask for a choice when there is no library to choose from', async () => {
    // An empty list under "read what is already there" invites a target the author
    // cannot have seen.
    const llm = scriptedLlm(['{"skill":null}']);
    await authorSkill(llm, input());
    expect(llm.prompts[0]).not.toContain('read what is already there');
  });

  it('refuses a target it was not shown, then takes the retry', async () => {
    // A slug it invented or half-remembered would patch a skill nobody put in
    // front of it — including, if it guessed, a file the user wrote by hand.
    const llm = scriptedLlm(['{"target":"some-other-skill"}', JSON.stringify({ skill: GOOD_SKILL })]);
    const res = await authorSkill(llm, input({ candidates: [CANDIDATE], libraryIndex: INDEX }));
    expect(llm.prompts[1]).toContain('"some-other-skill", which is not one of the skills listed above');
    expect(res).toMatchObject({ ok: true, attempts: 2 });
  });

  it('gives up on a second unlisted target rather than honouring it', async () => {
    const llm = scriptedLlm(['{"target":"some-other-skill"}', '{"target":"some-other-skill"}']);
    const res = await authorSkill(llm, input({ candidates: [CANDIDATE], libraryIndex: INDEX }));
    expect(res).toMatchObject({ ok: false, reason: 'target', attempts: 2 });
    expect((res as { target?: string }).target).toBeUndefined();
  });

  it('still creates a fresh skill when nothing in the library fits', async () => {
    const llm = scriptedLlm([JSON.stringify({ skill: GOOD_SKILL })]);
    const res = await authorSkill(llm, input({ candidates: [CANDIDATE], libraryIndex: INDEX }));
    expect(res).toMatchObject({ ok: true, patched: false, attempts: 1 });
    expect((res as { target?: string }).target).toBeUndefined();
  });

  it('still declines when the turn holds nothing worth keeping', async () => {
    const llm = scriptedLlm(['{"skill":null,"reason":"one-off errand"}']);
    const res = await authorSkill(llm, input({ candidates: [CANDIDATE], libraryIndex: INDEX }));
    expect(res).toMatchObject({ ok: false, reason: 'declined', detail: 'one-off errand' });
  });

  it('asks the second shot to fold the turn in, not to audit the skill', async () => {
    // The patch framing the graded path uses ("did this skill let you down")
    // would invite a decline here: the author has already decided the procedure
    // belongs in this skill.
    const existing = { name: 'extract-video-captions', description: 'd', body: GOOD_BODY };
    const llm = scriptedLlm([JSON.stringify({ skill: GOOD_SKILL })]);
    const res = await authorSkill(llm, input({ existing, chosenTarget: true }));
    expect(llm.prompts[0]).toContain('You named the skill below');
    expect(llm.prompts[0]).toContain('The skill you named:');
    expect(llm.prompts[0]).not.toContain('whether that one needs fixing');
    expect(res).toMatchObject({ ok: true, patched: true, target: 'extract-video-captions' });
  });
});

describe('parseAuthorReply: targets', () => {
  it('reads a bare target', () => {
    expect(parseAuthorReply('{"target":"extract-video-captions"}')).toEqual({
      kind: 'target',
      slug: 'extract-video-captions'
    });
  });

  it('lets a target outrank a draft in the same reply', () => {
    // The model has told us where the procedure belongs and then written it in the
    // wrong place. The second shot writes the right one.
    expect(parseAuthorReply(JSON.stringify({ target: 'a-b', skill: { name: 'c-d', description: 'x', body: 'y' } }))).toEqual({
      kind: 'target',
      slug: 'a-b'
    });
  });

  it('ignores an empty target', () => {
    expect(parseAuthorReply('{"target":"  ","skill":null,"reason":"nope"}')).toMatchObject({ kind: 'declined' });
  });
});

describe('SKILL_AUTHORING_INSTRUCTIONS', () => {
  it('stays liftable by the eval — no interpolation', () => {
    expect(SKILL_AUTHORING_INSTRUCTIONS).not.toContain('${');
    // The same rule for the branches added beside it: the eval lifts prompt
    // constants verbatim out of the source, so the moment one carries a template
    // hole it grades something that never ships.
    expect(SKILL_LIBRARY_INSTRUCTIONS).not.toContain('${');
    expect(SKILL_TARGET_PATCH_INSTRUCTIONS).not.toContain('${');
  });

  it('is joined with the contract only at prompt-build time', () => {
    // The two constants are graded separately: one sets the fire rate, the other
    // the shape. Keeping them unmerged in the source is what makes that possible.
    expect(SKILL_AUTHORING_INSTRUCTIONS).not.toContain('## Verification');
    expect(buildAuthorPrompt(input())).toContain('## Verification');
  });
});
