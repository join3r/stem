import { beginMailWork, type WorkHandle } from '../mail/work';
import { randomUUID } from 'node:crypto';
import type { ChatBackend, ParkRequest } from '../backend/types';
import type {
  BackendEventEnvelope,
  ScheduledRunReport,
  ScheduledTask,
  ScheduleTaskRequest,
  TaskRunRecord,
  TaskRunsAs,
  TaskSchedule
} from '../../shared/types';
import { TASK_RECENT_RUNS } from '../../shared/types';
import { degrade } from '../degrade';
import { log } from '../log';
import { noteTurnStart } from '../live-turns';
import { isValidCron, nextAfter } from '../../shared/cron';
import { clipError, coerceRunsAs, readTasksStore, saveTasks, titleFromPrompt } from '../workspace/tasks';
import { getPersona } from '../workspace/personas';
import { personaTurnFields } from '../workspace/persona-turn';
import * as activity from '../activity';

// The main-process scheduler. Holds tasks in memory, keeps ONE timer armed for the
// earliest due task, and runs each firing as a full autonomous agent turn in a
// FRESH thread (startTurn with no threadId — pi mints a new session). Nothing
// accumulates between firings: the run knows its prompt, its persona and recall,
// and no more. What a run found reaches the user as mail (notify_user); the
// thread it ran in is kept only when it produced mail, and deleted otherwise.
// Modeled on the existing background passes in whenReady (scheduleDistill /
// runCurate): a single timer + a re-entrancy guard, gated by nothing but the
// enabled flag.

export interface SchedulerOptions {
  runtime: ChatBackend;
  /** Pushed whenever the task list changes (created/updated/run/deleted). */
  onChange: (tasks: ScheduledTask[]) => void;
  /**
   * True while the user is actively interacting (a turn running, or recent input).
   * Runs defer while this holds — a scheduled turn would hold the single foreground
   * session gate and silently block the user's next message.
   */
  isUserActive?: () => boolean;
  /** Abort an in-flight turn (wired to runtime.interruptTurn) for preemption. */
  interrupt?: (turnId: string, reason?: string) => Promise<void>;
  /**
   * Delete a run's thread once nothing points at it. Defaults to
   * runtime.deleteThread; the host also forgets the thread in the chat search
   * index, which indexed its turn like any other.
   */
  deleteThread?: (threadId: string) => Promise<void>;
  /**
   * A persona run settled ok: reflect what it taught the persona into its
   * memory (mail/reflect.ts). Called only for personas that own a memory. Must
   * never reject; the run's thread is deleted once it resolves (when the run
   * sent no mail), so it reads the transcript while it is still there.
   */
  reflect?: (args: { personaId: string; assignment: string; threadId: string }) => Promise<void>;
  /**
   * A run that called `notify_user` settled ok with a final reply: hand the
   * reply to the mail its notification became (the last one, when it notified
   * more than once), so the Inbox carries the result and not only the headline.
   */
  onResult?: (args: { taskId: string; threadId: string; itemId: string; result: string }) => Promise<void>;
  /**
   * A clean run that never notified: mail its generated pictures, if it made
   * any (answers whether it mailed). Without it such a run's thread — the only
   * place its pictures live — is deleted with them unseen.
   */
  /**
   * A run stopped for the user's Allow/Deny (the safety check would not run a
   * command and nobody was watching): mail the approval into the task's
   * conversation. The run's thread is kept — the answer resumes it.
   */
  onParked?: (args: {
    taskId: string;
    title: string;
    threadId: string;
    personaId?: string;
    request: ParkRequest;
  }) => Promise<void>;
  /** A resumed run's final reply, mailed into the task's conversation. */
  onResumedReply?: (args: { taskId: string; title: string; threadId: string; personaId?: string; reply: string }) => Promise<void>;
  onUnreportedImages?: (args: {
    taskId: string;
    title: string;
    threadId: string;
    personaId?: string;
    reply?: string;
  }) => Promise<boolean>;
  /**
   * What this task's earlier runs already mailed the user, newest first, for
   * the run's preamble: a run has no thread history, so this is how a watch
   * task knows what it has reported. Absent = runs start blind (tests).
   */
  priorReports?: (taskId: string) => Promise<ScheduledRunReport[]>;
  /**
   * A task's run just failed after its previous one did not (or after none at
   * all): mail the user once, with the reason. Repeated failures stay quiet — the
   * Tasks tab row carries them — and a recovery sends nothing. The host attaches
   * the run's Work record to that mail, which is why it is called BEFORE the work
   * record is closed, with the run's thread; the thread is then kept.
   */
  onFailureTransition?: (args: {
    taskId: string;
    title: string;
    /** The failed run's own thread, when the turn got far enough to have one. */
    threadId?: string;
    personaId?: string;
    error: string;
  }) => Promise<void>;
  /**
   * A task was deleted: the threads its notifying runs left behind (recorded on
   * its mail items) are nobody's now. The mail itself stays.
   */
  onTaskDeleted?: (taskId: string) => Promise<void>;
  /**
   * The one-off pass for a tasks store from before runs had threads of their
   * own (see scheduler/rewrite.ts): answer a self-contained prompt for the
   * task, or null to leave it as it is. Absent = no pass (tests).
   */
  rewriteForFreshThreads?: (task: ScheduledTask) => Promise<string | null>;
  /** The pass is over: what it rewrote and what it could not. Mail the user. */
  onRewritten?: (result: { rewritten: ScheduledTask[]; untouched: ScheduledTask[] }) => Promise<void>;
}

