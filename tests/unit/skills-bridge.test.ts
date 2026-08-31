// The policy layer in front of every skill write the model asks for. The rules it
// encodes are not obvious from any one call site, so they are pinned here: the
// mode limits Stem's own initiative and nothing else, the validator runs before
// the user's attention is spent, and a refusal has to leave the model a path that
// still works. Uses a throwaway skills dir (STEM_SKILLS_DIR) so the real saveSkill
// runs and the front-matter can be read back off disk.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skills-bridge-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import {
  SkillBridge,
  type SkillApprovalOutcome,
  type SkillBridgeDeps,
  type SkillSaveRequest
} from '../../src/server/skills/bridge';
import type { SkillsMode } from '../../src/shared/types';

type Proposal = Parameters<SkillBridgeDeps['requestApproval']>[0];

const BODY = `## When to use
When the user asks what was said in a video that has captions.

## Steps
1. Open the watch URL with \`agent-browser open "<url>"\`.
2. Click the "..." menu, then "Show transcript".

## Verification
The transcript panel lists timestamped lines.`;

const SAVE: SkillSaveRequest = {
  op: 'save',
  initiatedBy: 'assistant',
  name: 'extract-video-captions',
  description: 'Pull the caption text out of a video when the user asks what was said in it.',
  body: BODY
};

function harness(opts: { mode?: SkillsMode; approve?: (p: Proposal) => SkillApprovalOutcome } = {}) {
  const seen = { approvals: [] as Proposal[], changed: 0, modeReads: 0 };
  const bridge = new SkillBridge({
    mode: async () => {
      seen.modeReads += 1;
      return opts.mode ?? 'ask';
    },
    requestApproval: async (proposal) => {
      seen.approvals.push(proposal);
      return opts.approve ? opts.approve(proposal) : { approved: true };
    },
    onChanged: () => {
      seen.changed += 1;
    }
  });
  return { bridge, seen };
}

const live = { isScheduled: false };

function onDisk(slug: string): boolean {
  return existsSync(join(skillsDir, slug, 'SKILL.md'));
}

function fileFor(slug: string): string {
  return readFileSync(join(skillsDir, slug, 'SKILL.md'), 'utf8');
}

/** A skill the user put there by hand: no stem bookkeeping means source: user. */
function writeUserSkill(slug: string): void {
  mkdirSync(join(skillsDir, slug), { recursive: true });
  writeFileSync(
    join(skillsDir, slug, 'SKILL.md'),
    `---\nname: ${JSON.stringify(slug)}\ndescription: "hand-written"\nmetadata:\n  stem:\n    source: user\n---\n\n${BODY}\n`,
    'utf8'
  );
}

beforeEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
});
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

describe('a save the user asked for', () => {
  for (const mode of ['off', 'ask', 'auto'] as SkillsMode[]) {
    it(`writes in ${mode} mode without raising a card`, async () => {
      // The mode's own label for off is "only when I ask", so refusing an explicit
      // request there would contradict the setting the user chose. Ask is the same
      // argument one step softer: the user already asked, and asking again is
      // friction on the one authoring path that demonstrably works.
      const { bridge, seen } = harness({ mode });
      const res = await bridge.handleRequest({ ...SAVE, initiatedBy: 'user' }, live);
      expect(res.ok).toBe(true);
      expect(onDisk('extract-video-captions')).toBe(true);
      expect(seen.approvals).toHaveLength(0);
    });
  }

  it('writes during a scheduled run, where Stem\'s own idea would be refused', async () => {
    // "Nobody is watching" is a reason not to propose. It is not a reason to drop
    // an instruction the user left behind for the run to carry out.
    const { bridge, seen } = harness({ mode: 'ask' });
    const res = await bridge.handleRequest({ ...SAVE, initiatedBy: 'user' }, { isScheduled: true });
    expect(res.ok).toBe(true);
    expect(seen.approvals).toHaveLength(0);
  });
});

