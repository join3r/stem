// The model skill picker (skills/pick.ts) and how selectSkills uses it: the
// model's picks join the cross-encoder cut, and any failure leaves the cut alone.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skills-pick-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import { selectSkills, type SkillRecordish } from '../../src/server/skills/inject';
import {
  PICK_SHORTLIST_SIZE, completionSkillPicker, parseSkillPick, skillPickPrompt, type PickCandidate
} from '../../src/server/skills/pick';

const QUERY = 'how do I deploy the staging build';

function unit(c: number): Float32Array {
  return Float32Array.from([c, Math.sqrt(Math.max(0, 1 - c * c))]);
}
function skill(slug: string): SkillRecordish {
  return { slug, name: slug, description: `does ${slug}`, body: `1. run ${slug}`, origin: 'assistant' };
}
function embeddings(cosines: Record<string, number>) {
  return {
    available: async () => true,
    modelId: async () => 'fake-embed',
    embed: async (texts: string[], kind?: string) =>
      kind === 'query' ? texts.map(() => Float32Array.from([1, 0])) : texts.map((t) => unit(cosines[t.split('\n')[0]] ?? 0))
  };
}
/** A cross-encoder that admits `deploy` only. */
const rerank = {
  available: async () => true,
  minRelevantScore: async () => -8,
  rerank: async (_q: string, docs: string[]) => docs.map((doc, index) => ({ index, score: doc.startsWith('deploy\n') ? -2 : -11 }))
};
const candidates: PickCandidate[] = [
  { name: 'Deploy staging', description: 'Use when deploying the staging build' },
  { name: 'Gardening', description: 'Use when planning the balcony garden' }
];

beforeEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
});
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

describe('parseSkillPick', () => {
  it('keeps listed names only, case-insensitively, capped and without repeats', () => {
    expect(parseSkillPick('{"load":["deploy STAGING","Invented","Deploy staging","Gardening"]}', candidates, 2))
      .toEqual(['Deploy staging', 'Gardening']);
    expect(parseSkillPick('Sure: {"load": ["Gardening", "Deploy staging"]}', candidates, 1)).toEqual(['Gardening']);
  });

  it('reads an empty list as a decision, and anything unreadable as none', () => {
    expect(parseSkillPick('{"load": []}', candidates, 2)).toEqual([]);
    expect(parseSkillPick('no idea', candidates, 2)).toBeNull();
    expect(parseSkillPick('{"load": "Gardening"}', candidates, 2)).toBeNull();
    expect(parseSkillPick('{"load": [', candidates, 2)).toBeNull();
  });
});

describe('skillPickPrompt', () => {
  it('lists every candidate, fences the message and gives the same prompt for the same message', () => {
    const prompt = skillPickPrompt('deploy it\nnow', candidates, 2);
    for (const c of candidates) expect(prompt).toContain(`- ${c.name} — ${c.description}`);
    expect(prompt).toContain('<message>\ndeploy it\nnow\n</message>');
    expect(prompt).toContain('at most 2');
    expect(skillPickPrompt('deploy it\nnow', [...candidates].reverse(), 2)).toBe(prompt);
  });
});

describe('completionSkillPicker', () => {
  it('resolves null and reports when the completion fails', async () => {
    const onError = vi.fn();
    const pick = completionSkillPicker(async () => { throw new Error('timeout'); }, onError);
    expect(await pick(QUERY, candidates, 2)).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('makes no call for an empty shortlist', async () => {
    const complete = vi.fn(async () => '{"load":[]}');
    expect(await completionSkillPicker(complete)(QUERY, [], 2)).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('selectSkills with a picker', () => {
  const library = () => Array.from({ length: 12 }, (_, i) => skill(`s${i}`)).concat(skill('deploy'));
  const cosines = { deploy: 0.9, ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`s${i}`, 0.8 - i * 0.02])) };

  it('adds the model picks from the embedder shortlist to the cross-encoder cut', async () => {
    const pick = vi.fn(async () => ['s1', 'deploy']);
    const sel = await selectSkills(QUERY, library(), { embeddings: embeddings(cosines), rerank, pick });
    // The cut admitted deploy; the picker adds s1 and its repeat of deploy is not counted twice.
    expect(sel.inlined.map((s) => s.slug)).toEqual(['deploy', 's1']);
    expect(sel.decision).toMatchObject({ reason: 'above-floor', picker: 'answered', picked: ['s1'] });
    const [, shown, max] = pick.mock.calls[0] as unknown as [string, PickCandidate[], number];
    expect(shown.map((c) => c.name)).toEqual(['deploy', 's0', 's1', 's2', 's3', 's4', 's5', 's6'].slice(0, PICK_SHORTLIST_SIZE));
    expect(max).toBe(2);
    expect(sel.indexed.map((s) => s.slug)).not.toContain('s1');
  });

  it('keeps the cut as it is when the model picks nothing or gives no answer', async () => {
    for (const answer of [[], null]) {
      const sel = await selectSkills(QUERY, library(), { embeddings: embeddings(cosines), rerank, pick: async () => answer });
      expect(sel.inlined.map((s) => s.slug)).toEqual(['deploy']);
      expect(sel.decision?.picker).toBe(answer ? 'answered' : 'failed');
    }
  });

  it('survives a picker that throws', async () => {
    const sel = await selectSkills(QUERY, library(), {
      embeddings: embeddings(cosines), rerank, pick: async () => { throw new Error('boom'); }
    });
    expect(sel.inlined.map((s) => s.slug)).toEqual(['deploy']);
    expect(sel.decision?.picker).toBe('failed');
  });

  it('does not inline a picked skill the chat already has', async () => {
    const sel = await selectSkills(QUERY, library(), {
      embeddings: embeddings(cosines), rerank, pick: async () => ['s2'], alreadyLoaded: new Set(['s2'])
    });
    expect(sel.inlined.map((s) => s.slug)).toEqual(['deploy']);
    expect(sel.decision?.alreadyLoaded).toEqual(['s2']);
  });
});
