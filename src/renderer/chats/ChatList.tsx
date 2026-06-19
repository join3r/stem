import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  MessageSquare
} from 'lucide-react';
import type { ChatListResult, ChatSummary, Folder } from '../../shared/types';

export interface ChatListProps {
  data: ChatListResult;
  activeThreadId: string | null;
  onOpen: (threadId: string) => void;
  onCreateFolder: (name: string, parentId: string | null) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onMoveFolder: (folderId: string, parentId: string | null) => void;
  onRenameChat: (threadId: string, name: string) => void;
  onDeleteChat: (threadId: string) => void;
  onMoveChat: (threadId: string, folderId: string | null) => void;
}

// Drag payloads. We tag the kind so a folder drop zone knows whether it caught a
// chat (→ assign folder) or another folder (→ reparent, cycle-guarded main-side).
const CHAT_MIME = 'application/x-stem-chat';
const FOLDER_MIME = 'application/x-stem-folder';

type Editing = { kind: 'chat' | 'folder'; id: string; value: string };
type Creating = { parentId: string | null; value: string };
type Menu =
  | { kind: 'chat'; id: string; x: number; y: number }
  | { kind: 'folder'; id: string; x: number; y: number };

export function ChatList(props: ChatListProps) {
  const { data, activeThreadId, onOpen } = props;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<string | 'root' | null>(null);

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
    return (
      <div key={folder.id}>
        <div
          className={`group-row folder-row${selectedFolder === folder.id ? ' selected' : ''}${
            dropTarget === folder.id ? ' drop-target' : ''
          }`}
          style={{ paddingLeft: 12 + depth * 14 }}
          draggable={!isEditing}
          onDragStart={(e) => {
            e.dataTransfer.setData(FOLDER_MIME, folder.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={allowDrop(folder.id)}
          onDragLeave={() => setDropTarget((t) => (t === folder.id ? null : t))}
          onDrop={onDrop(folder.id)}
          onClick={() => {
            setSelectedFolder(folder.id);
            toggle(folder.id);
          }}
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
              <strong>{folder.name}</strong>
            )}
          </span>
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

  const renderChat = (chat: ChatSummary, depth: number) => {
    const isEditing = editing?.kind === 'chat' && editing.id === chat.threadId;
    return (
      <div
        key={chat.threadId}
        className={`group-row chat-row${chat.threadId === activeThreadId ? ' selected' : ''}`}
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
          <MessageSquare size={13} />
        </span>
        <span className="row-main">
          {isEditing ? (
            editInput(editing.value, (v) => setEditing({ ...editing, value: v }), commitEdit)
          ) : (
            <strong>{chat.title}</strong>
          )}
        </span>
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

  const isEmpty = data.chats.length === 0 && data.folders.length === 0;

  return (
    <div className="chats-panel">
      <div className="grp-head chats-head">
        <span>Chats</span>
        <button
          className="grp-head-add"
          title="New folder"
          onClick={() => setCreating({ parentId: null, value: '' })}
        >
          <FolderPlus size={14} />
        </button>
      </div>
      <div
        className={`group chats-group${dropTarget === 'root' ? ' drop-target' : ''}`}
        onDragOver={allowDrop('root')}
        onDragLeave={() => setDropTarget((t) => (t === 'root' ? null : t))}
        onDrop={onDrop(null)}
      >
        {isEmpty && !creating && (
          <div className="group-row">
            <span className="row-main">
              <em>No chats yet — start a conversation.</em>
            </span>
          </div>
        )}
        {childFolders(null).map((f) => renderFolder(f, 0))}
        {folderChats(null).map((c) => renderChat(c, 0))}
        {creating && creating.parentId === null && renderCreateRow(0)}
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
              else props.onDeleteChat(menu.id);
              closeMenu();
            }}
          >
            Delete
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
