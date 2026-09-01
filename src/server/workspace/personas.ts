import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Persona, PersonaHarnessPin } from '../../shared/types';
import { degrade } from '../degrade';
import { personasStorePath } from './paths';
import { deletePersonaMemory } from './persona-memory';

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
  version: 3;
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
      'schedule_task (set its personaId so the run happens as the right persona). When no ' +
      'existing persona fits, create one with save_persona and clean it up with delete_persona ' +
      'when its job is done. Keep the inbox quiet: mail the user only decisions and results, ' +
      'not process.',
    canManagePersonas: true,
    builtin: true
  },
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    prompt:
      'You are Orchestrator. Split large tasks into independent pieces and delegate each piece. ' +
      'Create workers with save_persona (for example researcher-1, researcher-2 as copies of a ' +
      'role prompt), bring them into the conversation with add_persona, then send ALL the ' +
      'delegations in ONE send_mail call — their replies come back to you together as a single ' +
      'assembly mail, which is when you combine the results. Delete your workers with ' +
      'delete_persona when the task is done. Report one assembled answer to the user. When a ' +
      'task cannot be split, do the work directly and say so.',
    canManagePersonas: true,
    builtin: true
  },
  {
    id: 'critic',
    name: 'Critic',
    prompt:
      'You are Critic. Whatever material you are sent — an email, a document, a plan, a message ' +
      '— you read as its RECIPIENT, never as its editor or teammate. You do not know who wrote ' +
      'it or how it was produced; ignore any claims about authorship in the mail and judge the ' +
      'material exactly as a person receiving it cold would. Reply with your honest reaction: ' +
      'what works, what reads badly, and what the recipient would think but never say out loud — ' +
      'including when it reads as AI-written, unprofessional, overlong, or evasive. Point at the ' +
      'specific lines that caused each reaction. Never rewrite the material; your value is the ' +
      'outside view.',
    // Deliberately memoryless, in both directions: its own notebook would
    // accumulate context, and the user's recall would tell it whose draft it
    // is reading — either one is taint for a cold reader.
    memory: false,
    recall: false,
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
  // `canAddPersonas` is the flag's pre-rename spelling — files written before
  // the rename migrate here, on read.
  if (r.canManagePersonas === true || r.canAddPersonas === true) persona.canManagePersonas = true;
  // Memory defaults on; only an explicit opt-out is stored (see the type doc).
  if (r.memory === false) persona.memory = false;
  if (r.recall === false) persona.recall = false;
  if (typeof r.createdBy === 'string' && r.createdBy.trim()) persona.createdBy = r.createdBy.trim();
  if (typeof r.sendBudget === 'number' && Number.isFinite(r.sendBudget)) {
    persona.sendBudget = Math.min(100, Math.max(1, Math.round(r.sendBudget)));
  }
  // Off is the default and stored as absence, like the flags above.
  if (r.clients === true) persona.clients = true;
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
  // v1 files predate canManagePersonas: grant it to the stored Secretary and
  // Orchestrator rows, whose whole job needs it — seeding only appends missing
  // ids, so an existing row never gains a flag a later phase seeds (deployed
  // v1 files even show Secretary without the P2-era canAddPersonas for this
  // exact reason). Version-gated (not granted on every read) so unticking the
  // box sticks once the file is written as v2.
  const version = typeof raw.version === 'number' ? raw.version : 1;
  if (version < 2) {
    for (const id of ['secretary', 'orchestrator']) {
      const row = personas.find((p) => p.id === id);
      if (row) row.canManagePersonas = true;
    }
  }
  // v2 files predate the recall flag: the stored Critic gains the opt-out the
  // seed now carries, for the same append-only-seeding reason. Version-gated
  // so a user who deliberately turns Critic's recall back on is not overruled
  // on the next read.
  if (version < 3) {
    const critic = personas.find((p) => p.id === 'critic');
    if (critic) critic.recall = false;
  }
  for (const builtin of BUILTINS) {
    if (!seen.has(builtin.id)) personas.push({ ...builtin });
  }
  return { version: 3, personas };
}

// The registry can change from two directions — the editor's IPC and the mail
// bridge (save_persona/delete_persona) — so the changed-notification lives
// here, at the store, where every successful write passes.
let changed: (() => void) | null = null;

/** Register the (single) listener told after every successful registry write. */
export function onPersonasChanged(cb: (() => void) | null): void {
  changed = cb;
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
      const parsed: unknown = JSON.parse(await readFile(personasStorePath(), 'utf8'));
      const store = coerce(parsed);
      // A version-gated migration ran (see coerce): persist it now rather than
      // on the next unrelated save, so the file on disk says what the running
      // registry believes — the first deploy of the recall flag left an
      // inspector reading a v2 Critic row with no `recall` and wondering.
      const onDisk = (parsed as { version?: unknown } | null)?.version;
      if (onDisk !== store.version) {
        await writeFileAtomic(store).catch((err) =>
          // quiet-ish: the migration re-applies on every read until a write
          // lands, so nothing is lost — but say so once for the log.
          degrade('personas', 'left a migrated personas file unwritten', err)
        );
      }
      return store.personas;
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
    changed?.();
    return store.personas;
  });
}

