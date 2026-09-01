import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Persona, PersonaNote } from '../../shared/types';
import { degrade } from '../degrade';
import { personaMemoryDir } from './paths';

// A persona's private memory: durable lessons from its past work (procedures,
// gotchas, stable domain facts) — one JSON file per persona under
// persona-memory/. The design is deliberately small: no embeddings, no
// retrieval pipeline. The whole index (id + title per note) is injected into
// the persona's mail preamble every delivery turn, and bodies are fetched on
// demand via the read_notes bridge op — the MEMORY.md pattern, not recall's.
//
// Facts about the USER never belong here; those live in the one global recall.
// This store holds what re-prompting cannot recreate: what the persona learned
// doing its job.
//
// WHO owns a store is decided by the persona row, not by this module's
// callers agreeing to agree: built-ins and editor-made personas do,
// agent-created helpers (createdBy set) do not — the same "privileged starts
// absent" rule savePersonaFor applies to flags and pins — and a persona whose
// memory flag is switched off (the built-in Critic, or the editor toggle)
// keeps none either: no store at all, not a hidden one, because a store the
// persona writes but never reads is pure confusion. Every write path checks
// personaOwnsMemory; the store dies with delete_persona.

/** Whether this persona keeps a private memory (see module doc). */
export function personaOwnsMemory(persona: Pick<Persona, 'createdBy' | 'memory'>): boolean {
  return !persona.createdBy && persona.memory !== false;
}

/** Hard cap per persona — the index is injected wholesale, so it must stay small. */
export const MAX_PERSONA_NOTES = 200;
/** One line: the index face of a note. */
export const MAX_NOTE_TITLE = 120;
/** A note is a lesson, not a document. */
export const MAX_NOTE_BODY = 4000;

interface NotesFile {
  version: 1;
  notes: PersonaNote[];
}

/**
 * Persona ids are UUIDs or the built-ins' fixed slugs, so this guard never
 * fires in practice — it exists so a surprising id can't traverse out of the
 * memory dir (the exec-workspace isScratchId rule, applied here).
 */
function notesPath(personaId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(personaId) || personaId === '.' || personaId === '..') {
    throw new Error(`Not a valid persona id: "${personaId}".`);
  }
  return join(personaMemoryDir(), `${personaId}.json`);
}

function coerceNote(raw: unknown): PersonaNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.trim()) return null;
  if (typeof r.body !== 'string' || !r.body.trim()) return null;
  const source = r.source === 'reflection' || r.source === 'user' ? r.source : 'tool';
  const title =
    typeof r.title === 'string' && r.title.trim() ? r.title.trim() : titleFromBody(r.body);
  return {
    id: r.id.trim(),
    title: title.slice(0, MAX_NOTE_TITLE),
    body: r.body.slice(0, MAX_NOTE_BODY),
    at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0,
    source
  };
}

function coerce(parsed: unknown): NotesFile {
  const raw = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const notes: PersonaNote[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw.notes) ? raw.notes : []) {
    const note = coerceNote(entry);
    if (!note || seen.has(note.id)) continue;
    seen.add(note.id);
    notes.push(note);
  }
  return { version: 1, notes };
}

/** A missing title is the body's first line, trimmed to fit the index. */
function titleFromBody(body: string): string {
  const line = body.trim().split('\n')[0]?.trim() ?? '';
  return line.slice(0, MAX_NOTE_TITLE) || 'Untitled note';
}

/** Short id, unique within one persona's store. */
function mintNoteId(taken: Set<string>): string {
  for (;;) {
    const id = randomBytes(4).toString('hex');
    if (!taken.has(id)) return id;
  }
}

