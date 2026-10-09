import { EventEmitter } from 'node:events';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These tests own the scheduler's virtual clock. The recorder now awaits native
// file I/O before startTurn, which advancing a fake clock cannot flush. Keep that
// persistence boundary out of the timing unit tests; mail-work-scheduler.test.ts
// exercises the real scheduler + recorder together with real timers and files.
vi.mock('../../src/server/mail/work', () => ({
  beginMailWork: async (_runtime: unknown, input: { turnId: string }) => ({
    run: { turnId: input.turnId },
    bindThread: () => {},
    finish: async () => {}
  })
}));

// Point the tasks store at a throwaway file before importing modules that read the
// path. setup-unit.ts already isolates the other stores; tasks gets its own here.
const STORE = join(tmpdir(), `stem-tasks-${process.pid}.json`);
process.env.STEM_TASKS_STORE = STORE;

import type { ScheduledTask, StartTurnInput } from '../../src/shared/types';
import { TaskScheduler, type SchedulerOptions } from '../../src/server/scheduler';
import { readTasks, saveTasks } from '../../src/server/workspace/tasks';

// A minimal ChatBackend stand-in: records startTurn calls, mints a fresh thread
// per call (as pi does when no threadId comes in), emits the turn/completed event
// the scheduler waits on, and records thread deletions.
class FakeRuntime extends EventEmitter {
  starts: StartTurnInput[] = [];
  deleted: string[] = [];
  threadOf(n: number): string {
    return `run-${n}`;
  }
  async startTurn(input: StartTurnInput) {
    this.starts.push(input);
    const n = this.starts.length;
    const turnId = `turn-${n}`;
    const threadId = this.threadOf(n);
    // Settle on the next tick so waitForSettle's listener is attached first.
    setTimeout(() => this.emit('event', { method: 'turn/completed', params: { threadId, turn: { id: turnId } } }), 0);
    return { threadId, turnId };
  }
  async deleteThread(threadId: string) {
    this.deleted.push(threadId);
  }
}

// FakeRuntime whose runs settle per a scripted outcome list: an error string fails
// that run with turn/failed carrying it; null completes it.
class ScriptedRuntime extends FakeRuntime {
  constructor(private readonly outcomes: (string | null)[]) {
    super();
  }
  override async startTurn(input: StartTurnInput) {
    this.starts.push(input);
    const n = this.starts.length;
    const turnId = `turn-${n}`;
    const threadId = this.threadOf(n);
    const error = this.outcomes[n - 1] ?? null;
    setTimeout(() => {
      if (error) {
        this.emit('event', { method: 'turn/failed', params: { threadId, turn: { id: turnId }, error } });
      } else {
        this.emit('event', { method: 'turn/completed', params: { threadId, turn: { id: turnId } } });
      }
    }, 0);
    return { threadId, turnId };
  }
}

function makeScheduler(runtime: EventEmitter, extra: Partial<SchedulerOptions> = {}) {
  const changes: ScheduledTask[][] = [];
  const reflections: { personaId: string; assignment: string; threadId: string }[] = [];
  const failures: { taskId: string; title: string; threadId?: string; personaId?: string; error: string }[] = [];
  const deletedTasks: string[] = [];
  const scheduler = new TaskScheduler({
    runtime: runtime as never,
    onChange: (tasks) => changes.push(tasks),
    reflect: async (args) => {
      reflections.push(args);
    },
    onFailureTransition: async (args) => {
      failures.push(args);
    },
    onTaskDeleted: async (taskId) => {
      deletedTasks.push(taskId);
    },
    ...extra
  });
  return { scheduler, changes, reflections, failures, deletedTasks };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

// A run's chain is async all the way down — startTurn, the settle event, then the
// atomic store write — so a fixed sleep races it on a loaded CI runner. Wait for the
// observable condition instead. (Real timers only: never call this under fake ones.)
async function until(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await flush();
  }
}

/** The status the store has actually persisted for the first (usually only) task. */
const storedStatus = async () => (await readTasks())[0]?.lastStatus;

const seed = (patch: Partial<ScheduledTask> & { id: string; prompt: string }): ScheduledTask => ({
  threadId: 't1',
  schedule: { kind: 'cron', expr: '0 8 * * *' },
  enabled: true,
  createdAt: new Date().toISOString(),
  title: patch.prompt,
  runsAs: { kind: 'default' },
  ...patch
});

beforeEach(() => rmSync(STORE, { force: true }));
afterEach(() => {
  vi.useRealTimers();
  rmSync(STORE, { force: true });
});