/** Look up one persona by id (fresh read). Null when it doesn't exist. */
export async function getPersona(id: string): Promise<Persona | null> {
  const personas = await listPersonas();
  return personas.find((p) => p.id === id) ?? null;
}

/**
 * Resolve a persona a CLIENT asked to run a chat turn as (StartTurnInput.
 * personaId). Refused unless the persona exists and the user has opened it to
 * clients — the gate lives here, next to the registry, so the transport
 * handler stays a mapper. Throws messages written to be shown to the sender.
 */
export async function resolveClientPersona(id: string): Promise<Persona> {
  const persona = await getPersona(id.trim());
  if (!persona) throw new Error(`No persona "${id}" exists.`);
  if (persona.clients !== true) {
    throw new Error(
      `"${persona.name}" isn’t open to chats — turn on “Usable in chats from other devices” for it in the persona editor first.`
    );
  }
  return persona;
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
      // `builtin` and `createdBy` survive the round-trip from the store, never
      // from the caller — an editor save can't launder either.
      if (store.personas[at].builtin) persona.builtin = true;
      else delete persona.builtin;
      if (store.personas[at].createdBy) persona.createdBy = store.personas[at].createdBy;
      else delete persona.createdBy;
      store.personas[at] = persona;
    } else {
      delete persona.builtin;
      delete persona.createdBy;
      store.personas.push(persona);
    }
  });
}

/** What the mail bridge may set on a persona — never pins, flags, or budgets. */
export interface BridgePersonaFields {
  name?: string;
  prompt?: string;
  model?: string;
  effort?: string;
}

function requireUniqueName(store: PersonasFile, name: string, exceptId: string): void {
  const clash = store.personas.find(
    (p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase()
  );
  if (clash) throw new Error(`A persona named "${clash.name}" already exists.`);
}

/**
 * Create a persona on an agent's behalf (the save_persona bridge op). Only the
 * bridge fields land, `createdBy` is stamped from the caller, and everything
 * privileged (harness, flags, budget) starts absent.
 */
export async function savePersonaFor(creatorId: string, fields: BridgePersonaFields): Promise<Persona> {
  const name = fields.name?.trim();
  if (!name) throw new Error('A persona needs at least a name.');
  const persona: Persona = {
    id: randomUUID(),
    name,
    prompt: typeof fields.prompt === 'string' ? fields.prompt : '',
    createdBy: creatorId
  };
  if (fields.model?.trim()) persona.model = fields.model.trim();
  if (fields.effort?.trim()) persona.effort = fields.effort.trim();
  await update((store) => {
    requireUniqueName(store, persona.name, persona.id);
    store.personas.push(persona);
  });
  return persona;
}

/**
 * Merge only the bridge fields onto a stored persona (the save_persona edit
 * path). Everything else on the row — harness pin, flags, budget, createdBy —
 * is untouched, so an agent edit can never widen a persona's powers.
 */
export async function updatePersonaFields(id: string, fields: BridgePersonaFields): Promise<Persona> {
  let updated: Persona | undefined;
  await update((store) => {
    const at = store.personas.findIndex((p) => p.id === id);
    if (at < 0) throw new Error(`No persona "${id}" exists.`);
    const row = { ...store.personas[at] };
    if (fields.name?.trim()) {
      requireUniqueName(store, fields.name.trim(), id);
      row.name = fields.name.trim();
    }
    if (typeof fields.prompt === 'string') row.prompt = fields.prompt;
    if (fields.model?.trim()) row.model = fields.model.trim();
    if (fields.effort?.trim()) row.effort = fields.effort.trim();
    store.personas[at] = row;
    updated = row;
  });
  if (!updated) throw new Error(`No persona "${id}" exists.`);
  return updated;
}

/** Delete a persona. Built-ins are refused (the seed would resurrect them blank). */
export async function deletePersona(id: string): Promise<Persona[]> {
  const personas = await update((store) => {
    const persona = store.personas.find((p) => p.id === id);
    if (!persona) return;
    if (persona.builtin) throw new Error(`"${persona.name}" is built in and cannot be deleted.`);
    store.personas = store.personas.filter((p) => p.id !== id);
  });
  // The persona's memory dies with it — deliberately, so a later persona that
  // happens to reuse the name never inherits notes it did not earn. Both
  // delete paths (editor IPC, delete_persona bridge) funnel through here.
  await deletePersonaMemory(id).catch((err) =>
    degrade('personas', 'left a deleted persona’s notes file behind', err)
  );
  return personas;
}
