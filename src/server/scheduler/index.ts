import { randomUUID } from 'node:crypto';
import type { ChatBackend } from '../backend/types';
import type {
  BackendEventEnvelope,
  ScheduledRunPayload,
  ScheduledTask,
  ScheduleTaskRequest,
  TaskSchedule
} from '../../shared/types';
import { isContextOverflowError } from '../backend/overflow';
import { degrade } from '../degrade';
import { log } from '../log';
import { noteTurnStart } from '../live-turns';
import { toMs } from '../../shared/inbox';
import { isValidCron, nextAfter } from './cron';
import { clipError, readTasks, saveTasks, titleFromPrompt } from '../workspace/tasks';
import * as activity from '../activity';

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
  /**
   * True while the user is actively interacting (a turn running, or recent input).
   * Runs defer while this holds — a scheduled turn would hold the single foreground
   * session gate and silently block the user's next message.
   */
  isUserActive?: () => boolean;
  /** Abort an in-flight turn (wired to runtime.interruptTurn) for preemption. */
  interrupt?: (turnId: string) => Promise<void>;
  /**
   * A run settled without calling `notify_user`: it found nothing worth raising.
   * `before` and `at` bracket the run in the thread's own mtime terms, so the host
   * can keep the turn's mtime bump from reading as activity in the Inbox.
   */
  onSilentRun?: (threadId: string, before: number, at: number) => void;
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
// While the user is active, poll for idle at this cadence before starting a run…
const IDLE_POLL_MS = 15 * 1000;
// …but never starve a task forever: after this long, run anyway.
const DEFER_CAP_MS = 30 * 60 * 1000; // 30m
// A run preempted by the user retries after idle at most this many times per firing.
const MAX_REQUEUES = 3;
// Slop on the "this run was silent" stamp. Thread mtimes are second-granular and
// the backend's last session write can land after turn/completed, so a stamp taken
// at the exact instant the run settled can still end up behind the file it is
// meant to cover — which would resurrect the thread anyway. Nothing but the run's
// own trailing write realistically happens in this window.
const SILENT_RUN_GRACE_MS = 2000;

export { isContextOverflowError };

interface ActiveRun {
  taskId: string;
  threadId: string;
  turnId: string | null;
  preempted: boolean;
  /** The run called `notify_user` — i.e. it found something worth surfacing. */
  notified: boolean;
}

