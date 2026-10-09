import { FolderInput, Mail, MailOpen, Trash2, X } from 'lucide-react';

// Appears above the chat tree the moment a multi-selection exists, and only
// then — a permanently visible toolbar would be dead weight for the single-row
// case, which is nearly every case.

export interface SelectionBarProps {
  count: number;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  /** Opens the folder picker at the button. */
  onMove: (e: React.MouseEvent) => void;
  onDelete: () => void;
  onClear: () => void;
}

export function SelectionBar({ count, onMarkRead, onMarkUnread, onMove, onDelete, onClear }: SelectionBarProps) {
  return (
    <div className="inbox-selbar">
      <span className="inbox-selbar-count">{count} selected</span>
      <span className="inbox-selbar-actions">
        <button className="link-btn icon-only" data-label="Mark read" aria-label="Mark read" onClick={onMarkRead}>
          <MailOpen size={14} />
        </button>
        <button className="link-btn icon-only" data-label="Mark unread" aria-label="Mark unread" onClick={onMarkUnread}>
          <Mail size={14} />
        </button>
        <button className="link-btn icon-only" data-label="Move to folder" aria-label="Move to folder" onClick={onMove}>
          <FolderInput size={14} />
        </button>
        <button className="link-btn icon-only danger" data-label="Delete" aria-label="Delete" onClick={onDelete}>
          <Trash2 size={14} />
        </button>
        <button className="link-btn icon-only" data-label="Clear selection  Esc" aria-label="Clear selection" onClick={onClear}>
          <X size={14} />
        </button>
      </span>
    </div>
  );
}