// Timer cap: setTimeout is unreliable over very long delays and across system
// sleep/clock changes, so we never sleep longer than this — we just re-arm and
// re-check. Comfortably finer than any realistic schedule gap.
const MAX_TIMER_MS = 6 * 60 * 60 * 1000; // 6h
// A run that never settles must not wedge the scheduler forever.
const RUN_TIMEOUT_MS = 15 * 60 * 1000; // 15m
/** Named cause for the abort a preempt sends — the user did not press Stop. */
const PREEMPT_REASON = 'the scheduled run yielded to the user';
// Treat a task as due if its time has arrived within this slop (timers can fire a
// hair early; cron is minute-resolution so this is harmless).
const DUE_SLOP_MS = 1000;
// While the user is active, poll for idle at this cadence before starting a run…
const IDLE_POLL_MS = 15 * 1000;
// …but never starve a task forever: after this long, run anyway.
const DEFER_CAP_MS = 30 * 60 * 1000; // 30m
// A run preempted by the user retries after idle at most this many times per firing.
const MAX_REQUEUES = 3;

interface ActiveRun {
  taskId: string;
  /** The run's own fresh thread — known only once startTurn resolves. */
  threadId: string | null;
  turnId: string | null;
  preempted: boolean;
  /**
   * The run called `notify_user` — i.e. it found something worth surfacing, and
   * a mail now carries it. Decides whether the run's reply joins that mail and
   * whether its thread outlives it.
   */
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
      void this.opts.interrupt(run.turnId, PREEMPT_REASON).catch((err) =>
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
   * bridge). That's the run's own declaration that it found something: its reply
   * joins the mail the alert opened once the run settles, and its thread is kept
   * (see runTask). Scoped to the running task's own thread so an interactive
   * turn that calls the tool can't speak for it.
   */
  noteNotify(threadId: string): void {
    if (this.activeRun?.threadId === threadId) this.activeRun.notified = true;
  }

  /**
   * The task whose run is in flight in `threadId`, or null. Read by the notify
   * bridge so a push can name the task instead of the thread — the same scoping
   * as noteNotify: an interactive turn that calls the tool is nobody's scheduled
   * run and answers null here.
   */
  runningTask(threadId: string): ScheduledTask | null {
    const run = this.activeRun;
    if (!run || run.threadId !== threadId) return null;
    return this.tasks.find((t) => t.id === run.taskId) ?? null;
  }

