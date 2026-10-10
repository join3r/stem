// The one-time label repair. What matters most is what it refuses to do: a skill
// with no evidence keeps the user's label, and an import goes back to exactly the
// text that was installed.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skills-provenance-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import {
  SKILLS_PROVENANCE_FILE,
  checkUntangle,
  copiedFrom,
  drifted,
  inferOrigin,
  migrateSkillProvenance,
  readSessionSaves,
  type SaveEvidence,
  type SkillEvidence
} from '../../src/server/skills/provenance';
import { readSkillRecord } from '../../src/server/skills/store';
import type { LlmClient } from '../../src/server/recall/llm';

const body = (job: string, steps: string[]): string =>
  `## When to use\nUse for ${job} and nothing else at all.\n\n## Steps\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n## Verification\nConfirm the ${job} result is visible on screen.`;

const BROWSER = body('driving a browser with agent-browser', [
  'Create a session with `npx -y agent-browser session id --scope worktree`.',
  'Open the page with `npx -y agent-browser open "<url>"` and snapshot it.',
  'Take a fresh snapshot after every navigation before clicking anything.'
]);
const ISSUER = body('finding the App Store Connect Issuer ID', [
  'Open https://appstoreconnect.apple.com/access/integrations/api in the browser.',
  'Copy the value shown beside Issuer ID and return it to the user.'
]);

function writeSkill(slug: string, opts: { origin: string; description: string; body: string; created?: string }): void {
  mkdirSync(join(skillsDir, slug), { recursive: true });
  writeFileSync(
    join(skillsDir, slug, 'SKILL.md'),
    `---\nname: "${slug}"\ndescription: ${JSON.stringify(opts.description)}\nmetadata:\n  stem:\n    source: agent\n    origin: "${opts.origin}"\n    version: 3\n    created: "${opts.created ?? '2026-09-01T00:00:00.000Z'}"\n    updated: "2026-09-20T00:00:00.000Z"\n---\n\n${opts.body}\n`,
    'utf8'
  );
}

const save = (over: Partial<SaveEvidence>): SaveEvidence => ({
  at: '2026-09-01T00:00:00.000Z',
  by: 'user',
  description: 'd',
  body: 'b',
  copied: false,
  ...over
});

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

const line = (o: unknown): string => JSON.stringify(o);
function session(entries: unknown[]): string {
  return entries.map(line).join('\n');
}
const user = (t: string, at = '2026-09-01T10:00:00.000Z') => ({ type: 'message', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: t }] } });
const call = (id: string, args: Record<string, unknown>) => ({
  type: 'message',
  timestamp: '2026-09-01T10:01:00.000Z',
  message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'manage_skill', arguments: args }] }
});
const result = (id: string, text: string, isError = false) => ({
  type: 'message',
  message: { role: 'toolResult', toolCallId: id, isError, content: [{ type: 'text', text }] }
});

beforeEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
});
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

describe('reading the sessions', () => {
  it('records successful saves with who started them, and whether the text was pasted in', () => {
    const saves = new Map<string, SaveEvidence[]>();
    const first = readSessionSaves(
      session([
        user(`install this skill please:\n${BROWSER}`),
        call('a', { action: 'save', name: 'agent-browser-vercel', initiated_by: 'user', description: 'Browser CLI.', content: BROWSER }),
        result('a', 'Saved skill "agent-browser-vercel". It becomes active on the next turn.'),
        call('b', { action: 'save', name: 'find-issuer-id', initiated_by: 'assistant', description: 'Use when…', content: ISSUER }),
        result('b', 'The user declined saving that skill. Do not retry the tool.'),
        call('c', { action: 'save', name: 'find-issuer-id', initiated_by: 'assistant', description: 'Use when…', content: ISSUER }),
        result('c', 'Saved skill "find-issuer-id".', true),
        call('d', { action: 'remove', name: 'old-thing', initiated_by: 'user' }),
        result('d', 'Removed skill "old-thing".')
      ]),
      saves
    );
    expect(first).toBe('2026-09-01T10:00:00.000Z');
    expect([...saves.keys()]).toEqual(['agent-browser-vercel']);
    expect(saves.get('agent-browser-vercel')![0]).toMatchObject({ by: 'user', copied: true, body: BROWSER });
  });

  it('counts text a tool fetched as copied, but not the model drafting it itself', () => {
    const fetched = new Map<string, SaveEvidence[]>();
    readSessionSaves(
      session([
        user('add the agent-browser skill from its repo'),
        { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'f', name: 'web_fetch', arguments: {} }] } },
        result('f', BROWSER),
        call('a', { action: 'save', name: 'agent-browser-vercel', initiated_by: 'user', description: 'x', content: BROWSER }),
        result('a', 'Saved skill "agent-browser-vercel".')
      ]),
      fetched
    );
    expect(fetched.get('agent-browser-vercel')![0].copied).toBe(true);

    const drafted = new Map<string, SaveEvidence[]>();
    readSessionSaves(
      session([
        user('save that as a skill'),
        call('a', { action: 'save', name: 'agent-browser-vercel', initiated_by: 'user', description: 'x', content: BROWSER }),
        result('a', 'Saved skill "agent-browser-vercel".')
      ]),
      drafted
    );
    expect(drafted.get('agent-browser-vercel')![0].copied).toBe(false);
  });

  it('counts a skill file fetched in the same turn, even when the save rewords it', () => {
    const saves = new Map<string, SaveEvidence[]>();
    readSessionSaves(
      session([
        user('install the official agent-browser skill'),
        { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'f', name: 'fetch', arguments: {} }] } },
        result('f', '# agent-browser\n\n---\nname: agent-browser\ndescription: Browser automation CLI for AI agents.\n---\n\nRun it.'),
        call('a', { action: 'save', name: 'agent-browser-vercel', initiated_by: 'user', description: 'x', content: BROWSER }),
        result('a', 'Saved skill "agent-browser-vercel".'),
        user('now save the deploy steps we just did as a skill'),
        call('b', { action: 'save', name: 'deploy-the-thing', initiated_by: 'user', description: 'x', content: ISSUER }),
        result('b', 'Saved skill "deploy-the-thing".')
      ]),
      saves
    );
    expect(saves.get('agent-browser-vercel')![0].copied).toBe(true);
    // The next turn starts clean.
    expect(saves.get('deploy-the-thing')![0].copied).toBe(false);
  });

  it('needs most substantial lines to match, not a shared heading', () => {
    expect(copiedFrom(BROWSER, new Set(['## Steps', 'Use for driving a browser with agent-browser and nothing else at all.']))).toBe(false);
  });
});

