import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Point the tasks store at a throwaway file before importing modules that read the
// path. setup-unit.ts already isolates the other stores; tasks gets its own here.
const STORE = join(tmpdir(), `stem-tasks-${process.pid}.json`);
process.env.STEM_TASKS_STORE = STORE;

import type { ScheduledTask, StartTurnInput } from '../../src/shared/types';
import { isContextOverflowError, TaskScheduler } from '../../src/server/scheduler';
import { readTasks, saveTasks } from '../../src/server/workspace/tasks';

// A minimal ChatBackend stand-in: records startTurn calls, emits the turn/completed
// event the scheduler waits on, and reports one existing thread.
class FakeRuntime extends EventEmitter {
  starts: StartTurnInput[] = [];
  threadIds = new Set<string>(['t1']);
  async startTurn(input: StartTurnInput) {
    this.starts.push(input);
    const turnId = `turn-${this.starts.length}`;
    // Settle on the next tick so waitForSettle's listener is attached first.
    setTimeout(() => this.emit('event', { method: 'turn/completed', params: { threadId: input.threadId, turn: { id: turnId } } }), 0);
    return { threadId: input.threadId, turnId };
  }
  async listThreads() {
    return [...this.threadIds].map((threadId) => ({ threadId, title: '', folderId: null, createdAt: 0, updatedAt: 0 }));
  }
  compacts: string[] = [];
  async compactThread(threadId: string) {
    this.compacts.push(threadId);
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
    const turnId = `turn-${this.starts.length}`;
    const error = this.outcomes[this.starts.length - 1] ?? null;
    setTimeout(() => {
      if (error) {
        this.emit('event', {
          method: 'turn/failed',
          params: { threadId: input.threadId, turn: { id: turnId }, error }
        });
      } else {
        this.emit('event', { method: 'turn/completed', params: { threadId: input.threadId, turn: { id: turnId } } });
      }
    }, 0);
    return { threadId: input.threadId, turnId };
  }
}

const OVERFLOW_ERROR = 'Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.';

