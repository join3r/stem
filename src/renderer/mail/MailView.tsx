import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, X } from 'lucide-react';
import type { MailComposeInput, MailConversation, MailItem, Persona } from '../../shared/types';
import { MdxView } from '../chat/MdxView';
import { personaName } from './useMail';

// The centre pane's mail surface: a conversation read like email (discrete
// mails, newest last, a reply box underneath), or the compose form for a new
// one. Deliberately NOT a chat view — items are immutable mails, there is no
// streaming, and the persona's work happens out of sight on its hidden thread;
// the row spinner in the list is the only "in progress" signal.

function formatAt(at: number, now: number): string {
  const d = new Date(at);
  const sameDay = new Date(now);
  sameDay.setHours(0, 0, 0, 0);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (at >= sameDay.getTime()) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

export function MailConversationView({
  conversation,
  items,
  personas,
  onReply
}: {
  conversation: MailConversation;
  items: MailItem[];
  personas: Persona[];
  onReply: (body: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const now = Date.now();
  const scrollRef = useRef<HTMLDivElement>(null);
  const mails = useMemo(
    () => items.filter((i) => i.conversationId === conversation.id).sort((a, b) => a.at - b.at),
    [items, conversation.id]
  );
  // Land at the newest mail on open and when one arrives — email reads bottom-up here.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [mails.length]);

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    onReply(body);
    setDraft('');
  };

  return (
    <div className="mail-view">
      <header className="mail-head">
        <h1 title={conversation.subject}>{conversation.subject}</h1>
        <span className="mail-head-to">
          To: {conversation.participants.map((p) => personaName(personas, p)).join(', ')}
          {conversation.status === 'working' && <em> · working…</em>}
          {conversation.status === 'awaiting-user' && <em> · waiting on your reply</em>}
        </span>
      </header>
      <div className="mail-items" ref={scrollRef}>
        {mails.map((m) => (
          <article key={m.id} className={`mail-item${m.from === 'user' ? ' from-user' : ''}`}>
            <div className="mail-item-head">
              <strong>{m.from === 'user' ? 'You' : personaName(personas, m.from)}</strong>
              <span className="mail-item-at">{formatAt(m.at, now)}</span>
            </div>
            {m.from === 'user' ? (
              <p className="mail-item-body-plain">{m.body}</p>
            ) : (
              <MdxView text={m.body} />
            )}
          </article>
        ))}
        {mails.length === 0 && (
          <p className="muted">This conversation has no mail yet.</p>
        )}
      </div>
      <div className="mail-reply">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Reply to ${conversation.participants.map((p) => personaName(personas, p)).join(', ')}…`}
          rows={3}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="mail-send" onClick={send} disabled={!draft.trim()} title="Send reply (⌘↵)">
          <Send size={14} /> Send
        </button>
      </div>
    </div>
  );
}

export function MailComposeView({
  personas,
  onCompose,
  onCancel
}: {
  personas: Persona[];
  /** Resolves once sent; rejection shows its message inline. */
  onCompose: (input: MailComposeInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [to, setTo] = useState('normal');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (sending || !body.trim()) return;
    setSending(true);
    setError(null);
    try {
      await onCompose({ to: [to], subject, body });
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
        <label className="mail-field">
          <span>To</span>
          <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Persona this mail goes to">
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mail-field">
          <span>Subject</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What this is about"
          />
        </label>
        <textarea
          className="mail-compose-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write the task. The persona works it unattended and its reply lands in your Inbox."
          rows={10}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {error && <p className="task-failed">{error}</p>}
        <div className="mail-compose-actions">
          <button className="mail-send" onClick={() => void send()} disabled={sending || !body.trim()}>
            <Send size={14} /> {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
