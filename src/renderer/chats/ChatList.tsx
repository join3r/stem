import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCheck,
  ChevronRight,
  Clock,
  CornerUpLeft,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Lock,
  MessageSquare,
  Search,
  SquarePen,
  X
} from 'lucide-react';
import type {
  ChatListResult,
  ChatSearchHit,
  ChatSummary,
  Folder,
  MailListResult,
  Persona,
  ThreadStatus
} from '../../shared/types';
import { isUnread } from '../../shared/inbox';
import { useOffline } from '../hooks/useServerReachable';
import { stripCiteMarkers } from '../../shared/citations';
import { glyphsFor, useShortcut, type ShortcutId } from '../shortcuts';
import { MailList } from '../mail/MailList';
import type { ReturnChatRow } from './return-chat';

export interface ChatListProps {
  data: ChatListResult;
  activeThreadId: string | null;
  /**
   * Which sub-tab (Inbox mail vs Chats tree) is showing. Owned by App, not
   * remembered here: the open-a-chat handlers up there need to know whether the
   * Inbox was selected at that moment (it pins the Return-to-chat row below).
   */
  chatsTab: ChatsTab;
  onChatsTabChange: (tab: ChatsTab) => void;
  /** The pinned Return-to-chat utility row above the Inbox mail list (null = hidden). */
  inboxReturn: ReturnChatRow | null;
  onDismissInboxReturn: () => void;
  /** Per-thread run state → drives the status dot on each row. */
  statuses: Record<string, ThreadStatus>;
  /** Thread ids that own at least one scheduled task → show a clock badge. */
  scheduledThreadIds?: ReadonlySet<string>;
  onOpen: (threadId: string) => void;
  /** Open a fresh draft targeted at this folder (null = root). */
  onNewChat: (folderId: string | null) => void;
  onCreateFolder: (name: string, parentId: string | null) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onMoveFolder: (folderId: string, parentId: string | null) => void;
  onRenameChat: (threadId: string, name: string) => void;
  onDeleteChat: (threadId: string) => void;
  onMoveChat: (threadId: string, folderId: string | null) => void;
  /** Chat read/unread (the tree's bolding). Archive/snooze are mail concepts now. */
  onSetRead: (threadIds: string[], read: boolean) => void;
  /** Have a model write this thread's subject from its conversation, now. */
  onWriteSubject: (threadId: string) => void;

  // ---- the mail Inbox (the 'inbox' tab is mail, not chats) ----
  mail: MailListResult;
  personas: Persona[];
  activeMailId: string | null;
  onOpenMail: (conversationId: string) => void;
  onComposeMail: () => void;
  onMailArchive: (ids: string[], archived: boolean) => void;
  onMailSnooze: (ids: string[], until: number | null) => void;
  onMailSetRead: (ids: string[], read: boolean) => void;
  onMailMarkAllRead: () => void;
  onMailDelete: (conversationId: string) => void;
  /** Unread mail conversations — the count on the Inbox segment. */
  mailUnreadCount: number;
}

// Drag payloads. We tag the kind so a folder drop zone knows whether it caught a
// chat (→ assign folder) or another folder (→ reparent, cycle-guarded main-side).
const CHAT_MIME = 'application/x-stem-chat';
const FOLDER_MIME = 'application/x-stem-folder';

/**
 * The panel's two tabs, in the shape Memory's Facts | Recall established. Inbox
 * is MAIL — conversations between you and personas, email-style, rendered by
 * MailList — and Chats is the folder tree of ordinary threads. The two are
 * different kinds of thing now, not two views of one list: a chat never appears
 * in the Inbox, and a mail conversation never appears in the tree (its persona
 * work lives on hidden threads the server filters out of chats:list).
 */
export type ChatsTab = 'inbox' | 'chats';

const TABS: { id: ChatsTab; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'chats', label: 'Chats' }
];