function makeScheduler(runtime: EventEmitter) {
  const changes: ScheduledTask[][] = [];
  const runs: unknown[] = [];
  const silent: { threadId: string; before: number; at: number }[] = [];
  const scheduler = new TaskScheduler({
    runtime: runtime as never,
    onChange: (tasks) => changes.push(tasks),
    onRun: (run) => runs.push(run),
    onSilentRun: (threadId, before, at) => silent.push({ threadId, before, at })
  });
  return { scheduler, changes, runs, silent };
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

beforeEach(() => rmSync(STORE, { force: true }));
afterEach(() => {
  vi.useRealTimers();
  rmSync(STORE, { force: true });
});

describe('TaskScheduler.create', () => {
  it('creates a cron task with a future next-run', async () => {
    const runtime = new FakeRuntime();
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'do it', cron: '0 8 * * *' }, 't1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.task.schedule).toEqual({ kind: 'cron', expr: '0 8 * * *' });
    expect(res.task.nextRunAt).toBeTruthy();
    expect(new Date(res.task.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
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
});

describe('TaskScheduler catch-up', () => {
  it('runs an overdue task exactly once on start', async () => {
    // Seed a task whose persisted nextRunAt is in the past (missed during downtime).
    const past = new Date(Date.now() - 60_000).toISOString();
    await saveTasks([
      {
        id: 'a',
        threadId: 't1',
        prompt: 'catch me up',
        schedule: { kind: 'cron', expr: '0 8 * * *' },
        enabled: true,
        createdAt: past,
        nextRunAt: past,
        title: 'catch me up'
      }
    ]);

    const runtime = new FakeRuntime();
    const { scheduler, runs } = makeScheduler(runtime);
    await scheduler.start();
    await until(async () => (await storedStatus()) === 'ok', 'the catch-up run to be recorded');

    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0].threadId).toBe('t1');
    expect(runtime.starts[0].scheduled).toBeTruthy();
    expect(runs).toHaveLength(1);

    // After the catch-up run, nextRunAt is recomputed into the future (no re-run).
    const after = await readTasks();
    expect(after[0].lastStatus).toBe('ok');
    expect(after[0].lastRunAt).toBeTruthy();
    expect(new Date(after[0].nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    scheduler.stop();
  });

  it('does not catch up a task whose next-run is still in the future', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    await saveTasks([
      {
        id: 'b',
        threadId: 't1',
        prompt: 'later',
        schedule: { kind: 'cron', expr: '0 8 * * *' },
        enabled: true,
        createdAt: future,
        nextRunAt: future,
        title: 'later'
      }
    ]);
    const runtime = new FakeRuntime();
    const { scheduler } = makeScheduler(runtime);
    await scheduler.start();
    await flush();
    expect(runtime.starts).toHaveLength(0);
    scheduler.stop();
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
          () => this.emit('event', { method: 'turn/completed', params: { threadId: input.threadId, turn: { id: turnId } } }),
          600
        );
        return { threadId: input.threadId, turnId };
      }
      async listThreads() {
        return [{ threadId: 't1', title: '', folderId: null, createdAt: 0, updatedAt: 0 }];
      }
    }

    // A one-time task armed ~1.2s out: comfortably past the catch-up slop (so start()
    // arms the live timer instead of running it immediately), but soon enough to keep
    // the test short. A once-task also dodges cron's minute-boundary variability.
    const at = new Date(Date.now() + 1200).toISOString();
    await saveTasks([
      {
        id: 'flood',
        threadId: 't1',
        prompt: 'ping',
        schedule: { kind: 'once', at },
        enabled: true,
        createdAt: new Date().toISOString(),
        nextRunAt: at,
        title: 'ping'
      }
    ]);

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

  // A run that dies before its turn ever starts — the chat cannot be opened, the
  // backend will not spawn — used to leave "failed" in the Tasks tab and not one
  // word anywhere else, because the throw was caught and dropped. That is how a
  // migrated server ran every scheduled task into the ground for days unnoticed.
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
    scheduler.stop();
  });

  it('disables a task whose thread no longer exists instead of running it', async () => {
    const runtime = new FakeRuntime();
    runtime.threadIds.clear(); // t1 is gone
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'orphan', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await until(async () => (await storedStatus()) === 'failed', 'the orphaned task to be disabled');
    expect(runtime.starts).toHaveLength(0);
    const after = await readTasks();
    expect(after[0].enabled).toBe(false);
    expect(after[0].lastStatus).toBe('failed');
    scheduler.stop();
  });

  // The per-task model pin (Tasks tab): persisted on the task, carried into every
  // run as an explicit startTurn model/effort, and cleared back to "the chat's
  // model" with nulls — an unpinned task must keep sending no model at all, since
  // absence is what makes the runtime fall back to the thread's own.
  it('pins a model/effort onto runs and clears it back to the thread default', async () => {
    const runtime = new FakeRuntime();
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'digest', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    const id = res.task.id;

    // Unpinned: the run carries no model/effort keys.
    scheduler.runNow(id);
    await until(() => runtime.starts.length === 1, 'the unpinned run');
    expect('model' in runtime.starts[0]).toBe(false);
    expect('effort' in runtime.starts[0]).toBe(false);

    let list = await scheduler.updateModel(id, 'openai-codex/gpt-5.6-sol', 'high');
    expect(list[0]).toMatchObject({ model: 'openai-codex/gpt-5.6-sol', effort: 'high' });
    expect((await readTasks())[0]).toMatchObject({ model: 'openai-codex/gpt-5.6-sol', effort: 'high' });

    scheduler.runNow(id);
    await until(() => runtime.starts.length === 2, 'the pinned run');
    expect(runtime.starts[1]).toMatchObject({ model: 'openai-codex/gpt-5.6-sol', effort: 'high' });

    list = await scheduler.updateModel(id, null, null);
    expect(list[0].model).toBeUndefined();
    expect(list[0].effort).toBeUndefined();
    expect((await readTasks())[0].model).toBeUndefined();

    scheduler.runNow(id);
    await until(() => runtime.starts.length === 3, 'the cleared run');
    expect('model' in runtime.starts[2]).toBe(false);
    scheduler.stop();
  });

  it('pause/resume and delete update the store', async () => {
    const runtime = new FakeRuntime();
    const { scheduler } = makeScheduler(runtime);
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
    scheduler.stop();
  });
});