describe('TaskScheduler.create', () => {
  it('creates a cron task with a future next-run, scheduled from the calling thread', async () => {
    const runtime = new FakeRuntime();
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'do it', cron: '0 8 * * *' }, 't1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.task.schedule).toEqual({ kind: 'cron', expr: '0 8 * * *' });
    expect(res.task.threadId).toBe('t1');
    expect(res.task.runsAs).toEqual({ kind: 'default' });
    expect(res.task.nextRunAt).toBeTruthy();
    expect(new Date(res.task.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(scheduler.listForThread('t1').map((t) => t.id)).toEqual([res.task.id]);
    expect(scheduler.listForThread('elsewhere')).toEqual([]);
    // Persisted.
    expect((await readTasks())).toHaveLength(1);
    scheduler.stop();
  });

  it('rejects bad / ambiguous schedules', async () => {
    const { scheduler } = makeScheduler(new FakeRuntime());
    expect((await scheduler.create({ prompt: 'x', cron: 'nope' }, 't1')).ok).toBe(false);
    expect((await scheduler.create({ prompt: 'x', cron: '0 0 30 2 *' }, 't1')).ok).toBe(false);
    expect((await scheduler.create({ prompt: 'x', cron: '0 8 * * *', at: '2030-01-01T00:00:00Z' }, 't1')).ok).toBe(false);
    expect((await scheduler.create({ prompt: 'x' }, 't1')).ok).toBe(false);
    expect((await scheduler.create({ prompt: '', cron: '0 8 * * *' }, 't1')).ok).toBe(false);
    // A one-time datetime in the past would fire immediately — reject it.
    expect((await scheduler.create({ prompt: 'x', at: new Date(Date.now() - 60_000).toISOString() }, 't1')).ok).toBe(false);
    // A future one-time datetime is accepted.
    expect((await scheduler.create({ prompt: 'x', at: new Date(Date.now() + 60_000).toISOString() }, 't1')).ok).toBe(true);
    scheduler.stop();
  });

  it('validate refuses what create refuses, without writing anything', async () => {
    const { scheduler } = makeScheduler(new FakeRuntime());
    expect((await scheduler.validate({ prompt: 'x', cron: 'nope' })).ok).toBe(false);
    expect((await scheduler.validate({ prompt: '', cron: '0 8 * * *' })).ok).toBe(false);
    expect((await scheduler.validate({ prompt: 'x', cron: '0 8 * * *', personaId: 'nobody' })).ok).toBe(false);
    expect((await scheduler.validate({ prompt: 'x', cron: '0 8 * * *' })).ok).toBe(true);
    expect(await readTasks()).toEqual([]);
    scheduler.stop();
  });
});

describe('TaskScheduler catch-up', () => {
  it('runs an overdue task exactly once on start', async () => {
    // Seed a task whose persisted nextRunAt is in the past (missed during downtime).
    const past = new Date(Date.now() - 60_000).toISOString();
    await saveTasks([seed({ id: 'a', prompt: 'catch me up', createdAt: past, nextRunAt: past })]);

    const runtime = new FakeRuntime();
    const { scheduler } = makeScheduler(runtime);
    await scheduler.start();
    await until(async () => (await storedStatus()) === 'ok', 'the catch-up run to be recorded');

    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0].scheduled).toBeTruthy();

    // After the catch-up run, nextRunAt is recomputed into the future (no re-run).
    const after = await readTasks();
    expect(after[0].lastStatus).toBe('ok');
    expect(after[0].lastRunAt).toBeTruthy();
    expect(new Date(after[0].nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    scheduler.stop();
  });

  it('does not catch up a task whose next-run is still in the future', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    await saveTasks([seed({ id: 'b', prompt: 'later', createdAt: future, nextRunAt: future })]);
    const runtime = new FakeRuntime();
    const { scheduler } = makeScheduler(runtime);
    await scheduler.start();
    await flush();
    expect(runtime.starts).toHaveLength(0);
    scheduler.stop();
  });

  it('reads tasks saved before runsAs existed, folding the old pins into the one choice', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const legacy = (id: string, pins: Record<string, unknown>) => ({
      id, threadId: 't1', prompt: id, schedule: { kind: 'cron', expr: '0 8 * * *' }, enabled: true,
      createdAt: future, nextRunAt: future, title: id, ...pins
    });
    // Written raw: the store's own writer would already carry runsAs.
    writeFileSync(STORE, JSON.stringify({ version: 1, tasks: [
      legacy('plain', {}),
      legacy('pinned', { model: 'prov/m', effort: 'high' }),
      // Persona AND model used to coexist with the model ignored; the persona wins.
      legacy('persona', { personaId: 'verifier', model: 'prov/m' })
    ] }));
    const tasks = await readTasks();
    expect(tasks.map((t) => t.runsAs)).toEqual([
      { kind: 'default' },
      { kind: 'model', model: 'prov/m', effort: 'high' },
      { kind: 'persona', personaId: 'verifier' }
    ]);
  });
});

