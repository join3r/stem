// The reflection pass: after a settled delivery turn, one completion extracts
// 0–3 durable work notes into the persona's memory. The properties under test:
// eligibility (helpers and missing personas never reflect), the too-small-to-
// matter skip, defensive parsing of the model's reply, that notes land with
// source 'reflection', and that nothing here ever rejects.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { parseReflection, reflectOnDelivery } from '../../src/server/mail/reflect';
import { listPersonaNotes, savePersonaNote } from '../../src/server/workspace/persona-memory';
import { savePersona, savePersonaFor } from '../../src/server/workspace/personas';
import { personaMemoryDir, personasStorePath, settingsStorePath } from '../../src/server/workspace/paths';
import type { ChatBackend } from '../../src/server/backend/types';

const memoryDir = personaMemoryDir();

beforeEach(() => {
  rmSync(memoryDir, { recursive: true, force: true });
  rmSync(personasStorePath(), { force: true });
  rmSync(settingsStorePath(), { force: true });
});
afterEach(() => {
  rmSync(memoryDir, { recursive: true, force: true });
  rmSync(personasStorePath(), { force: true });
  rmSync(settingsStorePath(), { force: true });
});

/** Long enough to clear the too-small-to-reflect gate. */
const assignment = 'investigate the flaky login test and report what makes it flake '.repeat(10);

function fakeRuntime(over: {
  completions?: string[];
  reply?: string;
  prompts?: string[];
}): ChatBackend {
  const completions = over.completions ?? ['[]'];
  return {
    readThread: async () => ({
      title: 't',
      messages: [
        { id: '1', role: 'user', content: 'the assignment' },
        { id: '2', role: 'assistant', content: over.reply ?? 'the reply, long enough to matter' }
      ]
    }),
    complete: async (prompt: string) => {
      over.prompts?.push(prompt);
      return completions.shift() ?? '[]';
    }
  } as unknown as ChatBackend;
}

describe('parseReflection', () => {
  it('reads the first JSON array out of a chatty reply and drops junk entries', () => {
    const notes = parseReflection(
      'Here you go:\n[{"title":"A","body":"lesson"},{"nope":1},{"body":"untitled lesson"}]\nHope that helps!'
    );
    expect(notes).toEqual([
      { title: 'A', body: 'lesson' },
      { title: '', body: 'untitled lesson' }
    ]);
  });

  it('answers nothing for prose, malformed JSON, or a non-array', () => {
    expect(parseReflection('no notes today')).toEqual([]);
    expect(parseReflection('[{"title": broken')).toEqual([]);
    expect(parseReflection('{"title":"A","body":"b"}')).toEqual([]);
  });

  it('caps at three notes', () => {
    const five = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({ title: `t${i}`, body: `b${i}` }))
    );
    expect(parseReflection(five)).toHaveLength(3);
  });
});

describe('reflectOnDelivery', () => {
  it('writes the model’s notes with source reflection', async () => {
    const runtime = fakeRuntime({
      completions: ['[{"title":"Login flake","body":"The login test flakes when the clock is mocked."}]']
    });
    await reflectOnDelivery(runtime, { personaId: 'verifier', assignment, threadId: 't1' });
    const notes = await listPersonaNotes('verifier');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      title: 'Login flake',
      body: 'The login test flakes when the clock is mocked.',
      source: 'reflection'
    });
  });

  it('tells the model what the persona already knows, so it can decline to repeat it', async () => {
    await savePersonaNote('verifier', { title: 'Known already', body: 'x' }, 'tool');
    const prompts: string[] = [];
    const runtime = fakeRuntime({ prompts });
    await reflectOnDelivery(runtime, { personaId: 'verifier', assignment, threadId: 't1' });
    expect(prompts[0]).toContain('- Known already');
    expect(prompts[0]).toContain('do not repeat what they cover');
  });

  it('never reflects for an agent-created helper or a persona that no longer exists', async () => {
    const helper = await savePersonaFor('orchestrator', { name: 'researcher-1', prompt: 'r' });
    const prompts: string[] = [];
    const runtime = fakeRuntime({ prompts });
    await reflectOnDelivery(runtime, { personaId: helper.id, assignment, threadId: 't1' });
    await reflectOnDelivery(runtime, { personaId: 'never-existed', assignment, threadId: 't1' });
    expect(prompts).toEqual([]);
  });

  it('skips a turn too small to have taught anything', async () => {
    const prompts: string[] = [];
    const runtime = fakeRuntime({ prompts, reply: 'ok' });
    await reflectOnDelivery(runtime, { personaId: 'verifier', assignment: 'ping', threadId: 't1' });
    expect(prompts).toEqual([]);
  });

  it('skips quietly on a backend without the one-shot seam, and never rejects on a failing one', async () => {
    await expect(
      reflectOnDelivery({ readThread: async () => ({ title: '', messages: [] }) } as unknown as ChatBackend, {
        personaId: 'verifier',
        assignment,
        threadId: 't1'
      })
    ).resolves.toBeUndefined();
    const failing = fakeRuntime({});
    (failing as { complete: unknown }).complete = async () => {
      throw new Error('model down');
    };
    await expect(
      reflectOnDelivery(failing, { personaId: 'verifier', assignment, threadId: 't1' })
    ).resolves.toBeUndefined();
    expect(await listPersonaNotes('verifier')).toEqual([]);
  });

  it('a persona saved through the editor reflects like a built-in', async () => {
    await savePersona({ id: 'mine', name: 'researcher', prompt: 'research things' });
    const runtime = fakeRuntime({ completions: ['[{"body":"editor personas learn too"}]'] });
    await reflectOnDelivery(runtime, { personaId: 'mine', assignment, threadId: 't1' });
    expect((await listPersonaNotes('mine')).map((n) => n.body)).toEqual(['editor personas learn too']);
  });
});
