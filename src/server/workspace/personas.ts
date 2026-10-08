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
  version: 6;
  personas: Persona[];
}

/**
 * The seeded personas. Prompts are starting points the user is expected to
 * rewrite. Normal is the usual lead: it may start agents, and how to use them
 * well (the recipes) comes with the spawning instructions, not its prompt, so
 * a user who writes their own Normal keeps them.
 */
const BUILTINS: Persona[] = [
  {
    id: 'normal',
    name: 'Normal',
    prompt: '',
    canSpawn: true,
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
      'than doing the work yourself. Start agents from the existing personas with spawn_agent ' +
      '(each gets a name and a brief) and schedule follow-ups with schedule_task (set its ' +
      'personaId so the run happens as the right persona). Keep the inbox quiet: mail the user ' +
      'only decisions and results, not process.',
    canSpawn: true,
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
  const model = typeof r.model === 'string' ? r.model.trim().slice(0, 100) : '';
  return {
    agent: r.agent.trim(),
    cwd,
    ...(device ? { device } : {}),
    ...(model ? { model } : {}),
    // Strictly true: anything else (a string "true", 1) stays on the cards.
    ...(r.autoMode === true ? { autoMode: true as const } : {}),
    ...(r.reviewOnly === true ? { reviewOnly: true as const } : {})
  };
}

/** A computer or browser pin: both are just the paired Mac's id. */
function coerceDevicePin(raw: unknown): { device: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const device = typeof r.device === 'string' ? r.device.trim() : '';
  return device ? { device } : undefined;
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
  const computer = coerceDevicePin(r.computer);
  if (computer) persona.computer = computer;
  const browser = coerceDevicePin(r.browser);
  if (browser) persona.browser = browser;
  if (r.lightweight === true) persona.lightweight = true;
  // `canManagePersonas` and `canAddPersonas` are the flag's earlier spellings —
  // files written before the renames migrate here, on read.
  if (r.canSpawn === true || r.canManagePersonas === true || r.canAddPersonas === true) persona.canSpawn = true;
  // Memory defaults on; only an explicit opt-out is stored (see the type doc).
  if (r.memory === false) persona.memory = false;
  if (r.recall === false) persona.recall = false;
  if (typeof r.sendBudget === 'number' && Number.isFinite(r.sendBudget)) {
    persona.sendBudget = Math.min(100, Math.max(1, Math.round(r.sendBudget)));
  }
  // Off is the default and stored as absence, like the flags above.
  if (r.clients === true) persona.clients = true;
  const mcpServers = coerceMcpServers(r.mcpServers);
  if (mcpServers) persona.mcpServers = mcpServers;
  if (r.builtin === true) persona.builtin = true;
  return persona;
}

/**
 * The MCP allowlist, or undefined for "all". Only an array counts — an empty
 * one is a real restriction (no servers), so it is kept. Entries that are not
 * names are dropped, duplicates collapse, order is the editor's.
 */
function coerceMcpServers(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Every earlier seed text of a built-in's prompt. Seeding only appends missing
 * rows, so an install keeps whatever prompt it first got — the deployed server
 * still ran the phase-1 Secretary and Orchestrator, which never heard of
 * save_persona, and later ones still name the helper-persona tools agents
 * lost to spawn_agent. A stored prompt that matches one of these exactly was
 * never edited by the user, so the migration replaces it with the current
 * seed; an edited prompt is left alone.
 */
const LEGACY_SEED_PROMPTS: Record<string, string[]> = {
  secretary: [
    "You are Secretary. You triage requests: decide what a task needs, bring in the right personas, schedule follow-ups with your task tools, and keep the inbox quiet. Prefer delegating over doing the work yourself. When a tool you would use for delegation is not available yet, say what you would delegate and to whom instead of improvising.",
    "You are Secretary. You triage requests: decide what a task needs and delegate rather than doing the work yourself. Bring the right personas into the conversation with add_persona, hand them their piece with send_mail, and schedule follow-ups with schedule_task (set its personaId so the run happens as the right persona). Keep the inbox quiet: mail the user only decisions and results, not process.",
    "You are Secretary. You triage requests: decide what a task needs and delegate rather than doing the work yourself. Bring the right personas into the conversation with add_persona, hand them their piece with send_mail, and schedule follow-ups with schedule_task (set its personaId so the run happens as the right persona). When no existing persona fits, create one with save_persona and clean it up with delete_persona when its job is done. Keep the inbox quiet: mail the user only decisions and results, not process.",
    "You are Secretary. You triage requests: decide what a task needs and delegate rather than doing the work yourself. Bring the right personas into the conversation with add_persona, hand them their piece with send_mail, and schedule follow-ups with schedule_task (set its personaId so the run happens as the right persona). When no existing persona fits, create one with save_persona and clean it up with delete_persona when its job is done. When a job needs several workers, hand the whole job to Orchestrator in one brief: it creates and runs its own helpers and returns one assembled answer. Keep the inbox quiet: mail the user only decisions and results, not process.",
  ]
};

/**
 * Every seed text of a retired built-in. Orchestrator's fan-out knowledge now
 * lives in the spawning instructions every agent-starting persona gets (see
 * mail/preamble.ts), so a separate coordinator only added a hop. A stored row
 * whose prompt is one of these was never edited and is removed on upgrade; an
 * edited one stays, as an ordinary persona the user owns.
 */
const RETIRED_SEED_PROMPTS: Record<string, string[]> = {
  orchestrator: [
    "You are Orchestrator. Split large tasks into independent pieces, delegate each piece, and assemble the results into one coherent answer. When a task cannot be split, or the delegation tools are not available yet, do the work directly and say so.",
    "You are Orchestrator. Split large tasks into independent pieces and delegate each piece. Create workers with save_persona (for example researcher-1, researcher-2 as copies of a role prompt), bring them into the conversation with add_persona, then send ALL the delegations in ONE send_mail call — their replies come back to you together as a single assembly mail, which is when you combine the results. Delete your workers with delete_persona when the task is done. Report one assembled answer to the user. When a task cannot be split, do the work directly and say so.",
    "You are Orchestrator. Split large tasks into independent pieces and delegate each piece. Create workers with save_persona (for example researcher-1, researcher-2 as copies of a role prompt; recall false for a reviewer that must judge blind), bring them into the conversation with add_persona, tell each worker its name in its brief, then send ALL the delegations in ONE send_mail call — their replies come back to you together as a single assembly mail, which is when you combine the results. Delete your workers with delete_persona when the task is done. Report one assembled answer to whoever gave you the task — the user, or the persona that consulted you. When a task cannot be split, do the work directly and say so.",
    "You are Orchestrator. Split large tasks into independent pieces and delegate each piece to an agent: spawn_agent with an existing persona as its role, a short name, and the piece as its brief (blind true for a reviewer that must judge without knowing who wrote the work). Start all the pieces in the same turn: their replies come back to you together as one mail, which is when you combine the results. Report one assembled answer to whoever gave you the task. When a task cannot be split, do the work directly and say so.",
  ]
};

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
  const version = typeof raw.version === 'number' ? raw.version : 1;
  for (const entry of list) {
    // v4 and earlier let agents create helper personas (save_persona), stamped
    // `createdBy`. Agents are conversation-scoped now (spawn_agent), so the
    // leftovers are dropped once: nobody can address them any more, and they
    // kept no memory to lose.
    if (version < 5 && typeof (entry as { createdBy?: unknown } | null)?.createdBy === 'string') continue;
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
  // v1 files predate the delegation flag (now canSpawn): grant it to the
  // stored Secretary and Orchestrator rows, whose whole job needs it — seeding
  // only appends missing ids, so an existing row never gains a flag a later
  // phase seeds (deployed v1 files even show Secretary without the P2-era
  // canAddPersonas for this exact reason). Version-gated (not granted on every
  // read) so unticking the box sticks once the file is written.
  if (version < 2) {
    for (const id of ['secretary', 'orchestrator']) {
      const row = personas.find((p) => p.id === id);
      if (row) row.canSpawn = true;
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
  // v5 brings agents: Normal, the usual driver, may start them too. The grant
  // reaches nothing privileged: an agent never runs a persona pinned to the
  // user's computer unless the user put that persona in the conversation, and
  // never has wider integrations than its starter (mail/agents.ts). What it
  // adds is turns; untick the box to take it back.
  if (version < 5) {
    const normal = personas.find((p) => p.id === 'normal');
    if (normal) normal.canSpawn = true;
  }
  if (version < 5) {
    for (const [id, legacy] of Object.entries(LEGACY_SEED_PROMPTS)) {
      const row = personas.find((p) => p.id === id);
      const seed = BUILTINS.find((b) => b.id === id);
      if (row && seed && legacy.includes(row.prompt)) row.prompt = seed.prompt;
    }
  }
  // v6 retires Orchestrator: every persona that starts agents now gets the
  // fan-out instructions it carried. An untouched row goes; an edited one
  // stays as the user's own persona (no longer built in, so deletable).
  if (version < 6) {
    for (const [id, retired] of Object.entries(RETIRED_SEED_PROMPTS)) {
      const at = personas.findIndex((p) => p.id === id);
      if (at >= 0 && retired.includes(personas[at].prompt)) personas.splice(at, 1);
    }
  }
  for (const builtin of BUILTINS) {
    if (!seen.has(builtin.id)) personas.push({ ...builtin });
  }
  return { version: 6, personas };
}

// The registry is written by the editor's IPC (and migrations on read); the
// changed-notification lives here, at the store, where every successful write
// passes.
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
      // `builtin` survives the round-trip from the store, never from the
      // caller — an editor save can't make a persona undeletable.
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
export async function deletePersona(id: string): Promise<Persona[]> {
  const personas = await update((store) => {
    const persona = store.personas.find((p) => p.id === id);
    if (!persona) return;
    if (persona.builtin) throw new Error(`"${persona.name}" is built in and cannot be deleted.`);
    store.personas = store.personas.filter((p) => p.id !== id);
  });
  // The persona's memory dies with it — deliberately, so a later persona that
  // happens to reuse the name never inherits notes it did not earn.
  await deletePersonaMemory(id).catch((err) =>
    degrade('personas', 'left a deleted persona’s notes file behind', err)
  );
  return personas;
}