describe('TaskScheduler does not flood', () => {
  // Regression for the runaway-duplicate-runs bug. The defect: tick() enqueued a
  // run but left the task's nextRunAt at its (now-past) fire time, so the re-arm
  // kept re-detecting it as due and re-enqueuing every ~250ms while the run was
  // in-flight. Runs serialize through one queue, so the duplicates surfaced one
  // turn-settle apart — an unstoppable trickle of repeat runs + notifications.
  //
  // To catch it the run must settle SLOWER than the ~250ms re-arm interval (so the
  // buggy tick re-enqueues before nextRunAt is cleared), and we must observe long
  // enough for the queue to drain a SECOND run. The task is also armed to fire via
  // the live timer (not the catch-up path, which only ever enqueues once).
  it('fires a due task exactly once even when the run settles slowly', async () => {
    class SlowRuntime extends EventEmitter {
      starts: StartTurnInput[] = [];
      async startTurn(input: StartTurnInput) {
        this.starts.push(input);
        const turnId = `turn-${this.starts.length}`;
        // Settle after 600ms — longer than the re-arm interval, so a buggy tick has
        // multiple chances to re-enqueue this still-"due" task before it clears.
        setTimeout(
          () => this.emit('event', { method: 'turn/completed', params: { threadId: 'run-1', turn: { id: turnId } } }),
          600
        );
        return { threadId: 'run-1', turnId };
      }
      async deleteThread() {}
    }

    // A one-time task armed ~1.2s out: comfortably past the catch-up slop (so start()
    // arms the live timer instead of running it immediately), but soon enough to keep
    // the test short. A once-task also dodges cron's minute-boundary variability.
    const at = new Date(Date.now() + 1200).toISOString();
    await saveTasks([seed({ id: 'flood', prompt: 'ping', schedule: { kind: 'once', at }, nextRunAt: at })]);

    const runtime = new SlowRuntime();
    const { scheduler } = makeScheduler(runtime);
    await scheduler.start();
    // Observe past the point where a buggy second run would have started: first run
    // dispatches ~1.45s, settles ~2.05s, and the buggy re-enqueue's run would start
    // right after. By 2.5s the duplicate would be visible; the fix keeps it at one.
    await new Promise((r) => setTimeout(r, 2500));

    expect(runtime.starts).toHaveLength(1);
    // A fired one-time task is removed from the list, so it stops showing in the
    // Tasks tab and clears the owning chat's scheduled badge.
    expect(scheduler.snapshot()).toHaveLength(0);
    expect(await readTasks()).toHaveLength(0);
    scheduler.stop();
  });
}, 10_000);

describe('the one-off prompt rewrite for stores from before fresh-thread runs', () => {
  const legacyStore = (tasks: Array<{ id: string; prompt: string }>) => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    writeFileSync(STORE, JSON.stringify({ version: 1, tasks: tasks.map((t) => ({
      id: t.id, threadId: 't1', prompt: t.prompt, title: t.prompt, schedule: { kind: 'cron', expr: '0 8 * * *' },
      enabled: true, createdAt: future, nextRunAt: future
    })) }));
  };

  it('rewrites every prompt once, keeps the original for Revert, mails the outcome and moves the store to version 2', async () => {
    legacyStore([{ id: 'a', prompt: 'compare with earlier reports here' }, { id: 'b', prompt: 'already fine' }]);
    const asked: string[] = [];
    const mails: { rewritten: string[]; untouched: string[] }[] = [];
    const { scheduler } = makeScheduler(new FakeRuntime(), {
      rewriteForFreshThreads: async (task) => {
        asked.push(task.id);
        return task.id === 'a' ? 'Compare against the baseline: nothing known as of June.' : null;
      },
      onRewritten: async ({ rewritten, untouched }) => {
        mails.push({ rewritten: rewritten.map((t) => t.id), untouched: untouched.map((t) => t.id) });
      }
    });
    await scheduler.start();
    expect(asked).toEqual(['a', 'b']);
    expect(mails).toEqual([{ rewritten: ['a'], untouched: ['b'] }]);
    const [a, b] = scheduler.snapshot();
    expect(a.prompt).toBe('Compare against the baseline: nothing known as of June.');
    expect(a.title).toBe('Compare against the baseline: nothing known as of June.');
    expect(a.rewritten).toMatchObject({ original: 'compare with earlier reports here' });
    expect(b.prompt).toBe('already fine');
    expect(b.rewritten).toBeUndefined();
    expect(JSON.parse(readFileSync(STORE, 'utf8')).version).toBe(2);
    scheduler.stop();

    // A second boot on the saved store does not ask again.
    const again = makeScheduler(new FakeRuntime(), { rewriteForFreshThreads: async () => 'never' });
    await again.scheduler.start();
    expect(again.scheduler.snapshot()[0].prompt).toBe('Compare against the baseline: nothing known as of June.');
    again.scheduler.stop();
  });

  it('Revert puts the original back and drops the mark; a user edit drops the mark too', async () => {
    legacyStore([{ id: 'a', prompt: 'old words' }, { id: 'b', prompt: 'other old words' }]);
    const { scheduler } = makeScheduler(new FakeRuntime(), {
      rewriteForFreshThreads: async (task) => `${task.prompt}, spelled out`,
      onRewritten: async () => {}
    });
    await scheduler.start();
    let [a, b] = await scheduler.revertRewrite('a');
    expect(a).toMatchObject({ prompt: 'old words', title: 'old words' });
    expect(a.rewritten).toBeUndefined();
    expect(b.rewritten).toBeDefined();
    [a, b] = await scheduler.updatePrompt('b', 'my own words');
    expect(b.rewritten).toBeUndefined();
    expect((await readTasks()).map((t) => t.rewritten)).toEqual([undefined, undefined]);
    scheduler.stop();
  });

  it('a version-2 store, or no rewrite hook, leaves prompts alone', async () => {
    await saveTasks([seed({ id: 'a', prompt: 'fine' })]);
    const asked: string[] = [];
    const { scheduler } = makeScheduler(new FakeRuntime(), { rewriteForFreshThreads: async (t) => (asked.push(t.id), 'x') });
    await scheduler.start();
    expect(asked).toEqual([]);
    scheduler.stop();
    legacyStore([{ id: 'a', prompt: 'fine' }]);
    const bare = makeScheduler(new FakeRuntime(), { rewriteForFreshThreads: undefined });
    await bare.scheduler.start();
    expect(bare.scheduler.snapshot()[0].prompt).toBe('fine');
    bare.scheduler.stop();
  });
});