// Which tab you were last on — the same remembered-tab treatment every panel in
// the manage rail gets. App owns the remembering (see ChatListProps.chatsTab).
export const CHATS_TAB_KEY = 'stem.chats.tab';
export const CHATS_TAB_IDS = TABS.map((t) => t.id);

// Normalize Unix-seconds (real chats) vs ms (optimistic pending rows), then bucket
// by updatedAt the way ChatGPT/Claude group their sidebars.
function dateBucket(ts: number, now: number): { key: string; label: string } {
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const day = 86400000;
  const startMs = startOfToday.getTime();
  if (ms >= startMs) return { key: 'today', label: 'Today' };
  if (ms >= startMs - day) return { key: 'yesterday', label: 'Yesterday' };
  if (ms >= startMs - 7 * day) return { key: 'last7', label: 'Previous 7 Days' };
  if (ms >= startMs - 30 * day) return { key: 'last30', label: 'Previous 30 Days' };
  const nowYear = new Date(now).getFullYear();
  if (d.getFullYear() === nowYear)
    return { key: `m-${d.getMonth()}`, label: d.toLocaleString(undefined, { month: 'long' }) };
  return { key: `y-${d.getFullYear()}`, label: String(d.getFullYear()) };
}

// Turn an FTS5 snippet (matched terms wrapped in «…») into highlighted nodes. Split
// on the sentinels rather than injecting HTML so snippet text can never be markup.
// Cite markers are stripped at render because rows indexed before the strip fix
// keep their original text until the session is re-ingested.
function highlightSnippet(snippet: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let key = 0;
  stripCiteMarkers(snippet).split('«').forEach((chunk, idx) => {
    if (idx === 0) {
      if (chunk) nodes.push(chunk);
      return;
    }
    const close = chunk.indexOf('»');
    if (close === -1) {
      nodes.push(chunk);
      return;
    }
    nodes.push(<mark key={key++}>{chunk.slice(0, close)}</mark>);
    const rest = chunk.slice(close + 1);
    if (rest) nodes.push(rest);
  });
  return nodes;
}

/**
 * The accelerator column of a context-menu row, drawn the way a native menu draws
 * it: label left, keycap right in a dimmed column. Only rows whose action really
 * has a binding get one — Rename and the Move-to list would otherwise carry an
 * empty column that reads as a value that failed to load.
 */
function Accel({ id }: { id: ShortcutId }) {
  const glyphs = glyphsFor(id);
  return glyphs ? <span className="ctx-accel">{glyphs}</span> : null;
}

const STATUS_LABEL: Record<ThreadStatus, string> = {
  idle: '',
  running: 'Generating…',
  done: 'New reply',
  error: 'Failed'
};

type Editing = { kind: 'chat' | 'folder'; id: string; value: string };
type Creating = { parentId: string | null; value: string };
type Menu =
  | { kind: 'chat'; id: string; x: number; y: number }
  | { kind: 'folder'; id: string; x: number; y: number };

