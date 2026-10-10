// The skill contract is the gate every authoring path writes through, so its
// failure modes matter more than its happy path: a rule that is too strict blocks
// a good skill, one that is too loose lets the old library back in. These cases
// pin both edges.
import { describe, expect, it } from 'vitest';
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_CONTRACT_TEXT,
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_MAX,
  restatesName,
  slugifySkillName,
  validateSkill
} from '../../src/server/skills/contract';

const GOOD_BODY = `## When to use
When a YouTube page has auto-generated captions and you need the text.

## Steps
1. Open the watch URL with \`agent-browser open "<url>"\`.
2. Click the "..." menu, then "Show transcript".

## Verification
The transcript panel lists timestamped lines.`;

function draft(over: Partial<{ name: string; description: string; body: string }> = {}) {
  return {
    name: 'extract-video-captions',
    description: 'Pull the caption text out of a YouTube video when the user asks what was said in it.',
    body: GOOD_BODY,
    ...over
  };
}

function fields(violations: { field: string }[]): string[] {
  return violations.map((v) => v.field);
}

describe('validateSkill', () => {
  it('accepts a well-formed draft', () => {
    expect(validateSkill(draft())).toEqual([]);
  });

  it('rejects a free-text name and suggests the slug', () => {
    const v = validateSkill(draft({ name: 'Extract Video Captions' }));
    expect(fields(v)).toContain('name');
    expect(v[0].message).toContain('extract-video-captions');
  });

  it('rejects a name over the length cap', () => {
    const long = `a${'-b'.repeat(SKILL_NAME_MAX)}`;
    expect(fields(validateSkill(draft({ name: long })))).toContain('name');
  });

  it('rejects a description over the length cap', () => {
    const long = `Use this ${'x'.repeat(SKILL_DESCRIPTION_MAX)}`;
    expect(fields(validateSkill(draft({ description: long })))).toContain('description');
  });

  it('rejects a multi-sentence description', () => {
    const v = validateSkill(draft({ description: 'Gets captions. Use it for YouTube links.' }));
    expect(v.some((x) => x.message.includes('single sentence'))).toBe(true);
  });

  it('rejects a description that restates the name', () => {
    const v = validateSkill(draft({ description: 'Extract video captions from a page.' }));
    expect(v.some((x) => x.message.includes('restates the name'))).toBe(true);
  });

  it('allows a description that merely starts with the same first word', () => {
    // The rule is a leading token-for-token repeat, not a shared opening verb —
    // otherwise every "extract-…" skill would be barred from saying "Extract".
    expect(validateSkill(draft({ description: 'Extract the spoken text from a video the user linked.' }))).toEqual([]);
  });

  it('rejects a body missing any required section', () => {
    const v = validateSkill(draft({ body: '## When to use\nSometimes.\n\n## Steps\n1. Do it.' }));
    expect(v.some((x) => x.message.includes('## Verification'))).toBe(true);
  });

  it('rejects sections in the wrong order', () => {
    const scrambled = `## Steps
1. Do it.

## When to use
Sometimes.

## Verification
It worked.`;
    const v = validateSkill(draft({ body: scrambled }));
    expect(v.some((x) => x.message.includes('out of order'))).toBe(true);
  });

  it('rejects a body that carries its own front-matter', () => {
    const v = validateSkill(draft({ body: `---\nname: x\n---\n\n${GOOD_BODY}` }));
    expect(v.some((x) => x.message.includes('front-matter'))).toBe(true);
  });

  it('rejects an oversized body', () => {
    const v = validateSkill(draft({ body: `${GOOD_BODY}\n${'padding. '.repeat(SKILL_BODY_MAX_BYTES / 4)}` }));
    expect(v.some((x) => x.message.includes('bytes'))).toBe(true);
  });

  it('reports every violation at once, not just the first', () => {
    // The retry shows the model the whole list; one-at-a-time would trade
    // failures round after round.
    const v = validateSkill({ name: 'Bad Name', description: '', body: 'no sections' });
    expect(new Set(fields(v))).toEqual(new Set(['name', 'description', 'body']));
  });
});

describe('slugifySkillName', () => {
  it('repairs a near-miss name', () => {
    expect(slugifySkillName('Extract Video Captions')).toBe('extract-video-captions');
  });
  it('strips leading and trailing separators', () => {
    expect(slugifySkillName('  --Draft: invoice email!  ')).toBe('draft-invoice-email');
  });
});

describe('restatesName', () => {
  it('is literal about what counts as a restatement', () => {
    expect(restatesName('brew-coffee', 'Brew coffee for the morning.')).toBe(true);
    expect(restatesName('brew-coffee', 'Brew a pot when the user asks for coffee.')).toBe(false);
  });
});

describe('SKILL_CONTRACT_TEXT', () => {
  it('stays liftable by the eval — no interpolation', () => {
    // scripts/skill-author-eval.mjs reads this constant out of the source with a
    // regex so the gate grades the shipped prose, never a paraphrase of it.
    expect(SKILL_CONTRACT_TEXT).not.toContain('${');
  });

  it('states the same numbers the validator enforces', () => {
    expect(SKILL_CONTRACT_TEXT).toContain(String(SKILL_NAME_MAX));
    expect(SKILL_CONTRACT_TEXT).toContain(String(SKILL_DESCRIPTION_MAX));
    expect(SKILL_CONTRACT_TEXT).toContain(String(SKILL_BODY_MAX_BYTES));
  });
});

describe('authored descriptions', () => {
  // Five of the six multi-job skills on the server opened "Use to …" / "Use for …"
  // and listed what they could do; no single-job one did (2026-10-10).
  it('holds model-written text to "Use when"', () => {
    const listed = draft({ description: 'Use to diagnose port mismatches or upgrade to pinned images.' });
    expect(fields(validateSkill(listed, { authored: true }))).toEqual(['description']);
    expect(validateSkill(draft({ description: 'use when a port does not answer.' }), { authored: true })).toEqual([]);
  });

  it('leaves text a person wrote alone', () => {
    expect(validateSkill(draft({ description: 'Downloads the monthly invoice.' }))).toEqual([]);
  });

  it('says so in the contract the model reads', () => {
    expect(SKILL_CONTRACT_TEXT).toContain('starting "Use when"');
    expect(SKILL_CONTRACT_TEXT).toContain('One skill is one job.');
  });
});
