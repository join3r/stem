import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Persona, PersonaNote } from '../../shared/types';
import { degrade } from '../degrade';
import { log } from '../log';
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
// callers agreeing to agree: personas do; agents (spawned instances, which
// the router resolves with memory off) do not; and a persona whose
// memory flag is switched off (the built-in Critic, or the editor toggle)
// keeps none either: no store at all, not a hidden one, because a store the
// persona writes but never reads is pure confusion. A code persona (harness
// pin) keeps no LESSONS for the same reason from the other side: its wrapper
// is a relay that may only call coding_agent, so it could never read or write
// a note, and the coding agent it relays to carries its own memory (the
// project's CLAUDE.md and the agent's own per-project memory). What a code
// persona keeps instead is STANDING ANSWERS: the same file, but every entry is
// "when the agent asks this, the answer is that" — written by the user in the
// editor, or captured by the mail router from the user's reply to a question
// the agent asked. Rendered whole into the relay's preamble (no read_notes),
// so the persona can answer the agent itself instead of asking the user the
// same thing every time. Nothing writes them automatically from a model.
// Every write path checks one of the two owners; the store dies with the
// persona.

/** Whether this persona keeps a private memory of lessons (see module doc). */
export function personaOwnsMemory(persona: Pick<Persona, 'memory' | 'harness'>): boolean {
  return persona.memory !== false && !persona.harness;
}

/** Whether this persona keeps standing answers for its coding agent's questions (code personas). */
export function personaKeepsAnswers(persona: Pick<Persona, 'memory' | 'harness'>): boolean {
  return persona.memory !== false && !!persona.harness;
}

/** Hard cap per persona — the index is injected wholesale, so it must stay small. */
export const MAX_PERSONA_NOTES = 200;
/** One line: the index face of a note. */
export const MAX_NOTE_TITLE = 120;
/** A note is a lesson, not a document. */
export const MAX_NOTE_BODY = 4000;

// File versions. 1: the original store. 2: written by the stricter reflection
// (2026-09-14). A v1 file's auto-learned notes are dropped on first read and
// the file rewritten as v2 — the old pass filled stores with paraphrased
// advice and re-learned lessons, and keeping them would only have the new
// consolidation pass spend a model call to reach the same result. Notes the
// persona saved deliberately (tool) or the user wrote survive; they were the
// good ones. One-off: a v2 file is never purged again.
const NOTES_FILE_VERSION = 2;

interface NotesFile {
  version: typeof NOTES_FILE_VERSION;
  notes: PersonaNote[];
  /** Epoch ms of the last consolidation pass (mail/consolidate.ts); absent = never. */
  consolidatedAt?: number;
}

/** A persona's store as the consolidation pass reads it: every note plus when it was last tidied. */
export interface PersonaMemorySnapshot {
  notes: PersonaNote[];
  consolidatedAt: number;
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
  const source =
    r.source === 'reflection' || r.source === 'user' || r.source === 'answer' ? r.source : 'tool';
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

/** The store plus whether reading it migrated something the file should now record. */
function coerce(parsed: unknown): { store: NotesFile; migrated: boolean } {
  const raw = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const version = typeof raw.version === 'number' ? raw.version : 1;
  const purgeAutomatic = version < 2;
  let notes: PersonaNote[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw.notes) ? raw.notes : []) {
    const note = coerceNote(entry);
    if (!note || seen.has(note.id)) continue;
    seen.add(note.id);
    notes.push(note);
  }
  if (purgeAutomatic) notes = notes.filter((n) => n.source !== 'reflection');
  const consolidatedAt =
    typeof raw.consolidatedAt === 'number' && Number.isFinite(raw.consolidatedAt) ? raw.consolidatedAt : undefined;
  return {
    store: { version: NOTES_FILE_VERSION, notes, ...(consolidatedAt ? { consolidatedAt } : {}) },
    migrated: purgeAutomatic
  };
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { version: NOTES_FILE_VERSION, notes: [] };
    // quiet: null is the "corrupt/unreadable" signal — every caller degrades
    // or throws with its own scope (reads answer no notes, mutators refuse to
    // write over the file so a fixable file stays fixable).
    return null;
  }
  const { store, migrated } = coerce(parsed);
  // A version migration is persisted on read (as personas.json does), so the
  // purge happens once, on the first read after the upgrade, and the file on
  // disk shows what the server sees. Callers hold the write chain already.
  if (migrated) {
    log('persona-memory', 'migrated a notes file: automatic notes cleared', { personaId, kept: store.notes.length });
    await writeNotesFile(personaId, store);
  }
  return store;
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
    // Reverse before the stable sort so two notes saved in the same
    // millisecond still list newest-inserted first (the file appends).
    return [...store.notes].reverse().sort((a, b) => b.at - a.at);
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

