import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react';
import { File, Forward, Paperclip, Plus, Send, ShieldAlert, Square, X } from 'lucide-react';
import { MAIL_BETA_TITLE } from '../chats/ChatList';
import type {
  MailApproval,
  MailComposeInput,
  MailConversation,
  MailItem,
  MailWorkGroup,
  Persona,
  TurnAttachment,
  SystemVersion
} from '../../shared/types';
import { MdxView } from '../chat/MdxView';
import { formatSystemVersion, sameSystem } from '../../shared/sys-version';
import { forwardAttachments, forwardCompose, forwardQuote, forwardSubject } from '../../shared/mail-forward';
import { groupMailTimeline } from './grouping';
import { personaName } from './useMail';
import { useMailWork } from './useMailWork';
import { MailWork } from './MailWork';
import { GeneratedImages } from '../chat/GeneratedImage';

// The centre pane's mail surface: a conversation read like email (discrete
// mails, newest last, a reply box underneath), or the compose form for a new
// one. Replies stay discrete while the Work disclosure below their originating
// mail preserves the live activity of every participating persona.

/** Path-less bytes (a pasted screenshot) become base64, same as the chat composer. */
function fileToAttachment(file: globalThis.File): Promise<TurnAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve({ name: file.name, dataBase64: result.split(',')[1] ?? '', mime: file.type });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * The chat composer's attachment handling, distilled for the mail surfaces:
 * paperclip picker, image paste, drag-drop — chips rendered by AttachmentChips.
 */
function useAttachmentDraft(initial?: TurnAttachment[]) {
  const [attachments, setAttachments] = useState<TurnAttachment[]>(initial ?? []);

  const addFiles = useCallback(async (files: globalThis.File[]) => {
    if (!files.length) return;
    const next = await Promise.all(
      files.map(async (f) => {
        const path = window.stem.getPathForFile(f);
        return path ? { name: f.name, path } : await fileToAttachment(f);
      })
    );
    setAttachments((prev) => [...prev, ...next]);
  }, []);

  const pickFiles = useCallback(async () => {
    const paths = await window.stem.openFiles();
    if (!paths.length) return;
    setAttachments((prev) => [
      ...prev,
      ...paths.map((p) => ({ name: p.split('/').pop() || p, path: p }))
    ]);
  }, []);

  const onPaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (!images.length) return; // let plain-text paste through untouched
    e.preventDefault();
    const next = await Promise.all(images.map(fileToAttachment));
    setAttachments((prev) => [...prev, ...next]);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      void addFiles(Array.from(e.dataTransfer.files));
    },
    [addFiles]
  );

  const remove = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const clear = useCallback(() => setAttachments([]), []);

  return { attachments, addFiles, pickFiles, onPaste, onDrop, remove, clear };
}

/**
 * A mail being forwarded, as the compose form opens with it: the "Fwd:"
 * subject, the quoted original (read-only under the user's note) and the
 * original's images, carried from their stored bytes (shared/mail-forward).
 */
export interface MailForwardDraft {
  /** The forwarded item's id — a fresh form per forward. */
  key: string;
  subject: string;
  quote: string;
  attachments: TurnAttachment[];
}

/** Lets App route DropOverlay drops into the open mail view's draft. */
export interface MailViewHandle {
  addAttachments(files: globalThis.File[]): void;
}

function AttachmentChips({
  attachments,
  onRemove
}: {
  attachments: TurnAttachment[];
  onRemove: (idx: number) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="composer-attachments mail-attachments-draft">
      {attachments.map((att, i) => (
        <span className="attachment-chip" key={`${att.name}-${i}`}>
          <File size={13} />
          <span className="attachment-name">{att.name}</span>
          <button type="button" className="attachment-remove" title="Remove" onClick={() => onRemove(i)}>
            <X size={13} />
          </button>
        </span>
      ))}
    </div>
  );
}

