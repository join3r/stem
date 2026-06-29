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
import { TaskScheduler } from '../../src/main/scheduler';
import { readTasks, saveTasks } from '../../src/main/workspace/tasks';

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
}

function makeScheduler(runtime: EventEmitter) {
  const changes: ScheduledTask[][] = [];
  const runs: unknown[] = [];
  const scheduler = new TaskScheduler({
    runtime: runtime as never,
    onChange: (tasks) => changes.push(tasks),
    onRun: (run) => runs.push(run)
  });
  return { scheduler, changes, runs };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

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
    await flush();

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
    // The once-task was claimed (nextRunAt nulled) at dispatch, so nothing re-arms it.
    expect(scheduler.snapshot()[0].nextRunAt).toBeNull();
    expect(scheduler.snapshot()[0].lastRunAt).toBeTruthy();
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
    await flush();
    expect(runtime.starts).toHaveLength(1);
    const after = await readTasks();
    expect(after[0].lastStatus).toBe('ok');
    scheduler.stop();
  });

  it('disables a task whose thread no longer exists instead of running it', async () => {
    const runtime = new FakeRuntime();
    runtime.threadIds.clear(); // t1 is gone
    const { scheduler } = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'orphan', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await flush();
    expect(runtime.starts).toHaveLength(0);
    const after = await readTasks();
    expect(after[0].enabled).toBe(false);
    expect(after[0].lastStatus).toBe('failed');
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