describe('inferOrigin', () => {
  const skill = { origin: 'user-requested' as const, created: '2026-09-05T00:00:00.000Z' };

  it('keeps a skill the user saved themselves', () => {
    expect(inferOrigin(skill, [save({})])).toBeUndefined();
  });

  it('marks it imported when the user installed text that already existed', () => {
    expect(inferOrigin(skill, [save({ copied: true })])).toBe('imported');
    expect(inferOrigin(skill, [save({ by: 'import' })])).toBe('imported');
  });

  it('marks it approved when only Stem ever saved it (a card the user accepted)', () => {
    expect(inferOrigin(skill, [save({ by: 'assistant' })])).toBe('approved');
  });

  it('reads silence as a card only where the history reaches back past the skill', () => {
    expect(inferOrigin(skill, [], '2026-08-01T00:00:00.000Z')).toBe('approved');
    // A chat the user deleted leaves no call either: keep their label.
    expect(inferOrigin(skill, [], '2026-09-10T00:00:00.000Z')).toBeUndefined();
    expect(inferOrigin(skill, [])).toBeUndefined();
  });

  it('never touches any other label', () => {
    for (const origin of ['learn', 'recorded', 'imported', 'assistant', 'approved'] as const) {
      expect(inferOrigin({ ...skill, origin }, [save({ by: 'assistant' })], '2026-01-01')).toBeUndefined();
    }
  });
});

describe('drifted', () => {
  it('compares against the last save the user made, ignoring whitespace', () => {
    const saves = [save({ body: 'old' }), save({ body: 'a  b', description: 'd' }), save({ by: 'assistant', body: 'later' })];
    expect(drifted({ description: 'd', body: 'a b' }, saves)).toBeUndefined();
    expect(drifted({ description: 'd', body: 'a b\nmore' }, saves)?.body).toBe('a  b');
    expect(drifted({ description: 'd', body: 'x' }, [save({ by: 'assistant' })])).toBeUndefined();
  });
});

describe('checkUntangle', () => {
  const part = { name: 'retrieve-app-store-connect-issuer-id', description: 'Use when retrieving the App Store Connect Issuer ID.', body: ISSUER };

  it('accepts nothing to extract', () => {
    expect(checkUntangle({ slug: 's', origin: 'user-requested' }, { extracted: [], keep: null }, new Set())).toBeNull();
  });

  it('refuses a taken name, an un-authored description, or a missing keep', () => {
    expect(checkUntangle({ slug: 's', origin: 'imported' }, { extracted: [part], keep: null }, new Set([part.name]))).toMatch(/taken/);
    expect(checkUntangle({ slug: 's', origin: 'imported' }, { extracted: [{ ...part, description: 'Issuer ID lookup.' }], keep: null }, new Set())).toMatch(
      /Use when/
    );
    expect(checkUntangle({ slug: 's', origin: 'user-requested' }, { extracted: [part], keep: null }, new Set())).toMatch(/keep/);
    expect(checkUntangle({ slug: 's', origin: 'imported' }, { extracted: [part], keep: null }, new Set())).toBeNull();
  });
});

