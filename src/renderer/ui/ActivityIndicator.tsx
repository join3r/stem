import { useEffect, useRef, useState } from 'react';
import { Activity, Square } from 'lucide-react';
import type { ActivityEntry, ActivitySnapshot } from '../../shared/types';

// Toolbar background-activity indicator. Always mounted — that is the whole
// anti-flicker strategy: an icon that never appears or disappears can't shift
// layout, so short jobs need no debounce-before-showing. The only timing rule is
// that the pulse finishes its cycle (see `pulsing` below), which keeps a 40 ms
// job from registering as a single-frame twitch.
//
// Motion means work is in flight; colour is reserved for health, so a failure
// can never be mistaken for activity. Mostly read-only: pausing and retrying
// live next to the thing being paused, not here. The one exception is mail —
// its work happens entirely out of sight, so a mail row is the natural place
// to reach it: clicking opens the conversation, and a running row carries the
// same Stop control as the conversation header.

const EMPTY: ActivitySnapshot = { running: [], history: [], unseenFailure: false };

/** How many history rows before "show more". */
const COLLAPSED_ROWS = 10;

function formatDuration(ms: number): string {
  // Sub-second passes are common (a folder rescan with nothing new); rounding
  // them up to "1s" would overstate work that effectively didn't happen.
  if (ms < 1_000) return '<1s';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function formatAgo(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** Row-level open handler: only mail rows carry a conversation to open. */
function openProps(
  entry: ActivityEntry,
  onOpenMail?: (conversationId: string) => void
): Partial<React.LiHTMLAttributes<HTMLLIElement>> {
  const id = entry.conversationId;
  if (!id || !onOpenMail) return {};
  return {
    className: ' activity-row-openable',
    onClick: () => onOpenMail(id),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpenMail(id);
      }
    },
    role: 'button',
    tabIndex: 0,
    title: 'Open this mail conversation'
  };
}

function RunningRow({
  entry,
  onOpenMail
}: {
  entry: ActivityEntry;
  onOpenMail?: (conversationId: string) => void;
}) {
  const pct = entry.progress && entry.progress.total > 0
    ? Math.min(100, Math.round((entry.progress.done / entry.progress.total) * 100))
    : null;
  const open = openProps(entry, onOpenMail);
  return (
    <li {...open} className={`activity-row activity-row-running${open.className ?? ''}`}>
      <span className="activity-row-dot" aria-hidden="true" />
      <span className="activity-row-body">
        <span className="activity-row-label">{entry.label}</span>
        {entry.progress ? (
          <span className="activity-row-detail">
            {entry.progress.done.toLocaleString()}/{entry.progress.total.toLocaleString()}
          </span>
        ) : (
          entry.detail && <span className="activity-row-detail">{entry.detail}</span>
        )}
      </span>
      {pct !== null && (
        <span className="activity-bar" aria-hidden="true">
          <span className="activity-bar-fill" style={{ width: `${pct}%` }} />
        </span>
      )}
      {entry.conversationId && (
        <button
          className="icon-action sm mail-stop activity-row-stop"
          title="Stop — drop queued deliveries and interrupt the running personas"
          aria-label="Stop this mail conversation"
          onClick={(e) => {
            // The row itself opens the conversation; stopping must not.
            e.stopPropagation();
            void window.stem.stopMail(entry.conversationId!).catch(() => {
              // quiet: a conversation that finished in the meantime has
              // nothing left to stop — the next snapshot removes the row.
            });
          }}
        >
          <Square size={11} />
        </button>
      )}
    </li>
  );
}

function HistoryRow({
  entry,
  onOpenMail
}: {
  entry: ActivityEntry;
  onOpenMail?: (conversationId: string) => void;
}) {
  const failed = entry.state === 'failed';
  const open = openProps(entry, onOpenMail);
  return (
    <li {...open} className={`activity-row${failed ? ' activity-row-failed' : ''}${open.className ?? ''}`}>
      <span className="activity-row-body">
        <span className="activity-row-label">{entry.label}</span>
        {(failed || entry.detail) && (
          <span className="activity-row-detail">{failed ? entry.error ?? 'Failed' : entry.detail}</span>
        )}
      </span>
      <span className="activity-row-meta">
        {failed ? formatAgo(entry.startedAt) : `${formatDuration(entry.activeMs)} · ${formatAgo(entry.startedAt)}`}
      </span>
    </li>
  );
}

export function ActivityIndicator({
  onOpenMail
}: {
  /** Open a mail conversation in the centre pane (mail rows are doorways). */
  onOpenMail?: (conversationId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(EMPTY);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.stem.getActivity().then(setSnapshot);
    return window.stem.onActivity(setSnapshot);
  }, []);

  const running = snapshot.running.length > 0;

  // Hold the pulse until the keyframe reaches an iteration boundary. Applying
  // the animation via a class that only ever flips on a cycle edge keeps phase
  // continuous across back-to-back jobs (they read as one sustained pulse) and
  // guarantees at least one full, readable cycle for a job that lasts a frame.
  const [pulsing, setPulsing] = useState(false);
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => {
    if (running) setPulsing(true);
  }, [running]);

  // Dismiss on outside mousedown / Escape — the ModelPicker popover contract.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    setOpen((wasOpen) => {
      if (!wasOpen) {
        setExpanded(false);
        // Opening acknowledges the failure marker; main clears it and pushes.
        void window.stem.markActivitySeen();
      }
      return !wasOpen;
    });
  };

  // Opening a mail conversation dismisses the popover — the centre pane now
  // shows the thing the row pointed at.
  const openMail = onOpenMail
    ? (conversationId: string) => {
        setOpen(false);
        onOpenMail(conversationId);
      }
    : undefined;

  const shown = expanded ? snapshot.history : snapshot.history.slice(0, COLLAPSED_ROWS);
  const hidden = snapshot.history.length - shown.length;
  const summary = running
    ? snapshot.running.length === 1
      ? snapshot.running[0].label
      : `${snapshot.running.length} background jobs running`
    : 'Nothing running';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        // `active` is the toolbar's shared "toggled on" treatment (as on the
        // inspector button); `pulse` is ours and carries only the animation.
        className={`tbtn activity-ind${pulsing ? ' pulse' : ''}${open ? ' active' : ''}`}
        aria-label="Background activity"
        aria-expanded={open}
        title={open ? undefined : summary}
        onClick={toggle}
        onAnimationIteration={() => {
          if (!runningRef.current) setPulsing(false);
        }}
      >
        <Activity size={17} />
        {snapshot.unseenFailure && <span className="activity-ind-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div ref={popRef} className="activity-pop" role="dialog" aria-label="Background activity">
          <div className="activity-pop-head">Background activity</div>
          {running && (
            <ul className="activity-list">
              {snapshot.running.map((e) => (
                <RunningRow key={e.id} entry={e} onOpenMail={openMail} />
              ))}
            </ul>
          )}
          {snapshot.history.length === 0 && !running && (
            <p className="activity-empty">
              Nothing has run yet. Stem indexes, embeds and distils in the background when you
              are idle — anything it does will be listed here.
            </p>
          )}
          {snapshot.history.length > 0 && (
            <>
              {running && <div className="activity-pop-sub">Recent</div>}
              <ul className="activity-list">
                {shown.map((e) => (
                  <HistoryRow key={e.id} entry={e} onOpenMail={openMail} />
                ))}
              </ul>
              {hidden > 0 && (
                <button className="link-btn activity-more" onClick={() => setExpanded(true)}>
                  Show {hidden} more
                </button>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
