import { useEffect, useState } from 'react';
import { Trash2, Play, Pause, ExternalLink } from 'lucide-react';
import type {
  ModelSummary,
  Persona,
  ScheduledTask,
  TaskSchedule,
  ThreadTurnSettings
} from '../../../shared/types';
import { ModelPicker } from '../../ui/ModelPicker';
import { clampEffort, effortsOf, EffortSelect } from '../../ui/EffortSelect';
import { EFFORT_LABELS } from '../../modelLabels';

// ---- Tasks tab: scheduled autonomous re-runs ----
//
// A row's face is the task's title, its schedule, and when it runs next. The
// whole task — the prompt every run re-executes, the schedule, who it runs as,
// and on what — is one editor the row expands into. The prompt used to BE the
// row (clamped to three lines, unclamped on click), which in the 320px rail
// turned a paragraph-long watch task into a screen of text with the controls
// scrolled out of sight, and left the persona picker folded behind a chip
// nobody found.

/** "as Critic · GPT-5.6 Sol · High" — what a run of this task will execute as
 *  and on: the persona's pins, else its own, else the model selected in its
 *  chat. The collapsed face of the editor. */
function runsOnLabel(
  task: ScheduledTask,
  thread: ThreadTurnSettings,
  models: ModelSummary[],
  personas: Persona[]
): string {
  const persona = task.personaId ? personas.find((p) => p.id === task.personaId) : undefined;
  const modelId = (persona ? persona.model : undefined) ?? task.model ?? thread.model;
  const m = modelId ? models.find((x) => x.id === modelId) : undefined;
  const name = modelId ? (m ? m.displayName : modelId.split('/').pop() ?? modelId) : 'Chat model';
  const effort = (persona ? persona.effort : undefined) ?? task.effort ?? thread.effort;
  const base = effort && modelId ? `${name} · ${EFFORT_LABELS[effort] ?? effort}` : name;
  if (task.personaId) return `as ${persona?.name ?? task.personaId} · ${base}`;
  return base;
}

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

/** The editor's text for a schedule: the cron expression, or a datetime-local value. */
function scheduleDraftOf(schedule: TaskSchedule): string {
  if (schedule.kind === 'cron') return schedule.expr;
  return toDatetimeLocal(schedule.at);
}

