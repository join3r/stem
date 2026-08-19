import { useEffect, useState } from 'react';
import { Trash2, Play, Pause, ExternalLink } from 'lucide-react';
import type {
  ModelSummary,
  ScheduledTask,
  ThreadTurnSettings
} from '../../../shared/types';
import { ModelPicker } from '../../ui/ModelPicker';
import { clampEffort, effortsOf, EffortSelect } from '../../ui/EffortSelect';

// ---- Tasks tab: scheduled autonomous re-runs ----

/** Human-readable schedule, e.g. "cron 0 8 * * 1-5" or "once · Jul 1, 08:00". */
function describeSchedule(task: ScheduledTask): string {
  if (task.schedule.kind === 'cron') return `cron · ${task.schedule.expr}`;
  return `once · ${formatWhen(task.schedule.at)}`;
}

/** Compact local datetime, e.g. "Jul 1, 08:00". */
function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function TasksTab({
  onOpenChat,
  models
}: {
  onOpenChat: (threadId: string) => void;
  models: ModelSummary[];
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  // Each task runs on its thread's persisted model/effort — resolved lazily per
  // thread so the label stays honest after the user switches the chat's model.
  const [settings, setSettings] = useState<Record<string, ThreadTurnSettings>>({});
  // Task prompts can be long; show a clamped preview and let the row expand in place.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    window.stem.listTasks().then(setTasks);
    // Stay in sync as runs fire / the assistant schedules new tasks.
    return window.stem.onTasksChanged(setTasks);
  }, []);

  useEffect(() => {
    let stale = false;
    const ids = [...new Set(tasks.map((t) => t.threadId))];
    void Promise.all(
      ids.map(async (id) => [id, await window.stem.taskThreadSettings(id).catch(() => ({}))] as const)
    ).then((entries) => {
      if (!stale) setSettings(Object.fromEntries(entries));
    });
    return () => {
      stale = true;
    };
  }, [tasks]);

  const toggle = async (t: ScheduledTask) => setTasks(await window.stem.setTaskEnabled(t.id, !t.enabled));
  const runNow = async (t: ScheduledTask) => setTasks(await window.stem.runTaskNow(t.id));
  const remove = async (t: ScheduledTask) => setTasks(await window.stem.deleteTask(t.id));
  const pinModel = async (t: ScheduledTask, model: string | null, effort: string | null) =>
    setTasks(await window.stem.updateTaskModel(t.id, { model, effort }));

  return (
    <div>
      <div className="grp-head">Scheduled tasks</div>
      {tasks.length === 0 ? (
        <p className="muted">
          No scheduled tasks yet. Ask Stem in a chat to do something on a schedule — “every weekday
          at 8, summarize my unread email” or “check this page hourly and let me know if it changes”.
          The task runs in that chat and only interrupts you when there’s something worth seeing.
        </p>
      ) : (
        <div className="group">
          {tasks.map((t) => {
            const thread: ThreadTurnSettings = settings[t.threadId] ?? {};
            return (
            <div key={t.id} className={`task-item${t.enabled ? '' : ' paused'}`}>
              <div className="task-head">
                <span className="row-main">
                  <strong
                    className={`task-title${expanded.has(t.id) ? ' expanded' : ''}`}
                    onClick={() => toggleExpanded(t.id)}
                    title={expanded.has(t.id) ? 'Collapse' : 'Show the full task'}
                  >
                    {t.prompt}
                  </strong>
                  <em>{describeSchedule(t)}</em>
                </span>
                <button
                  className="icon-action sm"
                  onClick={() => onOpenChat(t.threadId)}
                  title="Open the chat this task runs in"
                  aria-label="Open chat"
                >
                  <ExternalLink size={14} />
                </button>
                <button
                  className="icon-action sm"
                  onClick={() => runNow(t)}
                  title="Run now"
                  aria-label="Run now"
                  disabled={t.lastStatus === 'running'}
                >
                  <Play size={14} />
                </button>
                <button
                  className="icon-action sm"
                  onClick={() => toggle(t)}
                  title={t.enabled ? 'Pause' : 'Resume'}
                  aria-label={t.enabled ? 'Pause' : 'Resume'}
                >
                  {t.enabled ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button
                  className="icon-action sm"
                  onClick={() => remove(t)}
                  title="Delete task"
                  aria-label="Delete task"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="task-meta muted">
                {t.lastStatus === 'running' ? (
                  <span className="task-running">Running now…</span>
                ) : (
                  <>
                    {t.enabled ? (
                      <span>Next: {formatWhen(t.nextRunAt)}</span>
                    ) : (
                      <span>Paused</span>
                    )}
                    {t.lastRunAt && (
                      <span>
                        {' · '}Last: {formatWhen(t.lastRunAt)}
                        {t.lastStatus === 'failed' && (
                          // The reason, not just the verdict: a row that says
                          // only "failed" leaves you nowhere to start.
                          <span className="task-failed" title={t.lastError ?? 'The run did not finish.'}>
                            {' (failed)'}
                          </span>
                        )}
                      </span>
                    )}
                  </>
                )}
              </div>
              {/* The model this task's runs execute on. Unset = the pinless
                  inheritance every task starts with: the model selected in its
                  chat, named by the picker's "uses …" line so an outdated one
                  is visible right where it can be overridden. */}
              <div className="task-model">
                <ModelPicker
                  models={models}
                  value={t.model ?? null}
                  onChange={(id) =>
                    pinModel(t, id, clampEffort(models, id ?? thread.model ?? null, t.effort ?? null))
                  }
                  emptyLabel="Chat model"
                  ariaLabel="Model this task runs on"
                  resolvedDefault={thread.model ?? null}
                />
                <EffortSelect
                  label="Effort this task runs at"
                  value={t.effort ?? null}
                  efforts={effortsOf(models, t.model ?? thread.model ?? null)}
                  emptyLabel="Chat effort"
                  resolved={thread.effort ?? null}
                  onChange={(effort) => pinModel(t, t.model ?? null, effort)}
                />
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
