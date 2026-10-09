import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { ScheduledTask, TaskRunRecord, TaskRunsAs, TaskSchedule } from '../../shared/types';
import { TASK_RECENT_RUNS } from '../../shared/types';
import { degrade } from '../degrade';
import { tasksStorePath } from './paths';

// The Stem-owned registry of scheduled tasks (tasks.json). Tiny and resilient like
// the connected-folders store: a corrupt/missing file degrades to "no tasks" rather
// than breaking the app. This module is the persistence layer only — the in-memory
// scheduler (scheduler/index.ts) owns timing and execution.

/**
 * Store versions: 1 — runs appended to the task's chat, so prompts could lean on
 * it; 2 — every run gets a fresh thread, prompts must stand alone. A version-1
 * store read by version-2 code is the one signal that its prompts were written
 * for the old world (see TaskScheduler.start's rewrite pass).
 */
const STORE_VERSION = 2;

interface TasksStore {
  version: number;
  tasks: ScheduledTask[];
}

/** Derive a short single-line title from a prompt for the list + chat badge. */
export function titleFromPrompt(prompt: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'Scheduled task';
}

/**
 * A failure reason, cut to something a row can carry: flattened to one line and
 * capped. Backend errors arrive as whole stacks and provider JSON bodies, and
 * this file is rewritten after every run — the cause is at the front of them.
 */
export function clipError(detail: string): string {
  const line = detail.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  return line.length > 300 ? `${line.slice(0, 297)}…` : line;
}

function coerceSchedule(raw: unknown): TaskSchedule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { kind?: unknown; expr?: unknown; at?: unknown };
  if (r.kind === 'cron' && typeof r.expr === 'string' && r.expr.trim()) return { kind: 'cron', expr: r.expr };
  if (r.kind === 'once' && typeof r.at === 'string' && r.at) return { kind: 'once', at: r.at };
  return null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Validate a `runsAs` value from any caller (the store, the Tasks tab, the
 * bridge). Null for anything that is not one of the three shapes — a task must
 * not be left half-pinned by a malformed patch.
 */
export function coerceRunsAs(raw: unknown): TaskRunsAs | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { kind?: unknown; personaId?: unknown; model?: unknown; effort?: unknown };
  if (r.kind === 'default') return { kind: 'default' };
  if (r.kind === 'persona') {
    const personaId = str(r.personaId);
    return personaId ? { kind: 'persona', personaId } : null;
  }
  if (r.kind === 'model') {
    const model = str(r.model);
    if (!model) return null;
    const effort = str(r.effort);
    return { kind: 'model', model, ...(effort ? { effort } : {}) };
  }
  return null;
}

/**
 * Tasks saved before `runsAs` existed carried three independent fields
 * (personaId, model, effort) with "the persona's pins win" as the tiebreak.
 * Fold them into the one choice on read; the next write persists the new shape.
 */
function legacyRunsAs(r: { personaId?: unknown; model?: unknown; effort?: unknown }): TaskRunsAs {
  const personaId = str(r.personaId);
  if (personaId) return { kind: 'persona', personaId };
  const model = str(r.model);
  if (model) {
    const effort = str(r.effort);
    return { kind: 'model', model, ...(effort ? { effort } : {}) };
  }
  return { kind: 'default' };
}

/** Coerce one parsed entry into a valid ScheduledTask, or null to drop it. */
function coerce(raw: unknown): ScheduledTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ScheduledTask> & { personaId?: unknown; model?: unknown; effort?: unknown };
  if (typeof r.threadId !== 'string' || !r.threadId) return null;
  if (typeof r.prompt !== 'string' || !r.prompt) return null;
  const schedule = coerceSchedule(r.schedule);
  if (!schedule) return null;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : randomUUID(),
    threadId: r.threadId,
    prompt: r.prompt,
    schedule,
    enabled: r.enabled !== false, // default true
    createdAt: typeof r.createdAt === 'string' && r.createdAt ? r.createdAt : new Date().toISOString(),
    title: typeof r.title === 'string' && r.title ? r.title : titleFromPrompt(r.prompt),
    runsAs: coerceRunsAs(r.runsAs) ?? legacyRunsAs(r),
    ...(r.rewritten && typeof r.rewritten === 'object' && typeof r.rewritten.at === 'string' && typeof r.rewritten.original === 'string'
      ? { rewritten: { at: r.rewritten.at, original: r.rewritten.original } }
      : {}),
    ...(typeof r.lastRunAt === 'string' ? { lastRunAt: r.lastRunAt } : {}),
    ...(typeof r.nextRunAt === 'string' || r.nextRunAt === null ? { nextRunAt: r.nextRunAt } : {}),
    ...(r.lastStatus === 'ok' || r.lastStatus === 'failed' || r.lastStatus === 'running'
      ? { lastStatus: r.lastStatus }
      : {}),
    ...(typeof r.lastError === 'string' && r.lastError ? { lastError: clipError(r.lastError) } : {}),
    ...(Array.isArray(r.recentRuns) ? { recentRuns: coerceRuns(r.recentRuns) } : {})
  };
}

