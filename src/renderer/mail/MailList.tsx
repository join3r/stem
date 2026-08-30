import { useEffect, useMemo, useState } from 'react';
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  ChevronRight,
  Mail,
  MailOpen,
  Send,
  Trash2
} from 'lucide-react';
import type { MailConversation, MailListResult, Persona } from '../../shared/types';
import { formatWake, isUnread, nextWakeAt, placement, type InboxSubject } from '../../shared/inbox';
import { SnoozeMenu } from '../chats/SnoozeMenu';
import { personaName } from './useMail';

// The Inbox tab's list: mail conversations, email-style. The waiting mail sits
// on top (unread bold), with what you've dealt with collapsed underneath —
// Snoozed, Archived, and Sent (every conversation, newest send first; the sent
// "copy" of a mail is its conversation). Placement and unread reuse the shared
// inbox derivations, fed each conversation's userUpdatedAt, so persona-internal
// traffic never resurrects or bolds a row.

export interface MailListProps {
  mail: MailListResult;
  personas: Persona[];
  activeConversationId: string | null;
  onOpen: (conversationId: string) => void;
  onArchive: (ids: string[], archived: boolean) => void;
  onSnooze: (ids: string[], until: number | null) => void;
  onSetRead: (ids: string[], read: boolean) => void;
  onDelete: (conversationId: string) => void;
}

/** The placement/unread input for a conversation row. */
function subjectOf(c: MailConversation): InboxSubject {
  return { threadId: c.id, updatedAt: c.userUpdatedAt };
}

type Menu = { id: string; x: number; y: number };
type Snoozing = { ids: string[]; x: number; y: number };

