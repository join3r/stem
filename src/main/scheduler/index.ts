import { randomUUID } from 'node:crypto';
import type { ChatBackend } from '../backend/types';
import type {
  BackendEventEnvelope,
  ScheduledRunPayload,
  ScheduledTask,
  ScheduleTaskRequest,
  TaskSchedule
} from '../../shared/types';
import { isValidCron, nextAfter } from './cron';
import { readTasks, saveTasks, titleFromPrompt } from '../workspace/tasks';

// The main-process scheduler. Holds tasks in memory, keeps ONE timer armed for the
// earliest due task, and runs each firing as a full autonomous agent turn appended
// to the task's originating chat (exactly like a user turn, via runtime.startTurn).
// Modeled on the existing background passes in whenReady (scheduleDistill / runCurate):
// a single timer + a re-entrancy guard, gated by nothing but the enabled flag.

export interface SchedulerOptions {
  runtime: ChatBackend;
  /** Pushed whenever the task list changes (created/updated/run/deleted). */
  onChange: (tasks: ScheduledTask[]) => void;
  /** Pushed when a run starts, so the open thread can show a collapsed run row. */
  onRun: (run: ScheduledRunPayload) => void;
}

// Timer cap: setTimeout is unreliable over very long delays and across system
// sleep/clock changes, so we never sleep longer than this — we just re-arm and
// re-check. Comfortably finer than any realistic schedule gap.
const MAX_TIMER_MS = 6 * 60 * 60 * 1000; // 6h
// A run that never settles must not wedge the scheduler forever.
const RUN_TIMEOUT_MS = 15 * 60 * 1000; // 15m
// Treat a task as due if its time has arrived within this slop (timers can fire a
// hair early; cron is minute-resolution so this is harmless).
const DUE_SLOP_MS = 1000;