export function ChatList(props: ChatListProps) {
  const { data, activeThreadId, onOpen, chatsTab: tab, onChatsTabChange: setTab, inboxReturn } = props;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Dismissing the Return-to-chat row removes the control that holds focus, so
  // focus is handed to the Inbox segment button — always present, and the thing
  // that names the section the row belonged to.
  const inboxSegRef = useRef<HTMLButtonElement>(null);
  const [dropTarget, setDropTarget] = useState<string | 'root' | null>(null);

  // ---- search ----
  // The search box is collapsed to a header icon by default so it costs no vertical
  // space until wanted; the icon (or ⌘F) surfaces it.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  // null = not searching (show the tree); array = results for the last run query.
  const [results, setResults] = useState<ChatSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Search runs against an index on the server, so offline it has nothing to
  // match — and "No matching chats." would be an answer to a question that was
  // never asked. The chats themselves are still listed from the cache; it is the
  // searching that is gone, and saying which is which is the whole point.
  const offline = useOffline();
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Guards against a slow expansion+search resolving after a newer one (or a clear).
  const searchSeq = useRef(0);

  const clearSearch = useCallback(() => {
    searchSeq.current += 1; // invalidate any in-flight run
    setQuery('');
    setResults(null);
    setSearching(false);
  }, []);

  // Collapse the box back to the icon and drop any query/results (returns to the tree).
  const closeSearch = useCallback(() => {
    clearSearch();
    setSearchOpen(false);
  }, [clearSearch]);

  // Focus (and select) the input whenever the box is surfaced.
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [searchOpen]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      clearSearch();
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    // Two-phase for snappy feel: instant same-language results, then the cross-language
    // superset once query expansion resolves. The expanded set ⊇ the fast set, so the
    // swap only ever adds; `expanded` guards the fast result from clobbering it if it
    // happens to arrive later.
    let expanded = false;
    window.stem
      .searchChatsFast(q)
      .then((hits) => {
        if (searchSeq.current === seq && !expanded) setResults(hits);
      })
      .catch(() => {});
    try {
      const hits = await window.stem.searchChats(q);
      if (searchSeq.current === seq) {
        expanded = true;
        setResults(hits);
      }
    } catch {
      if (searchSeq.current === seq) {
        expanded = true;
        setResults((prev) => prev ?? []);
      }
    } finally {
      if (searchSeq.current === seq) setSearching(false);
    }
  }, [query, clearSearch]);

  // ⌘F surfaces the search box (the effect focuses it); if already open, refocus.
  useShortcut('focus-chat-search', () => {
    if (!searchOpen) setSearchOpen(true);
    else {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  });

  const closeMenu = useCallback(() => setMenu(null), []);

  // Keep the context menu inside the window — without this it can open past the
  // bottom/right edge (e.g. right-clicking a chat low in the list) and clip.
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) {
      setMenuPos(null);
      return;
    }
    const rect = menuRef.current.getBoundingClientRect();
    const pad = 8;
    const x = Math.max(pad, Math.min(menu.x, window.innerWidth - rect.width - pad));
    const y = Math.max(pad, Math.min(menu.y, window.innerHeight - rect.height - pad));
    setMenuPos({ x, y });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = () => closeMenu();
    document.addEventListener('click', close);
    document.addEventListener('contextmenu', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('contextmenu', close);
    };
  }, [menu, closeMenu]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const childFolders = (parentId: string | null): Folder[] =>
    data.folders.filter((f) => f.parentId === parentId).sort((a, b) => a.order - b.order);
  const folderChats = (folderId: string | null): ChatSummary[] =>
    data.chats.filter((c) => c.folderId === folderId);

  // Unread rolled up per folder (ancestors included), so a bold row can't hide
  // inside a collapsed folder. Same predicate as the tree rows.
  const folderUnread = useMemo(() => {
    const parents = new Map(data.folders.map((f) => [f.id, f.parentId]));
    const counts = new Map<string, number>();
    for (const chat of data.chats) {
      if (!chat.folderId) continue;
      if (!isUnread(chat, data.inbox, props.statuses[chat.threadId] === 'running')) continue;
      for (let id: string | null = chat.folderId; id != null; id = parents.get(id) ?? null) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  }, [data.chats, data.folders, data.inbox, props.statuses]);

  // ---- drag + drop ----
  const onDrop = (target: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const chatId = e.dataTransfer.getData(CHAT_MIME);
    if (chatId) {
      props.onMoveChat(chatId, target);
      return;
    }
    const folderId = e.dataTransfer.getData(FOLDER_MIME);
    if (folderId && folderId !== target) props.onMoveFolder(folderId, target);
  };
  const allowDrop = (target: string | 'root') => (e: React.DragEvent) => {
    e.preventDefault();
    // Folder rows nest inside the root group, which is itself a drop zone. Without
    // stopping propagation the dragover bubbles up and the group overrides the
    // target to 'root', lighting up the whole list instead of the hovered folder.
    e.stopPropagation();
    setDropTarget(target);
  };

  // ---- inline edit commit ----
  const commitEdit = () => {
    if (!editing) return;
    const value = editing.value.trim();
    if (value) {
      if (editing.kind === 'folder') props.onRenameFolder(editing.id, value);
      else props.onRenameChat(editing.id, value);
    }
    setEditing(null);
  };
  const commitCreate = () => {
    if (!creating) return;
    const value = creating.value.trim();
    if (value) props.onCreateFolder(value, creating.parentId);
    setCreating(null);
  };

  const editInput = (value: string, onChange: (v: string) => void, onCommit: () => void) => (
    <input
      className="chat-edit"
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit();
        if (e.key === 'Escape') {
          setEditing(null);
          setCreating(null);
        }
      }}
      onBlur={onCommit}
    />
  );

  // ---- recursive render ----
  const renderFolder = (folder: Folder, depth: number) => {
    const open = expanded.has(folder.id);
    const isEditing = editing?.kind === 'folder' && editing.id === folder.id;
    // Only while closed: once open, the unread rows (or a nested closed
    // folder's own count) carry the signal themselves.
    const unreadInside = open ? 0 : folderUnread.get(folder.id) ?? 0;
    return (
      <div key={folder.id}>
        <div
          className={`group-row folder-row${dropTarget === folder.id ? ' drop-target' : ''}`}
          style={{ paddingLeft: 12 + depth * 14 }}
          draggable={!isEditing}
          onDragStart={(e) => {
            e.dataTransfer.setData(FOLDER_MIME, folder.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={allowDrop(folder.id)}
          onDragLeave={() => setDropTarget((t) => (t === folder.id ? null : t))}
          onDrop={onDrop(folder.id)}
          onClick={() => toggle(folder.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ kind: 'folder', id: folder.id, x: e.clientX, y: e.clientY });
          }}
        >
          <ChevronRight size={13} className={`chat-caret${open ? ' open' : ''}`} />
          <span className="row-icon folder">{open ? <FolderOpen size={14} /> : <FolderIcon size={14} />}</span>
          <span className="row-main">
            {isEditing ? (
              editInput(editing.value, (v) => setEditing({ ...editing, value: v }), commitEdit)
            ) : (
              <strong title={folder.name}>{folder.name}</strong>
            )}
          </span>
          {unreadInside > 0 && (
            <span className="folder-unread" title={`${unreadInside} unread`}>
              {unreadInside}
            </span>
          )}
          <button
            className="row-action"
            title="New chat in folder"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((prev) => new Set(prev).add(folder.id));
              props.onNewChat(folder.id);
            }}
          >
            <SquarePen size={13} />
          </button>
        </div>
        {open && (
          <>
            {childFolders(folder.id).map((f) => renderFolder(f, depth + 1))}
            {folderChats(folder.id).map((c) => renderChat(c, depth + 1))}
            {creating && creating.parentId === folder.id && renderCreateRow(depth + 1)}
          </>
        )}
      </div>
    );
  };

  /** One chat row in the tree. Read/unread is the only triage a chat has left. */
  const renderChat = (chat: ChatSummary, depth: number) => {
    const isEditing = editing?.kind === 'chat' && editing.id === chat.threadId;
    const status = props.statuses[chat.threadId] ?? 'idle';
    const unread = isUnread(chat, data.inbox, status === 'running');
    const subject = chat.subject ?? chat.title;
    return (
      <div
        key={chat.threadId}
        data-thread-id={chat.threadId}
        className={[
          'group-row chat-row',
          chat.threadId === activeThreadId ? 'selected' : '',
          unread ? 'unread' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ paddingLeft: 12 + depth * 14 }}
        draggable={!isEditing}
        onDragStart={(e) => {
          e.dataTransfer.setData(CHAT_MIME, chat.threadId);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onClick={() => onOpen(chat.threadId)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ kind: 'chat', id: chat.threadId, x: e.clientX, y: e.clientY });
        }}
      >
        <span className="row-icon chat">
          {status === 'idle' ? (
            <MessageSquare size={13} />
          ) : (
            <span className={`chat-status ${status}`} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} />
          )}
        </span>
        <span className="row-main">
          {isEditing ? (
            editInput(editing.value, (v) => setEditing({ ...editing, value: v }), commitEdit)
          ) : (
            <strong title={subject}>{subject}</strong>
          )}
        </span>
        {!isEditing && props.scheduledThreadIds?.has(chat.threadId) && (
          <span className="chat-sched-badge" title="Has a scheduled task" aria-label="Has a scheduled task">
            <Clock size={11} />
          </span>
        )}
        {!isEditing && chat.private && (
          <span
            className="chat-sched-badge"
            title="Private chat — nothing here is saved to memory or read from it"
            aria-label="Private chat"
          >
            <Lock size={11} />
          </span>
        )}
      </div>
    );
  };

  const renderCreateRow = (depth: number) =>
    creating && (
      <div className="group-row" style={{ paddingLeft: 12 + depth * 14 }}>
        <span className="row-icon folder">
          <FolderIcon size={14} />
        </span>
        <span className="row-main">
          {editInput(creating.value, (v) => setCreating({ ...creating, value: v }), commitCreate)}
        </span>
      </div>
    );

  // Flat, ranked search results replace the tree while a search is active. Rows reuse
  // the chat-row look but carry a why-it-matched snippet and skip drag/drop (there is
  // no tree on screen to drop onto). The context menu does come along: a row you just
  // found by searching is exactly the one you want to archive, rename or file, and
  // making you close the search and hunt it down in the tree first is busywork.
  const renderResults = (): React.ReactNode => {
    // Show whatever we have (the instant fast results) even while the cross-language
    // pass is still refining; only fall back to a status line when there's nothing yet.
    if (!results || results.length === 0) {
      const status = offline
        ? 'Search needs Stem’s server, which can’t be reached right now.'
        : searching
          ? 'Searching…'
          : 'No matching chats.';
      return <div className="group-row search-status">{status}</div>;
    }
    return results.map((hit) => {
      // The hit carries the title search indexed; the list carries the live one. Prefer
      // the live one so a rename made from this very menu shows up without re-searching.
      const title = data.chats.find((c) => c.threadId === hit.threadId)?.title ?? hit.title;
      const isEditing = editing?.kind === 'chat' && editing.id === hit.threadId;
      return (
        <div
          key={hit.threadId}
          data-thread-id={hit.threadId}
          className={`group-row chat-row search-result${hit.threadId === activeThreadId ? ' selected' : ''}`}
          onClick={() => onOpen(hit.threadId)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ kind: 'chat', id: hit.threadId, x: e.clientX, y: e.clientY });
          }}
        >
          <span className="row-icon chat">
            <MessageSquare size={13} />
          </span>
          <span className="row-main">
            {isEditing ? (
              editInput(editing.value, (v) => setEditing({ ...editing, value: v }), commitEdit)
            ) : (
              <>
                <strong title={title}>{title}</strong>
                {hit.snippet && <span className="chat-snippet">{highlightSnippet(hit.snippet)}</span>}
              </>
            )}
          </span>
        </div>
      );
    });
  };

  const isEmpty = data.chats.length === 0 && data.folders.length === 0;
  const showingSearch = searching || results !== null;
  // Render-time clock for the tree's date buckets; the mail list keeps its own
  // wake-timer clock (a snoozed conversation returns on its own schedule).
  const now = Date.now();

  return (
    <div className="chats-panel">
      {/* One row: the Inbox | Chats switch plus the list's actions. Grouped and
          labelled because the rail's Chats tab and this control's Chats segment
          share a name. No heading under it — the active segment already names
          the list, so a second "INBOX" only cost a row. */}
      <div className="chats-modes-row">
        <div className="seg-ctl chats-modes" role="group" aria-label="Chat list mode">
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={t.id === 'inbox' ? inboxSegRef : undefined}
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === 'inbox' && props.mailUnreadCount > 0 && (
                <span className="seg-count">{props.mailUnreadCount}</span>
              )}
            </button>
          ))}
        </div>
        <span className="grp-head-actions chats-actions">
          {tab === 'inbox' && props.mailUnreadCount > 0 && (
            <button className="grp-head-add" title="Mark all as read" onClick={props.onMailMarkAllRead}>
              <CheckCheck size={14} />
            </button>
          )}
          <button
            className={`grp-head-add${searchOpen ? ' active' : ''}`}
            // From the registry, so Windows/Linux read "Ctrl+F" rather than a ⌘ they have no key for.
            title={`Search chats (${glyphsFor('focus-chat-search')})`}
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          >
            <Search size={14} />
          </button>
          {/* On the Inbox tab the pen composes a mail; on Chats it opens a
              root-level draft (⌘N), as it always has. */}
          {tab === 'inbox' ? (
            <button className="grp-head-add" title="New mail" onClick={props.onComposeMail}>
              <SquarePen size={14} />
            </button>
          ) : (
            <button
              className="grp-head-add"
              title={`New thread (${glyphsFor('new-conversation')})`}
              onClick={() => props.onNewChat(null)}
            >
              <SquarePen size={14} />
            </button>
          )}
          {tab === 'chats' && (
            <button
              className="grp-head-add"
              title="New folder"
              onClick={() => setCreating({ parentId: null, value: '' })}
            >
              <FolderPlus size={14} />
            </button>
          )}
        </span>
      </div>
      {searchOpen && (
        <div className="chat-search">
          <Search size={13} className="chat-search-icon" />
          <input
            ref={searchInputRef}
            className="chat-search-input"
            type="text"
            placeholder="Search chats…"
            value={query}
            onChange={(e) => {
              const v = e.target.value;
              setQuery(v);
              if (!v.trim()) clearSearch(); // emptying the box returns to the tree
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void runSearch();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch(); // Esc collapses the box back to the icon
              }
            }}
          />
          {query && (
            <button className="chat-search-clear" title="Clear search" onClick={clearSearch}>
              <X size={13} />
            </button>
          )}
        </div>
      )}
      {/* The pinned Return-to-chat utility row — Inbox chrome above the mail list,
          never a mail item (no unread/preview/triage anatomy). While its chat is
          the centre pane it degrades to a same-height non-actionable "Currently
          viewing" label; the dismiss stays either way. */}
      {tab === 'inbox' && !showingSearch && inboxReturn && (
        <div className={`inbox-return${inboxReturn.current ? ' current' : ''}`}>
          {inboxReturn.current ? (
            <span className="inbox-return-main" aria-current="page">
              <MessageSquare size={13} className="inbox-return-icon" />
              <span className="inbox-return-label">Currently viewing</span>
              <strong title={inboxReturn.title}>{inboxReturn.title}</strong>
            </span>
          ) : (
            <button className="inbox-return-main" onClick={() => onOpen(inboxReturn.threadId)}>
              <CornerUpLeft size={13} className="inbox-return-icon" />
              <span className="inbox-return-label">Return to chat</span>
              <strong title={inboxReturn.title}>{inboxReturn.title}</strong>
            </button>
          )}
          <button
            className="inbox-return-dismiss"
            title="Dismiss"
            aria-label="Dismiss return to chat"
            onClick={() => {
              props.onDismissInboxReturn();
              inboxSegRef.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div
        className={`group chats-group${dropTarget === 'root' ? ' drop-target' : ''}`}
        onDragOver={tab === 'chats' ? allowDrop('root') : undefined}
        onDragLeave={() => setDropTarget((t) => (t === 'root' ? null : t))}
        onDrop={tab === 'chats' ? onDrop(null) : undefined}
      >
        {showingSearch ? (
          renderResults()
        ) : tab === 'chats' ? (
          <>
            {isEmpty && !creating && (
              <div className="group-row">
                <span className="row-main">
                  <em>No chats yet — start a conversation.</em>
                </span>
              </div>
            )}
            {childFolders(null).map((f) => renderFolder(f, 0))}
            {(() => {
              let lastKey: string | null = null;
              const rows: React.ReactNode[] = [];
              for (const c of folderChats(null)) {
                const b = dateBucket(c.updatedAt, now);
                if (b.key !== lastKey) {
                  rows.push(
                    <div key={`h-${b.key}`} className="chat-date-head">
                      {b.label}
                    </div>
                  );
                  lastKey = b.key;
                }
                rows.push(renderChat(c, 0));
              }
              return rows;
            })()}
            {creating && creating.parentId === null && renderCreateRow(0)}
          </>
        ) : (
          <MailList
            mail={props.mail}
            personas={props.personas}
            activeConversationId={props.activeMailId}
            onOpen={props.onOpenMail}
            onArchive={props.onMailArchive}
            onSnooze={props.onMailSnooze}
            onSetRead={props.onMailSetRead}
            onDelete={props.onMailDelete}
          />
        )}
      </div>
      {menu && (
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{ left: menuPos?.x ?? menu.x, top: menuPos?.y ?? menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.kind === 'folder' && (
            <button
              onClick={() => {
                setCreating({ parentId: menu.id, value: '' });
                setExpanded((prev) => new Set(prev).add(menu.id));
                closeMenu();
              }}
            >
              <FolderPlus size={13} /> New subfolder
            </button>
          )}
          {menu.kind === 'chat' &&
            (() => {
              const chat = data.chats.find((c) => c.threadId === menu.id);
              // Same running-suppressed unread the row paints, so the menu's
              // read/unread verb matches what the user is looking at.
              const unread = chat
                ? isUnread(chat, data.inbox, props.statuses[chat.threadId] === 'running')
                : false;
              return (
                <>
                  <button
                    onClick={() => {
                      props.onSetRead([menu.id], unread);
                      closeMenu();
                    }}
                  >
                    {unread ? 'Mark as read' : 'Mark as unread'}
                    <Accel id="toggle-read" />
                  </button>
                  <div className="ctx-sep" />
                  <button
                    onClick={() => {
                      props.onWriteSubject(menu.id);
                      closeMenu();
                    }}
                  >
                    Write a subject
                  </button>
                </>
              );
            })()}
          <button
            onClick={() => {
              const name =
                menu.kind === 'folder'
                  ? data.folders.find((f) => f.id === menu.id)?.name ?? ''
                  : data.chats.find((c) => c.threadId === menu.id)?.title ?? '';
              setEditing({ kind: menu.kind, id: menu.id, value: name });
              closeMenu();
            }}
          >
            Rename
          </button>
          <button
            className="danger"
            onClick={() => {
              if (menu.kind === 'folder') props.onDeleteFolder(menu.id);
              else {
                props.onDeleteChat(menu.id);
                // Search results are a snapshot, not a view of `data.chats` — drop the
                // row here too, or a deleted thread keeps a row that opens nothing.
                setResults((prev) => prev?.filter((h) => h.threadId !== menu.id) ?? prev);
              }
              closeMenu();
            }}
          >
            Delete
            {/* Chats only. The folder half of this row has no binding, and the
                thread shortcut takes the chat you are reading rather than the one
                you right-clicked — the keycap names the action, the way a native
                menu's accelerator does, not the row it happens to sit on. */}
            {menu.kind === 'chat' && <Accel id="delete-thread" />}
          </button>
          {menu.kind === 'chat' && (
            <>
              <div className="ctx-sep" />
              <div className="ctx-label">Move to…</div>
              <div className="ctx-scroll">
                <button onClick={() => (props.onMoveChat(menu.id, null), closeMenu())}>Root</button>
                {data.folders.map((f) => (
                  <button key={f.id} onClick={() => (props.onMoveChat(menu.id, f.id), closeMenu())}>
                    {f.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
