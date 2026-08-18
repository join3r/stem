// The scheduler's run lifecycle, enumerated as the matrix it actually is.
//
// A firing moves through queued → deferred (user active) → building (startTurn
// in flight) → running → settling, and at every one of those states the user can
// pause the task, delete it, delete its chat, or start typing (preempt). Each
// existing test exercised one state × one action; the bugs live where the
// combinations meet — the same shape as the approval bug (see
// exec-approval-matrix.test.ts).

import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Point the tasks store at a throwaway file before importing modules that read
// the path — same isolation as scheduler.test.ts, different file.
const STORE = join(tmpdir(), `stem-tasks-matrix-${process.pid}.json`);
process.env.STEM_TASKS_STORE = STORE;

import type { StartTurnInput } from '../../src/shared/types';
import { TaskScheduler } from '../../src/server/scheduler';

const OVERFLOW_ERROR =
  'Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.';

/**
 * A runtime whose turns hang until the test settles them, and whose startTurn
 * can itself be held open — the "building" state is a real window (prompt
 * assembly, session activation) and preemption during it is its own cell.
 */
class MatrixRuntime extends EventEmitter {
  starts: StartTurnInput[] = [];
  interrupted: string[] = [];
  compacts: string[] = [];
  threadIds = new Set<string>(['t1']);
  /** When set, startTurn parks until the test calls releaseBuild(). */
  holdBuild = false;
  private buildWaiters: Array<() => void> = [];

  async startTurn(input: StartTurnInput) {
    this.starts.push(input);
    const turnId = `turn-${this.starts.length}`;
    if (this.holdBuild) await new Promise<void>((r) => this.buildWaiters.push(r));
    return { threadId: input.threadId, turnId };
  }

  releaseBuild(): void {
    const waiters = this.buildWaiters.splice(0);
    for (const w of waiters) w();
  }

  settle(turnId: string, method = 'turn/completed', error?: string) {
    this.emit('event', {
      method,
      params: { threadId: 't1', turn: { id: turnId }, ...(error ? { error } : {}) }
    });
  }

  async listThreads() {
    return [...this.threadIds].map((threadId) => ({
      threadId,
      title: '',
      folderId: null,
      createdAt: 0,
      updatedAt: 0
    }));
  }

  async compactThread(threadId: string) {
    this.compacts.push(threadId);
  }
}

function makeScheduler(
  runtime: MatrixRuntime,
  opts: { isUserActive?: () => boolean } = {}
): TaskScheduler {
  return new TaskScheduler({
    runtime: runtime as never,
    onChange: () => {},
    onRun: () => {},
    isUserActive: opts.isUserActive,
    interrupt: async (turnId) => {
      runtime.interrupted.push(turnId);
      runtime.settle(turnId, 'turn/aborted');
    }
  });
}

beforeEach(() => {
  // setImmediate stays REAL: the tasks store writes through real file IO, and a
  // fully faked loop starves those promises — the queue then wedges behind a
  // write that can never land, which is a harness artifact, not the scheduler.
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
  rmSync(STORE, { force: true });
});

