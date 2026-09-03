import type { Persona, StartTurnInput } from '../../shared/types';
import { listPersonaNotes, personaOwnsMemory } from './persona-memory';

// The one place a persona row becomes the persona part of a StartTurnInput.
// Three surfaces run turns AS a persona — mail deliveries, scheduled tasks, and
// chats from a paired client — and each used to hand-assemble this block by
// itself. They drifted: a scheduled run got neither the persona's memory index
// nor its recall flag, so a recall-off persona (Critic) saw Recall on a
// schedule and never saw its own notes. Every knob a persona carries into a
// turn is decided here, once.

/** The persona-derived slice of a turn: pins first, then the persona block itself. */
export type PersonaTurnFields = Pick<StartTurnInput, 'model' | 'effort'> & {
  persona: NonNullable<StartTurnInput['persona']>;
};

/**
 * Build the persona fields of a turn from the persona row. `notes` (default
 * true) fetches the persona's memory index when it owns a store; pass false
 * where the preamble never renders it (an interactive chat) to skip the read.
 * The index is present-but-possibly-empty exactly when the persona owns a
 * memory — its presence is what tells the preamble to pitch remember_note.
 */
export async function personaTurnFields(persona: Persona, opts: { notes?: boolean } = {}): Promise<PersonaTurnFields> {
  const wantNotes = opts.notes !== false && personaOwnsMemory(persona);
  // quiet: an unreadable store already degrades inside listPersonaNotes; the
  // turn proceeds with an empty index rather than failing.
  const noteRows = wantNotes ? await listPersonaNotes(persona.id).catch(() => []) : undefined;
  const notes = noteRows?.map((n) => ({ id: n.id, title: n.title }));
  return {
    ...(persona.model ? { model: persona.model } : {}),
    ...(persona.effort ? { effort: persona.effort } : {}),
    persona: {
      id: persona.id,
      prompt: persona.prompt,
      ...(persona.harness ? { harness: persona.harness } : {}),
      ...(notes ? { notes } : {}),
      ...(persona.recall === false ? { recall: false as const } : {})
    }
  };
}
