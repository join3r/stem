import { TaskScheduler } from '../scheduler';
import { reflectOnDelivery } from '../mail/reflect';
import { degrade } from '../degrade';
import { pushTaskAlert } from '../push';
import { noteSilentRun } from '../workspace/inbox';
import { readSettings } from '../workspace/settings';
import type { ChatBackend } from '../backend';

/**
 * Scheduled tasks: re-run a chat's prompt as an autonomous turn on a cron/once
 * schedule. The scheduler owns timing + execution; the backend routes the
 * assistant's schedule_task/notify_user tools to it via the TaskBridge wired
 * here.
 */
export function initTaskScheduler(deps: {
  runtime: ChatBackend;
  /** Push on a client channel — the task feed and notify_user alerts. */
  emit: (channel: string, payload: unknown) => void;
  /** Turn in flight on either surface, or interaction in the last couple of minutes. */
  isUserActive: () => boolean;
  /** Raise + focus the main window (notify_user prominence). */
  revealMainWindow: () => void;
  /** OS-level attention nudge (dock bounce / taskbar flash — see platform.ts). */
  requestAttention: () => void;
  /**
   * Land a notify_user's message in the mail Inbox, grouped per task. This is
   * how a scheduled result surfaces now that the Inbox is mail — the run's turn
   * still lives in its chat thread, but the thread no longer has an Inbox row
   * to go bold.
   */
  deliverTaskMail: (input: {
    subject: string;
    body: string;
    taskId: string;
    /** The persona the run executed as (schedule-as-persona): the mail's sender. */
    personaId?: string;
  }) => Promise<void>;
}): TaskScheduler {
  const scheduler = new TaskScheduler({
    runtime: deps.runtime,
    onChange: (tasks) => deps.emit('tasks:changed', tasks),
    onRun: (run) => deps.emit('tasks:run', run),
    // Scheduled runs defer while the user is active, and an in-flight scheduled
    // run yields (preemptForUser) when the user sends a message.
    isUserActive: deps.isUserActive,
    interrupt: (turnId, reason) => deps.runtime.interruptTurn(turnId, reason),
    // A persona run that settled ok reflects into the persona's memory, the
    // same pass a mail delivery gets (mail/reflect.ts never rejects).
    reflect: (args) => reflectOnDelivery(deps.runtime, args),
    // A run that found nothing still wrote a turn, which bumps the thread's
    // mtime — the read-state signal the CHATS TREE bolds rows by. (The Inbox is
    // mail now and never sees the thread; this absorber only keeps a quiet
    // watch task's chat row from going bold for a turn nobody took.)
    onSilentRun: (threadId, before, at) => {
      void noteSilentRun(threadId, before, at)
        .then(() => deps.emit('chats:changed', undefined))
        .catch((err) => {
          degrade('tasks', 'left a silent scheduled run showing as unread in the chats tree', err);
        });
    }
  });
  deps.runtime.setTaskBridge({
    schedule: (req, threadId) => scheduler.create(req, threadId),
    listForThread: async (threadId) => scheduler.listForThread(threadId),
    cancel: async (taskId) => {
      const before = scheduler.snapshot().length;
      await scheduler.remove(taskId);
      return scheduler.snapshot().length < before ? { ok: true } : { ok: false, error: 'No such task.' };
    },
    // notify_user: how loudly this lands is the user's call (settings.tasks.notify).
    // `alert`, the default, is the full treatment — raise + focus the main window,
    // nudge at the OS level (dock bounce / taskbar flash), and show the alert modal;
    // native OS notifications were judged not prominent enough for watch-style tasks.
    // `nudge` keeps only the OS nudge, `inbox` interrupts not at all.
    //
    // What every mode keeps is the Inbox: the noteNotify below is the run's
    // declaration that it found something, so its turn stays out of onSilentRun and
    // the chat surfaces as an unread row on its own. That is the whole of `inbox`
    // mode — there is nothing extra to emit, because a written turn is already the
    // signal the Inbox reads.
    notify: async ({ title, message }, threadId) => {
      scheduler.noteNotify(threadId);
      // The Inbox half, in every mode: a scheduled run's notify_user is a mail
      // from the task, grouped with the task's earlier firings. Only for a run
      // actually in flight — an interactive turn calling notify_user has the
      // user right there, and a mail about it would be a copy of the reply.
      const running = scheduler.runningTask(threadId);
      if (running) {
        await deps
          .deliverTaskMail({
            subject: title?.trim() || running.title,
            body: message,
            taskId: running.id,
            ...(running.personaId ? { personaId: running.personaId } : {})
          })
          .catch((err) =>
            // The mail IS the surfacing now — an undelivered one is a watch
            // task that found something and told nobody but the modal (if the
            // mode even shows one).
            degrade('tasks', 'dropped a scheduled result on the way to the Inbox', err)
          );
      }
      // Read per notification rather than once at wiring time: a task fires long
      // after startup, and the toggle must apply to the very next run.
      // quiet: readSettings answers with the defaults and degrades ('settings')
      // itself rather than rejecting, so this catch is for a rejection it has not
      // got — and 'alert', the default, is the mode that cannot be missed.
      const mode = (await readSettings().catch(() => null))?.tasks.notify ?? 'alert';
      if (mode === 'inbox') return;
      // Both louder modes wake a phone, and this is the line that says so: `alert`
      // and `nudge` differ only in how they disturb the machine at the desk, and a
      // phone in a pocket is not at the desk. `inbox` returned above — that mode's
      // whole meaning is "do not interrupt me", on any device.
      //
      // Above the emit rather than beside it, because `nudge` never reaches the
      // emit; the push is not the modal's travelling companion, it is the second
      // audience for the same alert. The label is the task's own name, never the
      // notification's title or message (see server/push).
      //
      // Only for a run that is actually in flight. `notify_user` is registered for
      // EVERY turn — "scheduled tasks only" is prompt guidance, not a gate — so an
      // ordinary interactive turn can call it, and then there is no task: the
      // phone would be told "a scheduled task has something for you" about
      // nothing, on top of the push that turn's own ending already sends. The
      // desktop half below still runs, because a model that asked for the user's
      // attention at the desk should get it either way.
      if (running) pushTaskAlert({ threadId, taskId: running.id, label: running.title });
      if (mode === 'alert') deps.revealMainWindow();
      deps.requestAttention();
      if (mode === 'nudge') return;
      deps.emit('tasks:notify', {
        threadId,
        title,
        message,
        at: new Date().toISOString()
      });
    }
  });
  return scheduler;
}
