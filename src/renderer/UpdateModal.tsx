import { useEffect, useRef } from 'react';
import { ArrowUpCircle } from 'lucide-react';
import type { UpdateStatus } from '../shared/types';

// The "there's a newer Stem" dialog. Raised once per launch per version from
// App, for the two states worth interrupting for: a build sitting downloaded
// (the AppImage — restart to finish) or one sitting on a web page (mac and deb,
// which cannot fetch it themselves). Mirrors the TaskAlertModal markup. "Later"
// is a real answer: the banner under the title bar and the row in Settings → App
// keep the offer open, and a downloaded build installs itself on the next quit.
export function UpdateModal({
  update,
  onInstall,
  onLater
}: {
  update: UpdateStatus;
  onInstall: () => void;
  onLater: () => void;
}) {
  const installRef = useRef<HTMLButtonElement>(null);
  const ready = update.state === 'ready';

  useEffect(() => {
    installRef.current?.focus();
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onLater();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onInstall();
    }
  }

  return (
    <div
      className="mcp-approval-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Stem ${update.available} is available`}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onLater();
      }}
    >
      <div className="mcp-approval-card task-alert-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <ArrowUpCircle size={15} />
          </span>
          <strong>{ready ? `Stem ${update.available} is ready to install` : `Stem ${update.available} is out`}</strong>
        </div>
        <p className="task-alert-message">
          {ready
            ? `It's downloaded. Restart Stem to finish updating — or keep working, and it installs when you quit.`
            : `You're running ${update.appVersion}. This build can't update itself, so grab the new one from the release page and install it over this one.`}
        </p>
        <div className="mcp-approval-actions">
          <button className="push" onClick={onLater}>
            Later
          </button>
          <button ref={installRef} className="push default" onClick={onInstall}>
            {ready ? 'Restart now' : 'Get the update'}
          </button>
        </div>
      </div>
    </div>
  );
}