/** Let real file IO land between fake-clock steps (see the toFake note above). */
async function drainIo(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

afterEach(() => {
  vi.useRealTimers();
  rmSync(STORE, { force: true });
});

describe('deferred × user action', () => {
  // The guard exists in runTask ("paused/deleted while deferred"); nothing
  // exercised it. A run waiting out the user's activity is a run the user can
  // still see in the Tasks tab — and can still pause or delete while it waits.

  it('a task paused while its run waits for idle never starts', async () => {
    const runtime = new MatrixRuntime();
    let active = true;
    const scheduler = makeScheduler(runtime, { isUserActive: () => active });
    const res = await scheduler.create({ prompt: 'p', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await vi.advanceTimersByTimeAsync(5);
    expect(runtime.starts).toHaveLength(0); // deferred

    await scheduler.setEnabled(res.task.id, false);
    active = false;
    await vi.advanceTimersByTimeAsync(60_000); // several idle polls later…
    expect(runtime.starts).toHaveLength(0); // …it stayed paused
    // And nothing recorded a run that never happened.
    expect(scheduler.snapshot()[0].lastRunAt).toBeUndefined();
    scheduler.stop();
  });

  it('a task deleted while its run waits for idle never starts', async () => {
    const runtime = new MatrixRuntime();
    let active = true;
    const scheduler = makeScheduler(runtime, { isUserActive: () => active });
    const res = await scheduler.create({ prompt: 'p', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await vi.advanceTimersByTimeAsync(5);

    await scheduler.remove(res.task.id);
    active = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.starts).toHaveLength(0);
    scheduler.stop();
  });

  it('run-now on an already-paused task does not fire it', async () => {
    // Defense in depth today: the enabled guard in runTask catches this path
    // too. If "run a paused task by hand" ever becomes a feature, this is the
    // test that makes that an explicit decision instead of a side effect.
    const runtime = new MatrixRuntime();
    const scheduler = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'p', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    await scheduler.setEnabled(res.task.id, false);
    scheduler.runNow(res.task.id);
    await vi.advanceTimersByTimeAsync(50);
    expect(runtime.starts).toHaveLength(0);
    scheduler.stop();
  });
});

describe('building × preempt', () => {
  // preemptForUser can land while startTurn is still assembling the prompt —
  // run.turnId is null, so there is nothing to interrupt YET. The flag must be
  // honored the moment the turn id exists, or the user's message queues behind
  // a full agent turn that was supposed to yield.

  it('a preempt during prompt assembly interrupts the turn as soon as it has an id', async () => {
    const runtime = new MatrixRuntime();
    runtime.holdBuild = true;
    const scheduler = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'p', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await vi.advanceTimersByTimeAsync(5);
    expect(runtime.starts).toHaveLength(1); // building: startTurn entered, parked

    scheduler.preemptForUser(); // nothing to interrupt yet
    expect(runtime.interrupted).toEqual([]);

    runtime.releaseBuild(); // the turn id arrives
    await vi.advanceTimersByTimeAsync(5);
    expect(runtime.interrupted).toEqual(['turn-1']); // …and is aborted at once

    // A preempted run is a yield, not a failure.
    expect(scheduler.snapshot()[0].lastStatus).not.toBe('failed');
    scheduler.stop();
  });

  it('a run preempted past its retry budget records why it gave up', async () => {
    const runtime = new MatrixRuntime();
    const scheduler = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'p', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);

    // Preempt the firing and each of its MAX_REQUEUES retries (3).
    for (let i = 1; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(5);
      expect(runtime.starts).toHaveLength(i);
      scheduler.preemptForUser();
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(50);

    // Out of retries: no fifth start, and the row says what happened in words —
    // yielding to the user is not silence and not a mystery "failed".
    expect(runtime.starts).toHaveLength(4);
    const task = scheduler.snapshot()[0];
    expect(task.lastStatus).toBe('failed');
    expect(task.lastError).toMatch(/Yielded to you 3 times/);
    // The schedule is intact: it goes again at its next slot.
    expect(task.enabled).toBe(true);
    scheduler.stop();
  });
});

describe('running × failure source', () => {
  it('a backend that dies during the overflow retry fails the run without a third attempt', async () => {
    const runtime = new MatrixRuntime();
    const scheduler = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'p', cron: '0 8 * * *' }, 't1');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await vi.advanceTimersByTimeAsync(5);
    expect(runtime.starts).toHaveLength(1);

    // First attempt dies on overflow → condense → one retry.
    runtime.settle('turn-1', 'turn/failed', OVERFLOW_ERROR);
    await vi.advanceTimersByTimeAsync(5);
    expect(runtime.compacts).toEqual(['t1']);
    expect(runtime.starts).toHaveLength(2);

    // The retry never settles — the whole backend goes down instead.
    runtime.emit('event', { method: 'process/exit', params: { code: 1, signal: null } });
    await vi.advanceTimersByTimeAsync(50);

    expect(runtime.starts).toHaveLength(2); // the self-heal does not loop
    expect(scheduler.snapshot()[0].lastStatus).toBe('failed');
    scheduler.stop();
  });

  it('a task whose chat is gone is paused with the reason on its row', async () => {
    const runtime = new MatrixRuntime();
    runtime.threadIds.clear();
    const scheduler = makeScheduler(runtime);
    const res = await scheduler.create({ prompt: 'p', cron: '0 8 * * *' }, 't-gone');
    if (!res.ok) throw new Error('create failed');
    scheduler.runNow(res.task.id);
    await vi.advanceTimersByTimeAsync(50);

    const task = scheduler.snapshot()[0];
    expect(runtime.starts).toHaveLength(0);
    expect(task.enabled).toBe(false);
    expect(task.lastStatus).toBe('failed');
    // "failed" with nothing beside it is the shape the quiet-failure sweep was
    // about; this row must say WHY it will never fire again.
    expect(task.lastError).toMatch(/no longer exists/);
    scheduler.stop();
  });
});

describe('once-task × manual run', () => {
  it('running a pending once-task by hand does not consume its scheduled slot', async () => {
    const runtime = new MatrixRuntime();
    const scheduler = makeScheduler(runtime);
    const at = new Date(Date.now() + 60 * 60_000).toISOString();
    const res = await scheduler.create({ prompt: 'p', at }, 't1');
    if (!res.ok) throw new Error('create failed');

    scheduler.runNow(res.task.id);
    await drainIo();
    expect(runtime.starts).toHaveLength(1);
    runtime.settle('turn-1');
    await drainIo();

    // Still on the books, still aimed at its hour: the manual run was an extra,
    // not the firing.
    const task = scheduler.snapshot()[0];
    expect(task).toBeDefined();
    expect(task.nextRunAt).toBe(new Date(at).toISOString());

    // And when the real slot arrives, it fires once and retires.
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);
    await drainIo();
    expect(runtime.starts).toHaveLength(2);
    runtime.settle('turn-2');
    await drainIo();
    expect(scheduler.snapshot()).toHaveLength(0);
    scheduler.stop();
  });
});