// A runtime whose run raises a notify_user alert mid-turn — the task bridge routes
// the tool call to noteNotify, which is what marks the run as having found something.
class NotifyingRuntime extends FakeRuntime {
  scheduler: TaskScheduler | null = null;
  override async startTurn(input: StartTurnInput) {
    const started = await super.startTurn(input);
    if (input.threadId) this.scheduler?.noteNotify(input.threadId);
    return started;
  }
}

describe('silent runs', () => {
  // A scheduled run appends a turn whether or not it found anything, and that turn
  // bumps the thread's mtime — the Inbox's only notion of "something happened".
  // notify_user is the line between the two, so the scheduler reports every run
  // that didn't call it and the host absorbs the bump (see workspace/inbox).
  it('reports a run that never called notify_user', async () => {
    const runtime = new FakeRuntime();
    const { scheduler, silent } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'watch', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await until(async () => (await storedStatus()) === 'ok', 'the run to be recorded');
    expect(silent).toHaveLength(1);
    expect(silent[0].threadId).toBe('t1');
    // The stamp has to cover the turn's own writes, so it sits at/past the run's end.
    expect(silent[0].at).toBeGreaterThanOrEqual(silent[0].before);
    scheduler.stop();
  });

  it('stays quiet about a run that raised an alert', async () => {
    const runtime = new NotifyingRuntime();
    const { scheduler, silent } = makeScheduler(runtime);
    runtime.scheduler = scheduler;
    const res = await scheduler.create({ prompt: 'watch', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await until(async () => (await storedStatus()) === 'ok', 'the run to be recorded');
    expect(silent).toEqual([]);
    scheduler.stop();
  });

  it('ignores a notify_user that came from some other thread', async () => {
    const runtime = new FakeRuntime();
    const { scheduler, silent } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'watch', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.noteNotify('someone-else');
    scheduler.runNow(res.task.id);
    await until(async () => (await storedStatus()) === 'ok', 'the run to be recorded');
    expect(silent).toHaveLength(1);
    scheduler.stop();
  });
});

// A runtime whose turns hang until the test settles them — for preemption tests.
class HangingRuntime extends EventEmitter {
  starts: StartTurnInput[] = [];
  interrupted: string[] = [];
  async startTurn(input: StartTurnInput) {
    this.starts.push(input);
    return { threadId: input.threadId, turnId: `turn-${this.starts.length}` };
  }
  async listThreads() {
    return [{ threadId: 't1', title: '', folderId: null, createdAt: 0, updatedAt: 0 }];
  }
  settle(turnId: string, method = 'turn/completed') {
    this.emit('event', { method, params: { threadId: 't1', turn: { id: turnId } } });
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

  it('interrupts the backend turn when the run timeout expires', async () => {
    vi.useFakeTimers();
    const runtime = new HangingRuntime();
    const interrupted: string[] = [];
    const scheduler = new TaskScheduler({
      runtime: runtime as never,
      onChange: () => {},
      onRun: () => {},
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
      onRun: () => {},
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

  it('preempts an in-flight run for the user and re-queues it after idle', async () => {
    vi.useFakeTimers();
    const runtime = new HangingRuntime();
    let active = false;
    const scheduler = new TaskScheduler({
      runtime: runtime as never,
      onChange: () => {},
      onRun: () => {},
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

    // Once the user goes idle, the re-queued run fires again and completes.
    active = false;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(runtime.starts).toHaveLength(2);
    runtime.settle('turn-2');
    await vi.advanceTimersByTimeAsync(5);
    expect(scheduler.snapshot().find((t) => t.id === res.task.id)!.lastStatus).toBe('ok');
    scheduler.stop();
  });

  it('catch-up runs defer while the user is active', async () => {
    vi.useFakeTimers();
    const past = new Date(Date.now() - 60_000).toISOString();
    await saveTasks([
      {
        id: 'c',
        threadId: 't1',
        prompt: 'overdue',
        schedule: { kind: 'cron', expr: '0 8 * * *' },
        enabled: true,
        createdAt: past,
        nextRunAt: past,
        title: 'overdue'
      }
    ]);
    const runtime = new FakeRuntime();
    let active = true;
    const scheduler = new TaskScheduler({
      runtime: runtime as never,
      onChange: () => {},
      onRun: () => {},
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

describe('overflow self-heal', () => {
  it('condenses the thread and retries once when a run dies on a context overflow', async () => {
    const runtime = new ScriptedRuntime([OVERFLOW_ERROR, null]);
    const { scheduler, runs } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'morning news', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await until(async () => (await storedStatus()) === 'ok', 'the retried run to succeed');

    expect(runtime.compacts).toEqual(['t1']);
    expect(runtime.starts).toHaveLength(2);
    // Both attempts announce themselves so an open thread shows the run rows.
    expect(runs).toHaveLength(2);
    expect((await readTasks())[0].lastStatus).toBe('ok');
    scheduler.stop();
  });

  it('does not retry a non-overflow failure', async () => {
    const runtime = new ScriptedRuntime(['pi exploded', null]);
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'x', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await until(async () => (await storedStatus()) === 'failed', 'the failure to be recorded');

    expect(runtime.compacts).toEqual([]);
    expect(runtime.starts).toHaveLength(1);
    expect((await readTasks())[0].lastStatus).toBe('failed');
    scheduler.stop();
  });

  it('retries at most once per firing even when the retry overflows again', async () => {
    const runtime = new ScriptedRuntime([OVERFLOW_ERROR, OVERFLOW_ERROR, null]);
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'x', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await until(async () => (await storedStatus()) === 'failed', 'the second overflow to be recorded');

    expect(runtime.compacts).toEqual(['t1']);
    expect(runtime.starts).toHaveLength(2);
    expect((await readTasks())[0].lastStatus).toBe('failed');
    scheduler.stop();
  });

  it('records a failure when the condense itself fails, without retrying', async () => {
    const runtime = new ScriptedRuntime([OVERFLOW_ERROR, null]);
    runtime.compactThread = async () => {
      throw new Error('nothing to compact');
    };
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'x', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await until(async () => (await storedStatus()) === 'failed', 'the failed condense to be recorded');

    expect(runtime.starts).toHaveLength(1);
    expect((await readTasks())[0].lastStatus).toBe('failed');
    scheduler.stop();
  });
});

describe('isContextOverflowError', () => {
  it('recognizes provider overflow shapes and rejects lookalikes', () => {
    expect(isContextOverflowError(OVERFLOW_ERROR)).toBe(true);
    expect(isContextOverflowError('prompt is too long: 213462 tokens > 200000 maximum')).toBe(true);
    expect(isContextOverflowError("Requested token count exceeds the model's maximum context length of 131072 tokens")).toBe(true);
    expect(isContextOverflowError('tokens to keep from the initial prompt is greater than the context length')).toBe(true);
    expect(isContextOverflowError('the request exceeds the available context size, try increasing it')).toBe(true);
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError('pi exploded')).toBe(false);
    expect(isContextOverflowError('Rate limit reached, token limit exceeded for this minute')).toBe(false);
  });
});
