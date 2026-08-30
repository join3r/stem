import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Persona, PersonaHarnessPin } from '../../shared/types';
import { degrade } from '../degrade';
import { personasStorePath } from './paths';

// The Stem-owned persona registry. Same shape as the inbox store next door —
// serialized read-modify-write, atomic temp+rename, and a corrupt file degrading
// to "just the built-ins" rather than breaking the app.
//
// The built-ins are seeded rows, not code: after the first read they are
// ordinary personas the user edits like any other. Their special behaviours
// live entirely in their prompts (and, later, the tools those prompts use) —
// nothing on the server ever branches on a persona's id. The one rule that does
// reference `builtin` is deletion: a built-in cannot be deleted, because the
// seeding below would silently resurrect it on the next read and the "deleted"
// persona would come back blank.

interface PersonasFile {
  version: 1;
  personas: Persona[];
}

/**
 * The seeded personas. Prompts are starting points the user is expected to
 * rewrite; the Secretary and Orchestrator name tools that arrive in later
 * phases, and say so, rather than pretending to powers they don't have yet.
 */
const BUILTINS: Persona[] = [
  {
    id: 'normal',
    name: 'Normal',
    prompt: '',
    builtin: true
  },
  {
    id: 'verifier',
    name: 'Verifier',
    prompt:
      'You are Verifier. Check every factual claim in the work you receive — dates, numbers, ' +
      'names, quotes, file contents, command output — using your tools rather than memory. ' +
      'Reply to the persona that mailed you (send_mail, or just finish your reply) either that ' +
      'the work is verified (one line), or with the specific claims that are wrong and why, so ' +
      'the sender can fix them and send the work back to you. Be strict and brief; never ' +
      'rewrite the work yourself.',
    builtin: true
  },
  {
    id: 'secretary',
    name: 'Secretary',
    prompt:
      'You are Secretary. You triage requests: decide what a task needs and delegate rather ' +
      'than doing the work yourself. Bring the right personas into the conversation with ' +
      'add_persona, hand them their piece with send_mail, and schedule follow-ups with ' +
      'schedule_task (set its personaId so the run happens as the right persona). Keep the ' +
      'inbox quiet: mail the user only decisions and results, not process.',
    canAddPersonas: true,
    builtin: true
  },
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    prompt:
      'You are Orchestrator. Split large tasks into independent pieces, delegate each piece, and ' +
      'assemble the results into one coherent answer. When a task cannot be split, or the ' +
      'delegation tools are not available yet, do the work directly and say so.',
    builtin: true
  }
];

function coerceHarness(raw: unknown): PersonaHarnessPin | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.agent !== 'string' || !r.agent.trim()) return undefined;
  // A blank cwd is a pin mid-edit, not garbage: the editor saves per keystroke,
  // so the agent name arrives before the directory exists. Dropping the pin
  // here would erase the field under the user's cursor. The runtime treats a
  // blank pinned cwd as "no cwd" (thread scratch dir).
  const cwd = typeof r.cwd === 'string' ? r.cwd.trim() : '';
  const device = typeof r.device === 'string' ? r.device.trim() : '';
  return { agent: r.agent.trim(), cwd, ...(device ? { device } : {}) };
}

/** Reshape one stored/submitted persona; null when it isn't one. */
function coercePersona(raw: unknown): Persona | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.trim()) return null;
  if (typeof r.name !== 'string' || !r.name.trim()) return null;
  const persona: Persona = {
    id: r.id.trim(),
    name: r.name.trim(),
    prompt: typeof r.prompt === 'string' ? r.prompt : ''
  };
  if (typeof r.model === 'string' && r.model.trim()) persona.model = r.model.trim();
  if (typeof r.effort === 'string' && r.effort.trim()) persona.effort = r.effort.trim();
  const harness = coerceHarness(r.harness);
  if (harness) persona.harness = harness;
  if (r.lightweight === true) persona.lightweight = true;
  if (r.canAddPersonas === true) persona.canAddPersonas = true;
  if (r.builtin === true) persona.builtin = true;
  return persona;
}

/**
 * Reshape a whole file, then seed: any built-in missing from the stored list is
 * appended (first launch, and upgrades that add a built-in), keeping stored
 * edits to existing ones untouched. Duplicate ids keep the first occurrence.
 */
