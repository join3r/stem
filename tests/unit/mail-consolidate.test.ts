// The consolidation pass: the memory model tidies a persona's whole store
// (merge overlaps, drop advice). Under test: the trigger arithmetic, defensive
// parsing, the guard rails that keep a bad reply from erasing a store (unknown
// or reused ids, empty plans, merges without text), that user notes never
// enter the pass, that kept notes keep their id, and that the outcome is
// reported rather than thrown.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  CONSOLIDATE_EVERY,
  consolidatePersonaMemory,
  parseConsolidation,
  shouldConsolidate
} from '../../src/server/mail/consolidate';
import {
  listPersonaNotes,
  readPersonaMemory,
  savePersonaNote
} from '../../src/server/workspace/persona-memory';
import { savePersona } from '../../src/server/workspace/personas';
import { personaMemoryDir, personasStorePath, settingsStorePath } from '../../src/server/workspace/paths';
import type { ChatBackend } from '../../src/server/backend/types';

const memoryDir = personaMemoryDir();
const wipe = () => {
  rmSync(memoryDir, { recursive: true, force: true });
  rmSync(personasStorePath(), { force: true });
  rmSync(settingsStorePath(), { force: true });
};
beforeEach(wipe);
afterEach(wipe);

function fakeRuntime(reply: string | ((prompt: string) => string), prompts: string[] = []): ChatBackend {
  return {
    complete: async (prompt: string) => {
      prompts.push(prompt);
      return typeof reply === 'function' ? reply(prompt) : reply;
    }
  } as unknown as ChatBackend;
}

async function seed(n: number, source: 'reflection' | 'tool' | 'user' = 'reflection') {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push((await savePersonaNote('verifier', { title: `lesson ${i}`, body: `body ${i}` }, source)).id);
  }
  return ids;
}

describe('shouldConsolidate', () => {
  it('fires after CONSOLIDATE_EVERY reflection writes since the last pass, counting only reflection notes', async () => {
    await seed(CONSOLIDATE_EVERY - 1);
    expect(shouldConsolidate(await readPersonaMemory('verifier'))).toBe(false);
    await seed(5, 'tool');
    expect(shouldConsolidate(await readPersonaMemory('verifier'))).toBe(false);
    await seed(1);
    expect(shouldConsolidate(await readPersonaMemory('verifier'))).toBe(true);
  });

  it('a pass resets the count: only notes newer than consolidatedAt count', async () => {
    const ids = await seed(CONSOLIDATE_EVERY);
    await consolidatePersonaMemory(fakeRuntime(JSON.stringify(ids.map((id) => ({ from: [id] })))), 'verifier');
    expect(shouldConsolidate(await readPersonaMemory('verifier'))).toBe(false);
  });
});

describe('parseConsolidation', () => {
  it('reads the first JSON array out of a chatty reply, accepts a string `from`, drops junk', () => {
    expect(
      parseConsolidation('Sure:\n[{"from":"a"},{"from":["b","c"],"title":"T","body":"B"},{"body":"no from"},7]\nDone')
    ).toEqual([{ from: ['a'] }, { from: ['b', 'c'], title: 'T', body: 'B' }]);
  });
  it('answers nothing for prose or malformed JSON', () => {
    expect(parseConsolidation('nothing to tidy')).toEqual([]);
    expect(parseConsolidation('[{"from":')).toEqual([]);
  });
});

describe('consolidatePersonaMemory', () => {
  it('merges, keeps and drops as the plan says; kept notes keep their id; merged source is tool when any source was deliberate', async () => {
    const [a, b, c] = await seed(3);
    const d = (await savePersonaNote('verifier', { title: 'deliberate', body: 'saved on purpose' }, 'tool')).id;
    const plan = [{ from: [a, d], title: 'merged', body: 'a and d together' }, { from: [b] }];
    const outcome = await consolidatePersonaMemory(fakeRuntime(JSON.stringify(plan)), 'verifier');
    expect(outcome).toMatchObject({ ok: true, before: 4, after: 2, dropped: 1, rewritten: 1 });
    const notes = await listPersonaNotes('verifier');
    expect(notes.map((n) => n.id)).toContain(b);
    expect(notes.find((n) => n.id === b)?.body).toBe('body 1');
    const merged = notes.find((n) => n.title === 'merged');
    expect(merged).toMatchObject({ body: 'a and d together', source: 'tool' });
    expect(notes.some((n) => n.id === a || n.id === c || n.id === d)).toBe(false);
    expect((await readPersonaMemory('verifier')).consolidatedAt).toBeGreaterThan(0);
  });

  it('user-written notes never enter the pass: kept verbatim, listed to the model by title only', async () => {
    await seed(3);
    const mine = await savePersonaNote('verifier', { title: 'my rule', body: 'the user wrote this' }, 'user');
    const prompts: string[] = [];
    const outcome = await consolidatePersonaMemory(fakeRuntime('[]', prompts), 'verifier');
    expect(outcome.ok).toBe(false);
    expect(prompts[0]).toContain('- my rule');
    expect(prompts[0]).not.toContain(`--- ${mine.id}`);
    expect(prompts[0]).not.toContain('the user wrote this');
    expect((await listPersonaNotes('verifier')).find((n) => n.id === mine.id)?.body).toBe('the user wrote this');
  });

  it('changes nothing on an empty plan, an unknown id, a reused id, or a merge without text', async () => {
    const [a, b] = await seed(3);
    const before = await listPersonaNotes('verifier');
    for (const reply of [
      '[]',
      'no',
      JSON.stringify([{ from: [a] }, { from: ['nope'] }]),
      JSON.stringify([{ from: [a] }, { from: [a, b], body: 'x' }]),
      JSON.stringify([{ from: [a, b] }])
    ]) {
      const outcome = await consolidatePersonaMemory(fakeRuntime(reply), 'verifier');
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toBeTruthy();
    }
    expect(await listPersonaNotes('verifier')).toEqual(before);
    expect((await readPersonaMemory('verifier')).consolidatedAt).toBe(0);
  });

  it('skips a store too small to tidy, a memoryless persona, and a failing model — never rejects', async () => {
    await seed(2);
    expect((await consolidatePersonaMemory(fakeRuntime('[]'), 'verifier')).reason).toMatch(/too few/);
    await savePersona({ id: 'quiet', name: 'Quiet', prompt: 'h', memory: false });
    expect((await consolidatePersonaMemory(fakeRuntime('[]'), 'quiet')).reason).toMatch(/no memory/);
    await seed(1);
    const failing = fakeRuntime(() => {
      throw new Error('model down');
    });
    await expect(consolidatePersonaMemory(failing, 'verifier')).resolves.toMatchObject({ ok: false, reason: 'model down' });
    expect(await listPersonaNotes('verifier')).toHaveLength(3);
  });
});