function coerceRuns(raw: unknown[]): TaskRunRecord[] {
  const out: TaskRunRecord[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Partial<TaskRunRecord>;
    if (typeof r.at !== 'string' || (r.status !== 'ok' && r.status !== 'failed')) continue;
    out.push({
      at: r.at,
      status: r.status,
      ...(typeof r.error === 'string' && r.error ? { error: clipError(r.error) } : {}),
      ...(typeof r.threadId === 'string' && r.threadId ? { threadId: r.threadId } : {}),
      ...(r.parked === true ? { parked: true } : {})
    });
  }
  return out.slice(0, TASK_RECENT_RUNS);
}

async function loadStore(): Promise<{ tasks: ScheduledTask[]; version: number }> {
  const parsed = JSON.parse(await readFile(tasksStorePath(), 'utf8')) as Partial<TasksStore>;
  return {
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map(coerce).filter((t): t is ScheduledTask => !!t) : [],
    version: typeof parsed.version === 'number' ? parsed.version : 1
  };
}

async function loadTasks(): Promise<ScheduledTask[]> {
  return (await loadStore()).tasks;
}

export async function readTasks(): Promise<ScheduledTask[]> {
  return (await readTasksStore()).tasks;
}

/**
 * The tasks plus whether the store predates fresh-thread runs (`legacy`): a
 * version-1 file, whose prompts were written to be run inside their chat. A
 * missing store is current — there is nothing in it to rewrite.
 */
export async function readTasksStore(): Promise<{ tasks: ScheduledTask[]; legacy: boolean }> {
  try {
    const { tasks, version } = await loadStore();
    return { tasks, legacy: version < STORE_VERSION };
  } catch (error) {
    // "No tasks" is what a fresh install looks like, so a store that is there and
    // will not read stops every schedule without a word.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('tasks', 'reported no scheduled tasks', error);
    }
    return { tasks: [], legacy: false };
  }
}

/**
 * The read half of {@link updateTasks}, where an empty fallback is not a degraded
 * answer but a deletion: mutate() folds the new task into "no tasks" and the write
 * below persists exactly that, so one unreadable store costs the user every
 * schedule they have. Absent is still a first run; anything else refuses.
 */
async function readForUpdate(): Promise<ScheduledTask[]> {
  try {
    return await loadTasks();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    degrade('tasks', 'refused to write the task list over a store it could not read', error);
    throw error;
  }
}

// Serialize writes through a promise chain so concurrent callers can't interleave a
// read-modify-write and lose updates (mirrors connected-folders.ts / chats.ts).
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeTasks(tasks: ScheduledTask[]): Promise<void> {
  const path = tasksStorePath();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: STORE_VERSION, tasks } satisfies TasksStore, null, 2), 'utf8');
  await rename(tmp, path); // atomic on the same volume
}

/** Read, mutate the task array, persist atomically; returns the mutate() result. */
export function updateTasks<T>(mutate: (tasks: ScheduledTask[]) => { tasks: ScheduledTask[]; result: T }): Promise<T> {
  return enqueue(async () => {
    const current = await readForUpdate();
    const { tasks, result } = mutate(current);
    await writeTasks(tasks);
    return result;
  });
}

/**
 * Overwrite the whole list (used by the scheduler after recomputing run bookkeeping).
 *
 * The list handed in came from a `readTasks()` at scheduler boot, which answers
 * `[]` for a store that is merely unreadable — so a blind overwrite here is the
 * same deletion `updateTasks` refuses, arriving by a different door. Check that
 * the store reads before replacing it, and skip the write rather than reject:
 * one caller fires this without awaiting, and the cost of skipping is bookkeeping
 * that reruns a task after a restart, against every schedule gone.
 */
export function saveTasks(tasks: ScheduledTask[]): Promise<void> {
  return enqueue(async () => {
    try {
      await loadTasks();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        degrade('tasks', 'did not persist the task list over a store it could not read', error);
        return;
      }
    }
    await writeTasks(tasks);
  });
}