function coerce(parsed: unknown): PersonasFile {
  const raw = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const personas: Persona[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(raw.personas) ? raw.personas : [];
  for (const entry of list) {
    const persona = coercePersona(entry);
    if (!persona || seen.has(persona.id)) continue;
    // `builtin` is decided by the seed list, not the file: a hand-edited flag
    // could otherwise make a built-in deletable (or a user persona immortal).
    const seeded = BUILTINS.find((b) => b.id === persona.id);
    if (seeded) persona.builtin = true;
    else delete persona.builtin;
    seen.add(persona.id);
    personas.push(persona);
  }
  for (const builtin of BUILTINS) {
    if (!seen.has(builtin.id)) personas.push({ ...builtin });
  }
  return { version: 1, personas };
}

// Serialize writes through a promise chain so concurrent IPC calls can't
// interleave a read-modify-write and lose updates.
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeFileAtomic(store: PersonasFile): Promise<void> {
  const path = personasStorePath();
  // quiet: the write below is the one that has to land, and it rejects to the
  // mutator that called this if the directory really is not there.
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  // rename is atomic on the same volume — readers never see a half-written file.
  await rename(tmp, path);
}

/** Read the registry, seeding the built-ins on first use. */
export function listPersonas(): Promise<Persona[]> {
  return enqueue(async () => {
    try {
      return coerce(JSON.parse(await readFile(personasStorePath(), 'utf8'))).personas;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        const fresh = coerce({});
        await writeFileAtomic(fresh).catch((err) =>
          // quiet-ish: an unwritten seed costs nothing — the next read seeds
          // again — but say so once for the log.
          degrade('personas', 'left the seeded personas unwritten', err)
        );
        return fresh.personas;
      }
      // Corrupt/unreadable: degrade to the built-ins rather than throwing. The
      // user's personas are gone from the UI but not from disk — refuse to
      // write over the file (see update below) so a fixable file stays fixable.
      degrade('personas', 'started from the built-in personas', err);
      return coerce({}).personas;
    }
  });
}

/** Read, mutate, persist atomically. Both public mutators funnel through here. */
function update(mutate: (store: PersonasFile) => void): Promise<Persona[]> {
  return enqueue(async () => {
    let store: PersonasFile;
    try {
      store = coerce(JSON.parse(await readFile(personasStorePath(), 'utf8')));
    } catch (err) {
      // Refuse to write over a file that exists but can't be read — one failed
      // save is cheaper than silently replacing the user's personas with the
      // seed. (ENOENT is a first write on a fresh install and is the one case
      // where an empty store is the truth.)
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        degrade('personas', 'refused to write personas over a file it could not read', err);
        throw err;
      }
      store = coerce({});
    }
    mutate(store);
    await writeFileAtomic(store);
    return store.personas;
  });
}

/** Look up one persona by id (fresh read). Null when it doesn't exist. */
export async function getPersona(id: string): Promise<Persona | null> {
  const personas = await listPersonas();
  return personas.find((p) => p.id === id) ?? null;
}

/**
 * Create or update a persona (upsert by id; a missing/blank id gets a fresh
 * UUID). Names must be unique case-insensitively — the To: field addresses
 * personas by name, and two spellings of "verifier" would make mail ambiguous.
 */
export function savePersona(input: unknown): Promise<Persona[]> {
  return update((store) => {
    const raw = (input && typeof input === 'object' ? { ...(input as object) } : {}) as Record<
      string,
      unknown
    >;
    if (typeof raw.id !== 'string' || !raw.id.trim()) raw.id = randomUUID();
    const persona = coercePersona(raw);
    if (!persona) throw new Error('A persona needs at least a name.');
    const clash = store.personas.find(
      (p) => p.id !== persona.id && p.name.toLowerCase() === persona.name.toLowerCase()
    );
    if (clash) throw new Error(`A persona named "${clash.name}" already exists.`);
    const at = store.personas.findIndex((p) => p.id === persona.id);
    if (at >= 0) {
      // `builtin` survives the round-trip from the store, never from the caller.
      if (store.personas[at].builtin) persona.builtin = true;
      else delete persona.builtin;
      store.personas[at] = persona;
    } else {
      delete persona.builtin;
      store.personas.push(persona);
    }
  });
}

/** Delete a persona. Built-ins are refused (the seed would resurrect them blank). */
export function deletePersona(id: string): Promise<Persona[]> {
  return update((store) => {
    const persona = store.personas.find((p) => p.id === id);
    if (!persona) return;
    if (persona.builtin) throw new Error(`"${persona.name}" is built in and cannot be deleted.`);
    store.personas = store.personas.filter((p) => p.id !== id);
  });
}
