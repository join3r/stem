// Skills curator regression suite. Exercises the pure parse/clamp helpers and the
// real curateSkills() against a throwaway skills dir (STEM_SKILLS_DIR), with a
// fake LlmClient so no backend is needed — mirroring the recall probe style.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skills-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import { checkSplit, clampCurate, curateSkills, parseCurate, parseSplit, retireBudget, splitCandidate } from '../../src/server/skills/curate';
import type { EmbeddingsClient } from '../../src/server/recall/embeddings';
import { readUsage, recordUses } from '../../src/server/skills/usage';
import type { LlmClient } from '../../src/server/recall/llm';

function fakeLlm(reply: string): LlmClient {
  return { complete: async () => reply };
}

/** Every skill embeds to the same point, so every skill is every other's neighbour. */
function sameSpace(): EmbeddingsClient {
  return {
    available: async () => true,
    modelId: async () => 'test-model',
    embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0]))
  } as unknown as EmbeddingsClient;
}

/** Records every prompt and answers split reviews and merge groups separately. */
function routedLlm(answers: { split?: string[]; merge?: string }): LlmClient & { prompts: string[] } {
  const splits = [...(answers.split ?? [])];
  const prompts: string[] = [];
  return {
    prompts,
    complete: async (prompt: string) => {
      prompts.push(prompt);
      if (prompt.startsWith('You check a small group')) return answers.merge ?? '{"merge":[],"archive":[]}';
      return splits.shift() ?? '{"verdict":"one"}';
    }
  };
}

const UMBRELLA_BODY = `## When to use
When an Unraid container misbehaves.

## Steps
### Port diagnosis
1. Run \`docker port app\`.
### Pinned upgrade
1. Pull \`image@sha256:abc\`.

## Verification
The container answers on its port.`;

const PORT_BODY = `## When to use
When a container's published port does not answer.

## Steps
1. Run \`docker port app\`.

## Verification
The container answers on its port.`;

const UPGRADE_BODY = `## When to use
When a container must move to a verified pinned image.

## Steps
1. Pull \`image@sha256:abc\`.

## Verification
The container runs the pinned digest.`;

// A merged body is written through saveSkill now, so it has to meet the same
// contract as every other write — the curator is no longer a back door around it.
const MERGED_BODY = `## When to use
When the user asks for coffee.

## Steps
1. Boil water.
2. Pour it over the grounds.

## Verification
The cup is full and the kettle is empty.`;

function writeSkill(
  slug: string,
  opts: { source?: 'agent' | 'user'; version?: number; body?: string; description?: string; origin?: string }
): void {
  const src = opts.source ?? 'agent';
  const fm = [
    '---',
    `name: ${JSON.stringify(slug)}`,
    `description: ${JSON.stringify(opts.description ?? `Use when the user needs ${slug}.`)}`,
    'metadata:',
    '  stem:',
    `    source: ${src}`,
    `    origin: ${JSON.stringify(opts.origin ?? 'approved')}`,
    `    version: ${opts.version ?? 1}`,
    '    created: "2026-01-01T00:00:00.000Z"',
    '    updated: "2026-01-01T00:00:00.000Z"',
    '---'
  ].join('\n');
  mkdirSync(join(skillsDir, slug), { recursive: true });
  writeFileSync(join(skillsDir, slug, 'SKILL.md'), `${fm}\n\n${opts.body ?? `Step 1 for ${slug}.`}\n`, 'utf8');
}

beforeEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
});
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

describe('parseCurate', () => {
  it('parses merge/archive and tolerates fences/prose', () => {
    const ops = parseCurate('here you go:\n{"merge":[{"slugs":["a","b"],"description":"d","content":"x"}],"archive":["d"]}');
    expect(ops.merge).toHaveLength(1);
    expect(ops.merge[0].slugs).toEqual(['a', 'b']);
    expect(ops.archive).toEqual(['d']);
  });

  it('ignores a patch op, which the curator no longer performs', () => {
    // Body edits moved to the assistant, which fixes a skill when it uses one and
    // finds it wrong — the only moment there is evidence of what is actually
    // broken. A model still emitting the retired op must not be obeyed.
    const ops = parseCurate('{"merge":[],"patch":[{"slug":"c","content":"rewritten"}],"archive":[]}');
    expect(ops).toEqual({ merge: [], archive: [] });
  });

  it('drops malformed ops (merge needs >=2 slugs, content non-empty)', () => {
    const ops = parseCurate('{"merge":[{"slugs":["a"],"description":"d","content":"x"}],"archive":[1]}');
    expect(ops.merge).toHaveLength(0);
    expect(ops.archive).toHaveLength(0);
  });

  it('returns empty ops on non-JSON', () => {
    expect(parseCurate('no json here')).toEqual({ merge: [], archive: [] });
  });
});

