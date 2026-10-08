import type { ParkRequest } from '../backend/types';
import { TaskScheduler } from '../scheduler';
import { rewriteTaskPrompt } from '../scheduler/rewrite';
import { reflectOnDelivery } from '../mail/reflect';
import { degrade } from '../degrade';
import { pushTaskAlert } from '../push';
import { readSettings } from '../workspace/settings';
import { dropChatThread } from '../chatsearch/index-sync';
import type { ChatBackend } from '../backend';
import type { GeneratedImageRef, ScheduledRunReport } from '../../shared/types';

/**
 * Scheduled tasks: re-run a prompt as an autonomous turn on a cron/once
 * schedule, each firing in a fresh thread. The scheduler owns timing +
 * execution; the backend routes the assistant's schedule_task/notify_user tools
 * to it via the TaskBridge wired here, and everything a run has to say reaches
 * the user as mail.
 */
/** How many earlier firings a run is told about; older ones are the user's to re-raise. */
const PRIOR_REPORTS_SHOWN = 8;

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
   * Land a run's message in the mail Inbox, grouped per task. This is how a
   * scheduled result surfaces: a notify_user mid-run, or the one notice that a
   * task started failing. `threadId` is the run's own thread; the mail keeps it
   * (and its Work record) so the run stays inspectable. Answers the
   * conversation id.
   */
  deliverTaskMail: (input: {
    subject: string;
    body: string;
    taskId: string;
    /** The persona the run executed as (schedule-as-persona): the mail's sender. */
    personaId?: string;
    threadId?: string;
    /** The notify_user title, when given — this firing's own headline. */
    headline?: string;
    /** Pictures to carry; absent = whatever the run's thread made since the last take. */
    images?: GeneratedImageRef[];
    /** A parked run's Allow/Deny, carried on the item. */
    park?: ParkRequest;
  }) => Promise<string | void>;
  /**
   * The run behind a notification settled with a reply: put it on that mail.
   * Optional so a host without mail (tests) can leave results in Work.
   */
  attachTaskResult?: (input: { itemId: string; result: string; threadId?: string }) => Promise<void>;
  /**
   * The threads a task's mail-sending runs left behind (recorded on its mail
   * items as `runThreadId`), handed over for deletion when the task is deleted.
   * Optional for hosts without mail (tests).
   */
  taskRunThreadIds?: (taskId: string) => Promise<string[]>;
  /**
   * What a task's earlier runs already mailed (newest first, at most `limit`),
   * read into the next run's preamble so a watch task reports each finding
   * once. Optional for hosts without mail (tests).
   */
  taskMailHistory?: (taskId: string, limit: number) => Promise<ScheduledRunReport[]>;
}): TaskScheduler {
  // A run's thread got indexed for chat search when its turn landed, like any
  // thread; deleting it must forget that too, or the deleted run stays findable.
  const discardThread = async (threadId: string) => {
    await deps.runtime.deleteThread(threadId);
    dropChatThread(threadId);
  };
  const scheduler = new TaskScheduler({
    runtime: deps.runtime,
    onChange: (tasks) => deps.emit('tasks:changed', tasks),
    // Scheduled runs defer while the user is active, and an in-flight scheduled
    // run yields (preemptForUser) when the user sends a message.
    isUserActive: deps.isUserActive,
    interrupt: (turnId, reason) => deps.runtime.interruptTurn(turnId, reason),
    deleteThread: discardThread,
    // The only memory a run has of the task's earlier firings: what they mailed.
    ...(deps.taskMailHistory
      ? { priorReports: (taskId: string) => deps.taskMailHistory!(taskId, PRIOR_REPORTS_SHOWN) }
      : {}),
    // A persona run that settled ok reflects into the persona's memory, the
    // same pass a mail delivery gets (mail/reflect.ts never rejects).
    reflect: (args) => reflectOnDelivery(deps.runtime, args),
    // The run's reply joins the mail its notify_user opened — the Inbox then
    // holds the report or drafts, not a one-line pointer.
    ...(deps.attachTaskResult
      ? {
          onResult: (args: { itemId: string; result: string; threadId: string }) =>
            deps.attachTaskResult!({ itemId: args.itemId, result: args.result, threadId: args.threadId })
        }
      : {}),
    // A run that made pictures and never notified still mails them: deleting
    // its thread would delete the only copy, and nobody would ever see them.
    // A run stopped for the user's Allow/Deny: the approval is a mail from the
    // task, like its notify; the run's thread stays for the answer to resume.
    onParked: async (args) => {
      await deps.deliverTaskMail({
        subject: args.title,
        body:
          `This task paused: Stem's safety check would not run a command` +
          `${args.request.deviceLabel ? ` on ${args.request.deviceLabel}` : ''} without you. ` +
          'Allow it to let the run continue, or deny it.',
        taskId: args.taskId,
        threadId: args.threadId,
        ...(args.personaId ? { personaId: args.personaId } : {}),
        park: args.request
      });
    },
    onResumedReply: async (args) => {
      await deps.deliverTaskMail({
        subject: args.title,
        body: args.reply,
        taskId: args.taskId,
        threadId: args.threadId,
        ...(args.personaId ? { personaId: args.personaId } : {})
      });
    },
    onUnreportedImages: async (args) => {
      const images = deps.runtime.takeGeneratedImages(args.threadId);
      if (!images.length) return false;
      await deps.deliverTaskMail({
        subject: args.title,
        body: args.reply || 'Pictures from this run.',
        taskId: args.taskId,
        threadId: args.threadId,
        headline: args.title,
        images,
        ...(args.personaId ? { personaId: args.personaId } : {})
      });
      return true;
    },
    // A task that starts failing says so once, as mail — the Tasks tab row keeps
    // the reason after that. Inbox only: this is Stem's notice, not the agent's
    // own notify_user judgment, so no window is raised and no phone woken.
    onFailureTransition: async (args) => {
      await deps.deliverTaskMail({
        subject: args.title,
        body: `This task failed on its latest run:\n\n${args.error}\n\nIt will try again on its next schedule. Repeated failures are shown on the task's row in the Tasks tab, not mailed.`,
        taskId: args.taskId,
        headline: `Failed: ${args.title}`,
        ...(args.threadId ? { threadId: args.threadId } : {}),
        ...(args.personaId ? { personaId: args.personaId } : {})
      });
    },
    // Tasks from before runs had threads of their own get their prompts
    // rewritten to stand alone, once, and the user gets one mail saying which.
    rewriteForFreshThreads: (task) => rewriteTaskPrompt(deps.runtime, task),
    onRewritten: async ({ rewritten, untouched }) => {
      const lines = [
        'Scheduled runs now start in a thread of their own, with no view of the chat they were scheduled from. Prompts written for the old behaviour could lean on that chat ("compare with earlier reports in this conversation"), so Stem rewrote them to stand alone.',
        ''
      ];
      if (rewritten.length) {
        lines.push(`Rewritten (${rewritten.length}):`);
        for (const t of rewritten) lines.push(`- ${t.title}`);
        lines.push('', 'Each rewritten task shows its previous prompt in the Tasks tab, with a Revert. Please read the new prompts once — the rewrite keeps the task\'s purpose, but only you know what it was meant to do.');
      }
      if (untouched.length) {
        lines.push('', `Left as they were (${untouched.length}) — the chat could not be read, or the prompt was already self-contained:`);
        for (const t of untouched) lines.push(`- ${t.title}`);
        lines.push('', 'If one of these refers to its chat, edit its prompt in the Tasks tab so each run has everything it needs.');
      }
      await deps.deliverTaskMail({
        subject: 'Scheduled task prompts rewritten',
        body: lines.join('\n'),
        taskId: 'tasks:rewrite',
        headline: 'Scheduled task prompts rewritten'
      });
    },
    ...(deps.taskRunThreadIds
      ? {
          onTaskDeleted: async (taskId: string) => {
            const ids = await deps.taskRunThreadIds!(taskId);
            await Promise.all(
              ids.map((id) =>
                discardThread(id).catch((err) =>
                  // Hidden from every list already; an undeleted one costs disk.
                  degrade('tasks', 'left a deleted task\'s run thread on disk', err)
                )
              )
            );
          }
        }
      : {})
  });
  deps.runtime.setTaskBridge({
    // schedule_task binds the task to wherever it was called — a chat or a mail
    // persona's hidden session. Either works: no run ever writes there.
    schedule: async (req, threadId) => scheduler.create(req, threadId),
    listForThread: async (threadId) => scheduler.listForThread(threadId),
    originThread: (taskId) => scheduler.snapshot().find((t) => t.id === taskId)?.threadId ?? null,
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
    // What every mode keeps is the mail: once it has landed, noteNotify records
    // that this run found something, so its reply joins the mail once the run
    // settles, and its thread is kept for the mail to point at. That is the
    // whole of `inbox` mode — there is nothing extra to emit.
    notify: async ({ title, message }, threadId) => {
      // The Inbox half, in every mode: a scheduled run's notify_user is a mail
      // from the task, grouped with the task's earlier firings. Only for a run
      // actually in flight — an interactive turn calling notify_user has the
      // user right there, and a mail about it would be a copy of the reply.
      const running = scheduler.runningTask(threadId);
      let conversationId: string | void = undefined;
      if (running) {
        conversationId = await deps
          .deliverTaskMail({
            subject: title?.trim() || running.title,
            body: message,
            taskId: running.id,
            threadId,
            ...(title?.trim() ? { headline: title.trim() } : {}),
            ...(running.runsAs.kind === 'persona' ? { personaId: running.runsAs.personaId } : {})
          })
          .catch((err) =>
            // The mail IS the surfacing — an undelivered one is a watch
            // task that found something and told nobody but the modal (if the
            // mode even shows one).
            degrade('tasks', 'dropped a scheduled result on the way to the Inbox', err)
          );
        // Only a mail that landed keeps the thread: a notified flag with no
        // mail item naming the thread would leave a session nothing points at,
        // never listed and never deleted.
        if (conversationId) scheduler.noteNotify(threadId);
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
      if (running) pushTaskAlert({ threadId, taskId: running.id, label: running.title, ...(conversationId ? { conversationId } : {}) });
      if (mode === 'alert') deps.revealMainWindow();
      deps.requestAttention();
      if (mode === 'nudge') return;
      deps.emit('tasks:notify', {
        threadId,
        ...(running ? { taskId: running.id } : {}),
        ...(conversationId ? { conversationId } : {}),
        title,
        message,
        at: new Date().toISOString()
      });
    }
  });
  return scheduler;
}
