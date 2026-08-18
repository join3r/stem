import { useEffect, useState } from 'react';
import { Terminal } from 'lucide-react';
import type { ExecApprovalRequest, ExecDecision } from '../../shared/types';
import { enqueueApproval, removeApproval } from './approvalQueue';

// How close to the deadline the countdown appears. A clock on screen for the
// whole ten minutes reads as pressure to answer something that deserves reading;
// the last two minutes are when knowing there IS a deadline changes what you do.
const COUNTDOWN_FROM_MS = 120_000;

/** m:ss, never negative — the card is gone the moment it hits zero anyway. */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Modal confirm card shown when a run_command call fell through the auto-approve
// tiers (allowlist → LLM judge). The backend holds the tool call open until the
// user decides; "Always allow" also persists the prefix of every not-yet-allowed
// chained segment to the user allowlist so the command auto-runs next time
// (editable in Settings → Chat → Command execution).
export function ExecApprovalCard() {
  const [queue, setQueue] = useState<ExecApprovalRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A command whose answer arrived too late. Held separately from the queue: the
  // card it belonged to is already gone from it, and the one thing the user must
  // not be left believing is that their click ran something.
  const [missed, setMissed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const request = queue[0] ?? null;
  const busy = !!request && busyId === request.id;

  useEffect(() => {
    const offRequest = window.stem.onExecApproval((r) => {
      setQueue((q) => enqueueApproval(q, r));
    });
    const offResolved = window.stem.onExecApprovalResolved(({ id }) => {
      setQueue((q) => removeApproval(q, id));
      setBusyId((cur) => (cur === id ? null : cur));
    });
    // A card that was waiting behind another one is now the visible one, and its
    // deadline is only decided at that moment — see ExecService.armHead.
    const offArmed = window.stem.onExecApprovalArmed(({ id, expiresAt }) => {
      setQueue((q) => q.map((r) => (r.id === id ? { ...r, expiresAt } : r)));
    });
    return () => {
      offRequest();
      offResolved();
      offArmed();
    };
  }, []);

  // Tick only while there is a deadline to tick towards.
  const expiresAt = request?.expiresAt ?? null;
  useEffect(() => {
    if (expiresAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  // The missed answer takes the screen first: it is about a click already made,
  // and anything still queued keeps its own (much longer) clock meanwhile.
  if (missed) {
    return (
      <div className="mcp-approval-backdrop" role="dialog" aria-modal="true">
        <div className="mcp-approval-card">
          <div className="mcp-approval-head">
            <span className="row-icon">
              <Terminal size={15} />
            </span>
            <strong>That answer came too late</strong>
          </div>
          <p className="muted">
            Nobody answered in time, so this command was not run and the assistant has been told so —
            it was not recorded as a refusal. Ask it to try again if you still want it.
          </p>
          <pre className="exec-approval-command">{missed}</pre>
          <div className="mcp-approval-actions">
            <button className="push default" onClick={() => setMissed(null)}>
              OK
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!request) return null;

  const remainingMs = request.expiresAt ? request.expiresAt - now : null;
  const countdown =
    remainingMs !== null && remainingMs <= COUNTDOWN_FROM_MS ? formatRemaining(remainingMs) : null;

  async function decide(decision: ExecDecision) {
    if (!request || busy) return;
    setBusyId(request.id);
    setError(null);
    try {
      // False = the card had already expired (or another surface answered it),
      // and the tool call went on without this click. Saying nothing here is
      // what made a timeout look like a decision the user had made.
      const answered = await window.stem.respondExecApproval(request.id, decision);
      setQueue((q) => removeApproval(q, request.id));
      if (!answered) setMissed(request.command);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId((cur) => (cur === request.id ? null : cur));
    }
  }

  const verdictLine =
    request.judgeVerdict === 'unsafe'
      ? 'The safety check flagged this command as potentially unsafe'
      : request.judgeVerdict === 'failed'
        ? 'The automatic safety check could not run'
        : request.judgeVerdict === 'unsure'
          ? 'The safety check could not tell whether this command is safe'
          : 'Manual approval is on — commands only run when you allow them';

  return (
    <div className="mcp-approval-backdrop" role="dialog" aria-modal="true">
      <div className="mcp-approval-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <Terminal size={15} />
          </span>
          <strong>{request.deviceLabel ? `Run this command on “${request.deviceLabel}”?` : 'Run this command?'}</strong>
        </div>

        <p className="muted">
          {verdictLine}
          {request.judgeReason ? `: ${request.judgeReason}` : '.'}
        </p>

        <pre className="exec-approval-command">{request.command}</pre>
        <p className="muted">
          in <code>{request.cwd}</code>
          {/* Where it runs is as much what is being approved as what runs, and
              "always allow" scopes to that machine — say both plainly. */}
          {request.deviceLabel ? (
            <>
              {' '}
              — on <strong>{request.deviceLabel}</strong>, not on the machine Stem runs on. “Always
              allow” trusts these prefixes on that computer only.
            </>
          ) : null}
        </p>

        {countdown && (
          <p className="muted">
            Expires in <strong>{countdown}</strong> — after that it is not run, and the assistant is
            told nobody answered.
          </p>
        )}

        {error && <p className="error">{error}</p>}

        <div className="mcp-approval-actions">
          <button className="push" onClick={() => void decide('deny')} disabled={busy}>
            Deny
          </button>
          {request.prefixes.length > 0 && (
            <button
              className="push"
              onClick={() => void decide('alwaysAllow')}
              disabled={busy}
              title={`Adds ${request.prefixes.map((p) => `"${p}"`).join(', ')} to the allowlist in Settings → Chat → Command execution`}
            >
              Always allow {request.prefixes.map((p) => `“${p}”`).join(', ')}
            </button>
          )}
          <button className="push default" onClick={() => void decide('allowOnce')} disabled={busy}>
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
}