describe('clampCurate', () => {
  it('drops ops naming unknown slugs', () => {
    const known = new Set(['a', 'b']);
    const ops = clampCurate(
      { merge: [{ slugs: ['a', 'zzz'], description: 'd', content: 'x' }], archive: ['b', 'ghost'] },
      known,
      retireBudget(4)
    );
    expect(ops.merge).toHaveLength(0); // 'a' alone after filtering 'zzz' → <2 slugs
    expect(ops.archive).toEqual(['b']);
  });

  it('rejects a batch that would retire more than 40% of the set', () => {
    const known = new Set(['a', 'b', 'c', 'd', 'e']);
    const ops = clampCurate({ merge: [], archive: ['a', 'b', 'c'] }, known, retireBudget(5)); // 3/5 = 60%
    expect(ops).toEqual({ merge: [], archive: [] });
  });
});

describe('curateSkills', () => {
  it('merges duplicate agent skills and never touches user skills', async () => {
    writeSkill('make-coffee', { source: 'agent' });
    writeSkill('brew-coffee', { source: 'agent' });
    writeSkill('user-thing', { source: 'user' });

    const llm = fakeLlm(
      JSON.stringify({
        merge: [{ slugs: ['make-coffee', 'brew-coffee'], description: 'Use when the user asks for a pot of coffee.', content: MERGED_BODY }],
        archive: []
      })
    );
    const res = await curateSkills(llm, { force: true, embeddings: sameSpace() });
    expect(res.merged).toBe(1);
    expect(existsSync(join(skillsDir, 'make-coffee', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'brew-coffee'))).toBe(false); // loser removed
    expect(existsSync(join(skillsDir, 'user-thing', 'SKILL.md'))).toBe(true); // untouched
    const winner = readFileSync(join(skillsDir, 'make-coffee', 'SKILL.md'), 'utf8');
    expect(winner).toContain('Boil water');
    expect(winner).toMatch(/version:\s*2/); // bumped
  });

  it('archives a stale skill with the .disabled marker (reversible)', async () => {
    writeSkill('old-way', { source: 'agent' });
    writeSkill('keep-a', { source: 'agent' });
    writeSkill('keep-b', { source: 'agent' });

    const llm = fakeLlm(JSON.stringify({ merge: [], archive: ['old-way'] }));
    const res = await curateSkills(llm, { force: true, embeddings: sameSpace() });
    expect(res.archived).toBe(1);
    expect(existsSync(join(skillsDir, 'old-way', '.disabled'))).toBe(true);
    expect(existsSync(join(skillsDir, 'old-way', 'SKILL.md'))).toBe(true); // not deleted
    // ...and it actually leaves the prompt: the marker alone is invisible to the
    // backend, so the archive has to reach the ignore file too.
    const ignore = readFileSync(join(skillsDir, '.gitignore'), 'utf8');
    expect(ignore).toContain('old-way/');
    expect(ignore).not.toContain('keep-a/');
  });

  it('feeds usage stats into the prompt (tracked, never-used, tracking-since header)', async () => {
    writeSkill('used-one', { source: 'agent' });
    writeSkill('dusty-one', { source: 'agent' });
    recordUses(['used-one'], new Date('2026-07-10T00:00:00.000Z'));
    recordUses(['used-one'], new Date('2026-07-15T00:00:00.000Z'));

    let seen = '';
    const llm: LlmClient = {
      complete: async (prompt: string) => {
        seen = prompt;
        return '{"merge":[],"archive":[]}';
      }
    };
    await curateSkills(llm, { force: true, embeddings: sameSpace() });
    // Drift guard on the one-job posture (2026-10-10): merges are for the same job
    // written twice, never for "related" skills — the umbrella posture this replaced
    // produced descriptions that could not say what was inside them.
    expect(seen).toContain('ONLY two or more write-ups of the SAME job');
    expect(seen).not.toContain('labeled subsections?');
    expect(seen).toContain('archive — DEFAULT TO KEEP');
    expect(seen).toContain('Usage has been tracked since');
    expect(seen).toContain('used 2×, last 2026-07-15');
    expect(seen).toContain('never used since tracking began');
    expect(seen).toContain('Created 2026-01-01');
  });

  it('merge folds the losers\' usage into the winner and prunes their entries', async () => {
    writeSkill('make-coffee', { source: 'agent' });
    writeSkill('brew-coffee', { source: 'agent' });
    recordUses(['make-coffee'], new Date('2026-06-01T00:00:00.000Z'));
    recordUses(['brew-coffee'], new Date('2026-07-01T00:00:00.000Z'));

    const llm = fakeLlm(
      JSON.stringify({
        merge: [{ slugs: ['make-coffee', 'brew-coffee'], description: 'Use when the user asks for a pot of coffee.', content: MERGED_BODY }],
        archive: []
      })
    );
    const res = await curateSkills(llm, { force: true, embeddings: sameSpace() });
    expect(res.merged).toBe(1);
    const usage = readUsage();
    expect(usage.skills['make-coffee']).toEqual({ count: 2, lastUsedAt: '2026-07-01T00:00:00.000Z' });
    expect(usage.skills['brew-coffee']).toBeUndefined();
  });

  it('does not call the model for a library that has not changed since the last pass', async () => {
    writeSkill('make-coffee', {});
    writeSkill('brew-tea', {});
    writeSkill('pour-water', {});
    const first = routedLlm({});
    await curateSkills(first, { embeddings: sameSpace() });
    expect(first.prompts.length).toBeGreaterThan(0);
    const second = routedLlm({});
    const res = await curateSkills(second, { embeddings: sameSpace() });
    expect(second.prompts).toHaveLength(0);
    expect(res).toEqual({ merged: 0, archived: 0, split: 0 });
  });

  it('splits a skill whose sections are different jobs, keeping a backup', async () => {
    writeSkill('upgrade-unraid-container', {
      body: UMBRELLA_BODY,
      description: 'Use to diagnose port mismatches or upgrade to pinned images.'
    });
    writeSkill('keep-a', {});
    writeSkill('keep-b', {});
    const llm = routedLlm({
      split: [
        JSON.stringify({
          verdict: 'split',
          skills: [
            { name: 'ignored', description: 'Use when a container must move to a verified pinned image.', content: UPGRADE_BODY },
            { name: 'diagnose-container-port-mismatch', description: "Use when a container's published port does not answer.", content: PORT_BODY }
          ]
        })
      ]
    });
    const res = await curateSkills(llm, { embeddings: null });
    expect(res.split).toBe(1);
    const narrowed = readFileSync(join(skillsDir, 'upgrade-unraid-container', 'SKILL.md'), 'utf8');
    expect(narrowed).toContain('pinned digest');
    expect(narrowed).not.toContain('docker port');
    const part = readFileSync(join(skillsDir, 'diagnose-container-port-mismatch', 'SKILL.md'), 'utf8');
    expect(part).toContain('docker port');
    expect(part).toContain('origin: "approved"'); // provenance carried to the new part
    const runs = readdirSync(join(skillsDir, '.curator-history'));
    expect(runs).toHaveLength(1);
    expect(readFileSync(join(skillsDir, '.curator-history', runs[0], 'upgrade-unraid-container.md'), 'utf8')).toContain('### Port diagnosis');
  });

  it('retries a split once with the reason, then gives up and leaves the skill whole', async () => {
    writeSkill('upgrade-unraid-container', { body: UMBRELLA_BODY });
    writeSkill('keep-a', {});
    writeSkill('keep-b', {});
    const taken = JSON.stringify({
      verdict: 'split',
      skills: [
        { name: 'x', description: 'Use when a container must move to a verified pinned image.', content: UPGRADE_BODY },
        { name: 'keep-a', description: "Use when a container's published port does not answer.", content: PORT_BODY }
      ]
    });
    const llm = routedLlm({ split: [taken, taken] });
    const res = await curateSkills(llm, { embeddings: null });
    expect(res.split).toBe(0);
    expect(llm.prompts[1]).toContain('Your previous answer was rejected');
    expect(readFileSync(join(skillsDir, 'upgrade-unraid-container', 'SKILL.md'), 'utf8')).toContain('### Port diagnosis');
  });

  it("never reviews the user's own skills, only Stem's ideas", async () => {
    for (const origin of ['user-requested', 'imported', 'learn', 'recorded']) {
      writeSkill(`${origin}-umbrella`, { body: UMBRELLA_BODY, origin, description: 'Use to do two things.' });
    }
    writeSkill('auto-umbrella', { body: UMBRELLA_BODY, origin: 'turn', description: 'Use to do two things.' });
    const llm = routedLlm({});
    const res = await curateSkills(llm, { force: true, embeddings: null });
    expect(res.split).toBe(0);
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]).toContain('[auto-umbrella]');
  });

  it('shows read-only skills in a merge group but refuses to merge or archive them', async () => {
    writeSkill('recorded-coffee', { origin: 'recorded' });
    writeSkill('agent-coffee', {});
    writeSkill('other-coffee', {});
    let seen = '';
    const llm: LlmClient = {
      complete: async (prompt: string) => {
        seen = prompt;
        return JSON.stringify({
          merge: [{ slugs: ['recorded-coffee', 'agent-coffee'], description: 'Use when the user asks for coffee.', content: MERGED_BODY }],
          archive: ['other-coffee', 'recorded-coffee']
        });
      }
    };
    const res = await curateSkills(llm, { embeddings: sameSpace() });
    expect(seen).toContain("READ-ONLY (the user's own)");
    expect(res).toEqual({ merged: 0, archived: 1, split: 0 });
    expect(existsSync(join(skillsDir, 'agent-coffee', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'other-coffee', '.disabled'))).toBe(true);
    expect(existsSync(join(skillsDir, 'recorded-coffee', '.disabled'))).toBe(false);
  });
});

