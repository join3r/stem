import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, X } from 'lucide-react';
import type { MailComposeInput, MailConversation, MailItem, Persona } from '../../shared/types';
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
  // Expanded exchange groups, keyed by their first item's id (stable across refreshes).
  const [openExchanges, setOpenExchanges] = useState<Set<string>>(new Set());
  const now = Date.now();
  const scrollRef = useRef<HTMLDivElement>(null);
  const mails = useMemo(
    () => items.filter((i) => i.conversationId === conversation.id).sort((a, b) => a.at - b.at),
    [items, conversation.id]
  );
  const groups = useMemo(() => groupMailTimeline(mails), [mails]);
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
        <span className="mail-item-at">{formatAt(m.at, now)}</span>
      </div>
      {m.from === 'user' ? <p className="mail-item-body-plain">{m.body}</p> : <MdxView text={m.body} />}
    </article>
  );

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
  // The To: list in SELECTION ORDER — the first-picked persona is the driver
  // (it receives the mail and owns returning to the user); the rest are
  // participants the driver can consult with send_mail.
  const [to, setTo] = useState<string[]>(['normal']);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleTo = (id: string) => {
    setTo((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  };

  const send = async () => {
    if (sending || !body.trim()) return;
    setSending(true);
    setError(null);
    try {
      await onCompose({ to, subject, body });
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
        <textarea
          className="mail-compose-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write the task. The personas work it unattended and the reply lands in your Inbox."
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
          <button
            className="mail-send"
            onClick={() => void send()}
            disabled={sending || !body.trim() || to.length === 0}
          >
            <Send size={14} /> {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
