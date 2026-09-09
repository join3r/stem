import { useEffect, useState } from 'react';
import type { MailWorkActivity, MailWorkGroup, MailWorkRun, Persona } from '../../shared/types';
import { personaName } from './useMail';

function validTimestamp(at: number): boolean {
  return at > 0 && Number.isFinite(new Date(at).getTime());
}

function duration(start: number, end: number): string {
  if (!validTimestamp(start) || !validTimestamp(end)) return 'Duration unavailable';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const outcome = { running: 'Working', ok: 'Completed', failed: 'Failed', aborted: 'Stopped', error: 'Failed' };

function WorkTime({ at, compact = false }: { at: number; compact?: boolean }) {
  if (!validTimestamp(at)) return <span>Time unavailable</span>;
  const date = new Date(at);
  return <time dateTime={date.toISOString()} title={date.toLocaleString()}>
    {compact ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : date.toLocaleString()}
  </time>;
}

function Activity({ activity, now }: { activity: MailWorkActivity; now: number }) {
  const hasDetails = activity.input !== undefined || activity.output !== undefined;
  const row = <>
    <WorkTime at={activity.at} compact />
    <span className="mail-work-label">{activity.label}</span>
    <span className={`mail-work-status ${activity.status}`}>{activity.kind === 'progress' && activity.status === 'ok' ? 'Update' : outcome[activity.status]}</span>
    {(activity.endedAt !== undefined || activity.status === 'running') && <span className="mail-work-duration">
      {duration(activity.at, activity.endedAt ?? now)}
    </span>}
  </>;
  return <li className={`mail-work-activity${activity.parentId ? ' nested' : ''}`}>
    {hasDetails ? <details>
      <summary className="mail-work-action">{row}</summary>
      <div className="mail-work-details">
        {activity.input !== undefined && <><h5>Input</h5><pre>{activity.input || '(empty)'}</pre></>}
        {activity.output !== undefined && <><h5>{activity.kind === 'progress' ? 'Progress' : 'Output'}</h5><pre>{activity.output || '(empty)'}</pre></>}
      </div>
    </details> : <div className="mail-work-action">{row}</div>}
  </li>;
}

function Run({ run, index, now }: { run: MailWorkRun; index: number; now: number }) {
  return <section className="mail-work-run" aria-label={`Run ${index + 1}`}>
    <div className="mail-work-run-head">
      <strong>Run {index + 1}</strong>
      <WorkTime at={run.startedAt} />
      <span className={`mail-work-status ${run.status}`}>{outcome[run.status]}</span>
      <span>{run.endedAt !== undefined || run.status === 'running'
        ? duration(run.startedAt, run.endedAt ?? now) : 'Duration unavailable'}</span>
    </div>
    {run.error && <p className="mail-work-error">{run.error}</p>}
    {run.activities.length ? <ol className="mail-work-activities">
      {run.activities.map((activity) => <Activity key={activity.id} activity={activity} now={now} />)}
    </ol> : <p className="mail-work-note">{run.status === 'running' ? 'Waiting for the first recorded activity…' : 'No activity details were saved for this run.'}</p>}
  </section>;
}

/** Native details keep each disclosure open across live updates of the same run. */
export function MailWork({ group, personas, unlinked = false }: { group: MailWorkGroup; personas: Persona[]; unlinked?: boolean }) {
  const [now, setNow] = useState(Date.now);
  const [expanded, setExpanded] = useState(false);
  const running = group.runs.some((run) => run.status === 'running');
  useEffect(() => {
    if (!running || !expanded) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [running, expanded]);
  const byPersona = new Map<string, MailWorkRun[]>();
  for (const run of group.runs) {
    const runs = byPersona.get(run.personaId) ?? [];
    runs.push(run);
    byPersona.set(run.personaId, runs);
  }
  const failedCount = group.runs.filter((run) => run.status === 'failed').length;
  const stoppedCount = group.runs.filter((run) => run.status === 'aborted').length;
  const status = running ? 'Working' : failedCount ? `Finished · ${failedCount} failed ${failedCount === 1 ? 'run' : 'runs'}`
    : stoppedCount ? `Stopped · ${stoppedCount} ${stoppedCount === 1 ? 'run' : 'runs'}` : group.runs.length ? 'Completed' : 'History';
  const activityCount = group.runs.reduce((count, run) => count + run.activities.length, 0);
  return <details className="mail-work" onToggle={(event) => {
    if (event.target !== event.currentTarget) return;
    setExpanded(event.currentTarget.open);
    if (event.currentTarget.open) setNow(Date.now());
  }}>
    <summary className="mail-work-summary">
      <strong>Work</strong>
      <span className={running ? 'mail-work-live' : ''}>{status}</span>
      <span>{group.runs.length} {group.runs.length === 1 ? 'run' : 'runs'} · {activityCount} {activityCount === 1 ? 'activity' : 'activities'}</span>
      {group.historical && <span>Recovered history</span>}
    </summary>
    <div className="mail-work-content">
      {unlinked && <p className="mail-work-note">This work could not be linked reliably to an individual mail.</p>}
      {group.gaps?.map((gap, index) => <p key={index} className="mail-work-note">{gap}</p>)}
      {[...byPersona].map(([personaId, runs]) => <section className="mail-work-persona" key={personaId}>
        <h4>{personaName(personas, personaId)}</h4>
        {runs.map((run, index) => <Run key={run.id} run={run} index={index} now={now} />)}
      </section>)}
    </div>
  </details>;
}
