import { useEffect, useRef } from 'react';
import { Bell } from 'lucide-react';
import type { TaskNotifyPayload } from '../shared/types';

// Prominent alert raised when a scheduled run calls notify_user. Mirrors the
// McpApprovalCard / DeleteThreadDialog modal markup. "Open chat" jumps to the chat
// the run happened in; Dismiss (or Escape / backdrop click) closes it.
export function TaskAlertModal({
  payload,
  onOpenChat,
  onDismiss
}: {
  payload: TaskNotifyPayload;
  onOpenChat: (threadId: string) => void;
  onDismiss: () => void;
}) {
  const dismissRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    dismissRef.current?.focus();
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onDismiss();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onOpenChat(payload.threadId);
    }
  }

  return (
    <div
      className="mcp-approval-backdrop"
      role="dialog"
      aria-modal="true"
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className="mcp-approval-card task-alert-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <Bell size={15} />
          </span>
          <strong>{payload.title?.trim() || 'Scheduled task'}</strong>
        </div>
        <p className="task-alert-message">{payload.message}</p>
        <div className="mcp-approval-actions">
          <button className="push" onClick={onDismiss}>
            Dismiss
          </button>
          <button ref={dismissRef} className="push default" onClick={() => onOpenChat(payload.threadId)}>
            Open chat
          </button>
        </div>
      </div>
    </div>
  );
}
