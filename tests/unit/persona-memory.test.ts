// The persona memory store — the REAL files at the throwaway path the unit-test
// STEM_STATE_DIR provides. Covers CRUD, the newest-first listing, title
// derivation, the per-persona cap (reflection evicts its own oldest, deliberate
// writes are refused), corrupt-file behavior (reads degrade, writes refuse),
// isolation between personas, and that deleting a persona deletes its store.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deletePersonaMemory,
  deletePersonaNote,
  listPersonaNotes,
  MAX_NOTE_TITLE,
  MAX_PERSONA_NOTES,
  personaKeepsAnswers,
  personaOwnsMemory,
  savePersonaNote,
  saveStandingAnswer
} from '../../src/server/workspace/persona-memory';
import { deletePersona, savePersona } from '../../src/server/workspace/personas';
import { personaMemoryDir, personasStorePath } from '../../src/server/workspace/paths';

const dir = personaMemoryDir();

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(personasStorePath(), { force: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(personasStorePath(), { force: true });
});

describe('standing answers', () => {
  it('only a code persona with memory on keeps them', () => {
    const harness = { agent: 'claude', cwd: '/repo' };
    expect(personaKeepsAnswers({ harness })).toBe(true);
    expect(personaKeepsAnswers({ harness, memory: false })).toBe(false);
    expect(personaKeepsAnswers({})).toBe(false);
  });

  it('replaces the answer to a repeated question and survives as source answer', async () => {
    await saveStandingAnswer('coder', '  Should I   deploy? ', 'Yes.');
    await saveStandingAnswer('coder', 'Which branch?', 'main');
    await saveStandingAnswer('coder', 'Should I deploy?', 'Always.');
    const notes = await listPersonaNotes('coder');
    expect(notes.map((n) => [n.title, n.body, n.source])).toEqual([
      ['Should I deploy?', 'Always.', 'answer'],
      ['Which branch?', 'main', 'answer']
    ]);
    await expect(saveStandingAnswer('coder', '', 'x')).rejects.toThrow('needs a question');
  });
});

describe('ownership', () => {
  it('a persona owns a memory by default', () => {
    expect(personaOwnsMemory({})).toBe(true);
  });

  it('the memory flag opts a persona out; only an explicit false does', () => {
    expect(personaOwnsMemory({ memory: false })).toBe(false);
    expect(personaOwnsMemory({ memory: true })).toBe(true);
    expect(personaOwnsMemory({ memory: undefined })).toBe(true);
  });

  it('a code persona (harness pin) keeps no memory: its wrapper is a relay and the agent has its own', () => {
    expect(personaOwnsMemory({ harness: { agent: 'claude', cwd: '/repo' } })).toBe(false);
    expect(personaOwnsMemory({ memory: true, harness: { agent: 'claude', cwd: '/repo' } })).toBe(false);
  });
});

describe('notes CRUD', () => {
  it('saves, lists newest-first, edits in place, and deletes', async () => {
    const first = await savePersonaNote('verifier', { title: 'A', body: 'first lesson' }, 'tool');
    const second = await savePersonaNote('verifier', { title: 'B', body: 'second lesson' }, 'reflection');
    let notes = await listPersonaNotes('verifier');
    expect(notes.map((n) => n.id)).toEqual([second.id, first.id]);
    expect(notes[1]).toMatchObject({ title: 'A', body: 'first lesson', source: 'tool' });

    const edited = await savePersonaNote('verifier', { id: first.id, title: 'A2', body: 'reworded' }, 'user');
    // An edit keeps the note's original source — rewording doesn't launder it.
    expect(edited).toMatchObject({ id: first.id, title: 'A2', body: 'reworded', source: 'tool' });

    await deletePersonaNote('verifier', second.id);
    notes = await listPersonaNotes('verifier');
    expect(notes.map((n) => n.id)).toEqual([first.id]);
    // Deleting a note that's already gone is a quiet no-op.
    await expect(deletePersonaNote('verifier', 'nope')).resolves.toBeUndefined();
  });

  it('derives a missing title from the body first line, capped to the index width', async () => {
    const long = 'x'.repeat(MAX_NOTE_TITLE + 50);
    const note = await savePersonaNote('verifier', { body: `${long}\nmore` }, 'reflection');
    expect(note.title).toBe(long.slice(0, MAX_NOTE_TITLE));
  });

  it('refuses a bodyless note and an edit of a note that does not exist', async () => {
    await expect(savePersonaNote('verifier', { body: '   ' }, 'tool')).rejects.toThrow('needs a body');
    await expect(savePersonaNote('verifier', { id: 'nope', body: 'x' }, 'tool')).rejects.toThrow('No note');
  });

  it('keeps personas isolated: one store per persona id', async () => {
    await savePersonaNote('verifier', { body: 'verifier lesson' }, 'tool');
    await savePersonaNote('secretary', { body: 'secretary lesson' }, 'tool');
    expect((await listPersonaNotes('verifier')).map((n) => n.body)).toEqual(['verifier lesson']);
    expect((await listPersonaNotes('secretary')).map((n) => n.body)).toEqual(['secretary lesson']);
  });

  it('rejects a persona id that is not a safe path segment', async () => {
    await expect(listPersonaNotes('../escape')).rejects.toThrow('Not a valid persona id');
  });
});

