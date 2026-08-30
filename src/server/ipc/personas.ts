import { createAgentRegistry } from 'acpx/runtime';
import { registerServer } from './guard';
import { deletePersona, listPersonas, savePersona } from '../workspace/personas';
import { readSettings } from '../workspace/settings';

/**
 * Personas: the named agent configurations the mail Inbox addresses. Pure store
 * CRUD — nothing here touches the runtime; a persona's pins are read fresh
 * wherever a mail turn starts, so an edit applies to the very next delivery.
 * Mutators return the fresh list, the same contract the folder APIs use.
 */
export function registerPersonasIpc(onChange?: () => void): void {
  registerServer('personas:list', () => listPersonas());
  registerServer('personas:save', async (_e, persona: unknown) => {
    const list = await savePersona(persona);
    // Announced so every OTHER surface refreshes — the mail composer's To:
    // list in this and every connected client. The caller gets the fresh
    // list back directly, as before.
    onChange?.();
    return list;
  });
  registerServer('personas:delete', async (_e, id: string) => {
    const list = await deletePersona(id);
    onChange?.();
    return list;
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
