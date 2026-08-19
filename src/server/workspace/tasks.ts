import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { ScheduledTask, TaskSchedule } from '../../shared/types';
import { degrade } from '../degrade';
import { tasksStorePath } from './paths';

// The Stem-owned registry of scheduled tasks (tasks.json). Tiny and resilient like
// the connected-folders store: a corrupt/missing file degrades to "no tasks" rather
// than breaking the app. This module is the persistence layer only — the in-memory
// scheduler (scheduler/index.ts) owns timing and execution.

interface TasksStore {
  version: 1;
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

/** Coerce one parsed entry into a valid ScheduledTask, or null to drop it. */
function coerce(raw: unknown): ScheduledTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ScheduledTask>;
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
    ...(typeof r.model === 'string' && r.model ? { model: r.model } : {}),
    ...(typeof r.effort === 'string' && r.effort ? { effort: r.effort } : {}),
    ...(typeof r.lastRunAt === 'string' ? { lastRunAt: r.lastRunAt } : {}),
    ...(typeof r.nextRunAt === 'string' || r.nextRunAt === null ? { nextRunAt: r.nextRunAt } : {}),
    ...(r.lastStatus === 'ok' || r.lastStatus === 'failed' || r.lastStatus === 'running'
      ? { lastStatus: r.lastStatus }
      : {}),
    ...(typeof r.lastError === 'string' && r.lastError ? { lastError: clipError(r.lastError) } : {})
  };
}

async function loadTasks(): Promise<ScheduledTask[]> {
  const parsed = JSON.parse(await readFile(tasksStorePath(), 'utf8')) as Partial<TasksStore>;
  return Array.isArray(parsed.tasks) ? parsed.tasks.map(coerce).filter((t): t is ScheduledTask => !!t) : [];
}

export async function readTasks(): Promise<ScheduledTask[]> {
  try {
    return await loadTasks();
  } catch (error) {
    // "No tasks" is what a fresh install looks like, so a store that is there and
    // will not read stops every schedule without a word.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('tasks', 'reported no scheduled tasks', error);
    }
    return [];
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
  await writeFile(tmp, JSON.stringify({ version: 1, tasks } satisfies TasksStore, null, 2), 'utf8');
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
