import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  CheckCheck,
  ChevronRight,
  Clock,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  Search,
  SquarePen,
  X
} from 'lucide-react';
import type { ChatListResult, ChatSearchHit, ChatSummary, Folder, ThreadStatus } from '../../shared/types';
import { formatWake, isUnread, nextWakeAt, placement } from '../../shared/inbox';
import { useOffline } from '../hooks/useServerReachable';
import { useRememberedTab } from '../hooks/useRememberedTab';
import { stripCiteMarkers } from '../../shared/citations';
import { glyphsFor, useShortcut, type ShortcutId } from '../shortcuts';
import { SnoozeMenu } from './SnoozeMenu';
import { SelectionBar } from './SelectionBar';

/** The Inbox's multi-selection, as seen from outside the list. */
export interface InboxSelectionApi {
  ids: string[];
  clear: () => void;
}

export interface ChatListProps {
  data: ChatListResult;
  activeThreadId: string | null;
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
  /** Inbox triage. All take a list so a bulk selection is the same call. */
  onArchive: (threadIds: string[], archived: boolean) => void;
  /** `until` is epoch ms; null wakes the threads now. */
  onSnooze: (threadIds: string[], until: number | null) => void;
  onSetRead: (threadIds: string[], read: boolean) => void;
  onMarkAllRead: () => void;
  /**
   * Publish the current multi-selection (and the way to drop it) so the triage
   * shortcuts, which are registered in App and outlive this component, can act on
   * it. Called with null when the list unmounts — a selection nobody can see must
   * not keep steering a keystroke.
   */
  onSelectionApi?: (api: InboxSelectionApi | null) => void;
  /** Have a model write this thread's subject from its conversation, now. */
  onWriteSubject: (threadId: string) => void;
}

// Drag payloads. We tag the kind so a folder drop zone knows whether it caught a
// chat (→ assign folder) or another folder (→ reparent, cycle-guarded main-side).
const CHAT_MIME = 'application/x-stem-chat';
const FOLDER_MIME = 'application/x-stem-folder';

/**
 * The panel's two tabs, in the shape Memory's Facts | Recall established. Inbox is
 * a flat, date-bucketed view of every thread waiting on you, with what you've dealt
 * with (snoozed, archived) collapsed at the bottom; Chats is the folder tree,
 * untouched. Chat folders and inbox state are deliberately independent namespaces —
 * filing a thread under Chats › Work does not take it out of the Inbox, and
 * archiving does not hide it from the tree or from search.
 */
type Tab = 'inbox' | 'chats';

const TABS: { id: Tab; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'chats', label: 'Chats' }
];

// Which tab you were last on — the same remembered-tab treatment every panel in
// the manage rail gets.
const TAB_KEY = 'stem.chats.tab';
const TAB_IDS = TABS.map((t) => t.id);

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
/** An open snooze popover and the threads it will apply to. */
type Snoozing = { ids: string[]; x: number; y: number };

