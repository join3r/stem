// The persona registry — exercises the REAL file at the throwaway path the
// unit-test STEM_STATE_DIR provides. Covers the built-in seeding, upsert,
// name-uniqueness, the builtin-deletion refusal, corrupt-file degradation, and
// that concurrent writes don't clobber.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  deletePersona,
  getPersona,
  listPersonas,
  onPersonasChanged,
  savePersona,
  savePersonaFor,
  updatePersonaFields
} from '../../src/server/workspace/personas';
import { personasStorePath } from '../../src/server/workspace/paths';
import type { Persona } from '../../src/shared/types';

const path = personasStorePath();

beforeEach(() => {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
});
afterEach(() => {
  rmSync(path, { force: true });
});

const onDisk = () => JSON.parse(readFileSync(path, 'utf8'));

const persona = (over: Partial<Persona> = {}): Persona => ({
  id: 'p1',
  name: 'code — stem',
  prompt: 'work on stem',
  ...over
});

describe('first read', () => {
  it('seeds the four built-ins and writes the file', async () => {
    const personas = await listPersonas();
    expect(personas.map((p) => p.id)).toEqual(['normal', 'verifier', 'secretary', 'orchestrator']);
    expect(personas.every((p) => p.builtin)).toBe(true);
    expect(onDisk().version).toBe(2);
  });

  it('degrades a corrupt file to the built-ins rather than throwing', async () => {
    writeFileSync(path, '{ not json', 'utf8');
    const personas = await listPersonas();
    expect(personas.map((p) => p.id)).toEqual(['normal', 'verifier', 'secretary', 'orchestrator']);
  });

  it('re-seeds a built-in missing from the stored list, keeping edits to the rest', async () => {
    await savePersona({ id: 'verifier', name: 'Verifier', prompt: 'edited' });
    const raw = onDisk();
    raw.personas = raw.personas.filter((p: Persona) => p.id !== 'secretary');
    writeFileSync(path, JSON.stringify(raw), 'utf8');
    const personas = await listPersonas();
    expect(personas.find((p) => p.id === 'secretary')).toBeTruthy();
    expect(personas.find((p) => p.id === 'verifier')?.prompt).toBe('edited');
  });
});