describe('the cap', () => {
  async function fill(source: 'reflection' | 'tool') {
    const ids: string[] = [];
    for (let i = 0; i < MAX_PERSONA_NOTES; i++) {
      ids.push((await savePersonaNote('verifier', { title: `n${i}`, body: `lesson ${i}` }, source)).id);
    }
    return ids;
  }

  it('a reflection write at the cap evicts the oldest reflection note', async () => {
    // Timestamps tie within a fast loop, so "oldest" resolves to the first
    // inserted — which is exactly what the store's eviction order promises.
    const ids = await fill('reflection');
    const added = await savePersonaNote('verifier', { title: 'new', body: 'newest lesson' }, 'reflection');
    const after = await listPersonaNotes('verifier');
    expect(after).toHaveLength(MAX_PERSONA_NOTES);
    expect(after.some((n) => n.id === added.id)).toBe(true);
    expect(after.some((n) => n.id === ids[0])).toBe(false);
    expect(after.some((n) => n.id === ids[1])).toBe(true);
  });

  it('a deliberate write at the cap is refused when nothing reflective can be evicted', async () => {
    await fill('tool');
    await expect(savePersonaNote('verifier', { body: 'one more' }, 'user')).rejects.toThrow('already keeps');
    // …but reflection still cannot evict a deliberate note either.
    await expect(savePersonaNote('verifier', { body: 'auto' }, 'reflection')).rejects.toThrow('already keeps');
  });
});

describe('the v2 migration', () => {
  it('drops automatic notes from a v1 file on first read, keeps deliberate and user ones, and rewrites the file as v2', async () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'verifier.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        notes: [
          { id: 'a', title: 'auto', body: 'paraphrased advice', at: 1, source: 'reflection' },
          { id: 'b', title: 'tool', body: 'saved on purpose', at: 2, source: 'tool' },
          { id: 'c', title: 'mine', body: 'the user wrote it', at: 3, source: 'user' }
        ]
      })
    );
    expect((await listPersonaNotes('verifier')).map((n) => n.id)).toEqual(['c', 'b']);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.version).toBe(2);
    expect(onDisk.notes.map((n: { id: string }) => n.id)).toEqual(['b', 'c']);
  });

  it('a v2 file keeps its automatic notes: the purge is one-off', async () => {
    await savePersonaNote('verifier', { body: 'learned after the upgrade' }, 'reflection');
    expect(await listPersonaNotes('verifier')).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'verifier.json'), 'utf8')).version).toBe(2);
  });
});

describe('corrupt files', () => {
  it('reads degrade to no notes; writes refuse to clobber the unreadable file', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'verifier.json'), '{ not json', 'utf8');
    expect(await listPersonaNotes('verifier')).toEqual([]);
    await expect(savePersonaNote('verifier', { body: 'x' }, 'tool')).rejects.toThrow('unreadable');
    // The user's (fixable) file is still there, untouched.
    expect(readFileSync(join(dir, 'verifier.json'), 'utf8')).toBe('{ not json');
  });
});

describe('lifecycle', () => {
  it('deleting a persona deletes its memory store', async () => {
    await savePersona({ id: 'p1', name: 'researcher', prompt: 'research' });
    await savePersonaNote('p1', { body: 'a lesson' }, 'tool');
    expect(existsSync(join(dir, 'p1.json'))).toBe(true);
    await deletePersona('p1');
    expect(existsSync(join(dir, 'p1.json'))).toBe(false);
  });

  it('deletePersonaMemory is quietly idempotent', async () => {
    await expect(deletePersonaMemory('never-existed')).resolves.toBeUndefined();
  });
});