export class TaskScheduler {
  private tasks: ScheduledTask[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Serializes runs (and bookkeeping writes) so two firings never overlap. */
  private queue: Promise<unknown> = Promise.resolve();
  private started = false;

  constructor(private readonly opts: SchedulerOptions) {}

  /** Load persisted tasks, run any overdue ones once (catch-up), then arm the timer. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.tasks = await readTasks();

    const now = new Date();
    const overdue: ScheduledTask[] = [];
    for (const task of this.tasks) {
      // A task is "missed" if the next-run time persisted before shutdown has
      // already passed. Detect that BEFORE recomputing, then run it once.
      const due = task.enabled && task.nextRunAt && new Date(task.nextRunAt).getTime() <= now.getTime() + DUE_SLOP_MS;
      if (due) overdue.push(task);
      else task.nextRunAt = this.computeNextRunAt(task, now);
    }
    // Claim each overdue task's NEXT run BEFORE enqueuing it, so the run that is
    // about to fire is no longer itself detected as due (see advanceSchedule).
    for (const task of overdue) this.advanceSchedule(task);
    await saveTasks(this.tasks);
    this.opts.onChange(this.snapshot());

    // Catch-up: run each overdue task exactly once, sequentially, then resume.
    for (const task of overdue) this.enqueueRun(task.id, 'catchup');
    this.arm();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ---- public surface (IPC handlers + the TaskBridge build on these) ----

  snapshot(): ScheduledTask[] {
    return this.tasks.map((t) => ({ ...t }));
  }

  listForThread(threadId: string): ScheduledTask[] {
    return this.tasks.filter((t) => t.threadId === threadId).map((t) => ({ ...t }));
  }

  /** Create a task bound to a chat (the assistant's schedule_task tool). */
  async create(
    req: ScheduleTaskRequest,
    threadId: string
  ): Promise<{ ok: true; task: ScheduledTask } | { ok: false; error: string }> {
    const schedule = this.buildSchedule(req);
    if (!schedule.ok) return { ok: false, error: schedule.error };
    const prompt = (req.prompt ?? '').trim();
    if (!prompt) return { ok: false, error: 'A task needs a prompt to run.' };

    const now = new Date();
    const task: ScheduledTask = {
      id: randomUUID(),
      threadId,
      prompt,
      schedule: schedule.value,
      enabled: true,
      createdAt: now.toISOString(),
      title: titleFromPrompt(prompt),
      nextRunAt: null
    };
    task.nextRunAt = this.computeNextRunAt(task, now);
    this.tasks.push(task);
    await this.persistAndArm();
    return { ok: true, task: { ...task } };
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduledTask[]> {
    const task = this.tasks.find((t) => t.id === id);
    if (task) {
      task.enabled = enabled;
      task.nextRunAt = this.computeNextRunAt(task, new Date());
      await this.persistAndArm();
    }
    return this.snapshot();
  }

  async updateSchedule(id: string, schedule: TaskSchedule): Promise<ScheduledTask[]> {
    const task = this.tasks.find((t) => t.id === id);
    if (task) {
      task.schedule = schedule;
      // A re-scheduled once-task can fire again, so clear the "already ran" marker
      // that suppresses its next-run computation.
      if (schedule.kind === 'once') task.lastRunAt = undefined;
      task.nextRunAt = this.computeNextRunAt(task, new Date());
      await this.persistAndArm();
    }
    return this.snapshot();
  }

  async remove(id: string): Promise<ScheduledTask[]> {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    await this.persistAndArm();
    return this.snapshot();
  }

  /** Remove every task bound to a chat (called when the chat is deleted). */
  async removeForThread(threadId: string): Promise<void> {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.threadId !== threadId);
    if (this.tasks.length !== before) await this.persistAndArm();
  }

  /** Run a task immediately, off-schedule. Returns once it has been queued. */
  runNow(id: string): ScheduledTask[] {
    if (this.tasks.some((t) => t.id === id)) this.enqueueRun(id, 'manual');
    return this.snapshot();
  }

  // ---- scheduling internals ----

  private buildSchedule(req: ScheduleTaskRequest): { ok: true; value: TaskSchedule } | { ok: false; error: string } {
    const hasCron = typeof req.cron === 'string' && req.cron.trim();
    const hasAt = typeof req.at === 'string' && req.at.trim();
    if (hasCron && hasAt) return { ok: false, error: 'Provide either a cron expression or a one-time datetime, not both.' };
    if (!hasCron && !hasAt) return { ok: false, error: 'Provide a cron expression (recurring) or an ISO datetime (one-time).' };
    if (hasCron) {
      if (!isValidCron(req.cron!.trim())) {
        return { ok: false, error: `Invalid cron expression "${req.cron}". Use 5 fields: minute hour day-of-month month day-of-week.` };
      }
      return { ok: true, value: { kind: 'cron', expr: req.cron!.trim() } };
    }
    const at = new Date(req.at!.trim());
    if (Number.isNaN(at.getTime())) return { ok: false, error: `Invalid datetime "${req.at}". Use an ISO 8601 timestamp.` };
    // A one-time task in the past would fire the instant it is created — almost
    // always a timezone/clock mistake in the caller. Reject it so the mistake
    // surfaces rather than firing immediately. (Catch-up of a *persisted* missed
    // run is handled separately in start(); this guards new tasks only.)
    if (at.getTime() <= Date.now() + DUE_SLOP_MS) {
      return { ok: false, error: `One-time datetime "${req.at}" is in the past. Provide a future ISO 8601 datetime in local time (e.g. with no "Z"/offset, or the correct offset).` };
    }
    return { ok: true, value: { kind: 'once', at: at.toISOString() } };
  }

  private computeNextRunAt(task: ScheduledTask, from: Date): string | null {
    if (!task.enabled) return null;
    if (task.schedule.kind === 'once') {
      // A once-task fires a single time; once it has run, it never recomputes.
      if (task.lastRunAt) return null;
      return task.schedule.at;
    }
    const next = nextAfter(task.schedule.expr, from);
    return next ? next.toISOString() : null;
  }

  private earliestDueAt(): number | null {
    let earliest: number | null = null;
    for (const task of this.tasks) {
      if (!task.enabled || !task.nextRunAt) continue;
      const t = new Date(task.nextRunAt).getTime();
      if (earliest === null || t < earliest) earliest = t;
    }
    return earliest;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const earliest = this.earliestDueAt();
    if (earliest === null) return;
    const delay = Math.min(Math.max(earliest - Date.now(), 0) + 250, MAX_TIMER_MS);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private tick(): void {
    const now = Date.now();
    const due = this.tasks.filter(
      (t) => t.enabled && t.nextRunAt && new Date(t.nextRunAt).getTime() <= now + DUE_SLOP_MS
    );
    // Advance each due task's schedule SYNCHRONOUSLY before enqueuing its run.
    // The run itself is async (awaits the whole turn), so if we left nextRunAt
    // pointing at the now-past fire time, the re-arm below would see the task as
    // still due and re-enqueue it every ~250ms until the run settled — a runaway
    // flood of duplicate runs. Claiming the next slot here makes a task fire once.
    for (const task of due) this.advanceSchedule(task);
    for (const task of due) this.enqueueRun(task.id, 'scheduled');
    if (due.length) void this.persistAndArm();
    else this.arm();
  }

  // Move a task to its NEXT scheduled run, called the moment a run is dispatched.
  // once → null (fires exactly once); cron → the next occurrence after now. The
  // actual run outcome (lastRunAt/lastStatus) is recorded later in runTask.
  private advanceSchedule(task: ScheduledTask): void {
    if (task.schedule.kind === 'once') {
      task.nextRunAt = null;
      return;
    }
    const next = nextAfter(task.schedule.expr, new Date());
    task.nextRunAt = next ? next.toISOString() : null;
  }

  private async persistAndArm(): Promise<void> {
    await saveTasks(this.tasks);
    this.opts.onChange(this.snapshot());
    this.arm();
  }

  // Serialize all runs through one promise chain so firings never overlap (the
  // backend serializes turns too, but this keeps our bookkeeping race-free).
  private enqueueRun(id: string, _reason: 'scheduled' | 'catchup' | 'manual'): void {
    this.queue = this.queue.then(
      () => this.runTask(id),
      () => this.runTask(id)
    );
  }

  private async runTask(id: string): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    // Defense in depth: a task disabled (paused/deleted) after this run was queued
    // must not fire. Scheduled/catch-up enqueues are only for enabled tasks; this
    // catches a pause that lands while the run sits in the queue.
    if (!task.enabled) return;

    // Guard: the originating chat may have been deleted. Running would spawn a new
    // empty session (ensureActive falls back to newSession), so disable instead.
    const exists = await this.threadExists(task.threadId);
    if (!exists) {
      task.enabled = false;
      task.lastStatus = 'failed';
      task.nextRunAt = null;
      await this.persistAndArm();
      return;
    }

    const at = new Date();
    const atIso = at.toISOString();
    task.lastStatus = 'running';
    this.opts.onChange(this.snapshot());

    try {
      const { turnId } = await this.opts.runtime.startTurn({
        input: task.prompt,
        threadId: task.threadId,
        webSearch: true,
        scheduled: { at: atIso, taskId: task.id }
      });
      if (turnId) {
        this.opts.onRun({ threadId: task.threadId, turnId, taskId: task.id, prompt: task.prompt, at: atIso });
        const status = await this.waitForSettle(turnId, task.threadId);
        task.lastStatus = status;
      } else {
        task.lastStatus = 'ok';
      }
    } catch {
      task.lastStatus = 'failed';
    }

    task.lastRunAt = atIso;
    // nextRunAt was already claimed (advanced) at dispatch time for scheduled and
    // catch-up runs; a manual runNow deliberately leaves the schedule untouched.
    await this.persistAndArm();
  }

  /** Resolve when the given turn settles (completed/failed/aborted), via backend events. */
  private waitForSettle(turnId: string, threadId: string): Promise<'ok' | 'failed'> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (status: 'ok' | 'failed') => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        this.opts.runtime.off('event', onEvent);
        resolve(status);
      };
      const onEvent = (event: BackendEventEnvelope) => {
        const p = event.params as { threadId?: string; turn?: { id?: string } } | undefined;
        // Turns serialize, so threadId alone is sufficient, but match the turn id
        // when present for precision.
        const matches = p?.turn?.id ? p.turn.id === turnId : p?.threadId === threadId;
        if (!matches) return;
        if (event.method === 'turn/completed') finish('ok');
        else if (event.method === 'turn/failed' || event.method === 'turn/aborted') finish('failed');
        else if (event.method === 'process/exit') finish('failed');
      };
      const timeout = setTimeout(() => finish('failed'), RUN_TIMEOUT_MS);
      this.opts.runtime.on('event', onEvent);
    });
  }

  private async threadExists(threadId: string): Promise<boolean> {
    try {
      const threads = await this.opts.runtime.listThreads();
      return threads.some((t) => t.threadId === threadId);
    } catch {
      // If we can't tell, assume it exists rather than silently disabling the task.
      return true;
    }
  }
}