describe('a save Stem thought of itself', () => {
  it('is refused in off mode with guidance that keeps the model offering', async () => {
    // Without this text the model learns only that the tool fails, and stops
    // raising the idea at all — which quietly deletes the path where the user says
    // yes. The refusal has to name the path that still works.
    const { bridge, seen } = harness({ mode: 'off' });
    const res = await bridge.handleRequest(SAVE, live);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('Do not retry the tool');
    expect(res.text).toContain('say so briefly at the end of your reply');
    expect(res.text).toContain('initiated_by "user"');
    expect(seen.approvals).toHaveLength(0);
    expect(onDisk('extract-video-captions')).toBe(false);
  });

  it('writes silently in auto mode', async () => {
    const { bridge, seen } = harness({ mode: 'auto' });
    const res = await bridge.handleRequest(SAVE, live);
    expect(res.ok).toBe(true);
    expect(seen.approvals).toHaveLength(0);
    expect(onDisk('extract-video-captions')).toBe(true);
  });

  it('raises exactly one card in ask mode and writes what was approved', async () => {
    const { bridge, seen } = harness({ mode: 'ask' });
    const res = await bridge.handleRequest(SAVE, live);
    expect(res.ok).toBe(true);
    expect(seen.approvals).toHaveLength(1);
    expect(seen.approvals[0]).toMatchObject({ name: 'extract-video-captions', isPatch: false });
    expect(onDisk('extract-video-captions')).toBe(true);
  });

  it('writes nothing when the card is declined, and tells the model not to retry', async () => {
    const { bridge, seen } = harness({ mode: 'ask', approve: () => ({ approved: false }) });
    const res = await bridge.handleRequest(SAVE, live);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('Do not retry the tool');
    expect(onDisk('extract-video-captions')).toBe(false);
    expect(seen.changed).toBe(0);
  });

  it('is refused in a mail turn with the propose-by-reply path, without consulting the mode', async () => {
    // Mail differs from a scheduled run in that a human IS on the other end —
    // just not live at a card. The refusal must hand the model the reply path,
    // and a sender's later "yes" comes back as a user-initiated save (below).
    const { bridge, seen } = harness({ mode: 'ask' });
    const res = await bridge.handleRequest(SAVE, { isScheduled: true, isMail: true });
    expect(res.ok).toBe(false);
    expect(res.text).toContain('reply mail');
    expect(res.text).toContain('initiated_by "user"');
    expect(seen.modeReads).toBe(0);
    expect(seen.approvals).toHaveLength(0);
    expect(onDisk('extract-video-captions')).toBe(false);
  });

  it('writes a user-requested save during a mail turn without a card', async () => {
    const { bridge, seen } = harness({ mode: 'ask' });
    const res = await bridge.handleRequest({ ...SAVE, initiatedBy: 'user' }, { isScheduled: true, isMail: true });
    expect(res.ok).toBe(true);
    expect(seen.approvals).toHaveLength(0);
    expect(onDisk('extract-video-captions')).toBe(true);
  });

  it('is refused on a scheduled run without ever consulting the mode', async () => {
    // A card with nobody in front of the screen is a dead card, and in auto a
    // silent write out of an unattended run is worse. Neither answer the mode can
    // give is the right one, so it is not asked.
    const { bridge, seen } = harness({ mode: 'ask' });
    const res = await bridge.handleRequest(SAVE, { isScheduled: true });
    expect(res.ok).toBe(false);
    expect(res.text).toContain('nobody watching');
    expect(seen.modeReads).toBe(0);
    expect(seen.approvals).toHaveLength(0);
  });

  it('marks a patch as one on the card', async () => {
    const { bridge } = harness({ mode: 'auto' });
    await bridge.handleRequest(SAVE, live);
    const ask = harness({ mode: 'ask' });
    await ask.bridge.handleRequest({ ...SAVE, expectExisting: true }, live);
    expect(ask.seen.approvals[0]?.isPatch).toBe(true);
  });
});

describe('validation', () => {
  it('refuses an invalid draft before any card is raised', async () => {
    // Spending the user's attention on a file that would fail the contract anyway
    // is the one cost a card can never earn back.
    const { bridge, seen } = harness({ mode: 'ask' });
    const res = await bridge.handleRequest({ ...SAVE, name: 'Extract Video Captions' }, live);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('name must be lowercase');
    expect(seen.approvals).toHaveLength(0);
    expect(seen.modeReads).toBe(0);
  });

  it('refuses a user-initiated draft too, with every violation listed', async () => {
    const { bridge } = harness({ mode: 'off' });
    const res = await bridge.handleRequest({ ...SAVE, initiatedBy: 'user', name: 'Bad Name', body: 'just some prose' }, live);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('- name:');
    expect(res.text).toContain('- body:');
    expect(onDisk('bad-name')).toBe(false);
  });

  it('re-validates the text the user edited in the card', async () => {
    // The card is editable, so what the model proposed and what the user accepted
    // are different documents. Only the second one matters.
    const { bridge, seen } = harness({
      mode: 'ask',
      approve: (p) => ({ approved: true, skill: { ...p, body: 'I deleted the headings' } })
    });
    const res = await bridge.handleRequest(SAVE, live);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('no longer meets the contract');
    expect(onDisk('extract-video-captions')).toBe(false);
    expect(seen.changed).toBe(0);
  });

  it('writes the edited text, not the proposed text', async () => {
    const { bridge } = harness({
      mode: 'ask',
      approve: (p) => ({ approved: true, skill: { ...p, body: p.body.replace('Show transcript', 'Open transcript') } })
    });
    expect((await bridge.handleRequest(SAVE, live)).ok).toBe(true);
    expect(fileFor('extract-video-captions')).toContain('Open transcript');
  });
});