function formatAt(at: number, now: number): string {
  const d = new Date(at);
  const sameDay = new Date(now);
  sameDay.setHours(0, 0, 0, 0);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (at >= sameDay.getTime()) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

export const MailConversationView = forwardRef<MailViewHandle, {
  conversation: MailConversation;
  items: MailItem[];
  personas: Persona[];
  onReply: (body: string, attachments?: TurnAttachment[]) => void;
  /** Resolves once the persona is in; rejection shows its message inline. */
  onAddParticipant: (personaId: string) => Promise<void>;
  /** Stop the working personas: queued deliveries dropped, running turns interrupted. */
  onStop: () => void;
  /** Open the compose form forwarding one of this conversation's mails. */
  onForward: (draft: MailForwardDraft) => void;
  /**
   * The serving system's version (MailListResult.sys). A mail stamped with a
   * different one was made by older persona / skills / memory code and says so,
   * so a review of "how the personas behave now" can skip it.
   */
  currentSys?: SystemVersion;
}>(function MailConversationView(
  { conversation, items, personas, onReply, onAddParticipant, onStop, onForward, currentSys },
  ref
) {
  const [draft, setDraft] = useState('');
  const files = useAttachmentDraft();
  useImperativeHandle(ref, () => ({
    addAttachments: (dropped) => void files.addFiles(dropped)
  }));
  const [addingTo, setAddingTo] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Expanded exchange groups, keyed by their oldest item's id (stable across refreshes).
  const [openExchanges, setOpenExchanges] = useState<Set<string>>(new Set());
  const now = Date.now();
  const scrollRef = useRef<HTMLDivElement>(null);
  const mails = useMemo(
    () => items.filter((i) => i.conversationId === conversation.id).sort((a, b) => a.at - b.at),
    [items, conversation.id]
  );
  // Fold in time order, then show newest first — mail reads top-down, not like a chat.
  const groups = useMemo(
    () =>
      groupMailTimeline(mails)
        .map((g) => (g.kind === 'exchange' ? { ...g, items: [...g.items].reverse() } : g))
        .reverse(),
    [mails]
  );
  const work = useMailWork(conversation.id);
  const workGroups = work.groups;
  const workByMail = useMemo(() => {
    const mapped = new Map<string, MailWorkGroup[]>();
    for (const group of workGroups) {
      const anchor = group.notificationItemId ?? group.sourceItemId;
      if (!anchor) continue;
      mapped.set(anchor, [...(mapped.get(anchor) ?? []), group]);
    }
    return mapped;
  }, [workGroups]);
  const unlinkedWork = workGroups.filter((group) => {
    const anchor = group.notificationItemId ?? group.sourceItemId;
    return !anchor || !mails.some((mail) => mail.id === anchor);
  });
  const addable = useMemo(
    () => personas.filter((p) => !conversation.participants.includes(p.id)),
    [personas, conversation.participants]
  );
  // Land at the newest mail (the top) on open and when one arrives.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [conversation.id, mails.length]);

  const send = () => {
    const body = draft.trim();
    if (!body && !files.attachments.length) return;
    onReply(body, files.attachments.length ? files.attachments : undefined);
    setDraft('');
    files.clear();
  };

  const forward = (m: MailItem) => {
    // The quote is read by a persona: "User", not the renderer's "You".
    const who = (id: string) => (id === 'user' ? 'User' : personaName(personas, id));
    onForward({
      key: m.id,
      subject: forwardSubject(conversation.subject),
      quote: forwardQuote(
        {
          from: who(m.from),
          to: m.to.map(who),
          at: m.at,
          subject: m.subject ?? conversation.subject,
          // A scheduled run's report is part of the mail as the user reads it.
          body: m.result ? `${m.body}\n\n${m.result}` : m.body,
          attachments: m.attachments
        },
        (at) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      ),
      attachments: forwardAttachments(m.attachments).attachments
    });
  };

  const toggleExchange = (key: string) => {
    setOpenExchanges((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const mailCard = (m: MailItem, exchange: boolean) => (
    <Fragment key={m.id}>
    <article className={`mail-item${m.from === 'user' ? ' from-user' : ''}${exchange ? ' exchange' : ''}`}>
      <div className="mail-item-head">
        <strong title={m.sys ? `Made by system: ${formatSystemVersion(m.sys)}` : undefined}>
          {m.from === 'user' ? 'You' : personaName(personas, m.from)}
        </strong>
        {m.sys && currentSys && !sameSystem(m.sys, currentSys) && (
          <span
            className="mail-item-sys"
            title={`Made by an older version of the persona system (${formatSystemVersion(m.sys)}); now ${formatSystemVersion(currentSys)}`}
          >
            older system
          </span>
        )}
        {exchange && <span className="mail-item-to">→ {m.to.map((t) => (t === 'user' ? 'You' : personaName(personas, t))).join(', ')}</span>}
        {m.stale && (
          <span
            className="mail-item-stale"
            title="This landed after you had already sent a newer mail — it answers an earlier one"
          >
            ↩ answers your earlier mail
          </span>
        )}
        <span className="mail-item-at">{formatAt(m.at, now)}</span>
        <button
          type="button"
          className="icon-action sm mail-item-forward"
          onClick={() => forward(m)}
          title="Forward — send this mail on to personas in a new conversation"
          aria-label="Forward this mail"
        >
          <Forward size={13} />
        </button>
      </div>
      {m.subject && <h2 className="mail-item-subject">{m.subject}</h2>}
      {m.from === 'user' ? <p className="mail-item-body-plain">{m.body}</p> : <MdxView text={m.body} />}
      {m.result && (
        <section className="mail-item-result" aria-label="The run’s reply">
          <MdxView text={m.result} />
        </section>
      )}
      {m.agentReplies && m.agentReplies.length > 0 && (
        <details className="mail-item-agent">
          <summary className="mail-item-agent-summary">
            <strong>Coding agent’s reply</strong>
            <span>{m.agentReplies.length === 1 ? 'as received' : `${m.agentReplies.length} exchanges, as received`}</span>
          </summary>
          <div className="mail-item-agent-content">
            {m.agentReplies.map((text, i) => (
              <section key={i} className="mail-item-agent-reply">
                <MdxView text={text} />
              </section>
            ))}
          </div>
        </details>
      )}
      {m.approval && <MailApprovalBlock itemId={m.id} approval={m.approval} />}
      {m.images && m.images.length > 0 && <GeneratedImages images={m.images} live={false} />}
      {m.attachments && m.attachments.length > 0 && (
        <div className="message-attachments">
          {m.attachments.map((att, i) =>
            att.kind === 'image' && att.dataUrl ? (
              <img key={i} className="message-image" src={att.dataUrl} alt={att.name ?? 'attachment'} />
            ) : (
              <span className="attachment-chip" key={i}>
                <File size={13} />
                <span className="attachment-name">{att.name ?? 'file'}</span>
              </span>
            )
          )}
        </div>
      )}
    </article>
    {workByMail.get(m.id)?.map((group) => <MailWork key={group.id} group={group} personas={personas} />)}
    </Fragment>
  );

  return (
    <div className="mail-view">
      <header className="mail-head">
        <h1 title={conversation.subject}>{conversation.subject}</h1>
        <span className="mail-head-to">
          To: {conversation.participants.map((p) => personaName(personas, p)).join(', ')}
          {addable.length > 0 && (
            <button
              className="icon-action sm mail-add-toggle"
              onClick={() => setAddingTo((v) => !v)}
              title="Add a persona to this conversation"
              aria-label="Add a persona to this conversation"
              aria-expanded={addingTo}
            >
              <Plus size={12} />
            </button>
          )}
          {conversation.status === 'working' && (
            <>
              <em> · working…</em>
              <button
                className="icon-action sm mail-stop"
                onClick={onStop}
                title="Stop — drop queued deliveries and interrupt the running personas"
                aria-label="Stop the personas working this conversation"
              >
                <Square size={11} />
              </button>
            </>
          )}
          {conversation.status === 'awaiting-user' && <em> · waiting on your reply</em>}
          {conversation.status === 'failed' && <em> · failed — the last mail says why; reply to try again</em>}
          {conversation.status === 'aborted' && <em> · stopped — reply to pick it back up</em>}
        </span>
        {addingTo && addable.length > 0 && (
          <div className="mail-to-chips mail-add-chips" role="group" aria-label="Personas to add">
            {addable.map((p) => (
              <button
                key={p.id}
                className="mail-to-chip"
                onClick={() => {
                  setAddError(null);
                  onAddParticipant(p.id)
                    .then(() => setAddingTo(false))
                    .catch((err) => setAddError(err instanceof Error ? err.message : String(err)));
                }}
                title={`Add ${p.name} — the personas here can then mail it, and your replies reach it too`}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
        {addingTo && addError && <p className="task-failed">{addError}</p>}
      </header>
      <div className="mail-items" ref={scrollRef}>
        {unlinkedWork.map((group) => <MailWork key={group.id} group={group} personas={personas} unlinked />)}
        {work.error && <p className="mail-work-note">{work.error} <button type="button" onClick={work.refresh}>Retry</button></p>}
        {groups.map((group) => {
          if (group.kind === 'mail') return mailCard(group.item, false);
          // The exchange's oldest item (last after the flip) — stable as new mail lands.
          const key = group.items[group.items.length - 1].id;
          const open = openExchanges.has(key);
          const n = group.items.length;
          return (
            <div key={key} className="mail-exchange">
              <button className="mail-exchange-toggle" onClick={() => toggleExchange(key)}>
                {n} {n === 1 ? 'mail' : 'mails'} exchanged · {open ? 'hide' : 'show'}
              </button>
              {open && group.items.map((m) => mailCard(m, true))}
            </div>
          );
        })}
        {mails.length === 0 && (
          <p className="muted">This conversation has no mail yet.</p>
        )}
      </div>
      <div className="mail-reply" onDragOver={(e) => e.preventDefault()} onDrop={files.onDrop}>
        <AttachmentChips attachments={files.attachments} onRemove={files.remove} />
        <div className="mail-reply-row">
          <button
            type="button"
            className="composer-attach"
            title="Attach"
            onClick={() => void files.pickFiles()}
          >
            <Paperclip size={15} />
          </button>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Reply to ${conversation.participants.map((p) => personaName(personas, p)).join(', ')}…`}
            rows={3}
            onPaste={(e) => void files.onPaste(e)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            className="mail-send"
            onClick={send}
            disabled={!draft.trim() && !files.attachments.length}
            title="Send reply (⌘↵)"
          >
            <Send size={14} /> Send
          </button>
        </div>
      </div>
    </div>
  );
});

export const MailComposeView = forwardRef<MailViewHandle, {
  personas: Persona[];
  /** Resolves once sent; rejection shows its message inline. */
  onCompose: (input: MailComposeInput) => Promise<void>;
  onCancel: () => void;
  /** Open as a forward: the subject prefilled, the original quoted under the note. */
  forward?: MailForwardDraft;
}>(function MailComposeView({ personas, onCompose, onCancel, forward }, ref) {
  // The To: list in SELECTION ORDER — the first-picked persona is the driver
  // (it receives the mail and owns returning to the user); the rest are
  // participants the driver can consult with send_mail.
  const [to, setTo] = useState<string[]>(['normal']);
  const [subject, setSubject] = useState(forward?.subject ?? '');
  const [body, setBody] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const files = useAttachmentDraft(forward?.attachments);
  // A forward always has something to send — the quote — even with no note.
  const empty = !forward && !body.trim() && !files.attachments.length;
  useImperativeHandle(ref, () => ({
    addAttachments: (dropped) => void files.addFiles(dropped)
  }));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleTo = (id: string) => {
    setTo((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  };

  const send = async () => {
    if (sending || empty) return;
    setSending(true);
    setError(null);
    try {
      await onCompose(
        forward
          ? forwardCompose({ to, subject, note: body, quote: forward.quote, attachments: files.attachments, private: isPrivate })
          : {
              to,
              subject,
              body,
              ...(isPrivate ? { private: true } : {}),
              ...(files.attachments.length ? { attachments: files.attachments } : {})
            }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSending(false);
    }
  };

  return (
    <div className="mail-view mail-compose">
      <header className="mail-head">
        <h1>
          {forward ? 'Forward' : 'New mail'}
          <span className="beta-pill" aria-hidden="true" title={MAIL_BETA_TITLE}>
            Beta
          </span>
        </h1>
        <button className="icon-action sm" onClick={onCancel} title="Discard" aria-label="Discard">
          <X size={14} />
        </button>
      </header>
      <div className="mail-compose-form">
        <div className="mail-field">
          <span>To</span>
          <div className="mail-to-chips" role="group" aria-label="Personas this mail goes to">
            {personas.map((p) => {
              const at = to.indexOf(p.id);
              return (
                <button
                  key={p.id}
                  className={`mail-to-chip${at >= 0 ? ' on' : ''}`}
                  aria-pressed={at >= 0}
                  onClick={() => toggleTo(p.id)}
                  title={at === 0 ? `${p.name} drives the conversation` : p.name}
                >
                  {p.name}
                  {at === 0 && to.length > 1 && <em className="mail-to-driver">driver</em>}
                </button>
              );
            })}
          </div>
          {to.length === 0 && <p className="muted mail-to-hint">Pick at least one persona — the first picked drives.</p>}
        </div>
        <label className="mail-field">
          <span>Subject</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What this is about"
          />
        </label>
        <label className="mail-field mail-private-toggle">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
          <span>
            Private — nothing in this conversation is saved to memory or read from it, and the personas keep no
            notes of it. Fixed once sent.
          </span>
        </label>
        <textarea
          className="mail-compose-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={
            forward
              ? 'Add a note for the personas (optional) — the forwarded mail follows below.'
              : 'Write the task. The personas work it unattended and the reply lands in your Inbox.'
          }
          rows={forward ? 4 : 10}
          autoFocus
          onPaste={(e) => void files.onPaste(e)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={files.onDrop}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {forward && (
          <pre className="mail-forward-quote" aria-label="The forwarded mail">
            {forward.quote}
          </pre>
        )}
        <AttachmentChips attachments={files.attachments} onRemove={files.remove} />
        {error && <p className="task-failed">{error}</p>}
        <div className="mail-compose-actions">
          <button
            type="button"
            className="composer-attach"
            title="Attach"
            onClick={() => void files.pickFiles()}
          >
            <Paperclip size={15} />
          </button>
          <button
            className="mail-send"
            onClick={() => void send()}
            disabled={sending || empty || to.length === 0}
          >
            <Send size={14} /> {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
});

const APPROVAL_SETTLED: Record<Exclude<MailApproval['status'], 'pending'>, string> = {
  allowed: 'You allowed it — the task continued.',
  denied: 'You denied it — the task continued without it.',
  superseded: 'You answered with a mail instead.',
  cancelled: 'The conversation was stopped.'
};

/**
 * A parked run's Allow/Deny: the command Stem's safety check would not run
 * without the user, and why. Answering resumes the run on its own thread.
 */
function MailApprovalBlock({ itemId, approval }: { itemId: string; approval: MailApproval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (decision: 'allow' | 'deny') => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.stem.resolveMailApproval(itemId, decision);
      if (!result.ok) setError(result.error ?? 'That approval could not be answered.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mail-item-approval" aria-label="Approval needed">
      <div className="mcp-approval-head">
        <span className="row-icon">
          <ShieldAlert size={14} />
        </span>
        <strong>{approval.kind === 'harness' ? 'The coding agent wants to run' : 'Run this command'}{approval.deviceLabel ? ` on ${approval.deviceLabel}` : ''}?</strong>
      </div>
      <pre className="exec-approval-command">{approval.command}</pre>
      {approval.reason && <p className="muted">Safety check: {approval.reason}</p>}
      {approval.cwd && <p className="muted">In {approval.cwd}</p>}
      {error && <p className="error">{error}</p>}
      {approval.status === 'pending' ? (
        <div className="mcp-approval-actions">
          <button type="button" className="push" onClick={() => void answer('deny')} disabled={busy}>
            Deny
          </button>
          <button type="button" className="push default" onClick={() => void answer('allow')} disabled={busy}>
            Allow once
          </button>
        </div>
      ) : (
        <p className="muted">{APPROVAL_SETTLED[approval.status]}</p>
      )}
    </section>
  );
}
