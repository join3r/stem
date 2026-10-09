import { useEffect, useState } from 'react';
import { Trash2, RefreshCw } from 'lucide-react';
import { useOffline } from '../../hooks/useServerReachable';
import { InfoTip } from '../../ui/InfoTip';
import type {
  EpisodicStats,
  ThreadSummary,
  MemorySettings
} from '../../../shared/types';

// Episodic-store size caps. 0 = unlimited. Default is 100 MB (see the recall store).
const MB = 1024 * 1024;
const EPISODIC_PRESETS: { label: string; bytes: number }[] = [
  { label: '50 MB', bytes: 50 * MB },
  { label: '100 MB', bytes: 100 * MB },
  { label: '250 MB', bytes: 250 * MB },
  { label: 'Unlimited', bytes: 0 }
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

/** "May 3" or "May 3 – Jun 12" for a summary's covered window. */
function summaryDateRange(firstTs: number, lastTs: number): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const first = new Date(firstTs * 1000).toLocaleDateString(undefined, opts);
  const last = new Date(lastTs * 1000).toLocaleDateString(undefined, opts);
  return first === last ? last : `${first} – ${last}`;
}

/** One conversation summary: date range + text (clamped until clicked), delete with confirm. */
function SummaryRow({ summary, onDelete }: { summary: ThreadSummary; onDelete: (id: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="memory-note">
      <div className="memory-note-body">
        <button
          className={`memory-statement summary-text${expanded ? '' : ' clamped'}`}
          onClick={() => setExpanded((e) => !e)}
          title={expanded ? 'Collapse' : 'Show the full summary'}
        >
          {summary.text}
        </button>
        <span className="chip">{summaryDateRange(summary.firstTs, summary.lastTs)}</span>
        <span className="chip">{summary.messageCount} {summary.messageCount === 1 ? 'message' : 'messages'}</span>
        {confirming && (
          <span className="memory-reset-confirm">
            <span className="muted">Delete this summary? The chat itself is kept.</span>
            <button className="link-btn danger" onClick={() => onDelete(summary.id)}>Delete</button>
            <button className="link-btn" onClick={() => setConfirming(false)}>Cancel</button>
          </span>
        )}
      </div>
      <div className="memory-note-actions">
        <button
          className="memory-note-action danger"
          title="Delete this summary"
          aria-label="Delete this conversation summary"
          onClick={() => setConfirming(true)}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

export function EpisodicTab() {
  const [stats, setStats] = useState<EpisodicStats | null>(null);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [summaries, setSummaries] = useState<ThreadSummary[] | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  // The two loads below never resolve when the server is unreachable, so the
  // "Loading…" they leave behind has to say what is actually going on.
  const offline = useOffline();
  const unavailable = 'Your memory lives on Stem’s server, which can’t be reached right now.';

  function load() {
    window.stem.getEpisodicStats().then(setStats);
    window.stem.getThreadSummaries().then(setSummaries);
  }
  useEffect(() => {
    window.stem.getMemorySettings().then(setSettings);
    load();
  }, []);

  async function deleteSummary(id: number) {
    setSummaries(await window.stem.deleteThreadSummary(id));
  }

  function selectLimit(bytes: number) {
    window.stem.setEpisodicLimit(bytes).then((s) => {
      setSettings(s);
      // Lowering the cap can trigger pruning on the next capture; refresh the size.
      load();
    });
  }

  async function reset() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setResetting(true);
    setResetMsg(null);
    try {
      setStats(await window.stem.resetEpisodicMemory());
      setResetMsg('Episodic recall cleared.');
    } catch {
      setResetMsg('Reset failed — try again.');
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  }

  return (
    <div>
      {settings && (
        <div className="formgroup">
          <div className="set-block">
            <span className="set-sub">Storage limit</span>
            <div className="seg-ctl">
              {EPISODIC_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className={settings.episodicLimitBytes === p.bytes ? 'active' : ''}
                  onClick={() => selectLimit(p.bytes)}
                  title={p.bytes === 0 ? 'Never prune episodic recall' : `Keep up to ${p.label} of chat text`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="muted">Counts chat text only. When it grows past this, Stem drops the oldest messages first.</p>
          </div>
        </div>
      )}

      <div className="memory-view">
        <div className="memory-view-head">
          <strong>
            Episodic recall{' '}
            <InfoTip label="About episodic recall">
              The searchable history of past chats Stem draws on to recall what you've discussed
              before. Stored as a local database, never browsed directly.
            </InfoTip>
          </strong>
          <span className="memory-view-actions">
            <button className="link-btn icon-only" data-label="Refresh" aria-label="Refresh" onClick={load}>
              <RefreshCw size={13} />
            </button>
          </span>
        </div>
        {resetMsg && <p className="muted">{resetMsg}</p>}
        {!stats && <p className="muted">{offline ? unavailable : 'Loading…'}</p>}
        {stats && stats.messageCount === 0 && (
          <p className="muted">No episodic memory captured yet — Stem builds this as you chat.</p>
        )}
        {stats && stats.messageCount > 0 && (
          <p className="statement">
            {stats.messageCount.toLocaleString()}{' '}
            {stats.messageCount === 1 ? 'message' : 'messages'} · {formatBytes(stats.textBytes)} of text ·{' '}
            {formatBytes(stats.sizeBytes)} on disk
          </p>
        )}

        {stats && stats.messageCount > 0 && (
          <div className="memory-reset">
            {confirmReset ? (
              <span className="memory-reset-confirm">
                <span className="muted">
                  Erase all {stats.messageCount.toLocaleString()} captured{' '}
                  {stats.messageCount === 1 ? 'message' : 'messages'}? This can’t be undone.
                </span>
                <button className="link-btn danger" onClick={reset} disabled={resetting}>
                  {resetting ? 'Resetting…' : 'Erase recall'}
                </button>
                <button className="link-btn" onClick={() => setConfirmReset(false)} disabled={resetting}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                className="link-btn danger memory-reset-trigger"
                onClick={reset}
                title="Permanently erase episodic recall (keeps facts + your files)"
              >
                <Trash2 size={12} /> Reset recall
              </button>
            )}
          </div>
        )}
      </div>

      <div className="memory-view">
        <div className="memory-view-head">
          <strong>
            Conversation summaries{' '}
            <InfoTip label="About conversation summaries">
              A rolling English summary per chat — what was discussed, decided, and left open. Stem
              recalls these before digging into verbatim messages.
            </InfoTip>
          </strong>
          <span className="memory-view-actions">
            <button className="link-btn icon-only" data-label="Refresh" aria-label="Refresh" onClick={load}>
              <RefreshCw size={13} />
            </button>
          </span>
        </div>
        {!summaries && <p className="muted">{offline ? unavailable : 'Loading…'}</p>}
        {summaries && summaries.length === 0 && (
          <p className="muted">Summaries build as you chat (and backfill for older chats while Stem is idle).</p>
        )}
        {summaries && summaries.map((s) => (
          <SummaryRow key={s.id} summary={s} onDelete={(id) => void deleteSummary(id)} />
        ))}
      </div>
    </div>
  );
}
