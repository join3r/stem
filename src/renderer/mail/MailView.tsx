import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react';
import { File, Paperclip, Plus, Send, Square, X } from 'lucide-react';
import type {
  MailComposeInput,
  MailConversation,
  MailItem,
  Persona,
  TurnAttachment
} from '../../shared/types';
import { MdxView } from '../chat/MdxView';
import { groupMailTimeline } from './grouping';
import { personaName } from './useMail';

// The centre pane's mail surface: a conversation read like email (discrete
// mails, newest last, a reply box underneath), or the compose form for a new
// one. Deliberately NOT a chat view — items are immutable mails, there is no
// streaming, and the persona's work happens out of sight on its hidden thread;
// the row spinner in the list is the only "in progress" signal. Persona↔persona
// exchanges collapse behind per-gap "N mails exchanged" dividers: the user's
// conversation reads clean, the work is inspectable in place.

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
function useAttachmentDraft() {
  const [attachments, setAttachments] = useState<TurnAttachment[]>([]);

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
}>(function MailConversationView(
  { conversation, items, personas, onReply, onAddParticipant, onStop },
  ref
) {
  const [draft, setDraft] = useState('');
  const files = useAttachmentDraft();
  useImperativeHandle(ref, () => ({
    addAttachments: (dropped) => void files.addFiles(dropped)
  }));
  const [addingTo, setAddingTo] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Expanded exchange groups, keyed by their first item's id (stable across refreshes).
  const [openExchanges, setOpenExchanges] = useState<Set<string>>(new Set());
  const now = Date.now();
  const scrollRef = useRef<HTMLDivElement>(null);
  const mails = useMemo(
    () => items.filter((i) => i.conversationId === conversation.id).sort((a, b) => a.at - b.at),
    [items, conversation.id]
  );
  const groups = useMemo(() => groupMailTimeline(mails), [mails]);
  const addable = useMemo(
    () => personas.filter((p) => !conversation.participants.includes(p.id)),
    [personas, conversation.participants]
  );
  // Land at the newest mail on open and when one arrives — email reads bottom-up here.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [mails.length]);

  const send = () => {
    const body = draft.trim();
    if (!body && !files.attachments.length) return;
    onReply(body, files.attachments.length ? files.attachments : undefined);
    setDraft('');
    files.clear();
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
    <article key={m.id} className={`mail-item${m.from === 'user' ? ' from-user' : ''}${exchange ? ' exchange' : ''}`}>
      <div className="mail-item-head">
        <strong>{m.from === 'user' ? 'You' : personaName(personas, m.from)}</strong>
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
      </div>
      {m.from === 'user' ? <p className="mail-item-body-plain">{m.body}</p> : <MdxView text={m.body} />}
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
        {groups.map((group) => {
          if (group.kind === 'mail') return mailCard(group.item, false);
          const key = group.items[0].id;
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
}>(function MailComposeView({ personas, onCompose, onCancel }, ref) {
  // The To: list in SELECTION ORDER — the first-picked persona is the driver
  // (it receives the mail and owns returning to the user); the rest are
  // participants the driver can consult with send_mail.
  const [to, setTo] = useState<string[]>(['normal']);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const files = useAttachmentDraft();
  useImperativeHandle(ref, () => ({
    addAttachments: (dropped) => void files.addFiles(dropped)
  }));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleTo = (id: string) => {
    setTo((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  };

  const send = async () => {
    if (sending || (!body.trim() && !files.attachments.length)) return;
    setSending(true);
    setError(null);
    try {
      await onCompose({
        to,
        subject,
        body,
        ...(isPrivate ? { private: true } : {}),
        ...(files.attachments.length ? { attachments: files.attachments } : {})
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSending(false);
    }
  };

  return (
    <div className="mail-view mail-compose">
      <header className="mail-head">
        <h1>New mail</h1>
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
          placeholder="Write the task. The personas work it unattended and the reply lands in your Inbox."
          rows={10}
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
            disabled={sending || (!body.trim() && !files.attachments.length) || to.length === 0}
          >
            <Send size={14} /> {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
});