describe('split helpers', () => {
  it('flags skills with several labeled parts or a "Use to" description', () => {
    expect(splitCandidate({ body: UMBRELLA_BODY, description: 'Use when x happens.' })).toBe(true);
    expect(splitCandidate({ body: PORT_BODY, description: 'Use to diagnose ports or upgrade images.' })).toBe(true);
    expect(splitCandidate({ body: PORT_BODY, description: "Use when a container's port does not answer." })).toBe(false);
  });

  it('parseSplit reads malformed or one-part answers as "one"', () => {
    expect(parseSplit('nope')).toEqual({ verdict: 'one' });
    expect(parseSplit('{"verdict":"split","skills":[{"name":"a","description":"d","content":"c"}]}')).toEqual({ verdict: 'one' });
    expect(parseSplit('{"verdict":"one","description":"Use when x."}')).toEqual({ verdict: 'one', description: 'Use when x.' });
  });

  it('checkSplit pins the first part to the original slug and rejects taken names', () => {
    const parts = [
      { name: 'whatever', description: 'Use when a container must move to a verified pinned image.', body: UPGRADE_BODY },
      { name: 'diagnose-port', description: "Use when a container's published port does not answer.", body: PORT_BODY }
    ];
    const ok = checkSplit({ slug: 'upgrade-container' }, parts, new Set(['upgrade-container']));
    expect(ok.ok && ok.parts.map((p) => p.name)).toEqual(['upgrade-container', 'diagnose-port']);
    expect(checkSplit({ slug: 'upgrade-container' }, parts, new Set(['diagnose-port'])).ok).toBe(false);
    const vague = [parts[0], { ...parts[1], description: 'Use to check ports.' }];
    expect(checkSplit({ slug: 'upgrade-container' }, vague, new Set()).ok).toBe(false);
  });
});
