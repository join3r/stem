import { registerServer } from './guard';
import { deletePersona, listPersonas, savePersona } from '../workspace/personas';

/**
 * Personas: the named agent configurations the mail Inbox addresses. Pure store
 * CRUD — nothing here touches the runtime; a persona's pins are read fresh
 * wherever a mail turn starts, so an edit applies to the very next delivery.
 * Mutators return the fresh list, the same contract the folder APIs use.
 */
export function registerPersonasIpc(): void {
  registerServer('personas:list', () => listPersonas());
  registerServer('personas:save', (_e, persona: unknown) => savePersona(persona));
  registerServer('personas:delete', (_e, id: string) => deletePersona(id));
}
