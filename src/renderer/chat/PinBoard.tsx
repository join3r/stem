import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  ChevronDown,
  PanelTopClose,
  PanelTopOpen,
  Pencil,
  Pin,
  Plus,
  StickyNote,
  Tag,
  TextQuote,
  X
} from 'lucide-react';
import type { ChatMessage, ChatPin } from '../../shared/types';
import type { ChatPins } from '../hooks/useChatPins';
import { pinSource, pinSummary, readDocked, writeDocked } from './pins';

// The chat's pinboard (docs/chat-pinboard-plan.md): a strip under the chat
// header that names what the user kept from this chat, and opens into a list.
// Floating, the list drops over the transcript and any click outside it closes
// it again; docked ("Keep open"), it sits in the column and pushes the
// transcript down until closed on purpose. Hidden entirely until the chat has
// a first pin.

const KIND_ICON = { message: Pin, passage: TextQuote, note: StickyNote } as const;
const KIND_TITLE = { message: 'Pinned message', passage: 'Pinned passage', note: 'Note' } as const;

export function PinBoard({
  threadId,
  board,
  messages,
  onJump
}: {
  threadId: string;
  board: ChatPins;
  messages: ChatMessage[];
  /** Bring the pin's source message into view (only offered while it is still in the chat). */
  onJump: (pin: ChatPin, source: ChatMessage) => void;
}) {
  const { pins } = board;
  const [open, setOpen] = useState(() => readDocked(threadId));
  const [docked, setDocked] = useState(() => readDocked(threadId));
  // The note being written or edited: `new` for the composer under the list.
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Drag to reorder: which row is moving, and where it would land.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);

  // Floating: a press anywhere outside the board — the transcript, the
  // composer, the sidebar — closes it. Docked boards stay put.
  useEffect(() => {
    if (!open || docked) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditing(null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, docked]);

  // The last pin removed: nothing to show, and the next first pin starts closed.
  useEffect(() => {
    if (pins.length === 0 && editing !== 'new') setOpen(docked);
  }, [pins.length, editing, docked]);

  if (pins.length === 0 && editing !== 'new') return null;

  const drop = () => {
    if (dragId && dropAt && dragId !== dropAt.id) {
      const ids = pins.map((p) => p.id).filter((id) => id !== dragId);
      const at = ids.indexOf(dropAt.id) + (dropAt.after ? 1 : 0);
      ids.splice(at, 0, dragId);
      if (ids.join() !== pins.map((p) => p.id).join()) void board.reorder(ids);
    }
    setDragId(null);
    setDropAt(null);
  };

  const toggleDocked = () => {
    const next = !docked;
    setDocked(next);
    writeDocked(threadId, next);
    if (next) setOpen(true);
  };

  return (
    <div
      ref={rootRef}
      className={`pinboard${open ? ' open' : ''}${docked ? ' docked' : ''}`}
      onKeyDown={(e) => {
        // Escape belongs to the composer (stop / retract) unless focus is here.
        if (e.key === 'Escape' && !docked && editing === null) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="pinboard-strip"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setEditing(null);
        }}
      >
        <Pin size={13} className="pinboard-strip-icon" />
        <span className="pinboard-count">{pins.length}</span>
        {open ? (
          <span className="pinboard-summary">Pinned in this chat</span>
        ) : (
          <span className="pinboard-summary" title={pinSummary(pins)}>
            ({pinSummary(pins)})
          </span>
        )}
        <ChevronDown size={13} className={`pinboard-chevron${open ? ' open' : ''}`} />
      </button>

      {open && (
        <div className="pinboard-drop">
          <ul className="pinboard-list">
            {pins.map((pin) => (
              <PinRow
                key={pin.id}
                pin={pin}
                draggable={pins.length > 1 && editing === null}
                dragging={dragId === pin.id}
                dropMark={dropAt?.id === pin.id && dragId !== pin.id ? (dropAt.after ? 'after' : 'before') : null}
                onDragStart={() => setDragId(pin.id)}
                onDragOverRow={(after) => setDropAt({ id: pin.id, after })}
                onDrop={drop}
                onDragEnd={() => {
                  setDragId(null);
                  setDropAt(null);
                }}
                source={pinSource(pin, messages)}
                editing={editing === pin.id}
                onEdit={() => setEditing(pin.id)}
                onCancelEdit={() => setEditing(null)}
                onSave={async (text) => {
                  if (await board.update(pin.id, { text })) setEditing(null);
                }}
                onRemove={() => void board.remove(pin.id)}
                onRename={(label) => board.update(pin.id, { label })}
                onJump={(source) => {
                  onJump(pin, source);
                  if (!docked) setOpen(false);
                }}
              />
            ))}
          </ul>
          {editing === 'new' && (
            <NoteEditor
              initial=""
              placeholder="A note for this chat — the model sees it too"
              onCancel={() => setEditing(null)}
              onSave={async (text) => {
                if (await board.add({ kind: 'note', text })) setEditing(null);
              }}
            />
          )}
          {board.error && <p className="pinboard-error">{board.error}</p>}
          <div className="pinboard-foot">
            {editing !== 'new' && (
              <button type="button" className="link-btn" onClick={() => setEditing('new')}>
                <Plus size={12} /> Add note
              </button>
            )}
            <button type="button" className="link-btn pinboard-dock" onClick={toggleDocked}>
              {docked ? <PanelTopClose size={12} /> : <PanelTopOpen size={12} />}
              {docked ? 'Float over chat' : 'Keep open'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PinRow({
  pin,
  draggable,
  dragging,
  dropMark,
  onDragStart,
  onDragOverRow,
  onDrop,
  onDragEnd,
  source,
  editing,
  onEdit,
  onCancelEdit,
  onSave,
  onRemove,
  onRename,
  onJump
}: {
  pin: ChatPin;
  draggable: boolean;
  dragging: boolean;
  dropMark: 'before' | 'after' | null;
  onDragStart: () => void;
  /** The dragged row is over this one; `after` = its lower half. */
  onDragOverRow: (after: boolean) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  source: ChatMessage | null;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (text: string) => void;
  onRemove: () => void;
  /** Write the pin's label; null clears it (and a fresh one is written in the background). */
  onRename: (label: string | null) => Promise<boolean>;
  onJump: (source: ChatMessage) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const Icon = KIND_ICON[pin.kind];
  // A note is the user's own writing: removing it takes a second click. A pinned
  // message or passage can be pinned again from the chat, so one click does.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 2500);
    return () => window.clearTimeout(t);
  }, [armed]);

  const quoted = pin.kind !== 'note';
  const gone = quoted && !source;

  return (
    <li
      className={`pinboard-item kind-${pin.kind}${gone ? ' gone' : ''}${dragging ? ' dragging' : ''}${
        dropMark ? ` drop-${dropMark}` : ''
      }`}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        // Some engines start no drag without data.
        e.dataTransfer.setData('text/plain', pin.id);
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        onDragOverRow(e.clientY > box.top + box.height / 2);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
    >
      <Icon size={13} className="pinboard-item-icon" aria-label={KIND_TITLE[pin.kind]} />
      <div className="pinboard-item-body">
        {renaming ? (
          <LabelEditor
            initial={pin.label ?? ''}
            onCancel={() => setRenaming(false)}
            onSave={async (label) => {
              if (await onRename(label.trim() ? label : null)) setRenaming(false);
            }}
          />
        ) : (
          // Until a label is written the text itself is the name: no echo of its first words.
          pin.label && <div className="pinboard-item-label">{pin.label}</div>
        )}
        {editing ? (
          <NoteEditor initial={pin.text} onCancel={onCancelEdit} onSave={onSave} />
        ) : (
          <div className="pinboard-item-text">{pin.text}</div>
        )}
        {gone && <div className="pinboard-item-gone">No longer in this chat</div>}
      </div>
      {!editing && !renaming && (
        <div className="pinboard-item-actions">
          <button
            type="button"
            className="message-action"
            aria-label="Rename"
            title="Rename — the short name in the collapsed board"
            onClick={() => setRenaming(true)}
          >
            <Tag size={13} />
          </button>
          {quoted && source && (
            <button
              type="button"
              className="message-action"
              aria-label="Show in chat"
              title="Show in chat"
              onClick={() => onJump(source)}
            >
              <ArrowUpRight size={13} />
            </button>
          )}
          {pin.kind === 'note' && (
            <button type="button" className="message-action" aria-label="Edit note" title="Edit note" onClick={onEdit}>
              <Pencil size={13} />
            </button>
          )}
          <button
            type="button"
            className={`message-action${armed ? ' danger' : ''}`}
            aria-label={armed ? 'Click again to remove' : quoted ? 'Unpin' : 'Remove note'}
            title={armed ? 'Click again to remove' : quoted ? 'Unpin' : 'Remove note'}
            onClick={() => {
              if (quoted || armed) onRemove();
              else setArmed(true);
            }}
          >
            <X size={13} />
          </button>
        </div>
      )}
    </li>
  );
}

/** One-line label editor; empty clears the label so a fresh one is written. */
function LabelEditor({
  initial,
  onSave,
  onCancel
}: {
  initial: string;
  onSave: (label: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial);
  return (
    <input
      className="pinboard-label-input"
      autoFocus
      value={label}
      maxLength={60}
      placeholder="Short name — leave empty to let Stem name it"
      aria-label="Pin name"
      onChange={(e) => setLabel(e.target.value)}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onSave(label);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    />
  );
}

function NoteEditor({
  initial,
  placeholder,
  onSave,
  onCancel
}: {
  initial: string;
  placeholder?: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="pinboard-editor">
      <textarea
        autoFocus
        rows={2}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (text.trim()) onSave(text);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="pinboard-editor-actions">
        <button type="button" className="link-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="link-btn" disabled={!text.trim()} onClick={() => onSave(text)}>
          Save
        </button>
      </div>
    </div>
  );
}
