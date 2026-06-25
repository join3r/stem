import { useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';

// Confirm popup for deleting the active thread (triggered by ⌃X). Mirrors the
// McpApprovalCard modal markup/classes. Confirm via the Delete button (click or
// Enter, since it's autofocused) or by pressing ⌃X again (handled in App); cancel
// via Escape, the Cancel button, or a backdrop click.
export function DeleteThreadDialog({
  title,
  onConfirm,
  onCancel
}: {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onConfirm();
    }
  }

  const name = title.trim();

  return (
    <div
      className="mcp-approval-backdrop"
      role="dialog"
      aria-modal="true"
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="mcp-approval-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <Trash2 size={15} />
          </span>
          <strong>Delete this thread?</strong>
        </div>
        <p className="muted">
          {name ? `“${name}” ` : 'This thread '}
          will be permanently removed. This can’t be undone.
        </p>
        <div className="mcp-approval-actions">
          <button className="push" onClick={onCancel}>
            Cancel
          </button>
          <button ref={confirmRef} className="push default danger" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