describe('provenance', () => {
  it('records a card-approved skill as user-requested', async () => {
    // The model drafted it, but the user read this exact text and accepted it —
    // a stronger warrant than anything the assistant produced alone, and it is
    // what the injected label has to say.
    const { bridge } = harness({ mode: 'ask' });
    await bridge.handleRequest(SAVE, live);
    expect(fileFor('extract-video-captions')).toContain('origin: "user-requested"');
  });

  it('records an auto-mode save as the assistant\'s own', async () => {
    const { bridge } = harness({ mode: 'auto' });
    await bridge.handleRequest(SAVE, live);
    expect(fileFor('extract-video-captions')).toContain('origin: "assistant"');
  });

  it('honours an explicit origin override from a surface that knows better', async () => {
    const { bridge } = harness({ mode: 'off' });
    await bridge.handleRequest({ ...SAVE, initiatedBy: 'user', origin: 'learn' }, live);
    expect(fileFor('extract-video-captions')).toContain('origin: "learn"');
  });
});

describe('patching a skill that is not there', () => {
  it('fails without writing when expectExisting is set', async () => {
    // The model asking to patch a skill it does not have has misremembered its own
    // library; inventing it from a patch-shaped draft lands a half-written file.
    const { bridge, seen } = harness({ mode: 'auto' });
    const res = await bridge.handleRequest({ ...SAVE, expectExisting: true }, live);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('Save it as a new skill instead');
    expect(onDisk('extract-video-captions')).toBe(false);
    expect(seen.changed).toBe(0);
  });

  it('checks before the mode, so off and auto answer the same way', async () => {
    const { bridge, seen } = harness({ mode: 'off' });
    const res = await bridge.handleRequest({ ...SAVE, expectExisting: true }, live);
    expect(res.text).toContain('No skill "extract-video-captions"');
    expect(seen.modeReads).toBe(0);
  });
});

describe('remove', () => {
  it('retires a skill Stem wrote', async () => {
    const { bridge, seen } = harness({ mode: 'auto' });
    await bridge.handleRequest(SAVE, live);
    const res = await bridge.handleRequest({ op: 'remove', name: 'extract-video-captions' }, live);
    expect(res.ok).toBe(true);
    expect(onDisk('extract-video-captions')).toBe(false);
    expect(seen.changed).toBe(2);
  });

  it('refuses a skill the user wrote', async () => {
    // The model may retire what it wrote. A file the user dropped in is theirs to
    // delete, and deleting it from a tool call is unrecoverable.
    writeUserSkill('hand-written');
    const { bridge, seen } = harness({ mode: 'auto' });
    const res = await bridge.handleRequest({ op: 'remove', name: 'hand-written' }, live);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('remove it from the app instead');
    expect(onDisk('hand-written')).toBe(true);
    expect(seen.changed).toBe(0);
  });

  it('reports a missing skill and an empty name without touching disk', async () => {
    const { bridge, seen } = harness();
    expect(await bridge.handleRequest({ op: 'remove', name: 'ghost' }, live)).toMatchObject({ ok: false });
    expect(await bridge.handleRequest({ op: 'remove', name: '  ' }, live)).toMatchObject({
      ok: false,
      text: 'Specify which skill to remove.'
    });
    expect(seen.changed).toBe(0);
  });
});

describe('onChanged', () => {
  it('fires once per successful write and never on a refusal', async () => {
    // It is what reloads the backend and refreshes the Manage panel: firing when
    // nothing changed forces a needless reload mid-conversation.
    const { bridge, seen } = harness({ mode: 'auto' });
    await bridge.handleRequest(SAVE, live);
    await bridge.handleRequest(SAVE, live);
    expect(seen.changed).toBe(2);

    const off = harness({ mode: 'off' });
    await off.bridge.handleRequest(SAVE, live);
    await off.bridge.handleRequest({ ...SAVE, name: 'Nope' }, live);
    expect(off.seen.changed).toBe(0);
  });
});
