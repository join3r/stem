import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import type { QuickChatStatus } from '../../shared/types';

// macOS modifier glyphs, in canonical order (⌃⌥⇧⌘). The four-modifier hyperkey
// collapses to a single icon, matching the settings UI's accelerator rendering.
const MOD_ORDER = ['Control', 'Alt', 'Shift', 'Command'];
const MOD_GLYPH: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' };

/** Render an Electron accelerator ('Alt+Space') as compact mac glyphs ('⌥Space'). */
function formatAccelerator(accel: string): string {
  const parts = accel.split('+');
  const mods = parts
    .filter((p) => MOD_GLYPH[p])
    .sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  const keys = parts.filter((p) => !MOD_GLYPH[p]);
  const isHyper = MOD_ORDER.every((m) => mods.includes(m));
  const modStr = isHyper ? '✦' : mods.map((m) => MOD_GLYPH[m]).join('');
  return modStr + keys.join('');
}

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
  // Prompt with the real summon key when one is bound; otherwise the pill is
  // still clickable, so fall back to that.
  const hint = status.shortcut ? `${formatAccelerator(status.shortcut)} open` : 'click to open';

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
        {finished && <span className="hud-hint">{hint}</span>}
      </button>
    </div>
  );
}