export class TaskScheduler {
  private tasks: ScheduledTask[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Serializes runs (and bookkeeping writes) so two firings never overlap. */
  private queue: Promise<unknown> = Promise.resolve();
  private started = false;
  /** The scheduler-owned turn currently in flight (preemption target). */
  private activeRun: ActiveRun | null = null;
  /** Preempt-retry counts per firing, cleared on a completed (non-preempted) run. */
  private requeueCounts = new Map<string, number>();

  constructor(private readonly opts: SchedulerOptions) {}

  /**
   * The user is about to start an interactive turn: abort the scheduler-owned turn
   * (if any) so the foreground gate frees immediately. The preempted run is not a
   * failure — runTask re-queues it to retry once the user goes idle. Only ever
   * targets a scheduler-dispatched turn; user turns are never interrupted.
   */
  preemptForUser(): void {
    const run = this.activeRun;
    if (!run || run.preempted) return;
    run.preempted = true;
    // turnId may still be null while startTurn is building the prompt; runTask
    // checks the flag right after it resolves and interrupts then.
    if (run.turnId && this.opts.interrupt) {
      void this.opts.interrupt(run.turnId).catch((err) =>
        // The abort is the whole point of preempting: it is what frees the
        // foreground gate. An abort that failed leaves the scheduler's turn
        // running against the backend while the user waits behind it, and the
        // requeue below still records the run as yielded.
        degrade('tasks', 'left a preempted run holding the foreground gate', err)
      );
    }
  }

  /**
   * The in-flight run just raised a `notify_user` alert (routed here by the task
   * bridge). That's the run's own declaration that it found something, and the
   * only reason a run gets to disturb the Inbox — see the silent-run handling in
   * runTask. Scoped to the running task's thread so an interactive turn that
   * calls the tool can't speak for it.
   */
  noteNotify(threadId: string): void {
    if (this.activeRun?.threadId === threadId) this.activeRun.notified = true;
  }

  /**
   * The task whose run is in flight, or null. Read by the notify bridge so a push
   * can name the task instead of the thread — the same scoping as noteNotify: an
   * interactive turn that calls the tool is nobody's scheduled run and answers
   * null here.
   */
  runningTask(threadId: string): ScheduledTask | null {
    const run = this.activeRun;
    if (!run || run.threadId !== threadId) return null;
    return this.tasks.find((t) => t.id === run.taskId) ?? null;
  }

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
      const expr = req.cron!.trim();
      if (!isValidCron(expr)) {
        return { ok: false, error: `Invalid cron expression "${req.cron}". Use 5 fields: minute hour day-of-month month day-of-week.` };
      }
      // Syntax alone is not enough: combinations such as February 30 can never
      // produce an occurrence. Reject them rather than persisting an enabled task
      // with nextRunAt:null that silently never fires.
      if (!nextAfter(expr, new Date())) {
        return { ok: false, error: `Cron expression "${req.cron}" has no reachable future occurrence.` };
      }
      return { ok: true, value: { kind: 'cron', expr } };
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
  private enqueueRun(id: string, _reason: 'scheduled' | 'catchup' | 'manual' | 'requeued'): void {
    this.queue = this.queue.then(
      () => this.runTask(id),
      () => this.runTask(id)
    );
  }

  /**
   * Keep why a run failed, on the task and in the log, and drop it the moment one
   * succeeds. A run that fails before its turn ever starts — the chat could not be
   * opened, the backend would not spawn — used to leave "failed" in the Tasks tab
   * and NOTHING anywhere else: the error was caught and dropped here. That is how
   * every scheduled run on a freshly migrated server could die for days unnoticed.
   */
  private recordOutcome(task: ScheduledTask, error: string | null): void {
    if (!error) {
      delete task.lastError;
      return;
    }
    task.lastError = clipError(error);
    log('tasks', 'a scheduled run failed', { task: task.title, error: task.lastError });
  }

  /** Poll until the user goes idle (bounded so a task is never starved forever). */
  private async waitForUserIdle(): Promise<void> {
    const isActive = this.opts.isUserActive;
    if (!isActive) return;
    const start = Date.now();
    while (isActive() && Date.now() - start < DEFER_CAP_MS) {
      await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
    }
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
    // The same read yields the thread's pre-run mtime, which the silent-run stamp
    // below needs as its "before" — reading it after the turn would be too late.
    const before = await this.findThread(task.threadId);
    if (!before.found) {
      task.enabled = false;
      task.lastStatus = 'failed';
      task.nextRunAt = null;
      // Through recordOutcome, not a bare status: "failed" with nothing beside it
      // is the exact shape recordOutcome exists to prevent, and this branch used
      // to be the one path into it that skipped the explanation.
      this.recordOutcome(task, 'The chat this task belonged to no longer exists, so the task was paused.');
      await this.persistAndArm();
      return;
    }

    // Defer while the user is actively chatting — this run would hold the single
    // foreground gate and silently queue their message behind a whole agent turn.
    // Covers catch-up at launch too (it enqueues through this same path).
    await this.waitForUserIdle();
    if (!task.enabled || !this.tasks.some((t) => t.id === id)) return; // paused/deleted while deferred

    const at = new Date();
    const atIso = at.toISOString();
    const prevStatus = task.lastStatus;
    task.lastStatus = 'running';
    this.opts.onChange(this.snapshot());

    const run: ActiveRun = {
      taskId: id,
      threadId: task.threadId,
      turnId: null,
      preempted: false,
      notified: false
    };
    this.activeRun = run;
    // Instrumented here rather than at the onRun callback: onRun only fires when
    // the turn starts, and this is the only scope that also sees it settle.
    const handle = activity.begin('tasks.run', 'Running scheduled task', { detail: titleFromPrompt(task.prompt) });
    try {
      const { turnId } = await this.opts.runtime.startTurn({
        input: task.prompt,
        threadId: task.threadId,
        webSearch: true,
        scheduled: { at: atIso, taskId: task.id }
      });
      if (turnId) {
        run.turnId = turnId;
        // Start this turn's clock now rather than at its first streamed event, so
        // a run that hangs without producing one is still measurable — same
        // reason as the interactive path in server/index.ts (see noteTurnStart).
        noteTurnStart(task.threadId, turnId);
        // A preempt that landed while startTurn was still building: interrupt now.
        if (run.preempted && this.opts.interrupt) {
          // Same as preemptForUser: an abort that fails is a scheduled turn the
          // user's turn now queues behind, with nothing anywhere saying so.
          void this.opts.interrupt(turnId).catch((err) =>
            degrade('tasks', 'left a preempted run holding the foreground gate', err)
          );
        }
        this.opts.onRun({ threadId: task.threadId, turnId, taskId: task.id, prompt: task.prompt, at: atIso });
        let settle = await this.waitForSettle(turnId, task.threadId);
        // Overflow self-heal: a run that died because the thread outgrew the
        // model's context window is not a lost cause — condense the thread and
        // re-run once. (pi has its own compact-and-retry for this, but it has
        // been observed to fail silently; this backstop is model-agnostic.)
        if (settle.status === 'failed' && !run.preempted && isContextOverflowError(settle.error)) {
          const compacted = await this.opts.runtime
            .compactThread(task.threadId)
            .then(() => true)
            .catch((err) => {
              // The task row says the same "context window" failure whether the
              // condense was tried and did not help or never ran at all, and this
              // backstop exists precisely because pi's own compact-and-retry was
              // observed failing silently. Say which one happened.
              degrade('tasks', 'skipped the overflow retry with the thread still over the window', err);
              return false;
            });
          if (compacted) {
            const retry = await this.opts.runtime.startTurn({
              input: task.prompt,
              threadId: task.threadId,
              webSearch: true,
              scheduled: { at: atIso, taskId: task.id }
            });
            if (retry.turnId) {
              run.turnId = retry.turnId;
              noteTurnStart(task.threadId, retry.turnId);
              if (run.preempted && this.opts.interrupt) {
                // As above: a failed abort holds the gate against the user.
                void this.opts.interrupt(retry.turnId).catch((err) =>
                  degrade('tasks', 'left a preempted run holding the foreground gate', err)
                );
              }
              this.opts.onRun({
                threadId: task.threadId,
                turnId: retry.turnId,
                taskId: task.id,
                prompt: task.prompt,
                at: atIso
              });
              settle = await this.waitForSettle(retry.turnId, task.threadId);
            }
          }
        }
        task.lastStatus = settle.status;
        this.recordOutcome(task, settle.status === 'failed' ? settle.error ?? 'The run did not finish.' : null);
      } else {
        task.lastStatus = 'ok';
        this.recordOutcome(task, null);
      }
    } catch (error) {
      // quiet: recordOutcome puts the message on the task's row in the Tasks tab
      // and the finally below raises tasks.run on the activity popover.
      task.lastStatus = 'failed';
      this.recordOutcome(task, error instanceof Error ? error.message : String(error));
    } finally {
      this.activeRun = null;
      // A preempted run is requeued below rather than finished, so it earns
      // neither a completed row nor a failure — `worked: false` drops it.
      if (task.lastStatus === 'failed') {
        activity.fail('tasks.run', 'Scheduled run failed', 'Running scheduled task');
      } else {
        activity.end(handle, { worked: !run.preempted });
      }
    }

    // Preempted by the user: not a failure. Restore the pre-run status and retry
    // after idle, bounded so a busy user can't ping-pong a task indefinitely.
    if (run.preempted) {
      const n = (this.requeueCounts.get(id) ?? 0) + 1;
      if (n <= MAX_REQUEUES) {
        this.requeueCounts.set(id, n);
        task.lastStatus = prevStatus;
        this.opts.onChange(this.snapshot());
        this.enqueueRun(id, 'requeued');
        return;
      }
      this.requeueCounts.delete(id);
      // Out of retries — record the firing as failed and fall through to the
      // normal bookkeeping (lastRunAt, once-task cleanup, persist).
      task.lastStatus = 'failed';
      this.recordOutcome(task, `Yielded to you ${MAX_REQUEUES} times and ran out of retries; it goes again on its next schedule.`);
    } else {
      this.requeueCounts.delete(id);
    }

    // The run is over and it never called notify_user, so as far as the user is
    // concerned nothing happened — but the turn appended to the thread and moved
    // its mtime, which is exactly what the Inbox treats as new activity. Tell the
    // host so it can absorb the bump; otherwise every silent poll drags the thread
    // back out of the archive and marks it unread. (A preempted-out-of-retries run
    // reaches here too, and it produced nothing either.)
    if (!run.notified && before.updatedAt != null && this.opts.onSilentRun) {
      // Re-read the mtime rather than trusting the clock alone — the turn's own
      // writes are what we're covering, and they are the freshest thing on disk.
      const after = await this.findThread(task.threadId);
      const at = Math.max(Date.now(), after.updatedAt ?? 0) + SILENT_RUN_GRACE_MS;
      this.opts.onSilentRun(task.threadId, before.updatedAt, at);
    }

    task.lastRunAt = atIso;
    // nextRunAt was already claimed (advanced) at dispatch time for scheduled and
    // catch-up runs; a manual runNow deliberately leaves the schedule untouched.
    // A one-time task that has fired its scheduled slot is finished — drop it from
    // the list entirely so it stops showing in the Tasks tab and clears the owning
    // chat's scheduled badge (scheduledThreadIds is derived from the task list).
    // advanceSchedule nulls nextRunAt for once-tasks at dispatch (scheduled/catch-up);
    // a manual runNow of a still-pending once-task leaves nextRunAt set, so it
    // survives here until its real fire time.
    if (task.schedule.kind === 'once' && !task.nextRunAt) {
      this.tasks = this.tasks.filter((t) => t.id !== task.id);
    }
    await this.persistAndArm();
  }

  /** Resolve when the given turn settles (completed/failed/aborted), via backend events.
   *  A failure carries the turn's terminal error text (when the backend reported one)
   *  so runTask can recognize context-overflow deaths and self-heal. */
  private waitForSettle(turnId: string, threadId: string): Promise<{ status: 'ok' | 'failed'; error?: string }> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (status: 'ok' | 'failed', error?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        this.opts.runtime.off('event', onEvent);
        resolve({ status, ...(error ? { error } : {}) });
      };
      const onEvent = (event: BackendEventEnvelope) => {
        // Process exits are runtime-wide and intentionally carry no thread/turn
        // identifiers. Handle them before the scoped match below or this branch
        // is unreachable and the scheduler queue stays wedged until the 15m cap.
        if (event.method === 'process/exit') {
          finish('failed');
          return;
        }
        const p = event.params as { threadId?: string; turn?: { id?: string }; error?: string } | undefined;
        // Turns serialize, so threadId alone is sufficient, but match the turn id
        // when present for precision.
        const matches = p?.turn?.id ? p.turn.id === turnId : p?.threadId === threadId;
        if (!matches) return;
        if (event.method === 'turn/completed') finish('ok');
        else if (event.method === 'turn/failed') finish('failed', typeof p?.error === 'string' ? p.error : undefined);
        else if (event.method === 'turn/aborted') finish('failed');
      };
      const timeout = setTimeout(() => {
        // Mark the run failed promptly, but also abort its backend turn so a hung
        // agent does not keep the foreground gate occupied behind the scheduler's
        // now-advanced queue.
        if (this.opts.interrupt) {
          // If the abort itself fails, that is exactly what happens: the queue has
          // moved on, the row reads failed, and the turn is still running.
          void this.opts.interrupt(turnId).catch((err) =>
            degrade('tasks', 'left a timed-out run occupying the foreground gate', err)
          );
        }
        finish('failed');
      }, RUN_TIMEOUT_MS);
      this.opts.runtime.on('event', onEvent);
    });
  }

  /**
   * Look the task's chat up in the thread list: whether it still exists, and its
   * last-activity mtime normalized to ms. `updatedAt` is null when the list read
   * failed — the caller keeps running the task (see `found`) but skips anything
   * that needs a trustworthy mtime.
   */
  private async findThread(threadId: string): Promise<{ found: boolean; updatedAt: number | null }> {
    try {
      const threads = await this.opts.runtime.listThreads();
      const thread = threads.find((t) => t.threadId === threadId);
      return thread
        ? { found: true, updatedAt: toMs(thread.updatedAt) }
        : { found: false, updatedAt: null };
    } catch (err) {
      // If we can't tell, assume it exists rather than silently disabling the
      // task. The mtime is the loss that matters: onSilentRun uses the before/
      // after pair to keep a scheduled run out of the Inbox, and without it the
      // run either shows up as something the user did or hides something they
      // should have seen.
      degrade('tasks', 'ran the task without its chat\'s last-activity time', err);
      return { found: true, updatedAt: null };
    }
  }
}