/** ISO → "YYYY-MM-DDTHH:mm" in local time, the value an <input type=datetime-local> takes. */
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  // One expansion per row: the title, the schedule line and the "runs as" chip
  // all open the same editor. Most visits are a glance at next-run times, so
  // every row starts folded.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Prompt and schedule are typed then saved explicitly (Save/Revert), like the
  // persona editor: a half-typed cron must not arm anything, and a prompt saved
  // on every keystroke would rewrite tasks.json per character.
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const [scheduleDrafts, setScheduleDrafts] = useState<Record<string, string>>({});
  // The reason a save was refused (an unreachable cron, a datetime in the past),
  // shown under the field it came from.
  const [errors, setErrors] = useState<Record<string, string>>({});

  // For the "runs as" persona pin: the registry, loaded once per visit.
  const [personas, setPersonas] = useState<Persona[]>([]);

  useEffect(() => {
    window.stem.listTasks().then(setTasks);
    void window.stem.listPersonas().then(setPersonas);
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

  // The scheduler's own words, without Electron's "Error invoking remote
  // method '…': Error:" wrapper (same strip as ServerFolderPicker).
  const setError = (id: string, err: unknown | null) =>
    setErrors((prev) => {
      const next = { ...prev };
      const message =
        err == null ? '' : String((err as Error)?.message ?? err).replace(/^Error(?: invoking remote method '[^']*')?:\s*/, '');
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });
  const dropDraft = (drafts: Record<string, string>, id: string) => {
    const next = { ...drafts };
    delete next[id];
    return next;
  };

  const toggle = async (t: ScheduledTask) => setTasks(await window.stem.setTaskEnabled(t.id, !t.enabled));
  const runNow = async (t: ScheduledTask) => setTasks(await window.stem.runTaskNow(t.id));
  const remove = async (t: ScheduledTask) => setTasks(await window.stem.deleteTask(t.id));
  const pinModel = async (t: ScheduledTask, model: string | null, effort: string | null) =>
    setTasks(await window.stem.updateTaskModel(t.id, { model, effort }));
  const pinPersona = async (t: ScheduledTask, personaId: string | null) =>
    setTasks(await window.stem.updateTaskPersona(t.id, { personaId }));
  const savePrompt = async (t: ScheduledTask) => {
    const prompt = promptDrafts[t.id];
    if (prompt === undefined) return;
    try {
      setTasks(await window.stem.updateTaskPrompt(t.id, { prompt }));
      setPromptDrafts((d) => dropDraft(d, t.id));
      setError(t.id, null);
    } catch (err) {
      setError(t.id, err);
    }
  };
  const saveSchedule = async (t: ScheduledTask) => {
    const draft = scheduleDrafts[t.id];
    if (draft === undefined) return;
    const schedule: TaskSchedule =
      t.schedule.kind === 'cron'
        ? { kind: 'cron', expr: draft.trim() }
        : { kind: 'once', at: draft ? new Date(draft).toISOString() : '' };
    try {
      setTasks(await window.stem.updateTaskSchedule(t.id, { schedule }));
      setScheduleDrafts((d) => dropDraft(d, t.id));
      setError(t.id, null);
    } catch (err) {
      setError(t.id, err);
    }
  };

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
            const isOpen = open.has(t.id);
            const promptDraft = promptDrafts[t.id] ?? t.prompt;
            const promptDirty = promptDrafts[t.id] !== undefined && promptDrafts[t.id] !== t.prompt;
            const scheduleDraft = scheduleDrafts[t.id] ?? scheduleDraftOf(t.schedule);
            const scheduleDirty =
              scheduleDrafts[t.id] !== undefined && scheduleDrafts[t.id] !== scheduleDraftOf(t.schedule);
            return (
            <div key={t.id} className={`task-item${t.enabled ? '' : ' paused'}${isOpen ? ' open' : ''}`}>
              <div className="task-head">
                <span className="row-main">
                  <strong
                    className="task-title"
                    onClick={() => toggleOpen(t.id)}
                    title={isOpen ? 'Collapse' : 'Show and edit this task'}
                  >
                    {t.title}
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
                {' · '}
                <button
                  className="task-runs-on"
                  onClick={() => toggleOpen(t.id)}
                  title="Who this task runs as and on what model — click to change"
                  aria-expanded={isOpen}
                >
                  {runsOnLabel(t, thread, models, personas)}
                </button>
              </div>
              {isOpen && (
              <div className="task-editor">
                {/* The instruction every run re-executes. Scrolls inside its own
                    box past ~10 lines so a long watch task stays a row, not a page. */}
                <label className="task-field">
                  <span className="task-field-label">Prompt</span>
                  <textarea
                    className="ci-textarea task-prompt"
                    aria-label="Task prompt"
                    rows={6}
                    value={promptDraft}
                    onChange={(e) => setPromptDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                  />
                </label>
                {promptDirty && (
                  <div className="push-row">
                    <button className="link-btn" onClick={() => setPromptDrafts((d) => dropDraft(d, t.id))}>
                      Revert
                    </button>
                    <button className="link-btn" onClick={() => savePrompt(t)} disabled={!promptDraft.trim()}>
                      Save prompt
                    </button>
                  </div>
                )}
                <label className="task-field">
                  <span className="task-field-label">
                    {t.schedule.kind === 'cron' ? 'Schedule (cron: minute hour day month weekday)' : 'Runs once at'}
                  </span>
                  {t.schedule.kind === 'cron' ? (
                    <input
                      className="vfield task-schedule"
                      aria-label="Cron schedule"
                      value={scheduleDraft}
                      spellCheck={false}
                      onChange={(e) => setScheduleDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                    />
                  ) : (
                    <input
                      className="vfield task-schedule"
                      type="datetime-local"
                      aria-label="Run once at"
                      value={scheduleDraft}
                      onChange={(e) => setScheduleDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                    />
                  )}
                </label>
                {scheduleDirty && (
                  <div className="push-row">
                    <button className="link-btn" onClick={() => setScheduleDrafts((d) => dropDraft(d, t.id))}>
                      Revert
                    </button>
                    <button className="link-btn" onClick={() => saveSchedule(t)} disabled={!scheduleDraft.trim()}>
                      Save schedule
                    </button>
                  </div>
                )}
                {errors[t.id] && <div className="task-error">{errors[t.id]}</div>}
                {/* Runs AS: a persona run gets the persona's worker, role prompt,
                    memory and pins — its model/effort win over the two pickers
                    below, which then only matter for a plain run. */}
                <label className="task-field">
                  <span className="task-field-label">Runs as</span>
                  <select
                    className="vfield task-persona"
                    aria-label="Persona this task runs as"
                    value={t.personaId ?? ''}
                    onChange={(e) => pinPersona(t, e.target.value || null)}
                  >
                    <option value="">Plain run (no persona)</option>
                    {personas.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                {/* The model a PLAIN run executes on. Unset = the pinless
                    inheritance every task starts with: the model selected in its
                    chat, named by the picker's "uses …" line so an outdated one
                    is visible right where it can be overridden. A persona's own
                    pins take precedence, which the field label says. */}
                <div className="task-field">
                  <span className="task-field-label">
                    {t.personaId ? 'Model (used only where the persona pins none)' : 'Model'}
                  </span>
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
              </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
