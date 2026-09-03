import { describe, expect, it } from 'vitest';
import type { Persona } from '../../src/shared/types';
import { personaTurnFields } from '../../src/server/workspace/persona-turn';
import { savePersonaNote } from '../../src/server/workspace/persona-memory';

// The one builder every persona surface (mail, scheduler, client chats) uses:
// what a persona row contributes to a StartTurnInput.

const base: Persona = { id: 'p-turn', name: 'Turn', prompt: 'You are Turn.' };

describe('personaTurnFields', () => {
  it('carries the pins, the harness, the recall flag and a (possibly empty) notes index for a memory-owning persona', async () => {
    const fields = await personaTurnFields({
      ...base,
      model: 'prov/m',
      effort: 'high',
      harness: { agent: 'claude', cwd: '/repo' },
      recall: false
    });
    expect(fields.model).toBe('prov/m');
    expect(fields.effort).toBe('high');
    expect(fields.persona).toEqual({
      id: 'p-turn',
      prompt: 'You are Turn.',
      harness: { agent: 'claude', cwd: '/repo' },
      notes: [],
      recall: false
    });
  });

  it('lists the persona’s notes newest first, and omits the index for personas without a memory', async () => {
    const note = await savePersonaNote('p-turn', { title: 'A lesson', body: 'Body.' }, 'tool');
    expect((await personaTurnFields(base)).persona.notes).toEqual([{ id: note.id, title: 'A lesson' }]);
    // notes: false skips the store read where nothing renders the index.
    expect((await personaTurnFields(base, { notes: false })).persona.notes).toBeUndefined();
    // Memory switched off, or an agent-made helper: no index, so no remember_note pitch.
    expect((await personaTurnFields({ ...base, memory: false })).persona.notes).toBeUndefined();
    expect((await personaTurnFields({ ...base, createdBy: 'orchestrator' })).persona.notes).toBeUndefined();
    // Absent knobs stay absent rather than becoming undefined keys.
    const plain = await personaTurnFields({ ...base, memory: false });
    expect(plain).toEqual({ persona: { id: 'p-turn', prompt: 'You are Turn.' } });
  });
});