describe('save', () => {
  it('creates, then updates in place', async () => {
    await savePersona(persona());
    let saved = await getPersona('p1');
    expect(saved?.name).toBe('code — stem');
    await savePersona(persona({ prompt: 'now with tests' }));
    saved = await getPersona('p1');
    expect(saved?.prompt).toBe('now with tests');
    expect((await listPersonas()).filter((p) => p.id === 'p1')).toHaveLength(1);
  });

  it('mints an id when none is given', async () => {
    const list = await savePersona({ name: 'fresh', prompt: '' });
    const fresh = list.find((p) => p.name === 'fresh');
    expect(fresh?.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('refuses a name another persona already has, case-insensitively', async () => {
    await savePersona(persona());
    await expect(savePersona(persona({ id: 'p2', name: 'CODE — STEM' }))).rejects.toThrow(/already exists/);
    // The refusal must not have written anything.
    expect((await listPersonas()).find((p) => p.id === 'p2')).toBeUndefined();
  });

  it('keeps a rename to the persona’s own name legal', async () => {
    await savePersona(persona());
    await expect(savePersona(persona({ prompt: 'x' }))).resolves.toBeTruthy();
  });

  it('never lets a caller grant itself builtin', async () => {
    await savePersona(persona({ builtin: true }));
    expect((await getPersona('p1'))?.builtin).toBeUndefined();
  });

  it('keeps builtin across an edit of a built-in', async () => {
    await savePersona({ id: 'verifier', name: 'Verifier', prompt: 'stricter' });
    const verifier = await getPersona('verifier');
    expect(verifier?.builtin).toBe(true);
    expect(verifier?.prompt).toBe('stricter');
  });

  it('round-trips the manage-personas capability; Secretary and Orchestrator seed with it on', async () => {
    expect((await getPersona('secretary'))?.canManagePersonas).toBe(true);
    expect((await getPersona('orchestrator'))?.canManagePersonas).toBe(true);
    expect((await getPersona('verifier'))?.canManagePersonas).toBeUndefined();
    await savePersona(persona({ canManagePersonas: true }));
    expect((await getPersona('p1'))?.canManagePersonas).toBe(true);
    await savePersona(persona({ canManagePersonas: false }));
    expect((await getPersona('p1'))?.canManagePersonas).toBeUndefined();
  });

  it('migrates the pre-rename canAddPersonas flag on read', async () => {
    await listPersonas(); // seed
    const raw = onDisk();
    raw.version = 1;
    for (const p of raw.personas) {
      delete p.canManagePersonas;
      if (p.id === 'secretary') p.canAddPersonas = true;
    }
    writeFileSync(path, JSON.stringify(raw), 'utf8');
    expect((await getPersona('secretary'))?.canManagePersonas).toBe(true);
  });

  it('a v1 file grants Secretary and Orchestrator the flag once; unticking sticks on v2', async () => {
    await listPersonas(); // seed
    const raw = onDisk();
    raw.version = 1;
    for (const p of raw.personas) delete p.canManagePersonas;
    writeFileSync(path, JSON.stringify(raw), 'utf8');
    // v1 read: the stored rows gain the flag the seeds carry — appending-only
    // seeding never fixes an existing row, so the migration must.
    expect((await getPersona('orchestrator'))?.canManagePersonas).toBe(true);
    expect((await getPersona('secretary'))?.canManagePersonas).toBe(true);
    // The user unticks it — the write lands as v2 and the choice sticks.
    const orchestrator = (await getPersona('orchestrator'))!;
    await savePersona({ ...orchestrator, canManagePersonas: undefined });
    expect(onDisk().version).toBe(2);
    expect((await getPersona('orchestrator'))?.canManagePersonas).toBeUndefined();
  });

  it('never lets a caller set createdBy; it survives from the stored row', async () => {
    await savePersona(persona({ createdBy: 'orchestrator' } as Partial<Persona>));
    expect((await getPersona('p1'))?.createdBy).toBeUndefined();
    // A row that HAS createdBy on disk keeps it across an editor save.
    const raw = onDisk();
    raw.personas.find((p: Persona) => p.id === 'p1').createdBy = 'orchestrator';
    writeFileSync(path, JSON.stringify(raw), 'utf8');
    await savePersona(persona({ prompt: 'edited' }));
    expect((await getPersona('p1'))?.createdBy).toBe('orchestrator');
  });

  it('clamps sendBudget to 1..100 and drops junk', async () => {
    await savePersona(persona({ sendBudget: 700 }));
    expect((await getPersona('p1'))?.sendBudget).toBe(100);
    await savePersona(persona({ sendBudget: 0 }));
    expect((await getPersona('p1'))?.sendBudget).toBe(1);
    await savePersona(persona({ sendBudget: 5.4 }));
    expect((await getPersona('p1'))?.sendBudget).toBe(5);
    await savePersona(persona({ sendBudget: undefined }));
    expect((await getPersona('p1'))?.sendBudget).toBeUndefined();
  });

  it('keeps a harness pin with a blank cwd (mid-edit save) but drops one without an agent', async () => {
    // The editor saves per keystroke: the agent name lands before the cwd is
    // typed, and dropping the pin would wipe the field under the user's cursor.
    await savePersona(persona({ harness: { agent: 'claude', cwd: '' } }));
    expect((await getPersona('p1'))?.harness).toEqual({ agent: 'claude', cwd: '' });
    await savePersona(persona({ harness: { agent: '', cwd: '/src/stem' } }));
    expect((await getPersona('p1'))?.harness).toBeUndefined();
    await savePersona(persona({ harness: { agent: 'claude', cwd: '/src/stem' } }));
    expect((await getPersona('p1'))?.harness).toEqual({ agent: 'claude', cwd: '/src/stem' });
    await savePersona(persona({ harness: { agent: 'claude', cwd: '/src/stem', device: 'dev-1' } }));
    expect((await getPersona('p1'))?.harness).toEqual({
      agent: 'claude',
      cwd: '/src/stem',
      device: 'dev-1'
    });
  });
});

describe('delete', () => {
  it('removes a user persona', async () => {
    await savePersona(persona());
    const list = await deletePersona('p1');
    expect(list.find((p) => p.id === 'p1')).toBeUndefined();
  });

  it('refuses to delete a built-in (the seed would resurrect it blank)', async () => {
    await expect(deletePersona('verifier')).rejects.toThrow(/built in/);
    expect(await getPersona('verifier')).toBeTruthy();
  });

  it('is a no-op for an id that does not exist', async () => {
    const before = await listPersonas();
    const after = await deletePersona('ghost');
    expect(after).toEqual(before);
  });
});

describe('bridge mutators', () => {
  it('savePersonaFor stamps createdBy and only the plain fields', async () => {
    const created = await savePersonaFor('orchestrator', {
      name: 'researcher-1',
      prompt: 'dig',
      model: 'anthropic/claude-fable-5',
      effort: 'high'
    });
    const stored = await getPersona(created.id);
    expect(stored).toMatchObject({
      name: 'researcher-1',
      prompt: 'dig',
      createdBy: 'orchestrator'
    });
    expect(stored?.harness).toBeUndefined();
    expect(stored?.canManagePersonas).toBeUndefined();
  });

  it('savePersonaFor enforces name uniqueness', async () => {
    await savePersonaFor('orchestrator', { name: 'researcher-1', prompt: '' });
    await expect(savePersonaFor('orchestrator', { name: 'RESEARCHER-1', prompt: '' })).rejects.toThrow(
      /already exists/
    );
  });

  it('updatePersonaFields merges only the plain fields, keeping pins and flags', async () => {
    await savePersona(
      persona({ harness: { agent: 'claude', cwd: '/src' }, canManagePersonas: true, sendBudget: 3 })
    );
    const updated = await updatePersonaFields('p1', { prompt: 'sharper' });
    expect(updated.prompt).toBe('sharper');
    const stored = await getPersona('p1');
    expect(stored?.harness).toEqual({ agent: 'claude', cwd: '/src' });
    expect(stored?.canManagePersonas).toBe(true);
    expect(stored?.sendBudget).toBe(3);
  });

  it('the store-level change hook fires once per successful write', async () => {
    let fired = 0;
    onPersonasChanged(() => fired++);
    try {
      await savePersona(persona());
      expect(fired).toBe(1);
      await savePersonaFor('orchestrator', { name: 'helper', prompt: '' });
      expect(fired).toBe(2);
      await expect(savePersona(persona({ id: 'p2', name: 'code — stem' }))).rejects.toThrow();
      expect(fired).toBe(2); // a refused write announces nothing
    } finally {
      onPersonasChanged(null);
    }
  });
});

describe('concurrency', () => {
  it('interleaved saves all land (serialized read-modify-write)', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => savePersona({ id: `c${i}`, name: `c${i}`, prompt: '' }))
    );
    const personas = await listPersonas();
    for (let i = 0; i < 8; i++) expect(personas.find((p) => p.id === `c${i}`)).toBeTruthy();
  });
});

describe('unreadable file', () => {
  it('refuses to write over a corrupt store', async () => {
    await savePersona(persona());
    writeFileSync(path, '{ not json', 'utf8');
    await expect(savePersona(persona({ id: 'p2', name: 'other' }))).rejects.toThrow();
    // The corrupt bytes are still there for a human to fix — not replaced.
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });
});