/**
 * Record the user's answer to a question the coding agent asked (mail router,
 * code personas). Keyed by the question: answering the same question again
 * replaces the earlier answer rather than stacking a contradiction, and a
 * full store drops the oldest captured answer — captured answers are the one
 * automatic write here, so they must not wedge the user's own entries.
 */
export function saveStandingAnswer(personaId: string, question: string, answer: string): Promise<PersonaNote> {
  return enqueue(async () => {
    const title = question.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_TITLE);
    const body = answer.trim().slice(0, MAX_NOTE_BODY);
    if (!title || !body) throw new Error('A standing answer needs a question and an answer.');
    const store = await readNotesFile(personaId);
    if (!store) {
      degrade('persona-memory', 'refused to write notes over a file it could not read', personaId);
      throw new Error('This persona’s notes file is unreadable; refusing to overwrite it.');
    }
    const at = store.notes.findIndex((n) => n.source === 'answer' && n.title === title);
    if (at >= 0) {
      // Moved to the end, not replaced in place: listing breaks same-millisecond
      // ties by file order, so a fresh answer left at its old slot sorts older.
      const note = { ...store.notes[at], body, at: Date.now() };
      store.notes.splice(at, 1);
      store.notes.push(note);
      await writeNotesFile(personaId, store);
      return note;
    }
    if (store.notes.length >= MAX_PERSONA_NOTES) {
      const evict = store.notes.reduce<PersonaNote | null>(
        (oldest, n) => (n.source === 'answer' && (!oldest || n.at < oldest.at) ? n : oldest),
        null
      );
      if (!evict) throw new Error(`This persona already keeps ${MAX_PERSONA_NOTES} notes. Delete old ones first.`);
      store.notes = store.notes.filter((n) => n.id !== evict.id);
    }
    const note: PersonaNote = {
      id: mintNoteId(new Set(store.notes.map((n) => n.id))),
      title,
      body,
      at: Date.now(),
      source: 'answer'
    };
    store.notes.push(note);
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

/** The store as-is (file order), for the consolidation pass. Empty when unreadable. */
export function readPersonaMemory(personaId: string): Promise<PersonaMemorySnapshot> {
  return enqueue(async () => {
    const store = await readNotesFile(personaId);
    if (!store) {
      degrade('persona-memory', 'listed no notes from an unreadable store', personaId);
      return { notes: [], consolidatedAt: 0 };
    }
    return { notes: [...store.notes], consolidatedAt: store.consolidatedAt ?? 0 };
  });
}

/** One consolidation outcome: which notes go, which merged/rewritten ones replace them. */
export interface ConsolidationPlan {
  /** Ids to remove (merged into an `add` entry, or judged noise). Unknown ids are ignored. */
  drop: string[];
  /** Replacement notes; `tool` when any merged source was deliberate, else `reflection`. */
  add: { title?: string; body: string; source: PersonaNote['source'] }[];
}

/**
 * Apply a consolidation plan and stamp the store. Notes written while the
 * plan was being computed are untouched — the plan only names ids it read, and
 * an id it never saw is not in `drop` — so a reflection landing mid-pass is
 * kept, not silently lost. Returns the store after the write.
 */
export function applyConsolidation(personaId: string, plan: ConsolidationPlan): Promise<PersonaNote[]> {
  return enqueue(async () => {
    const store = await readNotesFile(personaId);
    if (!store) {
      degrade('persona-memory', 'refused to write notes over a file it could not read', personaId);
      throw new Error('This persona’s notes file is unreadable; refusing to overwrite it.');
    }
    const drop = new Set(plan.drop);
    store.notes = store.notes.filter((n) => !drop.has(n.id));
    const taken = new Set(store.notes.map((n) => n.id));
    const now = Date.now();
    for (const entry of plan.add) {
      const body = entry.body.trim().slice(0, MAX_NOTE_BODY);
      if (!body) continue;
      const id = mintNoteId(taken);
      taken.add(id);
      store.notes.push({
        id,
        title: (entry.title?.trim() || titleFromBody(body)).slice(0, MAX_NOTE_TITLE),
        body,
        at: now,
        source: entry.source
      });
    }
    store.consolidatedAt = now;
    await writeNotesFile(personaId, store);
    return [...store.notes];
  });
}

/** Remove a persona's whole store (deletePersona's cleanup). Quietly idempotent. */
export function deletePersonaMemory(personaId: string): Promise<void> {
  return enqueue(async () => {
    await rm(notesPath(personaId), { force: true });
  });
}