  /**
   * The thread the in-flight run occupies, or null. The chat list filters it
   * out: pi writes the session file with the first turn, and a run that has
   * not mailed yet is on no mail item — without this it would surface as a new
   * chat for as long as it ran, then vanish.
   */
  activeRunThreadId(): string | null {
    return this.activeRun?.threadId ?? null;
  }

  /** Load persisted tasks, run any overdue ones once (catch-up), then arm the timer. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const store = await readTasksStore();
    this.tasks = store.tasks;
    // A store from before runs had threads of their own: its prompts were
    // written for runs that could read their chat. Rewrite them once, before
    // anything fires blind on them. The save below moves the store to the new
    // version whatever happened, so the pass runs once per install.
    if (store.legacy && this.tasks.length) await this.rewriteLegacyPrompts();

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

  /**
   * Every task, in turn, through the host's rewrite; the original prompt is
   * kept on the task for Revert. Sequential on purpose — each is a model call
   * over a whole chat, and boot is not the moment to run five at once.
   */
  private async rewriteLegacyPrompts(): Promise<void> {
    const rewrite = this.opts.rewriteForFreshThreads;
    if (!rewrite) return;
    const rewritten: ScheduledTask[] = [];
    const untouched: ScheduledTask[] = [];
    for (const task of this.tasks) {
      // quiet: a rewrite that rejects is a task left as it was, and the mail
      // below names it under "left as they were" — the same outcome as null.
      const next = await rewrite(task).catch(() => null);
      if (!next) {
        untouched.push({ ...task });
        continue;
      }
      task.rewritten = { at: new Date().toISOString(), original: task.prompt };
      task.prompt = next;
      task.title = titleFromPrompt(next);
      log('tasks', 'rewrote a prompt for fresh-thread runs', { task: task.title });
      rewritten.push({ ...task });
    }
    // Persist before the mail goes out: a mail about a rewrite that a crash
    // then lost would be worse than no mail.
    await saveTasks(this.tasks);
    if (this.opts.onRewritten && (rewritten.length || untouched.length)) {
      await this.opts.onRewritten({ rewritten, untouched }).catch((err) =>
        degrade('tasks', 'did not mail the user which task prompts were rewritten', err)
      );
    }
  }

  /** Put back the prompt a task had before the rewrite pass; the mark goes with it. */
  async revertRewrite(id: string): Promise<ScheduledTask[]> {
    const task = this.tasks.find((t) => t.id === id);
    if (task?.rewritten) {
      task.prompt = task.rewritten.original;
      task.title = titleFromPrompt(task.prompt);
      delete task.rewritten;
      await this.persistAndArm();
    }
    return this.snapshot();
  }

  // ---- public surface (IPC handlers + the TaskBridge build on these) ----

  snapshot(): ScheduledTask[] {
    return this.tasks.map((t) => ({ ...t }));
  }

  /** Tasks scheduled from `threadId` (a chat or a mail persona's session). */
  listForThread(threadId: string): ScheduledTask[] {
    return this.tasks.filter((t) => t.threadId === threadId).map((t) => ({ ...t }));
  }

  /** The checks `create` runs before it writes anything. */
  async validate(req: ScheduleTaskRequest): Promise<{ ok: true } | { ok: false; error: string }> {
    const schedule = this.buildSchedule(req);
    if (!schedule.ok) return { ok: false, error: schedule.error };
    if (!(req.prompt ?? '').trim()) return { ok: false, error: 'A task needs a prompt to run.' };
    // Schedule-as-persona: validated at creation so a typo'd persona fails the
    // tool call loudly instead of every future run quietly.
    const personaId = (req.personaId ?? '').trim();
    if (personaId && !(await getPersona(personaId))) {
      return { ok: false, error: `No persona "${personaId}" exists.` };
    }
    return { ok: true };
  }