// Serialize writes through one promise chain (all personas share it — note
// traffic is a few writes per delivery turn, not a hot path) so concurrent
// reflection + tool writes can't interleave a read-modify-write.
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function readNotesFile(personaId: string): Promise<NotesFile | null> {
  // Outside the try: a bad persona id is the caller's error and must reject
  // loudly, not degrade into "no notes".
  const path = notesPath(personaId);
  try {
    return coerce(JSON.parse(await readFile(path, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { version: 1, notes: [] };
    // quiet: null is the "corrupt/unreadable" signal — every caller degrades
    // or throws with its own scope (reads answer no notes, mutators refuse to
    // write over the file so a fixable file stays fixable).
    return null;
  }
}

async function writeNotesFile(personaId: string, store: NotesFile): Promise<void> {
  const path = notesPath(personaId);
  // quiet: the write below is the one that has to land, and it rejects to the
  // mutator that called this if the directory really is not there.
  await mkdir(personaMemoryDir(), { recursive: true }).catch(() => undefined);
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await rename(tmp, path);
}

/** One persona's notes, newest first. Empty when there are none (or the file is corrupt). */
export function listPersonaNotes(personaId: string): Promise<PersonaNote[]> {
  return enqueue(async () => {
    const store = await readNotesFile(personaId);
    if (!store) {
      degrade('persona-memory', 'listed no notes from an unreadable store', personaId);
      return [];
    }
    return [...store.notes].sort((a, b) => b.at - a.at);
  });
}

export interface SaveNoteInput {
  /** Present = edit that note; absent = add a new one. */
  id?: string;
  title?: string;
  body: string;
}

/**
 * Add or edit one note. New notes at the cap: a reflection write evicts the
 * oldest reflection-sourced note (automatic learning must not silt the store
 * shut), while tool/user writes are refused — a deliberate note being silently
 * traded away is worse than an error the writer can react to.
 */
export function savePersonaNote(
  personaId: string,
  input: SaveNoteInput,
  source: PersonaNote['source']
): Promise<PersonaNote> {
  return enqueue(async () => {
    const body = input.body?.trim();
    if (!body) throw new Error('A note needs a body.');
    const store = await readNotesFile(personaId);
    if (!store) {
      degrade('persona-memory', 'refused to write notes over a file it could not read', personaId);
      throw new Error('This persona’s notes file is unreadable; refusing to overwrite it.');
    }
    const title = (input.title?.trim() || titleFromBody(body)).slice(0, MAX_NOTE_TITLE);
    const trimmedBody = body.slice(0, MAX_NOTE_BODY);
    let note: PersonaNote;
    const at = store.notes.findIndex((n) => n.id === input.id);
    if (input.id && at < 0) throw new Error(`No note "${input.id}" exists.`);
    if (at >= 0) {
      // Edits keep the original source: a user rewording a reflection note
      // doesn't launder it into a deliberate one (or vice versa).
      note = { ...store.notes[at], title, body: trimmedBody, at: Date.now() };
      store.notes[at] = note;
    } else {
      if (store.notes.length >= MAX_PERSONA_NOTES) {
        const evict = source === 'reflection'
          ? store.notes.reduce<PersonaNote | null>(
              (oldest, n) => (n.source === 'reflection' && (!oldest || n.at < oldest.at) ? n : oldest),
              null
            )
          : null;
        if (!evict) {
          throw new Error(
            `This persona already keeps ${MAX_PERSONA_NOTES} notes. Delete or merge old ones first.`
          );
        }
        store.notes = store.notes.filter((n) => n.id !== evict.id);
      }
      note = {
        id: mintNoteId(new Set(store.notes.map((n) => n.id))),
        title,
        body: trimmedBody,
        at: Date.now(),
        source
      };
      store.notes.push(note);
    }
    await writeNotesFile(personaId, store);
    return note;
  });
}

/** Delete one note. Missing notes are a no-op — the outcome asked for already holds. */
export function deletePersonaNote(personaId: string, noteId: string): Promise<void> {
  return enqueue(async () => {
    const store = await readNotesFile(personaId);
    if (!store) {
      degrade('persona-memory', 'refused to write notes over a file it could not read', personaId);
      throw new Error('This persona’s notes file is unreadable; refusing to overwrite it.');
    }
    const kept = store.notes.filter((n) => n.id !== noteId);
    if (kept.length === store.notes.length) return;
    store.notes = kept;
    await writeNotesFile(personaId, store);
  });
}

/** Remove a persona's whole store (delete_persona's cleanup). Quietly idempotent. */
export function deletePersonaMemory(personaId: string): Promise<void> {
  return enqueue(async () => {
    await rm(notesPath(personaId), { force: true });
  });
}
