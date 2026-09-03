import { useEffect, useRef, type ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import type { ReleaseNoteEntry } from '../shared/types';
import { renderMdx } from './mdx/render';

// "What's new" dialog. Raised once per release from App (the sections the user
// hasn't seen), and on demand from Settings → App → About (the whole history). Mirrors
// the TaskAlertModal / McpApprovalCard markup; the notes themselves are plain
// Markdown rendered through the same pipeline as an assistant reply, so a list
// or a bold run in RELEASE_NOTES.md looks like it does everywhere else.

export function ReleaseNotesModal({
  title,
  entries,
  showOnUpdate,
  onToggleShowOnUpdate,
  onShowAll,
  recommendation,
  onClose
}: {
  title: string;
  entries: ReleaseNoteEntry[];
  /** Omit (with onToggleShowOnUpdate) to hide the preference — Settings owns it there. */
  showOnUpdate?: boolean;
  onToggleShowOnUpdate?: (value: boolean) => void;
  /** Offered only while the dialog is showing a subset of the history. */
  onShowAll?: () => void;
  /**
   * A call to action tied to this update (e.g. the switch-to-recommended recall
   * setup), pinned under the notes so it is read after them and never scrolls
   * away with them. Absent from the Settings-opened history.
   */
  recommendation?: ReactNode;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className="mcp-approval-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mcp-approval-card release-notes-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <Sparkles size={15} />
          </span>
          <strong>{title}</strong>
        </div>
        <div className="release-notes-body">
          {entries.length === 0 ? (
            <p className="muted">No release notes yet.</p>
          ) : (
            entries.map((entry) => (
              <section className="release-notes-section" key={entry.version}>
                <div className="release-notes-version">
                  {entry.version}
                  {entry.label && <span>{entry.label}</span>}
                </div>
                <div className="mdx">{renderMdx(entry.body)}</div>
              </section>
            ))
          )}
        </div>
        {recommendation}
        <div className="mcp-approval-actions release-notes-actions">
          {showOnUpdate !== undefined && onToggleShowOnUpdate && (
            <label className="set-check" title="Show these notes the first time you open a new version">
              <input
                type="checkbox"
                checked={showOnUpdate}
                onChange={(e) => onToggleShowOnUpdate(e.target.checked)}
              />
              Show after updates
            </label>
          )}
          {onShowAll && (
            <button className="link-btn" onClick={onShowAll}>
              View all release notes
            </button>
          )}
          <button ref={closeRef} className="push default" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