  /**
   * Create a task scheduled from `threadId` (the assistant's schedule_task tool,
   * called in a chat or in a mail persona's hidden session — either is fine,
   * since no run ever writes there).
   */
  async create(
    req: ScheduleTaskRequest,
    threadId: string
  ): Promise<{ ok: true; task: ScheduledTask } | { ok: false; error: string }> {
    const valid = await this.validate(req);
    if (!valid.ok) return valid;
    const schedule = this.buildSchedule(req);
    if (!schedule.ok) return { ok: false, error: schedule.error };
    const prompt = req.prompt.trim();
    const personaId = (req.personaId ?? '').trim();

    const now = new Date();
    const task: ScheduledTask = {
      id: randomUUID(),
      threadId,
      prompt,
      schedule: schedule.value,
      enabled: true,
      createdAt: now.toISOString(),
      title: titleFromPrompt(prompt),
      nextRunAt: null,
      runsAs: personaId ? { kind: 'persona', personaId } : { kind: 'default' }
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

  /**
   * Replace a task's schedule. Rejects (the IPC surfaces the message) on a
   * malformed or unreachable cron and on a datetime that is not one — the same
   * checks the assistant's schedule_task goes through, so a schedule edited in
   * the Tasks tab cannot arm something the scheduler can never fire.
   */
  async updateSchedule(id: string, schedule: TaskSchedule): Promise<ScheduledTask[]> {
    const checked = this.buildSchedule(
      schedule.kind === 'cron' ? { prompt: '', cron: schedule.expr } : { prompt: '', at: schedule.at }
    );
    if (!checked.ok) throw new Error(checked.error);
    const task = this.tasks.find((t) => t.id === id);
    if (task) {
      task.schedule = checked.value;
      // A re-scheduled once-task can fire again, so clear the "already ran" marker
      // that suppresses its next-run computation.
      if (schedule.kind === 'once') task.lastRunAt = undefined;
      task.nextRunAt = this.computeNextRunAt(task, new Date());
      await this.persistAndArm();
    }
    return this.snapshot();
  }

  /**
   * Replace the prompt a task re-runs (Tasks tab editor). The title is derived
   * from the prompt, so it follows. Rejects an empty prompt — a task with
   * nothing to run is a task that fails every time.
   */
  async updatePrompt(id: string, prompt: string): Promise<ScheduledTask[]> {
    const next = prompt.trim();
    if (!next) throw new Error('A task needs a prompt to run.');
    const task = this.tasks.find((t) => t.id === id);
    if (task) {
      task.prompt = next;
      task.title = titleFromPrompt(next);
      // The user's own words now: the rewrite mark (and its Revert) would only
      // offer to throw them away.
      delete task.rewritten;
      await this.persistAndArm();
    }
    return this.snapshot();
  }

  /**
   * Replace who/what this task's runs execute as (Tasks tab). One choice, not
   * three fields: a persona, a pinned model, or the app default. Rejects a
   * malformed value and a persona that does not exist. No validation against
   * the model catalog: the Tasks tab only offers catalog entries, and the
   * runtime degrades a vanished model to the app default rather than skipping
   * the run.
   */
  async updateRunsAs(id: string, runsAs: TaskRunsAs): Promise<ScheduledTask[]> {
    const checked = coerceRunsAs(runsAs);
    if (!checked) throw new Error('Choose a persona, a model, or the default.');
    if (checked.kind === 'persona' && !(await getPersona(checked.personaId))) {
      throw new Error(`No persona "${checked.personaId}" exists.`);
    }
    const task = this.tasks.find((t) => t.id === id);
    if (task) {
      task.runsAs = checked;
      await this.persistAndArm();
    }
    return this.snapshot();
  }

  async remove(id: string): Promise<ScheduledTask[]> {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length !== before) {
      await this.persistAndArm();
      // The threads its mail-sending runs left behind: with the task gone
      // nothing will show them again except the mail, which keeps its own
      // record of the work.
      await this.opts.onTaskDeleted?.(id).catch((err) =>
        degrade('tasks', "left a deleted task's run threads behind", err)
      );
    }
    return this.snapshot();
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
   * succeeds. A run that fails before its turn ever starts — the backend would
   * not spawn — used to leave "failed" in the Tasks tab and NOTHING anywhere
   * else: the error was caught and dropped here. That is how every scheduled run
   * on a freshly migrated server could die for days unnoticed.
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

  /**
   * The persona/model fields a run of `task` carries into startTurn. A persona
   * that has vanished since the task was pinned degrades to the app default
   * rather than wedging the task — there is no model underneath a persona pin
   * to fall back to, by design.
   */
  private async resolveRunsAs(task: ScheduledTask): Promise<{
    extras: { model?: string; effort?: string; persona?: Awaited<ReturnType<typeof personaTurnFields>>['persona'] };
    personaId?: string;
    notes: boolean;
  }> {
    const runsAs = task.runsAs;
    if (runsAs.kind === 'model') {
      return { extras: { model: runsAs.model, ...(runsAs.effort ? { effort: runsAs.effort } : {}) }, notes: false };
    }
    if (runsAs.kind === 'persona') {
      // quiet: a registry read that rejects is indistinguishable here from a
      // missing persona — the degrade below names the fallback either way.
      const persona = await getPersona(runsAs.personaId).catch(() => null);
      if (persona) {
        // The persona block comes from the shared builder (memory index, recall
        // flag and all), so a persona on a schedule is the same persona as in mail.
        const fields = await personaTurnFields(persona);
        return {
          extras: {
            ...(fields.model ? { model: fields.model } : {}),
            ...(fields.effort ? { effort: fields.effort } : {}),
            persona: fields.persona
          },
          personaId: persona.id,
          notes: !!fields.persona.notes
        };
      }
      degrade(
        'tasks',
        'ran a persona task on the app default',
        new Error(`persona "${runsAs.personaId}" no longer exists`)
      );
    }
    return { extras: {}, notes: false };
  }

  private async runTask(id: string): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    // Defense in depth: a task disabled (paused/deleted) after this run was queued
    // must not fire. Scheduled/catch-up enqueues are only for enabled tasks; this
    // catches a pause that lands while the run sits in the queue.
    if (!task.enabled) return;

    // Defer while the user is actively chatting — this run would hold the single
    // foreground gate and silently queue their message behind a whole agent turn.
    // Covers catch-up at launch too (it enqueues through this same path).
    await this.waitForUserIdle();
    if (!task.enabled || !this.tasks.some((t) => t.id === id)) return; // paused/deleted while deferred

    const atIso = new Date().toISOString();
    const prevStatus = task.lastStatus;
    task.lastStatus = 'running';
    this.opts.onChange(this.snapshot());

    const resolved = await this.resolveRunsAs(task);
    const run: ActiveRun = { taskId: id, threadId: null, turnId: null, preempted: false, notified: false };
    this.activeRun = run;
    // Instrumented here rather than at a start callback: this is the only scope
    // that sees the run both start and settle.
    const handle = activity.begin('tasks.run', 'Running scheduled task', { detail: titleFromPrompt(task.prompt) });
    let work: WorkHandle | undefined;
    /** The reflection pass, when one runs: the run's thread must outlive it. */
    let reflection: Promise<void> | undefined;
    /** Stopped for the user's Allow/Deny: its reply is not a result, and it resumes later. */
    let parked = false;
    try {
      const requestedTurnId = randomUUID();
      // The work record opens before the turn (a synchronous startTurn failure
      // still leaves a record) and learns its thread once the backend names it.
      work = await beginMailWork(this.opts.runtime, { personaId: resolved.personaId ?? `task:${task.id}`, turnId: requestedTurnId });
      // quiet: a mail store that cannot be read costs this run its list of
      // earlier reports, nothing more; it runs as a first firing would.
      const prior = await this.opts.priorReports?.(task.id).catch(() => []);
      const started = await this.opts.runtime.startTurn({
        turnId: requestedTurnId,
        input: task.prompt,
        // No threadId: every firing gets a fresh session — the whole point.
        ...resolved.extras,
        webSearch: true,
        scheduled: { at: atIso, taskId: task.id, ...(prior?.length ? { prior } : {}) }
      });
      if (started.turnId) {
        const turnId = started.turnId;
        run.turnId = turnId;
        work.run.turnId = turnId;
        if (started.threadId) {
          run.threadId = started.threadId;
          work.bindThread(started.threadId);
          // Start this turn's clock now rather than at its first streamed event,
          // so a run that hangs without producing one is still measurable — same
          // reason as the interactive path in server/index.ts (see noteTurnStart).
          noteTurnStart(started.threadId, turnId);
        }
        // A preempt that landed while startTurn was still building: interrupt now.
        if (run.preempted && this.opts.interrupt) {
          // Same as preemptForUser: an abort that fails is a scheduled turn the
          // user's turn now queues behind, with nothing anywhere saying so.
          void this.opts.interrupt(turnId, PREEMPT_REASON).catch((err) =>
            degrade('tasks', 'left a preempted run holding the foreground gate', err)
          );
        }
        const settle = await this.waitForSettle(turnId, run.threadId);
        if (settle.status === 'parked') {
          parked = true;
          await this.mailPark(task, run.threadId, resolved.personaId, settle.parked!);
          run.notified = true;
        }
        task.lastStatus = settle.status === 'parked' ? 'ok' : settle.status;
        this.recordOutcome(task, settle.status === 'failed' ? settle.error ?? 'The run did not finish.' : null);
        // What did this run teach the persona? Same pass a mail delivery gets,
        // for the same reason: a persona that runs nightly and never reflects
        // never learns. Only for runs that settled ok and only when the persona
        // owns a memory (the index is present exactly then); never rejects (see
        // mail/reflect.ts). It reads the run's thread, so the thread waits for it.
        if (settle.status === 'ok' && resolved.notes && resolved.personaId && run.threadId && this.opts.reflect) {
          reflection = this.opts.reflect({ personaId: resolved.personaId, assignment: task.prompt, threadId: run.threadId });
        }
      } else {
        task.lastStatus = 'ok';
        this.recordOutcome(task, null);
      }
    } catch (error) {
      // quiet: recordOutcome puts the message on the task's row in the Tasks tab
      // and the activity below raises tasks.run on the activity popover.
      task.lastStatus = 'failed';
      this.recordOutcome(task, error instanceof Error ? error.message : String(error));
    }

    // Preempted by the user: not a failure. Restore the pre-run status and retry
    // after idle, bounded so a busy user can't ping-pong a task indefinitely. The
    // yielded attempt's thread is disposed of like any other run's (kept only if
    // it had already notified); the retry gets a fresh one.
    if (run.preempted) {
      const n = (this.requeueCounts.get(id) ?? 0) + 1;
      if (n <= MAX_REQUEUES) {
        this.requeueCounts.set(id, n);
        await work?.finish('aborted');
        this.activeRun = null;
        activity.end(handle, { worked: false });
        await this.disposeRunThread(run, reflection);
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

    // First failure after a run that did not fail: one mail, with the reason.
    // Before the work record closes, so the mail can adopt it (attachScheduledWork
    // finds the record by the run's thread while it is still active); the thread
    // is then kept for the mail, like a notifying run's.
    if (task.lastStatus === 'failed' && prevStatus !== 'failed' && this.opts.onFailureTransition) {
      await this.opts
        .onFailureTransition({
          taskId: task.id,
          title: task.title,
          ...(run.threadId ? { threadId: run.threadId } : {}),
          ...(resolved.personaId ? { personaId: resolved.personaId } : {}),
          error: task.lastError ?? 'The run did not finish.'
        })
        .then(() => {
          run.notified = true;
        })
        .catch((err) => degrade('tasks', 'did not mail the user that a task started failing', err));
    }

    const reply = await work?.finish(task.lastStatus === 'ok' ? 'ok' : 'failed', task.lastError ?? undefined);
    // The notify said "the report is in the mail"; the report is this reply.
    // Only a run that notified has a mail to carry it, and only a clean
    // settle has a reply worth the name (a failed run's partial text is not).
    const resultItemId = work?.group?.notificationItemIds?.at(-1);
    if (!parked && !run.notified && run.threadId && task.lastStatus === 'ok' && this.opts.onUnreportedImages) {
      const mailed = await this.opts
        .onUnreportedImages({
          taskId: task.id,
          title: task.title,
          threadId: run.threadId,
          ...(resolved.personaId ? { personaId: resolved.personaId } : {}),
          ...(reply ? { reply } : {})
        })
        .catch((err) => {
          degrade('tasks', "did not mail a scheduled run's pictures", err);
          return false;
        });
      if (mailed) run.notified = true;
    }
    // A reply-less run can still have pictures made after its notify.
    if (!parked && resultItemId && run.notified && run.threadId && task.lastStatus === 'ok' && this.opts.onResult) {
      await this.opts
        .onResult({ taskId: task.id, threadId: run.threadId, itemId: resultItemId, result: reply ?? '' })
        .catch((err) => degrade('tasks', 'left a scheduled result out of its mail', err));
    }
    this.activeRun = null;
    if (task.lastStatus === 'failed') {
      activity.fail('tasks.run', 'Scheduled run failed', 'Running scheduled task');
    } else {
      activity.end(handle, { worked: true });
    }

    // The run is over. Whatever it found went out as mail, and the mail keeps
    // the thread it came from; a run that sent none leaves nothing behind.
    await this.disposeRunThread(run, reflection);

    task.lastRunAt = atIso;
    // The Runs list: a quiet run's thread is gone by now, so this is all it leaves.
    const failed = task.lastStatus === 'failed';
    const record: TaskRunRecord = {
      at: atIso,
      status: failed ? 'failed' : 'ok',
      ...(failed && task.lastError ? { error: task.lastError } : {}),
      ...(run.notified && run.threadId ? { threadId: run.threadId } : {}),
      ...(parked ? { parked: true } : {})
    };
    task.recentRuns = [record, ...(task.recentRuns ?? [])].slice(0, TASK_RECENT_RUNS);
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

  /** Mail a parked run's approval into its task conversation (the run's thread is kept for it). */
  private async mailPark(
    task: ScheduledTask,
    threadId: string | null,
    personaId: string | undefined,
    request: ParkRequest
  ): Promise<void> {
    if (!threadId || !this.opts.onParked) return;
    await this.opts
      .onParked({ taskId: task.id, title: task.title, threadId, ...(personaId ? { personaId } : {}), request })
      .catch((err) => degrade('tasks', 'parked a scheduled run without telling the user', err));
  }

  /**
   * The user answered a parked run: continue it on its own thread, through the
   * run queue like any firing (one scheduler-owned turn at a time), so its
   * notify_user still reaches mail. The body says what the user decided; the
   * run can park again, and its final reply is mailed to the task's conversation.
   */
  resumeParkedRun(taskId: string, threadId: string, body: string): Promise<void> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return Promise.reject(new Error('That scheduled task no longer exists.'));
    const resume = async (): Promise<void> => {
      const resolved = await this.resolveRunsAs(task);
      const run: ActiveRun = { taskId, threadId, turnId: null, preempted: false, notified: true };
      this.activeRun = run;
      try {
        const started = await this.opts.runtime.startTurn({
          turnId: randomUUID(),
          threadId,
          input: body,
          ...resolved.extras,
          webSearch: true,
          scheduled: { at: new Date().toISOString(), taskId, resumed: true }
        });
        if (!started.turnId) return;
        run.turnId = started.turnId;
        const settle = await this.waitForSettle(started.turnId, threadId);
        if (settle.status === 'parked') {
          await this.mailPark(task, threadId, resolved.personaId, settle.parked!);
          return;
        }
        const reply = settle.status === 'ok' ? (await this.opts.runtime.readWorkHistory?.(threadId))?.at(-1)?.finalText : undefined;
        if (reply?.trim() && this.opts.onResumedReply) {
          await this.opts.onResumedReply({
            taskId,
            title: task.title,
            threadId,
            ...(resolved.personaId ? { personaId: resolved.personaId } : {}),
            reply
          });
        }
        if (settle.status === 'failed') this.recordOutcome(task, settle.error ?? 'The resumed run did not finish.');
      } catch (error) {
        degrade('tasks', 'could not resume a parked scheduled run', error);
      } finally {
        this.activeRun = null;
      }
    };
    this.queue = this.queue.then(resume, resume);
    return Promise.resolve();
  }

  /**
   * Delete the run's fresh thread unless a mail now points at it (a notify or a
   * failure mail — `notified` covers both). A pending reflection reads the
   * thread's transcript, so the delete waits for it; the wait is not awaited
   * here, because a reflection is a model call and the queue must move on.
   */
  private async disposeRunThread(run: ActiveRun, reflection?: Promise<void>): Promise<void> {
    const threadId = run.threadId;
    if (!threadId || run.notified) return;
    const deleteThread = this.opts.deleteThread ?? ((id: string) => this.opts.runtime.deleteThread(id));
    const remove = () =>
      deleteThread(threadId).catch((err) =>
        // The thread is hidden from every list either way (nothing points at
        // it); what an undeleted one costs is disk, and a session file the next
        // scan still finds.
        degrade('tasks', 'left a silent scheduled run\'s thread behind', err)
      );
    if (reflection) void reflection.then(remove, remove);
    else await remove();
  }

  /** Resolve when the given turn settles (completed/failed/aborted), via backend events.
   *  A failure carries the turn's terminal error text (when the backend reported one).
   *  `threadId` is the run's own thread, for events that carry no turn id and for
   *  attributing a worker's death; null when the backend named none. */
  private waitForSettle(
    turnId: string,
    threadId: string | null
  ): Promise<{ status: 'ok' | 'failed' | 'parked'; error?: string; parked?: ParkRequest }> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (status: 'ok' | 'failed' | 'parked', error?: string, parked?: ParkRequest) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        this.opts.runtime.off('event', onEvent);
        resolve({ status, ...(error ? { error } : {}), ...(parked ? { parked } : {}) });
      };
      const onEvent = (event: BackendEventEnvelope) => {
        // A process exit is attributed: its threadId names the turn the dying
        // worker was carrying (null when it sat idle). Only OUR thread's death
        // fails this run — an idle pool worker's retirement must not fail a run
        // streaming on another worker. An unattributed exit (an older backend)
        // still fails conservatively, or the queue stays wedged until the 15m cap.
        if (event.method === 'process/exit') {
          const p = event.params as { threadId?: string | null } | undefined;
          const attributed = !!p && 'threadId' in p;
          if (!attributed || (p.threadId != null && p.threadId === threadId)) finish('failed');
          return;
        }
        const p = event.params as
          | { threadId?: string; turn?: { id?: string }; error?: string; parked?: ParkRequest }
          | undefined;
        // Match the turn id when present; a thread-only event counts when it
        // names our thread.
        const matches = p?.turn?.id ? p.turn.id === turnId : threadId !== null && p?.threadId === threadId;
        if (!matches) return;
        // Stopped for the user's Allow/Deny (PiRuntime.parkTurn): not a failure.
        const terminal = event.method === 'turn/completed' || event.method === 'turn/failed' || event.method === 'turn/aborted';
        if (terminal && p?.parked) finish('parked', undefined, p.parked);
        else if (event.method === 'turn/completed') finish('ok');
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
          void this.opts.interrupt(turnId, 'the scheduled run timed out').catch((err) =>
            degrade('tasks', 'left a timed-out run occupying the foreground gate', err)
          );
        }
        finish('failed');
      }, RUN_TIMEOUT_MS);
      this.opts.runtime.on('event', onEvent);
    });
  }
}
