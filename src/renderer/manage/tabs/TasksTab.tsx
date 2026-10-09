import { useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, Clock, ExternalLink, Loader, Mail, MessageSquare, Play, Trash2 } from 'lucide-react';
import type {
  MailItem,
  ModelSummary,
  Persona,
  ScheduledTask,
  TaskRunsAs,
  TaskSchedule
} from '../../../shared/types';
import { describeCron, isValidCron } from '../../../shared/cron';
import {
  AttentionBar,
  Chip,
  ConfirmDelete,
  DetailFooter,
  DetailHeader,
  DetailIdent,
  DetailTabs,
  Field,
  Glyph,
  ListGroup,
  ListHeader,
  ListRow,
  ListSearch
} from '../ListDetail';
import { ModelPicker } from '../../ui/ModelPicker';
import { clampEffort, effortsOf, EffortSelect } from '../../ui/EffortSelect';
import { EFFORT_LABELS } from '../../modelLabels';

// ---- Tasks tab: scheduled autonomous re-runs ----
//
// A row's face is the task's title, its schedule in words, who it runs as, and
// when it runs next; rows are grouped Needs attention / Upcoming / Paused.
// Opening one replaces the list with its editor — Prompt / Schedule / Runs —
// written on Save. The Runs list is the task's own log of its last firings
// (recentRuns), since a run that mails nothing leaves no thread behind. The prompt used to BE the
// row (clamped to three lines, unclamped on click), which in the 320px rail
// turned a paragraph-long watch task into a screen of text with the controls
// scrolled out of sight, and left the persona picker folded behind a chip
// nobody found.

/** "as Critic" / "GPT-5.6 Sol · High" / "App default" — who and what a run of
 *  this task executes as. The collapsed face of the editor. */
