import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import type { HarnessApprovalRequest } from '../../shared/types';
import { enqueueApproval, removeApproval } from './approvalQueue';

// Same countdown stance as the exec card: the clock appears only when knowing
// there IS a deadline changes what you do.
const COUNTDOWN_FROM_MS = 120_000;

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The card's buttons are the harness's own options; pick a sensible order. */
function orderedOptions(request: HarnessApprovalRequest): HarnessApprovalRequest['options'] {
  const rank = (kind?: string) =>
    kind === 'reject_once' || kind === 'reject_always' ? 0 : kind === 'allow_always' ? 1 : 2;
  return [...request.options].sort((a, b) => rank(a.kind) - rank(b.kind));
}

// Modal confirm card shown when an external coding agent escalated a tool call
// AND the approval tiers didn't clear it (allowlisted or judge-safe commands
// are auto-answered server-side and never get here). The buttons are still the
// harness's own options and the answer goes straight back to it — "always
// allow" here is the AGENT learning (into its own settings for that project),
// not Stem's allowlist. A judged card says why it escalated.
export function HarnessApprovalCard() {
  const [queue, setQueue] = useState<HarnessApprovalRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // An answer that arrived after the card expired. The one thing the user must
  // not be left believing is that their click allowed something.
  const [missed, setMissed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const request = queue[0] ?? null;
  const busy = !!request && busyId === request.id;

  useEffect(() => {
    const offRequest = window.stem.onHarnessApproval((r) => {
      setQueue((q) => enqueueApproval(q, r));
    });
    const offResolved = window.stem.onHarnessApprovalResolved(({ id }) => {
      setQueue((q) => removeApproval(q, id));
      setBusyId((cur) => (cur === id ? null : cur));
    });
    const offArmed = window.stem.onHarnessApprovalArmed(({ id, expiresAt }) => {
      setQueue((q) => q.map((r) => (r.id === id ? { ...r, expiresAt } : r)));
    });
    return () => {
      offRequest();
      offResolved();
      offArmed();
    };
  }, []);

  const expiresAt = request?.expiresAt ?? null;
  useEffect(() => {
    if (expiresAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  if (missed) {
    return (
      <div className="mcp-approval-backdrop" role="dialog" aria-modal="true">
        <div className="mcp-approval-card">
          <div className="mcp-approval-head">
            <span className="row-icon">
              <Bot size={15} />
            </span>
            <strong>That answer came too late</strong>
          </div>
          <p className="muted">
            Nobody answered in time, so the coding agent was told its request expired — not that you
            refused. Ask the assistant to try again if you still want it.
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

  async function decide(optionId: string) {
    if (!request || busy) return;
    setBusyId(request.id);
    setError(null);
    try {
      const answered = await window.stem.respondHarnessApproval(request.id, optionId);
      setQueue((q) => removeApproval(q, request.id));
      if (!answered) setMissed(request.title);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId((cur) => (cur === request.id ? null : cur));
    }
  }

  return (
    <div className="mcp-approval-backdrop" role="dialog" aria-modal="true">
      <div className="mcp-approval-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <Bot size={15} />
          </span>
          <strong>The {request.agent} agent asks for permission</strong>
        </div>

        <p className="muted">
          {/* Where it acts is as much what is being approved as what it does. */}
          Running on <strong>{request.hostLabel}</strong>
          {request.description ? ` — ${request.description}` : '.'}
        </p>

        {/* Why the tiers escalated: the guard beats the judge; absent on
            non-command asks, which carry neither field. */}
        {request.guardReason ? (
          <p className="muted">
            {request.guardReason} Allowing it here lets the agent run it anyway.
          </p>
        ) : request.judgeVerdict !== undefined ? (
          <p className="muted">
            {request.judgeVerdict === 'unsafe'
              ? 'The safety check flagged this command as potentially unsafe'
              : request.judgeVerdict === 'failed'
                ? 'The automatic safety check could not run'
                : request.judgeVerdict === 'unsure'
                  ? 'The safety check could not tell whether this command is safe'
                  : 'Manual approval is on — commands only run when you allow them'}
            {request.judgeReason ? `: ${request.judgeReason}` : '.'}
          </p>
        ) : null}

        <pre className="exec-approval-command">{request.title}</pre>

        {(request.content ?? []).map((piece, i) =>
          piece.type === 'diff' ? (
            <div key={i} className="harness-approval-diff">
              <p className="muted">
                <code>{piece.path}</code>
              </p>
              {piece.oldText !== undefined && (
                <pre className="exec-approval-command harness-diff-old">{piece.oldText}</pre>
              )}
              {piece.newText !== undefined && (
                <pre className="exec-approval-command harness-diff-new">{piece.newText}</pre>
              )}
            </div>
          ) : (
            <pre key={i} className="exec-approval-command">
              {piece.text}
            </pre>
          )
        )}

        {countdown && (
          <p className="muted">
            Expires in <strong>{countdown}</strong> — after that the agent is told nobody answered.
          </p>
        )}

        {error && <p className="error">{error}</p>}

        <div className="mcp-approval-actions">
          {orderedOptions(request).map((option, i, all) => (
            <button
              key={option.optionId}
              className={`push${i === all.length - 1 ? ' default' : ''}`}
              onClick={() => void decide(option.optionId)}
              disabled={busy}
            >
              {option.name || option.optionId}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