export function ChatList(props: ChatListProps) {
  const { data, activeThreadId, onOpen } = props;
  const [tab, setTab] = useRememberedTab<Tab>(TAB_KEY, TAB_IDS, 'inbox');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<string | 'root' | 'archive' | null>(null);
  const [snoozing, setSnoozing] = useState<Snoozing | null>(null);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  // A chat row is mid-drag. The Archived group is the drop target for archiving,
  // so it has to exist while you're dragging even when nothing is archived yet —
  // otherwise the very first drag has nowhere to land.
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Anchor for shift-click ranges: the last row touched without shift.
  const anchorRef = useRef<string | null>(null);

  // ---- the clock ----
  // A snoozed thread returns to the Inbox on its own, so the list has to re-render
  // at that instant. We schedule ONE timeout for the earliest wake time rather than
  // polling: an interval here would be the "missing subscription" the UI
  // conventions warn about, but this is a known future transition with an exact
  // time, which a timer expresses precisely.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const at = nextWakeAt(data.chats, data.inbox, now);
    if (at == null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(250, at - Date.now()));
    return () => clearTimeout(timer);
  }, [data, now]);

  // ---- preview lines ----
  // How much of the newest message each Inbox row shows (Settings → Chat → Chats). Read
  // once on mount and again when Settings says it changed — the same in-renderer
  // CustomEvent the Escape-to-retract preference uses, since both live in one
  // window and a round trip through the server would tell us nothing new.
  const [previewLines, setPreviewLines] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => {
      window.stem
        .getSettings()
        .then((s) => {
          if (alive) setPreviewLines(s.chats.previewLines);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener('stem:chat-settings', load);
    return () => {
      alive = false;
      window.removeEventListener('stem:chat-settings', load);
    };
  }, []);

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

  // ---- inbox partition ----
  // `data.chats` already arrives newest-first; the buckets inherit that. Snoozed
  // rows re-sort by wake time, which is the order you'd want to review them in.
  const buckets = useMemo(() => {
    const inbox: ChatSummary[] = [];
    const snoozed: ChatSummary[] = [];
    const archived: ChatSummary[] = [];
    for (const chat of data.chats) {
      const where = placement(chat, data.inbox, now);
      if (where === 'snoozed') snoozed.push(chat);
      else if (where === 'archived') archived.push(chat);
      else inbox.push(chat);
    }
    snoozed.sort(
      (a, b) =>
        (data.inbox.entries[a.threadId]?.snoozedUntil ?? 0) -
        (data.inbox.entries[b.threadId]?.snoozedUntil ?? 0)
    );
    return { inbox, snoozed, archived };
  }, [data, now]);

  const unreadCount = useMemo(
    () => buckets.inbox.filter((c) => isUnread(c, data.inbox, props.statuses[c.threadId] === 'running')).length,
    [buckets.inbox, data.inbox, props.statuses]
  );

  // Unread rolled up per folder (ancestors included), so a bold row can't hide
  // inside a collapsed folder. Same predicate as the tree rows — placement is
  // ignored on purpose, so the count always agrees with what opening reveals.
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

  // ---- selection ----
  // Only the Inbox selects; the tree keeps its single meaning (click = open).
  const selectable = tab === 'inbox' && results === null && !searching;
  // Shift-click extends over what is actually on screen, in the order it is drawn —
  // so a range never silently swallows rows inside a collapsed group.
  const flatOrder = useMemo(
    () => [
      ...buckets.inbox,
      ...(snoozedOpen ? buckets.snoozed : []),
      ...(archivedOpen ? buckets.archived : [])
    ],
    [buckets, snoozedOpen, archivedOpen]
  );
  // The selection bar offers Archive or Move to Inbox, never both — decided by
  // where the selected rows actually are rather than by which list is showing.
  // Only an all-archived selection offers the restore; a mixed one archives,
  // which is both the commoner intent and the reversible direction.
  const archivedIds = useMemo(() => new Set(buckets.archived.map((c) => c.threadId)), [buckets.archived]);
  const selectionArchived = selected.size > 0 && [...selected].every((id) => archivedIds.has(id));

  const clearSelection = useCallback(() => {
    setSelected((prev) => (prev.size ? new Set() : prev));
    anchorRef.current = null;
  }, []);

  // Leaving the flat modes (or starting a search) drops a selection that would
  // otherwise apply to rows nobody can see.
  useEffect(() => {
    if (!selectable) clearSelection();
  }, [selectable, clearSelection]);

  const { onSelectionApi } = props;
  useEffect(() => {
    if (!onSelectionApi) return;
    onSelectionApi({ ids: [...selected], clear: clearSelection });
    return () => onSelectionApi(null);
  }, [selected, clearSelection, onSelectionApi]);

  useEffect(() => {
    if (!selected.size) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearSelection();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected.size, clearSelection]);

  const onChatClick = (chat: ChatSummary) => (e: React.MouseEvent) => {
    if (selectable && (e.metaKey || e.ctrlKey)) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(chat.threadId)) next.delete(chat.threadId);
        else next.add(chat.threadId);
        return next;
      });
      anchorRef.current = chat.threadId;
      return;
    }
    if (selectable && e.shiftKey && anchorRef.current) {
      const ids = flatOrder.map((c) => c.threadId);
      const from = ids.indexOf(anchorRef.current);
      const to = ids.indexOf(chat.threadId);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of ids.slice(lo, hi + 1)) next.add(id);
          return next;
        });
        return;
      }
    }
    // A plain click always means "open this thread" — and drops any selection,
    // so the selection bar can never act on rows you've moved on from.
    clearSelection();
    anchorRef.current = chat.threadId;
    onOpen(chat.threadId);
  };

  /** Act on the selection when the clicked row is part of it, else on that row alone. */
  const targets = (threadId: string): string[] =>
    selected.has(threadId) ? [...selected] : [threadId];

  // Auto-advance after triage (move on to the next waiting thread) lives in App,
  // with the handlers themselves — the same triage runs from keyboard shortcuts
  // that stay live while this list is unmounted.
  const archive = (threadIds: string[], archived: boolean) => {
    props.onArchive(threadIds, archived);
    clearSelection();
  };
  const openSnooze = (ids: string[], e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSnoozing({ ids, x: e.clientX, y: e.clientY });
  };

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
  const allowDrop = (target: string | 'root' | 'archive') => (e: React.DragEvent) => {
    e.preventDefault();
    // Folder rows nest inside the root group, which is itself a drop zone. Without
    // stopping propagation the dragover bubbles up and the group overrides the
    // target to 'root', lighting up the whole list instead of the hovered folder.
    e.stopPropagation();
    setDropTarget(target);
  };
  // Dropping a row on the Archived segment archives it — the same gesture the tree
  // already uses to file a chat, pointed at the one destination that isn't a folder.
  const onDropArchive = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    setDragging(false);
    const chatId = e.dataTransfer.getData(CHAT_MIME);
    if (chatId) archive(targets(chatId), true);
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

  /**
   * One chat row. `variant` decides which triage actions it offers: an inbox row
   * can be snoozed or archived, an archived row moved back, a snoozed row woken.
   * The tree ('none') keeps its original chrome so the Chats mode is unchanged.
   */
  const renderChat = (
    chat: ChatSummary,
    depth: number,
    variant: 'none' | 'inbox' | 'archived' | 'snoozed' = 'none'
  ) => {
    const isEditing = editing?.kind === 'chat' && editing.id === chat.threadId;
    const status = props.statuses[chat.threadId] ?? 'idle';
    const unread = isUnread(chat, data.inbox, status === 'running');
    const wake = data.inbox.entries[chat.threadId]?.snoozedUntil;
    const isSelected = selected.has(chat.threadId);
    const subject = chat.subject ?? chat.title;
    // The tree stays one line per thread; only the Inbox reads like mail.
    const showPreview = variant !== 'none' && previewLines > 0 && !!chat.preview && !isEditing;
    return (
      <div
        key={chat.threadId}
        data-thread-id={chat.threadId}
        className={[
          'group-row chat-row',
          variant !== 'none' ? 'inbox-row' : '',
          showPreview ? `has-preview lines-${previewLines}` : '',
          chat.threadId === activeThreadId ? 'selected' : '',
          unread ? 'unread' : '',
          isSelected ? 'multi' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ paddingLeft: 12 + depth * 14 }}
        draggable={!isEditing}
        onDragStart={(e) => {
          e.dataTransfer.setData(CHAT_MIME, chat.threadId);
          e.dataTransfer.effectAllowed = 'move';
          setDragging(true);
        }}
        onDragEnd={() => setDragging(false)}
        onClick={onChatClick(chat)}
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
            <>
              {/* The subject when a model wrote one, else the name the thread has.
                  At the `everywhere` setting these are the same string; at `inbox`
                  they differ on purpose, and this is the list that shows the subject. */}
              <strong title={subject}>{subject}</strong>
              {showPreview && <span className="chat-preview">{chat.preview}</span>}
            </>
          )}
        </span>
        {variant === 'snoozed' && wake != null && (
          <span className="chat-wake">{formatWake(wake, now)}</span>
        )}
        {!isEditing && props.scheduledThreadIds?.has(chat.threadId) && (
          <span className="chat-sched-badge" title="Has a scheduled task" aria-label="Has a scheduled task">
            <Clock size={11} />
          </span>
        )}
        {!isEditing && variant !== 'none' && (
          <span className="chat-actions">
            {variant === 'inbox' && (
              <button
                className="chat-action"
                title={`Snooze (${glyphsFor('snooze-thread')})`}
                aria-label="Snooze"
                onClick={(e) => openSnooze(targets(chat.threadId), e)}
              >
                <AlarmClock size={13} />
              </button>
            )}
            {variant === 'snoozed' && (
              <button
                className="chat-action"
                title={`Un-snooze (${glyphsFor('snooze-thread')})`}
                aria-label="Un-snooze"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onSnooze([chat.threadId], null);
                }}
              >
                <AlarmClockOff size={13} />
              </button>
            )}
            {variant !== 'snoozed' && (
              <button
                className="chat-action"
                title={`${variant === 'archived' ? 'Move to Inbox' : 'Archive'} (${glyphsFor('archive-thread')})`}
                aria-label={variant === 'archived' ? 'Move to Inbox' : 'Archive'}
                onClick={(e) => {
                  e.stopPropagation();
                  archive(targets(chat.threadId), variant !== 'archived');
                }}
              >
                {variant === 'archived' ? <ArchiveRestore size={13} /> : <Archive size={13} />}
              </button>
            )}
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

  /** Date-bucketed rows for the flat (Inbox / Archived) modes. */
  const renderBuckets = (chats: ChatSummary[], variant: 'inbox' | 'archived'): React.ReactNode[] => {
    let lastKey: string | null = null;
    const rows: React.ReactNode[] = [];
    for (const c of chats) {
      const b = dateBucket(c.updatedAt, now);
      if (b.key !== lastKey) {
        rows.push(
          <div key={`h-${b.key}`} className="chat-date-head">
            {b.label}
          </div>
        );
        lastKey = b.key;
      }
      rows.push(renderChat(c, 0, variant));
    }
    return rows;
  };

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

  return (
    <div className="chats-panel">
      {/* Grouped and labelled: the rail's Chats tab and this control's Chats
          segment share a name, so the group is what tells them apart. */}
      <div className="seg-ctl chats-modes" role="group" aria-label="Chat list mode">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'inbox' && unreadCount > 0 && <span className="seg-count">{unreadCount}</span>}
          </button>
        ))}
      </div>
      <div className="grp-head chats-head">
        <span>{TABS.find((t) => t.id === tab)?.label}</span>
        <span className="grp-head-actions">
          {tab === 'inbox' && unreadCount > 0 && (
            <button className="grp-head-add" title="Mark all as read" onClick={props.onMarkAllRead}>
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
          {/* ⌘N opens a root-level draft, which is exactly this button. The
              per-folder twin below deliberately stays keycap-free — the shortcut
              can't target a folder. */}
          <button
            className="grp-head-add"
            title={`New thread (${glyphsFor('new-conversation')})`}
            onClick={() => props.onNewChat(null)}
          >
            <SquarePen size={14} />
          </button>
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
      {selected.size > 0 && (
        <SelectionBar
          count={selected.size}
          archived={selectionArchived}
          onSnooze={(e) => openSnooze([...selected], e)}
          onArchive={() => archive([...selected], !selectionArchived)}
          onMarkRead={() => {
            props.onSetRead([...selected], true);
            clearSelection();
          }}
          onClear={clearSelection}
        />
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
          <>
            {buckets.inbox.length === 0 && (
              <div className="group-row">
                <span className="row-main">
                  <em>{isEmpty ? 'No chats yet — start a conversation.' : 'Inbox zero — nothing waiting.'}</em>
                </span>
              </div>
            )}
            {renderBuckets(buckets.inbox, 'inbox')}
            {/* What you've already dealt with, collapsed at the foot of the list:
                things that come back on their own, then things that don't. */}
            {buckets.snoozed.length > 0 && (
              <>
                <button
                  className="memory-view-toggle inbox-snoozed-toggle"
                  onClick={() => setSnoozedOpen((v) => !v)}
                >
                  <ChevronRight size={13} className={snoozedOpen ? 'open' : ''} />
                  Snoozed ({buckets.snoozed.length})
                </button>
                {snoozedOpen && buckets.snoozed.map((c) => renderChat(c, 0, 'snoozed'))}
              </>
            )}
            {(buckets.archived.length > 0 || dragging) && (
              <>
                {/* Also the drop target: dragging a row onto it archives it, the
                    same gesture the tree uses to file a chat into a folder. */}
                <button
                  className={`memory-view-toggle inbox-snoozed-toggle${
                    dropTarget === 'archive' ? ' drop-target' : ''
                  }`}
                  onClick={() => setArchivedOpen((v) => !v)}
                  onDragOver={allowDrop('archive')}
                  onDragLeave={() => setDropTarget((t) => (t === 'archive' ? null : t))}
                  onDrop={onDropArchive}
                >
                  <ChevronRight size={13} className={archivedOpen ? 'open' : ''} />
                  Archived ({buckets.archived.length})
                </button>
                {archivedOpen && buckets.archived.map((c) => renderChat(c, 0, 'archived'))}
              </>
            )}
          </>
        )}
      </div>
      {snoozing && (
        <SnoozeMenu
          x={snoozing.x}
          y={snoozing.y}
          count={snoozing.ids.length}
          onPick={(until) => {
            props.onSnooze(snoozing.ids, until);
            setSnoozing(null);
            clearSelection();
          }}
          onClose={() => setSnoozing(null)}
        />
      )}
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
              const ids = targets(menu.id);
              const chat = data.chats.find((c) => c.threadId === menu.id);
              const where = chat ? placement(chat, data.inbox, now) : 'inbox';
              // Same running-suppressed unread the row paints, so the menu's
              // read/unread verb matches what the user is looking at.
              const unread = chat
                ? isUnread(chat, data.inbox, props.statuses[chat.threadId] === 'running')
                : false;
              return (
                <>
                  <button
                    onClick={() => {
                      archive(ids, where !== 'archived');
                      closeMenu();
                    }}
                  >
                    {where === 'archived' ? 'Move to Inbox' : 'Archive'}
                    <Accel id="archive-thread" />
                  </button>
                  {where === 'snoozed' ? (
                    <button
                      onClick={() => {
                        props.onSnooze(ids, null);
                        closeMenu();
                      }}
                    >
                      Un-snooze
                      <Accel id="snooze-thread" />
                    </button>
                  ) : (
                    <button
                      onClick={(e) => {
                        // Reopen as the snooze popover at the same spot.
                        const at = { x: menu.x, y: menu.y };
                        closeMenu();
                        e.stopPropagation();
                        setSnoozing({ ids, ...at });
                      }}
                    >
                      Snooze…
                      <Accel id="snooze-thread" />
                    </button>
                  )}
                  <button
                    onClick={() => {
                      props.onSetRead(ids, unread);
                      clearSelection();
                      closeMenu();
                    }}
                  >
                    {unread ? 'Mark as read' : 'Mark as unread'}
                    <Accel id="toggle-read" />
                  </button>
                  <div className="ctx-sep" />
                  {/* Single-row only: this is a model call per thread, so it is
                      not something to fire off across a selection by accident. */}
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
