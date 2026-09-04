import { useEffect, useState, type ReactNode } from 'react';
import { Bot, ShieldAlert, Terminal } from 'lucide-react';
import type { ExecApprovalRequest, ExecDecision, HarnessApprovalOption, HarnessApprovalRequest } from '../../shared/types';
import { approvalKey, type PendingApproval } from './approvalQueue';
import { decideApproval, dismissMissedApproval, useApprovals } from './approvalStore';

// The permission card: a run_command call or a coding agent's tool call fell
// through the auto-approve tiers, the backend holds it open, and the turn that
// asked waits for the answer.
//
// It renders in the chat that asked, pinned above that chat's composer — the
// question belongs to the conversation it interrupts, and a dialog dropped over
// whatever chat happened to be on screen read as a question about THAT chat.
// The same body renders as a modal on a surface that has no such chat to hold
// it (Quick Chat, for an ask from some other thread).

// How close to the deadline the countdown appears. A clock on screen for the
// whole ten minutes reads as pressure to answer something that deserves reading;
// the last two minutes are when knowing there IS a deadline changes what you do.
const COUNTDOWN_FROM_MS = 120_000;

/** m:ss, never negative — the card is gone the moment it hits zero anyway. */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function useCountdown(expiresAt: number | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  // Tick only while there is a deadline to tick towards.
  useEffect(() => {
    if (expiresAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (expiresAt === undefined) return null;
  const remaining = expiresAt - now;
  return remaining <= COUNTDOWN_FROM_MS ? formatRemaining(remaining) : null;
}

function verdictLine(verdict: 'unsafe' | 'unsure' | 'failed' | null | undefined): string {
  return verdict === 'unsafe'
    ? 'The safety check flagged this command as potentially unsafe'
    : verdict === 'failed'
      ? 'The automatic safety check could not run'
      : verdict === 'unsure'
        ? 'The safety check could not tell whether this command is safe'
        : 'Manual approval is on — commands only run when you allow them';
}

// ---- coding-agent option labels ----

// The adapter's option names carry the rule it would learn ("Always Allow
// Read(//home/me/proj/src/**)"), which on a button is a paragraph. The button
// says the decision; the rule is spelled out beside it where it can wrap.
const KIND_LABEL: Record<string, string> = {
  allow_once: 'Allow',
  allow_always: 'Always allow',
  reject_once: 'Reject',
  reject_always: 'Always reject'
};

export function harnessOptionLabel(o: HarnessApprovalOption): string {
  return (o.kind && KIND_LABEL[o.kind]) || o.name || o.optionId;
}

/** What "Always allow" would teach the agent, when its name says more than the verb. */
export function harnessAlwaysAllowScope(o: HarnessApprovalOption): string | null {
  if (o.kind !== 'allow_always' || !o.name) return null;
  const scope = o.name.replace(/^\s*always\s+allow\b[\s:]*/i, '').trim();
  return scope && scope !== o.name.trim() ? scope : null;
}

/** The card's buttons are the harness's own options; reject, learn, allow — in that order. */
export function orderedHarnessOptions(request: HarnessApprovalRequest): HarnessApprovalOption[] {
  const rank = (kind?: string) =>
    kind === 'reject_once' || kind === 'reject_always' ? 0 : kind === 'allow_always' ? 1 : 2;
  return [...request.options].sort((a, b) => rank(a.kind) - rank(b.kind));
}

// ---- bodies ----

interface BodyProps<R> {
  request: R;
  busy: boolean;
  error: string | null;
  countdown: string | null;
  decide: (choice: ExecDecision | { optionId: string }) => void;
}

function ExecBody({ request, busy, error, countdown, decide }: BodyProps<ExecApprovalRequest>) {
  return (
    <>
      <div className="mcp-approval-head">
        <span className="row-icon">
          <Terminal size={15} />
        </span>
        <strong>{request.deviceLabel ? `Run this command on “${request.deviceLabel}”?` : 'Run this command?'}</strong>
      </div>

      <p className="muted">
        {verdictLine(request.judgeVerdict)}
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
            — on <strong>{request.deviceLabel}</strong>, not on the machine Stem runs on. “Always allow”
            trusts these prefixes on that computer only.
          </>
        ) : null}
      </p>

      {countdown && (
        <p className="muted">
          Expires in <strong>{countdown}</strong> — after that it is not run, and the assistant is told
          nobody answered.
        </p>
      )}

      {error && <p className="error">{error}</p>}

      <div className="mcp-approval-actions">
        <button className="push" onClick={() => decide('deny')} disabled={busy}>
          Deny
        </button>
        {request.prefixes.length > 0 && (
          <button
            className="push"
            onClick={() => decide('alwaysAllow')}
            disabled={busy}
            title={`Adds ${request.prefixes.map((p) => `"${p}"`).join(', ')} to the allowlist in Settings → Chat → Command execution`}
          >
            Always allow {request.prefixes.map((p) => `“${p}”`).join(', ')}
          </button>
        )}
        <button className="push default" onClick={() => decide('allowOnce')} disabled={busy}>
          Allow once
        </button>
      </div>
    </>
  );
}

function HarnessBody({ request, busy, error, countdown, decide }: BodyProps<HarnessApprovalRequest>) {
  const options = orderedHarnessOptions(request);
  const scope = options.map(harnessAlwaysAllowScope).find((s) => s !== null) ?? null;
  return (
    <>
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
        <p className="muted">{request.guardReason} Allowing it here lets the agent run it anyway.</p>
      ) : request.judgeVerdict !== undefined ? (
        <p className="muted">
          {verdictLine(request.judgeVerdict)}
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

      {scope && (
        <p className="muted harness-approval-scope">
          “Always allow” means the agent stops asking for <code>{scope}</code> in this project — its own
          rule, not Stem’s allowlist.
        </p>
      )}

      {countdown && (
        <p className="muted">
          Expires in <strong>{countdown}</strong> — after that the agent is told nobody answered.
        </p>
      )}

      {error && <p className="error">{error}</p>}

      <div className="mcp-approval-actions">
        {options.map((option, i, all) => (
          <button
            key={option.optionId}
            className={`push${i === all.length - 1 ? ' default' : ''}`}
            onClick={() => decide({ optionId: option.optionId })}
            disabled={busy}
            title={option.name && option.name !== harnessOptionLabel(option) ? option.name : undefined}
          >
            {harnessOptionLabel(option)}
          </button>
        ))}
      </div>
    </>
  );
}

// ---- the card ----

interface ApprovalCardProps {
  approval: PendingApproval;
  /** Pinned above the owning chat's composer, or a dialog over a surface with no such chat. */
  variant: 'inline' | 'modal';
  /** How many more asks from the same chat wait behind this one. */
  queued?: number;
}

export function ApprovalCard({ approval, variant, queued = 0 }: ApprovalCardProps) {
  const { busyKey } = useApprovals();
  const [error, setError] = useState<string | null>(null);
  const key = approvalKey(approval);
  const busy = busyKey === key;
  const countdown = useCountdown(approval.request.expiresAt);

  // The card is keyed by its ask, so an error never outlives the card it was about.
  useEffect(() => setError(null), [key]);

  const decide = (choice: ExecDecision | { optionId: string }) => {
    if (busy) return;
    setError(null);
    void decideApproval(approval, choice).then((err) => {
      if (err) setError(err);
    });
  };

  const body =
    approval.kind === 'exec' ? (
      <ExecBody request={approval.request} busy={busy} error={error} countdown={countdown} decide={decide} />
    ) : (
      <HarnessBody request={approval.request} busy={busy} error={error} countdown={countdown} decide={decide} />
    );
  const more = queued > 0 && (
    <p className="muted approval-queued">
      {queued === 1 ? 'One more ask' : `${queued} more asks`} from this chat wait behind this one.
    </p>
  );

  if (variant === 'inline') {
    return (
      <div className="chat-approval" role="region" aria-live="polite" aria-label="Permission needed">
        <div className="chat-approval-card">
          {body}
          {more}
        </div>
      </div>
    );
  }
  return (
    <div className="mcp-approval-backdrop" role="dialog" aria-modal="true">
      <div className="mcp-approval-card">
        {body}
        {more}
      </div>
    </div>
  );
}

// ---- the notice in every other chat ----

interface ApprovalNoticeProps {
  /** Asks waiting in chats other than the one on screen, oldest first. */
  approvals: PendingApproval[];
  /** The owning chat's title, or null when it is not a chat the sidebar lists (a mail turn). */
  titleFor: (threadId: string) => string | null;
  /** Bring that chat to the centre pane. */
  onOpen: (threadId: string) => void;
}

/**
 * A slim bar over the conversation when some OTHER chat is waiting on an
 * answer. The card itself stays in its chat; this is the tap on the shoulder
 * that gets you there. An ask from a thread the sidebar cannot open (a mail
 * turn) is answered here, in a dialog, since there is no chat to go to.
 */
export function ApprovalNotice({ approvals, titleFor, onOpen }: ApprovalNoticeProps) {
  const [showing, setShowing] = useState<string | null>(null);
  const head = approvals[0];
  if (!head) return null;
  const title = titleFor(head.request.threadId);
  const who =
    head.kind === 'exec' ? 'The assistant' : `The ${head.request.agent} agent`;
  const where = title ? <>in “{title}”</> : 'in another conversation';
  const shown = showing ? approvals.find((a) => approvalKey(a) === showing) : null;
  const rest = approvals.length - 1;

  let action: ReactNode;
  if (title) {
    action = (
      <button className="approval-notice-btn" onClick={() => onOpen(head.request.threadId)}>
        Open chat
      </button>
    );
  } else {
    action = (
      <button className="approval-notice-btn" onClick={() => setShowing(approvalKey(head))}>
        Review
      </button>
    );
  }

  return (
    <>
      <div className="approval-notice" role="status">
        <ShieldAlert size={14} />
        <span className="approval-notice-msg">
          {who} {where} asks for permission
          {rest > 0 ? ` (and ${rest} more ${rest === 1 ? 'ask waits' : 'asks wait'})` : ''}.
        </span>
        {action}
      </div>
      {shown && <ApprovalCard key={approvalKey(shown)} approval={shown} variant="modal" />}
    </>
  );
}

// ---- the answer that came too late ----

/** Shown once, over everything: about a click already made, not a question still open. */
export function MissedApprovalDialog() {
  const { missed } = useApprovals();
  if (!missed) return null;
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
          Nobody answered in time, so this was not run and the assistant was told so — it was not
          recorded as a refusal. Ask it to try again if you still want it.
        </p>
        <pre className="exec-approval-command">{missed}</pre>
        <div className="mcp-approval-actions">
          <button className="push default" onClick={dismissMissedApproval}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