export function MailList(props: MailListProps) {
  const { mail, personas, onOpen } = props;
  const [snoozing, setSnoozing] = useState<Snoozing | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [sentOpen, setSentOpen] = useState(false);

  // One timer for the earliest snooze wake — the ChatList treatment, verbatim.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const at = nextWakeAt(mail.conversations.map(subjectOf), mail.inbox, now);
    if (at == null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(250, at - Date.now()));
    return () => clearTimeout(timer);
  }, [mail, now]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener('click', close);
    document.addEventListener('contextmenu', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('contextmenu', close);
    };
  }, [menu]);

  const sections = useMemo(() => {
    const inbox: MailConversation[] = [];
    const snoozed: MailConversation[] = [];
    const archived: MailConversation[] = [];
    for (const c of mail.conversations) {
      const where = placement(subjectOf(c), mail.inbox, now);
      if (where === 'snoozed') snoozed.push(c);
      else if (where === 'archived') archived.push(c);
      // The Inbox holds mail you RECEIVED. A conversation nothing has been
      // mailed back on yet (userUpdatedAt 0) is just your own send — it lives
      // under Sent (spinner included) until a reply lands, like email.
      else if (c.userUpdatedAt > 0) inbox.push(c);
    }
    inbox.sort((a, b) => b.updatedAt - a.updatedAt);
    snoozed.sort(
      (a, b) =>
        (mail.inbox.entries[a.id]?.snoozedUntil ?? 0) - (mail.inbox.entries[b.id]?.snoozedUntil ?? 0)
    );
    archived.sort((a, b) => b.updatedAt - a.updatedAt);
    // Sent: every conversation, ordered by the user's own last send.
    const lastSent = new Map<string, number>();
    for (const item of mail.items) {
      if (item.from === 'user') {
        lastSent.set(item.conversationId, Math.max(lastSent.get(item.conversationId) ?? 0, item.at));
      }
    }
    const sent = mail.conversations
      .filter((c) => lastSent.has(c.id))
      .sort((a, b) => (lastSent.get(b.id) ?? 0) - (lastSent.get(a.id) ?? 0));
    return { inbox, snoozed, archived, sent };
  }, [mail, now]);

  /** The two-line body under a subject: the latest mail addressed to the user,
   *  else the user's own latest send (a conversation still being worked). */
  const previewOf = (c: MailConversation): string => {
    let best: { at: number; body: string } | null = null;
    let bestUser: { at: number; body: string } | null = null;
    for (const item of mail.items) {
      if (item.conversationId !== c.id) continue;
      if (item.to.includes('user') && (!best || item.at > best.at)) best = item;
      if (item.from === 'user' && (!bestUser || item.at > bestUser.at)) bestUser = item;
    }
    return (best ?? bestUser)?.body.slice(0, 200) ?? '';
  };

  const fromLabel = (c: MailConversation): string =>
    c.participants.map((p) => personaName(personas, p)).join(', ');

  const renderRow = (c: MailConversation, variant: 'inbox' | 'snoozed' | 'archived' | 'sent') => {
    const unread = isUnread(subjectOf(c), mail.inbox);
    const wake = mail.inbox.entries[c.id]?.snoozedUntil;
    return (
      <div
        key={`${variant}-${c.id}`}
        data-conversation-id={c.id}
        className={[
          'group-row chat-row inbox-row mail-row has-preview lines-2',
          c.id === props.activeConversationId ? 'selected' : '',
          unread ? 'unread' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => onOpen(c.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ id: c.id, x: e.clientX, y: e.clientY });
        }}
      >
        <span className="row-icon chat">
          {c.status === 'working' ? (
            <span className="chat-status running" title="A persona is working on this" aria-label="Working" />
          ) : unread ? (
            <Mail size={13} />
          ) : (
            <MailOpen size={13} />
          )}
        </span>
        <span className="row-main">
          <span className="mail-from">
            {fromLabel(c)}
            {c.status === 'awaiting-user' && <em className="mail-needs-you"> · needs you</em>}
          </span>
          <strong title={c.subject}>{c.subject}</strong>
          <span className="chat-preview">{previewOf(c)}</span>
        </span>
        {variant === 'snoozed' && wake != null && <span className="chat-wake">{formatWake(wake, now)}</span>}
        <span className="chat-actions">
          {variant === 'inbox' && (
            <button
              className="chat-action"
              title="Snooze"
              aria-label="Snooze"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSnoozing({ ids: [c.id], x: e.clientX, y: e.clientY });
              }}
            >
              <AlarmClock size={13} />
            </button>
          )}
          {variant === 'snoozed' && (
            <button
              className="chat-action"
              title="Un-snooze"
              aria-label="Un-snooze"
              onClick={(e) => {
                e.stopPropagation();
                props.onSnooze([c.id], null);
              }}
            >
              <AlarmClockOff size={13} />
            </button>
          )}
          {variant !== 'snoozed' && (
            <button
              className="chat-action"
              title={variant === 'archived' ? 'Move to Inbox' : 'Archive'}
              aria-label={variant === 'archived' ? 'Move to Inbox' : 'Archive'}
              onClick={(e) => {
                e.stopPropagation();
                props.onArchive([c.id], variant !== 'archived');
              }}
            >
              {variant === 'archived' ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            </button>
          )}
        </span>
      </div>
    );
  };

  const section = (
    label: string,
    icon: React.ReactNode,
    rows: MailConversation[],
    open: boolean,
    toggle: () => void,
    variant: 'snoozed' | 'archived' | 'sent'
  ) =>
    rows.length > 0 && (
      <>
        <button className="memory-view-toggle inbox-snoozed-toggle" onClick={toggle}>
          <ChevronRight size={13} className={open ? 'open' : ''} />
          {icon}
          {label} ({rows.length})
        </button>
        {open && rows.map((c) => renderRow(c, variant))}
      </>
    );

  return (
    <>
      {sections.inbox.length === 0 && (
        <div className="group-row">
          <span className="row-main">
            <em>
              {mail.conversations.length === 0
                ? 'No mail yet — send one to a persona with the compose button above.'
                : 'Inbox zero — nothing waiting.'}
            </em>
          </span>
        </div>
      )}
      {sections.inbox.map((c) => renderRow(c, 'inbox'))}
      {section('Snoozed', null, sections.snoozed, snoozedOpen, () => setSnoozedOpen((v) => !v), 'snoozed')}
      {section('Archived', null, sections.archived, archivedOpen, () => setArchivedOpen((v) => !v), 'archived')}
      {section(
        'Sent',
        <Send size={11} className="mail-sent-icon" />,
        sections.sent,
        sentOpen,
        () => setSentOpen((v) => !v),
        'sent'
      )}
      {snoozing && (
        <SnoozeMenu
          x={snoozing.x}
          y={snoozing.y}
          count={snoozing.ids.length}
          onPick={(until) => {
            props.onSnooze(snoozing.ids, until);
            setSnoozing(null);
          }}
          onClose={() => setSnoozing(null)}
        />
      )}
      {menu &&
        (() => {
          const c = mail.conversations.find((x) => x.id === menu.id);
          if (!c) return null;
          const where = placement(subjectOf(c), mail.inbox, now);
          const unread = isUnread(subjectOf(c), mail.inbox);
          return (
            <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => {
                  props.onArchive([c.id], where !== 'archived');
                  setMenu(null);
                }}
              >
                {where === 'archived' ? 'Move to Inbox' : 'Archive'}
              </button>
              {where === 'snoozed' ? (
                <button
                  onClick={() => {
                    props.onSnooze([c.id], null);
                    setMenu(null);
                  }}
                >
                  Un-snooze
                </button>
              ) : (
                <button
                  onClick={(e) => {
                    const at = { x: menu.x, y: menu.y };
                    setMenu(null);
                    e.stopPropagation();
                    setSnoozing({ ids: [c.id], ...at });
                  }}
                >
                  Snooze…
                </button>
              )}
              <button
                onClick={() => {
                  props.onSetRead([c.id], unread);
                  setMenu(null);
                }}
              >
                {unread ? 'Mark as read' : 'Mark as unread'}
              </button>
              <button
                className="danger"
                onClick={() => {
                  props.onDelete(c.id);
                  setMenu(null);
                }}
              >
                <Trash2 size={13} /> Delete conversation
              </button>
            </div>
          );
        })()}
    </>
  );
}