describe('migrateSkillProvenance', () => {
  const tangled = `${BROWSER}\n\n### App Store Connect Issuer ID\n1. Open the API keys page and copy the Issuer ID.`;
  const evidence = (): SkillEvidence => ({
    historyStart: '2026-08-01T00:00:00.000Z',
    saves: new Map([
      ['agent-browser-vercel', [save({ description: 'Browser automation CLI.', body: BROWSER, copied: true })]],
      ['query-postgres', [save({ description: 'Use when querying Postgres.', body: ISSUER })]],
      ['summarise-podcast', [save({ by: 'assistant' })]]
    ])
  });
  const reply = JSON.stringify({
    extracted: [{ name: 'retrieve-app-store-connect-issuer-id', description: 'Use when retrieving the App Store Connect Issuer ID.', body: ISSUER }],
    keep: null
  });

  function library(): void {
    writeSkill('agent-browser-vercel', { origin: 'user-requested', description: 'Use when browsing, or finding Apple IDs.', body: tangled });
    writeSkill('query-postgres', { origin: 'user-requested', description: 'Use when querying Postgres.', body: ISSUER });
    writeSkill('summarise-podcast', { origin: 'user-requested', description: 'Use when summarising a podcast.', body: BROWSER });
    writeSkill('card-from-a-turn', { origin: 'user-requested', description: 'Use when doing a thing.', body: BROWSER });
    writeSkill('my-recording', { origin: 'recorded', description: 'Use when replaying.', body: BROWSER });
  }

  it('relabels, restores the import, pulls the merged job out, and finishes', async () => {
    library();
    const llm = scriptedLlm([reply]);
    const res = await migrateSkillProvenance(llm, { evidence: evidence(), embeddings: null });

    expect(res.relabeled).toEqual({ 'agent-browser-vercel': 'imported', 'summarise-podcast': 'approved', 'card-from-a-turn': 'approved' });
    expect(readSkillRecord('query-postgres')!.origin).toBe('user-requested');
    expect(readSkillRecord('my-recording')!.origin).toBe('recorded');

    const restored = readSkillRecord('agent-browser-vercel')!;
    expect(restored).toMatchObject({ origin: 'imported', description: 'Browser automation CLI.', body: BROWSER });
    expect(readSkillRecord('retrieve-app-store-connect-issuer-id')!.origin).toBe('approved');
    expect(res.untangled).toEqual(['agent-browser-vercel']);
    // Only the drifted skill cost a model call, and it saw the rest of the library.
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]).toContain('- query-postgres: Use when querying Postgres.');

    expect(existsSync(join(skillsDir, SKILLS_PROVENANCE_FILE))).toBe(true);
    const runs = readdirSync(join(skillsDir, '.curator-history'));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatch(/-relabel$/);
    expect(readFileSync(join(skillsDir, '.curator-history', runs[0], 'agent-browser-vercel.md'), 'utf8')).toContain('### App Store Connect');

    // Once is enough.
    const again = await migrateSkillProvenance(scriptedLlm([reply]), { evidence: evidence(), embeddings: null });
    expect(again).toEqual({ relabeled: {}, untangled: [], extracted: [], pending: [] });
  });

  it('keeps a user-requested skill as it is when the model finds nothing merged in', async () => {
    writeSkill('query-postgres', { origin: 'user-requested', description: 'Use when querying Postgres.', body: `${ISSUER}\n\nNote: the port is 5433.` });
    const res = await migrateSkillProvenance(scriptedLlm([JSON.stringify({ extracted: [], keep: null })]), {
      evidence: evidence(),
      embeddings: null
    });
    expect(res.untangled).toEqual([]);
    expect(readSkillRecord('query-postgres')!.body).toContain('5433');
    expect(existsSync(join(skillsDir, SKILLS_PROVENANCE_FILE))).toBe(true);
  });

  it('relabels without a model and comes back later for the untangling', async () => {
    library();
    const res = await migrateSkillProvenance(null, { evidence: evidence(), embeddings: null });
    expect(res.relabeled['summarise-podcast']).toBe('approved');
    expect(res.pending).toEqual(['agent-browser-vercel']);
    expect(readSkillRecord('agent-browser-vercel')!.body).toBe(tangled);
    expect(existsSync(join(skillsDir, SKILLS_PROVENANCE_FILE))).toBe(false);

    const later = await migrateSkillProvenance(scriptedLlm([reply]), { evidence: evidence(), embeddings: null });
    expect(later.relabeled).toEqual({});
    expect(later.untangled).toEqual(['agent-browser-vercel']);
  });

  it('retries a broken answer once, then leaves the skill alone', async () => {
    library();
    const llm = scriptedLlm(['not json', 'still not json']);
    const res = await migrateSkillProvenance(llm, { evidence: evidence(), embeddings: null });
    expect(llm.prompts).toHaveLength(2);
    expect(res.untangled).toEqual([]);
    expect(readSkillRecord('agent-browser-vercel')!.body).toBe(tangled);
  });
});
