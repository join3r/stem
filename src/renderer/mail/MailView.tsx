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
import {
  Check,
  ChevronUp,
  Clock,
  CornerDownRight,
  File,
  Forward,
  Lock,
  Paperclip,
  Plus,
  RotateCcw,
  Send,
  ShieldAlert,
  Square,
  X,
  Pencil,
  Trash2
} from 'lucide-react';
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
import { mailPreviewText } from '../../shared/mail-subject';
import { exchangeLabel, layoutThread, type ThreadEntry } from './thread';
import { MailToField } from './MailToField';
import { personaName, type PendingSend } from './useMail';
import {
  EMPTY_COMPOSE,
  freshCompose,
  readComposeDraft,
  rememberRecipients,
  readReplyDraft,
  writeComposeDraft,
  writeReplyDraft
} from './mail-drafts';
import { useMailWork } from './useMailWork';
import { MailWork } from './MailWork';
import { GeneratedImages } from '../chat/GeneratedImage';

// The centre pane's mail surface: a conversation read like the Inbox (newest
// on top, the reply box above the mail it answers, older mails folded to one
// line), or the compose form for a new one. The personas' consulting folds onto
// the reply it produced, and their live work shows on a card at the top.

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

  const add = useCallback((more: TurnAttachment[]) => {
    if (more.length) setAttachments((prev) => [...prev, ...more]);
  }, []);

  return { attachments, addFiles, pickFiles, onPaste, onDrop, remove, clear, add };
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
  /** This conversation's replies still on their way, or failed. */
  pending: PendingSend[];
  onRetrySend: (id: string) => void;
  onDropSend: (id: string) => void;
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
  { conversation, items, personas, onReply, pending, onRetrySend, onDropSend, onAddParticipant, onStop, onForward, currentSys },
  ref
) {
  // Keyed by conversation in App, so this mounts fresh per conversation and
  // its draft is that conversation's own.
  const [draft, setDraft] = useState(() => readReplyDraft(conversation.id).text);
  const files = useAttachmentDraft(readReplyDraft(conversation.id).attachments);
  useEffect(() => {
    writeReplyDraft(conversation.id, { text: draft, attachments: files.attachments });
  }, [conversation.id, draft, files.attachments]);
  useImperativeHandle(ref, () => ({
    addAttachments: (dropped) => void files.addFiles(dropped)
  }));
  const [addingTo, setAddingTo] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Mails the user opened or folded, flipping their default (see layoutThread).
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  // Mails whose folded-in persona exchange is shown.
  const [openExchanges, setOpenExchanges] = useState<Set<string>>(new Set());
  const now = Date.now();
  const scrollRef = useRef<HTMLDivElement>(null);
  const mails = useMemo(
    () => items.filter((i) => i.conversationId === conversation.id),
    [items, conversation.id]
  );
  const work = useMailWork(conversation.id);
  const layout = useMemo(() => layoutThread(mails, work.groups), [mails, work.groups]);
  const addable = useMemo(
    () => personas.filter((p) => !conversation.participants.includes(p.id)),
    [personas, conversation.participants]
  );
  const name = (id: string) => (id === 'user' ? 'You' : personaName(personas, id));
  const lead = conversation.participants[0];
  // A run parked on the user's Allow/Deny takes the next mail instead of the lead.
  const parkedBy = layout.entries.find((e) => e.item.approval?.status === 'pending')?.item.from;
  const recipient = parkedBy ?? lead;
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

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) => {
    set((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const isOpen = (id: string) => layout.defaultOpen.has(id) !== flipped.has(id);

  /** A failed send goes back into the box for another try; it leaves the thread. */
  const editSend = (p: PendingSend) => {
    setDraft((prev) => (prev.trim() ? `${prev}\n\n${p.body}` : p.body));
    files.add(p.attachments ?? []);
    onDropSend(p.id);
  };

  const pendingCard = (p: PendingSend) => (
    <article
      key={p.id}
      className={`mail-item from-user mail-pending${p.status === 'failed' ? ' failed' : ''}`}
      aria-live="polite"
    >
      <div className="mail-item-head">
        <strong>You</strong>
        <span className="mail-item-to">to {name(recipient)}</span>
        <span className="mail-pending-state">
          {p.status === 'sending' ? (
            <>
              <span className="mail-spin" aria-hidden="true" /> Sending…
            </>
          ) : (
            'Not sent'
          )}
        </span>
      </div>
      {p.body && <p className="mail-item-body-plain">{p.body}</p>}
      {p.attachments && p.attachments.length > 0 && (
        <div className="message-attachments">
          {p.attachments.map((att, i) => (
            <span className="attachment-chip" key={i}>
              <File size={13} />
              <span className="attachment-name">{att.name}</span>
            </span>
          ))}
        </div>
      )}
      {p.status === 'failed' && (
        <>
          <p className="mail-pending-error">{p.error || 'The server didn’t answer.'} Your text is safe.</p>
          <div className="mail-pending-actions">
            <button
              type="button"
              className="icon-action sm"
              onClick={() => onRetrySend(p.id)}
              title="Retry"
              aria-label="Retry sending"
            >
              <RotateCcw size={13} />
            </button>
            <button type="button" className="icon-action sm" onClick={() => editSend(p)} title="Edit" aria-label="Edit">
              <Pencil size={13} />
            </button>
            <button
              type="button"
              className="icon-action sm"
              onClick={() => onDropSend(p.id)}
              title="Delete"
              aria-label="Delete"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </>
      )}
    </article>
  );

  const exchangeMails = (key: string, exchange: MailItem[]) =>
    openExchanges.has(key) && (
      <div className="mail-exchange">
        {exchange.map((m) => (
          <article key={m.id} className="mail-item exchange">
            <div className="mail-item-head">
              <strong>{name(m.from)}</strong>
              <span className="mail-item-to">→ {m.to.map(name).join(', ')}</span>
              <span className="mail-item-at">{formatAt(m.at, now)}</span>
            </div>
            <MdxView text={m.body} />
          </article>
        ))}
      </div>
    );

  const exchangeChip = (key: string, exchange: MailItem[], author: string) =>
    exchange.length > 0 && (
      <button
        type="button"
        className="mail-chip"
        aria-expanded={openExchanges.has(key)}
        onClick={(e) => {
          e.stopPropagation();
          toggle(setOpenExchanges, key);
        }}
        title="The mail the personas sent each other before this reply"
      >
        <CornerDownRight size={12} />
        {exchangeLabel(exchange, author, name)}
      </button>
    );

  const folded = (entry: ThreadEntry) => {
    const m = entry.item;
    return (
      <Fragment key={m.id}>
        <button type="button" className="mail-fold" onClick={() => toggle(setFlipped, m.id)} aria-expanded={false}>
          <span className="mail-fold-who">{name(m.from)}</span>
          <span className="mail-fold-gist">{mailPreviewText(m.body) || (m.attachments?.length ? 'Attachments' : '')}</span>
          {exchangeChip(m.id, entry.exchange, m.from)}
          {m.stale && <span className="mail-item-stale">↩ earlier mail</span>}
          <span className="mail-fold-at">{formatAt(m.at, now)}</span>
        </button>
        {exchangeMails(m.id, entry.exchange)}
      </Fragment>
    );
  };

  const card = (entry: ThreadEntry) => {
    const m = entry.item;
    return (
      <Fragment key={m.id}>
        <article className={`mail-item${m.from === 'user' ? ' from-user' : ''}`}>
          <div className="mail-item-head">
            <strong title={m.sys ? `Made by system: ${formatSystemVersion(m.sys)}` : undefined}>{name(m.from)}</strong>
            <span className="mail-item-to">to {m.to.map((t) => (t === 'user' ? 'you' : name(t))).join(', ')}</span>
            {m.sys && currentSys && !sameSystem(m.sys, currentSys) && (
              <span
                className="mail-item-sys"
                title={`Made by an older version of the persona system (${formatSystemVersion(m.sys)}); now ${formatSystemVersion(currentSys)}`}
              >
                older system
              </span>
            )}
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
              className="icon-action sm mail-item-btn"
              onClick={() => forward(m)}
              title="Forward — send this mail on to personas in a new conversation"
              aria-label="Forward this mail"
            >
              <Forward size={13} />
            </button>
            {m.approval?.status !== 'pending' && (
              <button
                type="button"
                className="icon-action sm mail-item-btn"
                onClick={() => toggle(setFlipped, m.id)}
                title="Fold this mail to one line"
                aria-label="Fold this mail"
              >
                <ChevronUp size={13} />
              </button>
            )}
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
          {(entry.exchange.length > 0 || entry.work.length > 0) && (
            <div className="mail-item-foot">
              {exchangeChip(m.id, entry.exchange, m.from)}
              {entry.work.map((group) => (
                <MailWork key={group.id} group={group} personas={personas} />
              ))}
            </div>
          )}
        </article>
        {exchangeMails(m.id, entry.exchange)}
      </Fragment>
    );
  };

  const working = conversation.status === 'working';
  const showOthers = conversation.participants.filter((p) => p !== recipient);

  return (
    <div className="mail-view">
      <header className="mail-head">
        <div className="mail-head-main">
          <h1 title={conversation.subject}>{conversation.subject}</h1>
          <div className="mail-head-to">
            <span>
              <strong>{name(lead)}</strong>
              {conversation.participants.length > 1 && ' leads'}
              {conversation.participants.slice(1).map((p) => ` · ${name(p)}`)}
            </span>
            {working && (
              <span className="mail-status working">
                <span className="mail-spin" aria-hidden="true" /> Working
              </span>
            )}
            {conversation.status === 'awaiting-user' && <span className="mail-status waiting">Waiting on you</span>}
            {conversation.status === 'failed' && (
              <span className="mail-status failed">Failed — the latest mail says why; reply to try again</span>
            )}
            {conversation.status === 'aborted' && <span className="mail-status">Stopped — reply to pick it back up</span>}
          </div>
        </div>
        {addable.length > 0 && (
          <button
            className="icon-action mail-add-toggle"
            onClick={() => setAddingTo((v) => !v)}
            title="Add a persona to this conversation"
            aria-label="Add a persona to this conversation"
            aria-expanded={addingTo}
          >
            <Plus size={14} />
          </button>
        )}
      </header>
      {addingTo && addable.length > 0 && (
        <div className="mail-add-row">
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
          {addError && <p className="task-failed">{addError}</p>}
        </div>
      )}
      <div className="mail-items" ref={scrollRef}>
        <ReplyBox
          key={conversation.id}
          draft={draft}
          setDraft={setDraft}
          files={files}
          recipient={name(recipient)}
          others={showOthers.map(name)}
          parked={!!parkedBy}
          working={working}
          onSend={send}
        />
        {[...pending].reverse().map(pendingCard)}
        {working && (
          <LiveCard
            groups={layout.liveWork}
            lead={name(lead)}
            personas={personas}
            onStop={onStop}
          />
        )}
        {layout.trailingExchange.length > 0 && (
          <>
            <div className="mail-fold-row">
              {exchangeChip('trailing', layout.trailingExchange, lead)}
            </div>
            {exchangeMails('trailing', layout.trailingExchange)}
          </>
        )}
        {work.error && (
          <p className="mail-work-note">
            {work.error}{' '}
            <button type="button" className="icon-action sm inline" onClick={work.refresh} title="Retry" aria-label="Retry">
              <RotateCcw size={12} />
            </button>
          </p>
        )}
        {layout.entries.map((entry) => (isOpen(entry.item.id) ? card(entry) : folded(entry)))}
        {layout.unlinkedWork.length > 0 && (
          <details className="mail-earlier-work">
            <summary>
              Earlier work · {layout.unlinkedWork.length} {layout.unlinkedWork.length === 1 ? 'record' : 'records'} not tied to a mail
            </summary>
            {layout.unlinkedWork.map((group) => (
              <MailWork key={group.id} group={group} personas={personas} unlinked />
            ))}
          </details>
        )}
        {mails.length === 0 && pending.length === 0 && <p className="muted">This conversation has no mail yet.</p>}
      </div>
    </div>
  );
});

/**
 * The reply box, on top under the header like an email client's: one line
 * until you click into it or have a draft, then it says who gets the reply.
 */
function ReplyBox({
  draft,
  setDraft,
  files,
  recipient,
  others,
  parked,
  working,
  onSend
}: {
  draft: string;
  setDraft: (text: string) => void;
  files: ReturnType<typeof useAttachmentDraft>;
  recipient: string;
  others: string[];
  parked: boolean;
  working: boolean;
  onSend: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const hasDraft = !!draft.trim() || files.attachments.length > 0;
  const expanded = focused || hasDraft;
  return (
    <div
      ref={boxRef}
      className={`mail-reply${expanded ? ' expanded' : ''}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={files.onDrop}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        // Moving to the box's own buttons keeps it open; leaving it collapses an empty one.
        if (!boxRef.current?.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {expanded && (
        <div className="mail-reply-to">
          <span>To</span>
          <span className="mail-reply-recipient">{recipient}</span>
          {parked ? (
            <span>instead of answering its Allow or Deny.</span>
          ) : (
            others.length > 0 && (
              <span>
                {others.join(', ')} {others.length === 1 ? 'hears' : 'hear'} this only if {recipient} asks.
              </span>
            )
          )}
        </div>
      )}
      {expanded && working && (
        <p className="mail-reply-note">
          <Clock size={13} />
          {recipient} reads this when its current run ends. If that run answers your earlier mail, it’s marked so.
        </p>
      )}
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={`Reply to ${recipient}`}
        placeholder={parked ? `Or answer in words — ${recipient} gets this instead of Allow or Deny` : `Reply to ${recipient}`}
        rows={expanded ? 3 : 1}
        onPaste={(e) => void files.onPaste(e)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      {expanded && (
        <>
          <AttachmentChips attachments={files.attachments} onRemove={files.remove} />
          <div className="mail-reply-actions">
            <button type="button" className="icon-action" title="Attach" aria-label="Attach" onClick={() => void files.pickFiles()}>
              <Paperclip size={14} />
            </button>
            {hasDraft && (
              <span className="mail-draft-saved">
                <Check size={12} /> Draft saved
              </span>
            )}
            <span className="mail-compose-spacer" />
            <span className="mail-kbd">⌘↵</span>
            <button className="mail-send" onClick={onSend} disabled={!hasDraft} title="Send reply (⌘↵)">
              <Send size={14} /> Send
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** While personas work: who is on it, the latest steps, and Stop — at the top, where you look. */
function LiveCard({
  groups,
  lead,
  personas,
  onStop
}: {
  groups: MailWorkGroup[];
  lead: string;
  personas: Persona[];
  onStop: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const [showWork, setShowWork] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const runs = groups.flatMap((g) => g.runs).filter((r) => r.status === 'running');
  const names = [...new Set(runs.map((r) => personaName(personas, r.personaId)))];
  const who = names.length ? names : [lead];
  const started = runs.length ? Math.min(...runs.map((r) => r.startedAt)) : null;
  const steps = runs
    .flatMap((r) => r.activities)
    .sort((a, b) => b.at - a.at)
    .slice(0, 3);
  const elapsed = started ? Math.max(0, Math.floor((now - started) / 1000)) : null;
  return (
    <section className="mail-live" aria-label="Live progress" aria-live="polite">
      <div className="mail-live-head">
        <span className="mail-spin" aria-hidden="true" />
        <strong>
          {who.join(' and ')} {who.length > 1 ? 'are' : 'is'} on it
        </strong>
        {elapsed !== null && (
          <span className="mail-live-time">
            {elapsed < 60 ? `${elapsed} s` : `${Math.floor(elapsed / 60)} min ${elapsed % 60} s`}
          </span>
        )}
        <span className="mail-compose-spacer" />
        {groups.length > 0 && (
          <button type="button" className="mail-chip" aria-expanded={showWork} onClick={() => setShowWork((v) => !v)}>
            {showWork ? 'Hide work' : 'Show work'}
          </button>
        )}
        <button
          type="button"
          className="mail-chip danger"
          onClick={onStop}
          title="Stop — drop queued deliveries and interrupt the running personas"
        >
          <Square size={10} /> Stop
        </button>
      </div>
      {steps.length ? (
        <ul className="mail-live-steps">
          {steps.map((s) => (
            <li key={s.id} className={s.status}>
              {s.status === 'running' ? (
                <span className="mail-spin" aria-hidden="true" />
              ) : s.status === 'ok' ? (
                <Check size={12} />
              ) : (
                <X size={12} />
              )}
              {s.label}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mail-live-idle">Starting…</p>
      )}
      {showWork && groups.map((group) => <MailWork key={group.id} group={group} personas={personas} />)}
    </section>
  );
}

export const MailComposeView = forwardRef<MailViewHandle, {
  personas: Persona[];
  /** Resolves once sent; rejection shows its message inline. */
  onCompose: (input: MailComposeInput) => Promise<void>;
  onCancel: () => void;
  /** Open as a forward: the subject prefilled, the original quoted under the note. */
  forward?: MailForwardDraft;
}>(function MailComposeView({ personas, onCompose, onCancel, forward }, ref) {
  // A plain New mail resumes the saved draft; a forward starts from its quote
  // and is never saved (it is one click away on the original mail).
  // A blank one is addressed to whoever the last mail went to.
  const [saved] = useState(() => {
    // An empty list is personas still loading, not every persona deleted.
    const fresh = freshCompose(personas.length ? new Set(personas.map((p) => p.id)) : undefined);
    return forward ? { ...EMPTY_COMPOSE, to: fresh.to } : readComposeDraft() ?? fresh;
  });
  // The To: list in SELECTION ORDER — the first persona leads (it receives the
  // mail and owns returning to the user); the rest are participants the lead
  // can consult with send_mail.
  const [to, setTo] = useState<string[]>(saved.to);
  const [subject, setSubject] = useState(forward?.subject ?? saved.subject);
  const [body, setBody] = useState(saved.body);
  const [isPrivate, setIsPrivate] = useState(saved.private);
  const files = useAttachmentDraft(forward?.attachments ?? saved.attachments);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const sentRef = useRef(false);
  useEffect(() => {
    if (forward || sentRef.current) return;
    writeComposeDraft({ to, subject, body, private: isPrivate, attachments: files.attachments });
  }, [forward, to, subject, body, isPrivate, files.attachments]);
  // A forward always has something to send — the quote — even with no note.
  const empty = !forward && !body.trim() && !files.attachments.length;
  const hasDraft = !forward && (!!body.trim() || !!subject.trim() || files.attachments.length > 0);
  useImperativeHandle(ref, () => ({
    addAttachments: (dropped) => void files.addFiles(dropped)
  }));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leadName = to[0] ? personaName(personas, to[0]) : null;

  const send = async () => {
    if (sending || empty || to.length === 0) return;
    setSending(true);
    setError(null);
    try {
      // Stop saving first: the pane unmounts as the send resolves.
      sentRef.current = true;
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
      rememberRecipients(to);
      if (!forward) writeComposeDraft(null);
    } catch (err) {
      sentRef.current = false;
      setError(err instanceof Error ? err.message : String(err));
      setSending(false);
    }
  };

  const discard = () => {
    if (!forward) writeComposeDraft(null);
    sentRef.current = true;
    onCancel();
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
        <span className="mail-compose-spacer" />
        {hasDraft && (
          <span className="mail-draft-saved">
            <Check size={12} /> Draft saved
          </span>
        )}
        <button
          type="button"
          className={`mail-private-switch${isPrivate ? ' on' : ''}`}
          aria-pressed={isPrivate}
          onClick={() => setIsPrivate((v) => !v)}
          title="Private: nothing in this conversation is saved to memory or read from it, and the personas keep no notes of it. Fixed once sent."
        >
          <Lock size={12} /> Private
        </button>
        <button
          className="icon-action sm"
          onClick={forward ? discard : onCancel}
          title={forward ? 'Discard' : 'Close — the draft is kept'}
          aria-label={forward ? 'Discard' : 'Close and keep the draft'}
        >
          <X size={14} />
        </button>
      </header>
      {isPrivate && (
        <p className="mail-private-note">
          <Lock size={12} /> Private: nothing here is saved to memory or read from it. Fixed once sent.
        </p>
      )}
      <div className="mail-compose-form">
        <div className="mail-field mail-field-to">
          <span>To</span>
          <MailToField personas={personas} to={to} onChange={setTo} />
        </div>
        <label className="mail-field">
          <span>Subject</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Optional — Stem names it after the first reply"
          />
        </label>
        <textarea
          className="mail-compose-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-label="Mail"
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
            aria-label="Attach"
            onClick={() => void files.pickFiles()}
          >
            <Paperclip size={15} />
          </button>
          {confirmDiscard ? (
            <span className="mail-discard-confirm" role="group" aria-label="Discard this draft?">
              Discard this draft?
              <button type="button" className="push default danger" onClick={discard}>
                Discard
              </button>
              <button type="button" className="push" onClick={() => setConfirmDiscard(false)}>
                Keep
              </button>
            </span>
          ) : (
            !forward && (
              <button type="button" className="mail-discard" onClick={() => setConfirmDiscard(true)} disabled={!hasDraft}>
                Discard…
              </button>
            )
          )}
          <span className="mail-compose-spacer" />
          <span className="mail-kbd">⌘↵</span>
          <button
            className="mail-send"
            onClick={() => void send()}
            disabled={sending || empty || to.length === 0}
          >
            <Send size={14} /> {sending ? 'Sending…' : leadName ? `Send to ${leadName}` : 'Send'}
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
