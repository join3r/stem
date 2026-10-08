import { createAgentRegistry } from 'acpx/runtime';
import type { ChatBackend } from '../backend/types';
import { registerServer } from './guard';
import { consolidatePersonaMemory } from '../mail/consolidate';
import { deletePersona, listPersonas, savePersona } from '../workspace/personas';
import {
  deletePersonaNote,
  listPersonaNotes,
  savePersonaNote,
  type SaveNoteInput
} from '../workspace/persona-memory';
import { readSettings } from '../workspace/settings';

/**
 * Personas: the named agent configurations the mail Inbox addresses. Pure store
 * CRUD — nothing here touches the runtime; a persona's pins are read fresh
 * wherever a mail turn starts, so an edit applies to the very next delivery.
 * Mutators return the fresh list, the same contract the folder APIs use.
 */
export function registerPersonasIpc(deps: { runtime: () => ChatBackend }): void {
  registerServer('personas:list', () => listPersonas());
  // Change announcements (`personas:changed`) come from the store itself —
  // every write path fires them — so the mutators here just return the fresh
  // list.
  registerServer('personas:save', (_e, persona: unknown) => savePersona(persona));
  registerServer('personas:delete', (_e, id: string) => deletePersona(id));
  // Persona memory notes (workspace/persona-memory.ts): the editor's browse/
  // edit/delete surface. Editor writes are source 'user'; mutators return the
  // fresh list, like the persona CRUD above.
  registerServer('personas:notes:list', (_e, personaId: string) => listPersonaNotes(personaId));
  registerServer('personas:notes:save', async (_e, personaId: string, note: unknown) => {
    const raw = (note && typeof note === 'object' ? note : {}) as Record<string, unknown>;
    const input: SaveNoteInput = {
      ...(typeof raw.id === 'string' && raw.id.trim() ? { id: raw.id.trim() } : {}),
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
      body: typeof raw.body === 'string' ? raw.body : ''
    };
    await savePersonaNote(personaId, input, 'user');
    return listPersonaNotes(personaId);
  });
  registerServer('personas:notes:delete', async (_e, personaId: string, noteId: string) => {
    await deletePersonaNote(personaId, noteId);
    return listPersonaNotes(personaId);
  });
  // The editor's "Tidy up" button: the same consolidation pass the reflection
  // trigger runs (mail/consolidate.ts), on demand. Never rejects; the outcome
  // says what changed (or why nothing did) and the fresh list comes with it.
  registerServer('personas:notes:consolidate', async (_e, personaId: string) => {
    const outcome = await consolidatePersonaMemory(deps.runtime(), personaId);
    return { outcome, notes: await listPersonaNotes(personaId) };
  });
  // The names the persona editor's coding-agent picker offers: acpx's built-in
  // registry plus any custom entries from harness settings. Names only — a
  // listed agent still needs its CLI installed wherever the turn runs.
  registerServer('personas:agents', async () => {
    const overrides = Object.fromEntries(
      Object.entries((await readSettings()).harness.agents).flatMap(([name, a]) =>
        a.command ? [[name, a.command]] : []
      )
    );
    return createAgentRegistry({ overrides }).list().sort();
  });
}