function runsOnLabel(task: ScheduledTask, models: ModelSummary[], personas: Persona[]): string {
  const runsAs = task.runsAs;
  if (runsAs.kind === 'persona') return `as ${personas.find((p) => p.id === runsAs.personaId)?.name ?? runsAs.personaId}`;
  if (runsAs.kind === 'model') {
    const m = models.find((x) => x.id === runsAs.model);
    const name = m ? m.displayName : runsAs.model.split('/').pop() ?? runsAs.model;
    return runsAs.effort ? `${name} · ${EFFORT_LABELS[runsAs.effort] ?? runsAs.effort}` : name;
  }
  return 'App default';
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

/** What a run's row in the Runs list links to: the mail it sent, when there is one. */
interface RunMail {
  conversationId: string;
  subject: string;
}

/** The form: prompt, schedule text, and who it runs as. Written on Save. */
interface TaskDraft {
  prompt: string;
  schedule: string;
  /** 'default' | 'model' | 'persona:<id>' */
  runsAs: string;
  model: string | null;
  effort: string | null;
}

function taskDraftOf(t: ScheduledTask): TaskDraft {
  return {
    prompt: t.prompt,
    schedule: scheduleDraftOf(t.schedule),
    runsAs: t.runsAs.kind === 'persona' ? `persona:${t.runsAs.personaId}` : t.runsAs.kind,
    model: t.runsAs.kind === 'model' ? t.runsAs.model : null,
    effort: t.runsAs.kind === 'model' ? t.runsAs.effort ?? null : null
  };
}

function runsAsOf(d: TaskDraft): TaskRunsAs | null {
  if (d.runsAs === 'default') return { kind: 'default' };
  if (d.runsAs.startsWith('persona:')) return { kind: 'persona', personaId: d.runsAs.slice('persona:'.length) };
  // "A model of its own" with none picked yet is not a choice that can be saved.
  if (!d.model) return null;
  return { kind: 'model', model: d.model, ...(d.effort ? { effort: d.effort } : {}) };
}

/** "Weekdays at 08:00" when the cron reads plainly, else the expression; "Once, Jul 1, 08:00". */
function scheduleWords(s: TaskSchedule): string {
  if (s.kind === 'cron') return describeCron(s.expr) ?? `cron ${s.expr}`;
  return `Once, ${formatWhen(s.at)}`;
}

type TaskTab = 'prompt' | 'schedule' | 'runs';

export function TasksTab({
  onOpenChat,
  onOpenMail,
  onNewChat,
  mailItems,
  models
}: {
  onOpenChat: (threadId: string) => void;
  /** Tasks are made in a chat: "New in chat" opens one. */
  onNewChat: () => void;
  /** Open a mail conversation in the Inbox (the Runs list links a run to the mail it sent). */
  onOpenMail: (conversationId: string) => void;
  mailItems: MailItem[];
  models: ModelSummary[];
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  // For the "runs as" persona pin: the registry, loaded once per visit.
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<TaskTab>('prompt');
  // Prompt, schedule and runs-as are typed then written on Save: a half-typed
  // cron must not arm anything, and a prompt saved per keystroke would rewrite
  // tasks.json per character.
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [saving, setSaving] = useState(false);
  // The reason a save was refused (an unreachable cron, a datetime in the past).
  const [error, setErrorText] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    window.stem.listTasks().then(setTasks);
    void window.stem.listPersonas().then(setPersonas);
    // Stay in sync as runs fire / the assistant schedules new tasks.
    return window.stem.onTasksChanged(setTasks);
  }, []);

  // The scheduler's own words, without Electron's "Error invoking remote
  // method '…': Error:" wrapper (same strip as ServerFolderPicker).
  const setError = (err: unknown | null) =>
    setErrorText(
      err == null ? null : String((err as Error)?.message ?? err).replace(/^Error(?: invoking remote method '[^']*')?:\s*/, '') || null
    );

  function open(t: ScheduledTask, at?: TaskTab) {
    setDraft(taskDraftOf(t));
    setTab(at ?? (t.lastStatus === 'failed' ? 'runs' : 'prompt'));
    setOpenId(t.id);
    setError(null);
  }

  function back() {
    setOpenId(null);
    setDraft(null);
    setError(null);
  }

  const runNow = async (t: ScheduledTask) => setTasks(await window.stem.runTaskNow(t.id));
  const toggle = async (t: ScheduledTask) => setTasks(await window.stem.setTaskEnabled(t.id, !t.enabled));
  const remove = async (t: ScheduledTask) => {
    setTasks(await window.stem.deleteTask(t.id));
    back();
  };
  const revertRewrite = async (t: ScheduledTask) => {
    const next = await window.stem.revertTaskRewrite(t.id);
    setTasks(next);
    const fresh = next.find((x) => x.id === t.id);
    if (fresh && draft) setDraft({ ...draft, prompt: fresh.prompt });
  };

  /** Write what changed, one call per part; stops at the first refusal and keeps the form. */
  async function save(t: ScheduledTask, d: TaskDraft) {
    const base = taskDraftOf(t);
    setSaving(true);
    setError(null);
    try {
      let next = tasks;
      if (d.prompt !== base.prompt) next = await window.stem.updateTaskPrompt(t.id, { prompt: d.prompt });
      if (d.schedule !== base.schedule) {
        const schedule: TaskSchedule =
          t.schedule.kind === 'cron'
            ? { kind: 'cron', expr: d.schedule.trim() }
            : { kind: 'once', at: d.schedule ? new Date(d.schedule).toISOString() : '' };
        next = await window.stem.updateTaskSchedule(t.id, { schedule });
      }
      const runsAs = runsAsOf(d);
      if (runsAs && (d.runsAs !== base.runsAs || d.model !== base.model || d.effort !== base.effort)) {
        next = await window.stem.updateTaskRunsAs(t.id, { runsAs });
      }
      setTasks(next);
      const fresh = next.find((x) => x.id === t.id);
      if (fresh) setDraft(taskDraftOf(fresh));
    } catch (err) {
      setError(err);
      // Parts saved before the refusal are real; show them under the rest of the form.
      setTasks(await window.stem.listTasks());
    } finally {
      setSaving(false);
    }
  }

  /** Mail a kept run thread produced, by that thread — newest item wins. */
  const mailByThread = new Map<string, RunMail>();
  for (const i of mailItems) {
    if (!i.runThreadId || !i.taskId) continue;
    const seen = mailByThread.get(i.runThreadId);
    if (!seen) mailByThread.set(i.runThreadId, { conversationId: i.conversationId, subject: i.subject ?? '' });
  }

  function stateChip(t: ScheduledTask) {
    if (t.lastStatus === 'running') return <Chip tone="ok" icon={<Loader size={10} className="spin" />}>Running</Chip>;
    if (t.lastStatus === 'failed' && t.enabled) return <Chip tone="danger" icon={<AlertTriangle size={10} />} title={t.lastError}>Failed</Chip>;
    if (!t.enabled) return <Chip tone="off">Paused</Chip>;
    return t.nextRunAt ? <span className="ld-when">{relativeWhen(t.nextRunAt)}</span> : null;
  }

  const opened = openId ? tasks.find((t) => t.id === openId) : undefined;
  if (opened && draft) {
    const t = opened;
    const d = draft;
    const base = taskDraftOf(t);
    const dirty =
      d.prompt !== base.prompt ||
      d.schedule !== base.schedule ||
      ((d.runsAs !== base.runsAs || d.model !== base.model || d.effort !== base.effort) && runsAsOf(d) !== null);
    const valid =
      !!d.prompt.trim() && !!d.schedule.trim() && (t.schedule.kind !== 'cron' || isValidCron(d.schedule.trim()));
    const runs = t.recentRuns ?? [];
    const draftWords = t.schedule.kind === 'cron' ? describeCron(d.schedule.trim()) : null;
    return (
      <div className="ld-detail">
        <DetailHeader backLabel="Scheduled tasks" onBack={back}>
          <button
            type="button"
            className={`switch${t.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={t.enabled}
            aria-label="Active"
            title={t.enabled ? 'Pause' : 'Resume'}
            onClick={() => void toggle(t)}
          />
          <button
            type="button"
            className="icon-action sm"
            onClick={() => onOpenChat(t.threadId)}
            title="Open the chat this task was scheduled from"
            aria-label="Open chat"
          >
            <ExternalLink size={14} />
          </button>
          <button
            type="button"
            className="icon-action sm"
            onClick={() => void runNow(t)}
            title="Run now"
            aria-label="Run now"
            disabled={t.lastStatus === 'running'}
          >
            <Play size={14} />
          </button>
          <ConfirmDelete label="Delete task" icon={<Trash2 size={14} />} onConfirm={() => void remove(t)} />
        </DetailHeader>
        <DetailIdent
          glyph={<Glyph icon={t.schedule.kind === 'once' ? <CalendarClock size={17} /> : <Clock size={17} />} tone={t.lastStatus === 'failed' ? 'danger' : 'plain'} size="lg" />}
          name={<span className="ld-name-static">{t.title}</span>}
          caption={
            t.lastStatus === 'running'
              ? 'Running now…'
              : !t.enabled
                ? 'Paused'
                : `${scheduleWords(t.schedule)} · next ${formatWhen(t.nextRunAt)}`
          }
        />
        {t.lastStatus === 'failed' && (
          <div className="mcp-approval ld-failed">
            <span className="set-sub">Last run failed · {formatWhen(t.lastRunAt)}</span>
            <p className="muted">{t.lastError ?? 'The run did not finish.'}</p>
          </div>
        )}
        {error && <p className="task-failed">{error}</p>}
        <DetailTabs
          tabs={[
            { key: 'prompt', label: 'Prompt' },
            { key: 'schedule', label: 'Schedule' },
            { key: 'runs', label: 'Runs' }
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="ld-body">
          {tab === 'prompt' && (
            <>
              {/* The instruction every run re-executes. Scrolls inside its own box
                  past ~10 lines so a long watch task stays a form, not a page. */}
              <Field label="Prompt" htmlFor="task-prompt">
                <textarea
                  id="task-prompt"
                  className="ci-textarea task-prompt"
                  aria-label="Task prompt"
                  rows={7}
                  value={d.prompt}
                  onChange={(e) => setDraft({ ...d, prompt: e.target.value })}
                />
              </Field>
              {/* Stem rewrote this prompt when runs moved into threads of their
                  own. The old one stays readable here until the user makes the
                  prompt theirs — by reverting, or by saving an edit. */}
              {t.rewritten && d.prompt === t.prompt && (
                <details className="task-rewritten">
                  <summary className="muted">
                    Rewritten by Stem on {formatWhen(t.rewritten.at)} to stand alone — runs no longer see the chat.{' '}
                    <button
                      className="link-btn"
                      onClick={(e) => {
                        e.preventDefault();
                        void revertRewrite(t);
                      }}
                    >
                      Revert to the original
                    </button>
                  </summary>
                  <pre className="task-rewritten-original">{t.rewritten.original}</pre>
                </details>
              )}
              {/* Runs AS — one choice: a persona (its worker, role prompt, memory
                  and model settings; its mails arrive from it), a model of the
                  task's own, or the app default. Never a persona AND a model. */}
              <Field label="Runs as" htmlFor="task-runs-as">
                <select
                  id="task-runs-as"
                  className="vfield"
                  aria-label="Who or what this task runs as"
                  value={d.runsAs}
                  onChange={(e) => setDraft({ ...d, runsAs: e.target.value })}
                >
                  <option value="default">App default model</option>
                  <option value="model">A model of its own…</option>
                  {personas.length > 0 && (
                    <optgroup label="Personas">
                      {personas.map((p) => (
                        <option key={p.id} value={`persona:${p.id}`}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </Field>
              {d.runsAs === 'model' && (
                <Field label="Model">
                  <div className="task-model">
                    <ModelPicker
                      models={models}
                      value={d.model}
                      onChange={(id) =>
                        setDraft({ ...d, model: id, effort: id ? clampEffort(models, id, d.effort) ?? null : null })
                      }
                      emptyLabel="Choose a model"
                      ariaLabel="Model this task runs on"
                    />
                    <EffortSelect
                      label="Effort this task runs at"
                      value={d.effort}
                      efforts={effortsOf(models, d.model)}
                      emptyLabel="Model default"
                      onChange={(effort) => setDraft({ ...d, effort })}
                    />
                  </div>
                </Field>
              )}
            </>
          )}
          {tab === 'schedule' &&
            (t.schedule.kind === 'cron' ? (
              <>
                <Field label="Cron (minute · hour · day · month · weekday)" htmlFor="task-cron">
                  <input
                    id="task-cron"
                    className="vfield mono"
                    aria-label="Cron schedule"
                    value={d.schedule}
                    spellCheck={false}
                    onChange={(e) => setDraft({ ...d, schedule: e.target.value })}
                  />
                </Field>
                <p className="ld-hint">
                  {!isValidCron(d.schedule.trim())
                    ? 'Not a cron expression yet. Five fields, e.g. 0 8 * * 1-5 for weekdays at 08:00.'
                    : draftWords
                      ? `${draftWords}, in the Stem server’s time.`
                      : 'In the Stem server’s time.'}
                </p>
                {d.schedule === base.schedule && t.enabled && t.nextRunAt && (
                  <div className="ld-stat">
                    <Clock size={13} />
                    <span>
                      Next run <strong>{formatWhen(t.nextRunAt)}</strong>
                    </span>
                  </div>
                )}
              </>
            ) : (
              <>
                <Field label="Runs once at" htmlFor="task-once">
                  <input
                    id="task-once"
                    className="vfield"
                    type="datetime-local"
                    aria-label="Run once at"
                    value={d.schedule}
                    onChange={(e) => setDraft({ ...d, schedule: e.target.value })}
                  />
                </Field>
                <p className="ld-hint">After it runs, the task is removed.</p>
              </>
            ))}
          {tab === 'runs' && (
            <>
              {runs.length === 0 ? (
                <p className="ld-hint">
                  {t.lastRunAt
                    ? `Last run ${formatWhen(t.lastRunAt)}${t.lastStatus === 'failed' ? ' (failed)' : ''}. Earlier runs were not recorded; new ones appear here.`
                    : 'No runs yet.'}
                </p>
              ) : (
                <div className="ld-runs">
                  {runs.map((r) => {
                    const mail = r.threadId ? mailByThread.get(r.threadId) : undefined;
                    return (
                      <div key={r.at} className="ld-run">
                        <span className="ld-run-main">
                          <strong>{formatWhen(r.at)}</strong>
                          <em className={r.status === 'failed' ? 'failed' : undefined} title={r.error}>
                            {r.status === 'failed'
                              ? r.error ?? 'The run did not finish.'
                              : r.parked
                                ? 'Waiting for your approval in the Inbox'
                                : mail
                                  ? `Mailed: ${mail.subject || 'a report'}`
                                  : 'Nothing to report. No mail sent.'}
                          </em>
                        </span>
                        {mail ? (
                          <button type="button" className="ld-btn" onClick={() => onOpenMail(mail.conversationId)}>
                            <Mail size={12} /> Open
                          </button>
                        ) : (
                          <Chip tone={r.status === 'failed' ? 'danger' : 'ok'}>{r.status === 'failed' ? 'Failed' : 'OK'}</Chip>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="ld-hint">Each run starts fresh. A run that mails nothing leaves only this line.</p>
            </>
          )}
        </div>
        <DetailFooter
          dirty={dirty}
          saving={saving}
          canSave={valid}
          onCancel={back}
          onSave={() => void save(t, d)}
        />
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const shown = q ? tasks.filter((t) => t.title.toLowerCase().includes(q) || t.prompt.toLowerCase().includes(q)) : tasks;
  const byNext = (a: ScheduledTask, b: ScheduledTask) => (a.nextRunAt ?? '￿').localeCompare(b.nextRunAt ?? '￿');
  const groups: { key: string; label: string; items: ScheduledTask[] }[] = [
    { key: 'attention', label: 'Needs attention', items: shown.filter((t) => t.enabled && t.lastStatus === 'failed') },
    { key: 'upcoming', label: 'Upcoming', items: shown.filter((t) => t.enabled && t.lastStatus !== 'failed').sort(byNext) },
    { key: 'paused', label: 'Paused', items: shown.filter((t) => !t.enabled) }
  ];
  const failing = tasks.filter((t) => t.enabled && t.lastStatus === 'failed');
  const runsAsName = (t: ScheduledTask) => runsOnLabel(t, models, personas).replace(/^as /, '');

  return (
    <div className="ld-list">
      <ListHeader
        title="Scheduled tasks"
        newLabel="New in chat"
        templates={[
          {
            key: 'chat',
            icon: <MessageSquare size={12} />,
            label: 'Describe it in a chat',
            hint: 'Opens a new chat. Say what to do and when: “every weekday at 8, summarize my unread email”.',
            onPick: onNewChat
          }
        ]}
      />
      <ListSearch value={query} onChange={setQuery} placeholder="Find a task" />
      {failing.length > 0 && (
        <AttentionBar onClick={() => open(failing[0]!, 'runs')}>
          {failing.length === 1 ? `${failing[0]!.title} failed` : `${failing.length} tasks are failing`}
        </AttentionBar>
      )}
      {tasks.length === 0 ? (
        <p className="muted ld-empty">
          No scheduled tasks yet. Ask Stem in a chat to do something on a schedule — “every weekday at 8, summarize
          my unread email” or “check this page hourly and let me know if it changes”. Each run starts fresh, and
          anything worth seeing arrives as mail in your Inbox.
        </p>
      ) : (
        groups.map((g) =>
          g.items.length === 0 ? null : (
            <ListGroup key={g.key} label={g.label} count={g.items.length}>
              {g.items.map((t) => (
                <ListRow
                  key={t.id}
                  glyph={
                    <Glyph
                      icon={t.schedule.kind === 'once' ? <CalendarClock size={14} /> : <Clock size={14} />}
                      tone={t.enabled && t.lastStatus === 'failed' ? 'danger' : 'plain'}
                    />
                  }
                  name={t.title}
                  sub={`${scheduleWords(t.schedule)} · ${runsAsName(t)}`}
                  right={stateChip(t)}
                  dim={!t.enabled}
                  onOpen={() => open(t)}
                />
              ))}
            </ListGroup>
          )
        )
      )}
    </div>
  );
}

/** "in 23 min", "in 5 h", "tomorrow 08:00", or the date — for the row's next-run slot. */
function relativeWhen(iso: string): string {
  const d = new Date(iso);
  const ms = d.getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms < 60_000) return 'now';
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)} min`;
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(new Date())) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `tmrw ${time}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
