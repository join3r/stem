import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import type { QuickChatStatus } from '../../shared/types';

// The bottom-left status pill, shown while the overlay is hidden and a turn runs.
// It only reflects state pushed from the main process (`quickchat:status`); it
// never runs turns itself. Clicking it re-summons the overlay to read the answer.
export function StatusHud() {
  const [status, setStatus] = useState<QuickChatStatus | null>(null);

  useEffect(() => {
    return window.stem.onQuickChatStatus(setStatus);
  }, []);

  if (!status) return null;
  const finished = status.phase === 'finished';

  return (
    <div className="hud-root">
      <button className={`hud-pill${finished ? ' finished' : ''}`} onClick={() => window.stem.revealQuickChat()}>
        {finished ? (
          <span className="hud-check" aria-hidden="true">
            <Check size={13} />
          </span>
        ) : (
          <span className="activity-dots" aria-hidden="true">
            <span className="activity-dot" />
            <span className="activity-dot" />
            <span className="activity-dot" />
          </span>
        )}
        <span className="hud-label">{status.label}</span>
        {finished && <span className="hud-hint">⏎ open</span>}
      </button>
    </div>
  );
}