describe('every run gets a fresh thread', () => {
  it('sends no threadId, so the backend mints a session per firing; the origin chat is never written to', async () => {
    const runtime = new FakeRuntime();
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'now', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await until(async () => (await storedStatus()) === 'ok', 'the first run to be recorded');
    scheduler.runNow(res.task.id);
    await until(() => runtime.starts.length === 2 && runtime.deleted.length === 2, 'the second run to settle');
    for (const start of runtime.starts) {
      expect('threadId' in start).toBe(false);
      expect(start.scheduled?.taskId).toBe(res.task.id);
      expect(start.webSearch).toBe(true);
    }
    // Neither run notified: both fresh threads are gone, and t1 was never touched.
    expect(runtime.deleted).toEqual(['run-1', 'run-2']);
    expect((await readTasks())[0].threadId).toBe('t1');
    scheduler.stop();
  });

  it('hands the run what earlier firings already mailed; a store that cannot be read costs only that', async () => {
    const runtime = new FakeRuntime();
    const asked: string[] = [];
    let fail = false;
    const { scheduler } = makeScheduler(runtime, {
      priorReports: async (taskId) => {
        asked.push(taskId);
        if (fail) throw new Error('mail store unreadable');
        return [{ at: 1, headline: 'Found one', body: 'A new release', reply: 'v2 is out' }];
      }
    });
    const res = await scheduler.create({ prompt: 'watch', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await until(async () => (await storedStatus()) === 'ok', 'the first run');
    expect(asked).toEqual([res.task.id]);
    expect(runtime.starts[0].scheduled?.prior).toEqual([{ at: 1, headline: 'Found one', body: 'A new release', reply: 'v2 is out' }]);
    fail = true;
    scheduler.runNow(res.task.id);
    await until(() => runtime.starts.length === 2 && runtime.deleted.length === 2, 'the second run');
    expect(runtime.starts[1].scheduled?.prior).toBeUndefined();
    expect(await storedStatus()).toBe('ok');
    scheduler.stop();
  });

  it('keeps the thread of a run that called notify_user — the mail points at it', async () => {
    const runtime = new NotifyingRuntime();
    const { scheduler } = makeScheduler(runtime);
    runtime.scheduler = scheduler;
    const res = await scheduler.create({ prompt: 'watch', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await until(async () => (await storedStatus()) === 'ok', 'the run to be recorded');
    await flush();
    expect(runtime.deleted).toEqual([]);
    // The Runs list points at the kept thread, which is what its mail item carries too.
    expect((await readTasks())[0].recentRuns?.[0]?.threadId).toBeTruthy();
    scheduler.stop();
  });

  it('ignores a notify_user from some other thread: that run\'s thread is still disposed of', async () => {
    const runtime = new FakeRuntime();
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'watch', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.noteNotify('someone-else');
    scheduler.runNow(res.task.id);
    await until(() => runtime.deleted.length === 1, 'the run thread to be deleted');
    expect(runtime.deleted).toEqual(['run-1']);
    scheduler.stop();
  });

  it('disposes through the host\'s deleteThread when given one (it also forgets the search index)', async () => {
    const runtime = new FakeRuntime();
    const discarded: string[] = [];
    const { scheduler } = makeScheduler(runtime, {
      deleteThread: async (id) => {
        discarded.push(id);
      }
    });
    const res = await scheduler.create({ prompt: 'watch', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await until(() => discarded.length === 1, 'the host to be asked');
    expect(discarded).toEqual(['run-1']);
    expect(runtime.deleted).toEqual([]);
    scheduler.stop();
  });

  it('runningTask answers for the run\'s own thread only', async () => {
    const runtime = new HangingRuntime();
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'p', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await until(() => runtime.listenerCount('event') > 0, 'the run to await its settle');
    expect(scheduler.runningTask('run-1')?.id).toBe(res.task.id);
    expect(scheduler.runningTask('t1')).toBeNull();
    // …and the chat list asks for it by this name, to hide it while it runs.
    expect(scheduler.activeRunThreadId()).toBe('run-1');
    runtime.settle('turn-1');
    await until(async () => (await storedStatus()) === 'ok', 'the run to settle');
    expect(scheduler.activeRunThreadId()).toBeNull();
    scheduler.stop();
  });
});

describe('TaskScheduler.runNow + management', () => {
  it('runs a task immediately and records the outcome', async () => {
    const runtime = new FakeRuntime();
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'now', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await until(async () => (await storedStatus()) === 'ok', 'the run to be recorded');
    expect(runtime.starts).toHaveLength(1);
    const after = await readTasks();
    expect(after[0].lastStatus).toBe('ok');
    scheduler.stop();
  });

  // A run that dies before its turn ever starts — the backend will not spawn —
  // used to leave "failed" in the Tasks tab and not one word anywhere else,
  // because the throw was caught and dropped. That is how a migrated server ran
  // every scheduled task into the ground for days unnoticed.
  it('keeps why a run failed, and drops it once one succeeds', async () => {
    const runtime = new FakeRuntime();
    let refuse = true;
    const baseStart = runtime.startTurn.bind(runtime);
    runtime.startTurn = async (input: StartTurnInput) => {
      if (refuse) throw new Error('Stored session working directory does not exist: /Users/someone/workspace');
      return baseStart(input);
    };
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'watch', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');

    scheduler.runNow(res.task.id);
    await until(async () => (await storedStatus()) === 'failed', 'the failure to be recorded');
    expect((await readTasks())[0].lastError).toMatch(/working directory does not exist/);

    refuse = false;
    scheduler.runNow(res.task.id);
    await until(async () => (await storedStatus()) === 'ok', 'the good run to be recorded');
    expect((await readTasks())[0].lastError).toBeUndefined();
    // Both firings are in the Runs list, newest first; neither mailed, so neither keeps a thread.
    const runs = (await readTasks())[0].recentRuns!;
    expect(runs.map((r) => r.status)).toEqual(['ok', 'failed']);
    expect(runs[1].error).toMatch(/working directory does not exist/);
    expect(runs.every((r) => r.threadId === undefined)).toBe(true);
    scheduler.stop();
  });

  it('pause/resume and delete update the store; delete hands the task\'s run threads over', async () => {
    const runtime = new FakeRuntime();
    const { scheduler, deletedTasks } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'x', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    const id = res.task.id;

    let list = await scheduler.setEnabled(id, false);
    expect(list[0].enabled).toBe(false);
    expect(list[0].nextRunAt).toBeNull();

    list = await scheduler.setEnabled(id, true);
    expect(list[0].enabled).toBe(true);
    expect(list[0].nextRunAt).toBeTruthy();

    list = await scheduler.remove(id);
    expect(list).toHaveLength(0);
    expect(await readTasks()).toHaveLength(0);
    expect(deletedTasks).toEqual([id]);
    // Removing what is not there hands nothing over.
    await scheduler.remove(id);
    expect(deletedTasks).toEqual([id]);
    scheduler.stop();
  });
});

describe('first-failure mail', () => {
  it('mails once when a task starts failing, stays quiet on repeats, and says nothing on recovery', async () => {
    const runtime = new ScriptedRuntime(['boom one', 'boom two', null, 'boom three']);
    const { scheduler, failures } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'watch', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    const runAndWait = async (n: number, status: 'ok' | 'failed') => {
      scheduler.runNow(res.task.id);
      await until(async () => runtime.starts.length === n && (await storedStatus()) === status, `run ${n}`);
    };
    await runAndWait(1, 'failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ taskId: res.task.id, title: 'watch', threadId: 'run-1', error: 'boom one' });
    // The failure mail keeps the failed run's thread; nothing else does.
    expect(runtime.deleted).toEqual([]);

    await runAndWait(2, 'failed');
    expect(failures).toHaveLength(1);
    await until(() => runtime.deleted.includes('run-2'), 'the repeat failure\'s thread to be deleted');

    await runAndWait(3, 'ok');
    expect(failures).toHaveLength(1);

    await runAndWait(4, 'failed');
    expect(failures).toHaveLength(2);
    expect(failures[1]).toMatchObject({ threadId: 'run-4', error: 'boom three' });
    scheduler.stop();
  });

  it('a failure before the turn had a thread mails without one', async () => {
    const runtime = new FakeRuntime();
    runtime.startTurn = async () => {
      throw new Error('backend down');
    };
    const { scheduler, failures } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'watch', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await until(async () => (await storedStatus()) === 'failed', 'the failure');
    expect(failures).toHaveLength(1);
    expect(failures[0].threadId).toBeUndefined();
    expect(failures[0].error).toMatch(/backend down/);
    scheduler.stop();
  });
});

// A runtime whose run raises a notify_user alert mid-turn — the task bridge routes
// the tool call to noteNotify with the run's own thread, which is what marks the
// run as having found something.
class NotifyingRuntime extends FakeRuntime {
  scheduler: TaskScheduler | null = null;
  override async startTurn(input: StartTurnInput) {
    this.starts.push(input);
    const n = this.starts.length;
    const turnId = `turn-${n}`;
    const threadId = this.threadOf(n);
    // The bridge fires while the run is under way — after the scheduler learned
    // the thread from startTurn's result, before the turn settles.
    setTimeout(() => {
      this.scheduler?.noteNotify(threadId);
      this.emit('event', { method: 'turn/completed', params: { threadId, turn: { id: turnId } } });
    }, 0);
    return { threadId, turnId };
  }
}

describe('Tasks tab editor', () => {
  it('updatePrompt rewrites the prompt and its derived title, and refuses an empty one', async () => {
    const runtime = new FakeRuntime();
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'old instruction', cron: '0 8 * * *' }, 't1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const long = 'Every morning, search the live web thoroughly for newly released macOS betas and report.';
    const [task] = await scheduler.updatePrompt(res.task.id, `  ${long}  `);
    expect(task.prompt).toBe(long);
    expect(task.title).toBe(`${long.slice(0, 57)}…`);
    expect((await readTasks())[0].prompt).toBe(long);
    await expect(scheduler.updatePrompt(res.task.id, '   ')).rejects.toThrow(/needs a prompt/);
    expect((await readTasks())[0].prompt).toBe(long);
    scheduler.stop();
  });

  it('updateSchedule validates like schedule_task: bad or unreachable cron and past datetimes are refused', async () => {
    const runtime = new FakeRuntime();
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'x', cron: '0 8 * * *' }, 't1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await expect(scheduler.updateSchedule(res.task.id, { kind: 'cron', expr: 'not cron' })).rejects.toThrow(/Invalid cron/);
    await expect(scheduler.updateSchedule(res.task.id, { kind: 'cron', expr: '0 0 30 2 *' })).rejects.toThrow(/no reachable/);
    await expect(scheduler.updateSchedule(res.task.id, { kind: 'once', at: '2001-01-01T00:00:00Z' })).rejects.toThrow(/in the past/);
    // The stored schedule is untouched by a refused edit…
    expect((await readTasks())[0].schedule).toEqual({ kind: 'cron', expr: '0 8 * * *' });
    // …and a valid one (with stray whitespace) lands trimmed with a fresh nextRunAt.
    const [task] = await scheduler.updateSchedule(res.task.id, { kind: 'cron', expr: ' 30 9 * * 1 ' });
    expect(task.schedule).toEqual({ kind: 'cron', expr: '30 9 * * 1' });
    expect(new Date(task.nextRunAt!).getDay()).toBe(1);
    scheduler.stop();
  });

  // The per-task "runs as" choice (Tasks tab): a model pin is carried into every
  // run as an explicit startTurn model/effort; the default sends no model at all,
  // since absence is what leaves the run on the app default.
  it('updateRunsAs pins a model/effort onto runs and clears it back to the default', async () => {
    const runtime = new FakeRuntime();
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'digest', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    const id = res.task.id;

    // Default: the run carries no model/effort keys.
    scheduler.runNow(id);
    await until(() => runtime.starts.length === 1, 'the unpinned run');
    expect('model' in runtime.starts[0]).toBe(false);
    expect('effort' in runtime.starts[0]).toBe(false);

    let list = await scheduler.updateRunsAs(id, { kind: 'model', model: 'openai-codex/gpt-5.6-sol', effort: 'high' });
    expect(list[0].runsAs).toEqual({ kind: 'model', model: 'openai-codex/gpt-5.6-sol', effort: 'high' });
    expect((await readTasks())[0].runsAs).toEqual({ kind: 'model', model: 'openai-codex/gpt-5.6-sol', effort: 'high' });

    scheduler.runNow(id);
    await until(() => runtime.starts.length === 2, 'the pinned run');
    expect(runtime.starts[1]).toMatchObject({ model: 'openai-codex/gpt-5.6-sol', effort: 'high' });
    expect(runtime.starts[1].persona).toBeUndefined();

    list = await scheduler.updateRunsAs(id, { kind: 'default' });
    expect(list[0].runsAs).toEqual({ kind: 'default' });

    scheduler.runNow(id);
    await until(() => runtime.starts.length === 3, 'the cleared run');
    expect('model' in runtime.starts[2]).toBe(false);
    scheduler.stop();
  });

  it('updateRunsAs is one choice: a persona replaces a model pin outright, and vice versa; junk is refused', async () => {
    const runtime = new FakeRuntime();
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'x', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    const id = res.task.id;
    await scheduler.updateRunsAs(id, { kind: 'model', model: 'prov/m', effort: 'low' });
    let [task] = await scheduler.updateRunsAs(id, { kind: 'persona', personaId: 'verifier' });
    expect(task.runsAs).toEqual({ kind: 'persona', personaId: 'verifier' });
    [task] = await scheduler.updateRunsAs(id, { kind: 'model', model: 'prov/other' });
    expect(task.runsAs).toEqual({ kind: 'model', model: 'prov/other' });
    await expect(scheduler.updateRunsAs(id, { kind: 'persona', personaId: 'ghost' })).rejects.toThrow(/No persona/);
    await expect(scheduler.updateRunsAs(id, { kind: 'model', model: '' } as never)).rejects.toThrow(/Choose/);
    await expect(scheduler.updateRunsAs(id, { kind: 'bogus' } as never)).rejects.toThrow(/Choose/);
    expect((await readTasks())[0].runsAs).toEqual({ kind: 'model', model: 'prov/other' });
    scheduler.stop();
  });
});

describe('schedule-as-persona', () => {
  it('validates the persona at creation and threads it into the run', async () => {
    const runtime = new FakeRuntime();
    const { scheduler } = makeScheduler(runtime);
    // A typo'd persona fails the create loudly, not every future run quietly.
    expect((await scheduler.create({ prompt: 'x', cron: '0 8 * * *', personaId: 'ghost' }, 't1')).ok).toBe(false);
    const res = await scheduler.create({ prompt: 'watch it', cron: '0 8 * * *', personaId: 'verifier' }, 't1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.task.runsAs).toEqual({ kind: 'persona', personaId: 'verifier' });
    scheduler.runNow(res.task.id);
    await until(() => runtime.starts.length === 1, 'the persona run');
    // The run executes AS the persona: worker match + spawn prompt come from this.
    expect(runtime.starts[0].persona?.id).toBe('verifier');
    expect(runtime.starts[0].persona?.prompt).toContain('Verifier');
    expect(runtime.starts[0].scheduled?.taskId).toBe(res.task.id);
    scheduler.stop();
  });

  it('a persona run carries the persona’s memory index and recall flag, reflects when it settles ok, and its thread outlives the reflection', async () => {
    const { savePersonaNote } = await import('../../src/server/workspace/persona-memory');
    // Verifier is a built-in that owns a memory; seed one note so the index is non-empty.
    const note = await savePersonaNote('verifier', { title: 'Check the build first', body: 'Always run tsc.' }, 'tool');
    const runtime = new FakeRuntime();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const reflections: { personaId: string; assignment: string; threadId: string }[] = [];
    const { scheduler } = makeScheduler(runtime, {
      reflect: async (args) => {
        reflections.push(args);
        await held;
      }
    });
    const res = await scheduler.create({ prompt: 'verify the nightly', cron: '0 8 * * *', personaId: 'verifier' }, 't1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    scheduler.runNow(res.task.id);
    await until(() => runtime.starts.length === 1, 'the persona run');
    // The same persona block a mail delivery gets: the notes index rides the turn…
    expect(runtime.starts[0].persona?.notes).toEqual([{ id: note.id, title: 'Check the build first' }]);
    // …and the run that settled ok reflects into the persona's memory, reading
    // the run's own thread — which stays until the reflection is done with it.
    await until(() => reflections.length === 1, 'the reflection pass');
    expect(reflections[0]).toEqual({ personaId: 'verifier', assignment: 'verify the nightly', threadId: 'run-1' });
    await until(async () => (await storedStatus()) === 'ok', 'the run to be recorded');
    expect(runtime.deleted).toEqual([]);
    release();
    await until(() => runtime.deleted.length === 1, 'the thread to go after the reflection');
    expect(runtime.deleted).toEqual(['run-1']);
    scheduler.stop();
  });

  it('a persona without memory or recall runs blind: no notes index, recall: false, no reflection', async () => {
    // Critic ships memory: false, recall: false.
    const runtime = new FakeRuntime();
    const { scheduler, reflections } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'grade it', cron: '0 8 * * *', personaId: 'critic' }, 't1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    scheduler.runNow(res.task.id);
    await until(() => runtime.starts.length === 1, 'the critic run');
    expect(runtime.starts[0].persona?.recall).toBe(false);
    expect(runtime.starts[0].persona?.notes).toBeUndefined();
    await until(() => (readTasks().then((ts) => ts[0].lastStatus === 'ok')), 'the run to settle');
    expect(reflections).toHaveLength(0);
    scheduler.stop();
  });

  it('the persona’s model pin rides the run; a vanished persona degrades to the app default', async () => {
    const { savePersona, deletePersona } = await import('../../src/server/workspace/personas');
    await savePersona({ id: 'temp-runner', name: 'Temp runner', prompt: 'You are Temp.', model: 'prov/persona-model' });
    try {
      const runtime = new FakeRuntime();
      const { scheduler } = makeScheduler(runtime);
      const res = await scheduler.create({ prompt: 'go', cron: '0 8 * * *', personaId: 'temp-runner' }, 't1');
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      scheduler.runNow(res.task.id);
      await until(() => runtime.starts.length === 1, 'the persona run');
      expect(runtime.starts[0].model).toBe('prov/persona-model');

      // The persona disappears: the next run is a plain one on the app default
      // rather than skipped — there is no model pin underneath a persona choice.
      await deletePersona('temp-runner');
      scheduler.runNow(res.task.id);
      await until(() => runtime.starts.length === 2, 'the degraded run');
      expect(runtime.starts[1].persona).toBeUndefined();
      expect('model' in runtime.starts[1]).toBe(false);
      scheduler.stop();
    } finally {
      await deletePersona('temp-runner').catch(() => undefined);
    }
  });
});

// A runtime whose turns hang until the test settles them — for preemption tests.
class HangingRuntime extends EventEmitter {
  starts: StartTurnInput[] = [];
  interrupted: string[] = [];
  deleted: string[] = [];
  async startTurn(input: StartTurnInput) {
    this.starts.push(input);
    const n = this.starts.length;
    return { threadId: `run-${n}`, turnId: `turn-${n}` };
  }
  async deleteThread(threadId: string) {
    this.deleted.push(threadId);
  }
  settle(turnId: string, method = 'turn/completed') {
    this.emit('event', { method, params: { threadId: `run-${turnId.slice('turn-'.length)}`, turn: { id: turnId } } });
  }
}

describe('TaskScheduler backend exit handling', () => {
  it('settles an active run immediately when the backend process exits', async () => {
    const runtime = new HangingRuntime();
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'p', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    // The turn hangs, so wait on waitForSettle's listener rather than a status: the
    // process/exit below is only observed once that listener is attached.
    await until(() => runtime.listenerCount('event') > 0, 'the run to await its settle');
    expect(runtime.starts).toHaveLength(1);

    runtime.emit('event', { method: 'process/exit', params: { code: 1, signal: null } });
    await until(async () => (await storedStatus()) === 'failed', 'the run to settle as failed');

    expect(scheduler.snapshot().find((t) => t.id === res.task.id)?.lastStatus).toBe('failed');
    expect((await readTasks())[0].lastStatus).toBe('failed');
    scheduler.stop();
  });

  it("ignores attributed exits of OTHER pool workers, fails on its own thread's", async () => {
    const runtime = new HangingRuntime();
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'p', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await until(() => runtime.listenerCount('event') > 0, 'the run to await its settle');

    // A different worker dies carrying its own thread; an idle extra worker is
    // reaped (attributed, null thread). Neither is this run's death.
    runtime.emit('event', { method: 'process/exit', params: { code: 1, signal: null, threadId: 'other-thread' } });
    runtime.emit('event', { method: 'process/exit', params: { code: 0, signal: null, threadId: null } });
    // The settle listener is still attached: the run was not failed.
    expect(runtime.listenerCount('event')).toBeGreaterThan(0);
    expect(await storedStatus()).not.toBe('failed');

    runtime.emit('event', { method: 'process/exit', params: { code: 1, signal: null, threadId: 'run-1' } });
    await until(async () => (await storedStatus()) === 'failed', 'the run to settle as failed');
    scheduler.stop();
  });

  it('interrupts the backend turn when the run timeout expires', async () => {
    vi.useFakeTimers();
    const runtime = new HangingRuntime();
    const interrupted: string[] = [];
    const scheduler = new TaskScheduler({
      runtime: runtime as never,
      onChange: () => {},
      interrupt: async (turnId) => {
        interrupted.push(turnId);
      }
    });
    const res = await scheduler.create({ prompt: 'p', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await vi.advanceTimersByTimeAsync(5);
    expect(runtime.starts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(15 * 60_000 + 5);

    expect(interrupted).toEqual(['turn-1']);
    expect(scheduler.snapshot().find((t) => t.id === res.task.id)?.lastStatus).toBe('failed');
    scheduler.stop();
  });
});

describe('TaskScheduler defer + preempt', () => {
  it('defers a run while the user is active and starts once idle', async () => {
    vi.useFakeTimers();
    const runtime = new FakeRuntime();
    let active = true;
    const scheduler = new TaskScheduler({
      runtime: runtime as never,
      onChange: () => {},
      isUserActive: () => active,
      interrupt: async () => {}
    });
    const res = await scheduler.create({ prompt: 'p', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);

    await vi.advanceTimersByTimeAsync(5);
    expect(runtime.starts).toHaveLength(0); // deferred, not started

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.starts).toHaveLength(0); // still active, still deferred

    active = false;
    await vi.advanceTimersByTimeAsync(16_000); // next idle poll notices
    expect(runtime.starts).toHaveLength(1);
    scheduler.stop();
  });

  it('preempts an in-flight run for the user, drops its thread, and re-queues it after idle in a fresh one', async () => {
    vi.useFakeTimers();
    const runtime = new HangingRuntime();
    let active = false;
    const scheduler = new TaskScheduler({
      runtime: runtime as never,
      onChange: () => {},
      isUserActive: () => active,
      // Preemption aborts via the backend; the fake settles the turn as aborted.
      interrupt: async (turnId) => {
        runtime.interrupted.push(turnId);
        runtime.settle(turnId, 'turn/aborted');
      }
    });
    const res = await scheduler.create({ prompt: 'p', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await vi.advanceTimersByTimeAsync(5);
    expect(runtime.starts).toHaveLength(1); // run started (user idle)

    // The user sends a message: the scheduled turn is aborted, not failed.
    active = true;
    scheduler.preemptForUser();
    await vi.advanceTimersByTimeAsync(5);
    expect(runtime.interrupted).toEqual(['turn-1']);
    const afterPreempt = scheduler.snapshot().find((t) => t.id === res.task.id)!;
    expect(afterPreempt.lastStatus).not.toBe('failed');
    expect(afterPreempt.lastStatus).not.toBe('running');
    // The yielded attempt produced nothing; its thread goes.
    expect(runtime.deleted).toEqual(['run-1']);

    // Once the user goes idle, the re-queued run fires again — in a thread of its own — and completes.
    active = false;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(runtime.starts).toHaveLength(2);
    runtime.settle('turn-2');
    await vi.advanceTimersByTimeAsync(5);
    expect(scheduler.snapshot().find((t) => t.id === res.task.id)!.lastStatus).toBe('ok');
    expect(runtime.deleted).toEqual(['run-1', 'run-2']);
    scheduler.stop();
  });

  it('catch-up runs defer while the user is active', async () => {
    vi.useFakeTimers();
    const past = new Date(Date.now() - 60_000).toISOString();
    await saveTasks([seed({ id: 'c', prompt: 'overdue', createdAt: past, nextRunAt: past })]);
    const runtime = new FakeRuntime();
    let active = true;
    const scheduler = new TaskScheduler({
      runtime: runtime as never,
      onChange: () => {},
      isUserActive: () => active,
      interrupt: async () => {}
    });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(5);
    expect(runtime.starts).toHaveLength(0); // catch-up waits for idle

    active = false;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(runtime.starts).toHaveLength(1);
    scheduler.stop();
  });
});
