import { useEffect, useRef, useState } from 'react';
import { Check, Circle, X } from 'lucide-react';
import type { ComputerAccess } from '../../shared/types';

// The sheet the Record chip opens: what will be recorded, the three macOS
// grants it needs (with a way to ask for the missing ones), and Start. Start
// hides Stem and puts the recording pill at the top of the screen.

const GRANTS: { key: keyof ComputerAccess; name: string; why: string; required: boolean }[] = [
  { key: 'accessibility', name: 'Accessibility', why: 'to name what you click', required: true },
  { key: 'inputMonitoring', name: 'Input Monitoring', why: 'to notice clicks and keys', required: true },
  { key: 'screen', name: 'Screen Recording', why: 'pictures, only for values no text explains', required: false }
];

export function RecordSheet({
  threadId,
  draftId,
  onClose
}: {
  threadId: string;
  /** Recording another example for this draft. */
  draftId?: string | null;
  onClose: () => void;
}) {
  const [access, setAccess] = useState<ComputerAccess | null>(null);
  const [checking, setChecking] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    void window.stem
      .recorderAccess()
      .then((a) => alive && setAccess(a))
      .catch(() => undefined)
      .finally(() => alive && setChecking(false));
    startRef.current?.focus();
    return () => {
      alive = false;
    };
  }, []);

  const missing = access ? GRANTS.filter((g) => g.required && !access[g.key]) : [];
  const ready = !!access && missing.length === 0;

  async function grant() {
    setError(null);
    try {
      const state = await window.stem.requestComputerAccess();
      setAccess(state.access ?? (await window.stem.recorderAccess()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function start() {
    if (!ready || starting) return;
    setStarting(true);
    setError(null);
    try {
      await window.stem.startRecording(threadId, draftId ?? null);
      onClose();
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      setStarting(false);
    }
  }

  return (
    <div
      className="mcp-approval-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Record a skill"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mcp-approval-card record-sheet">
        <div className="mcp-approval-head">
          <span className="record-dot" aria-hidden="true" />
          <strong>{draftId ? 'Record another example' : 'Record a skill'}</strong>
        </div>
        <p className="muted">
          Do the task the way you always do. Stem notes what you click and type, by name, and the text in front of you, so
          it can tell where each value came from. When you press Stop, it writes the steps up as a skill for you to check.
        </p>
        <ul className="record-grants">
          {GRANTS.map((g) => {
            const ok = !!access?.[g.key];
            return (
              <li key={g.key} className={ok ? 'ok' : g.required ? 'missing' : 'optional'}>
                {checking ? <Circle size={13} /> : ok ? <Check size={13} /> : <X size={13} />}
                <span className="record-grant-name">{g.name}</span>
                <span className="muted">{g.why}</span>
              </li>
            );
          })}
        </ul>
        <p className="muted record-fine">
          Passwords and password managers are never recorded. Nothing leaves this Mac until you press Stop, and then only
          the steps and the lines each value was found in. Pause any time; ⌃⌥R stops.
        </p>
        {error && <p className="record-error">{error}</p>}
        <div className="mcp-approval-actions">
          {!checking && access && GRANTS.some((g) => !access[g.key]) && (
            <button className="push" onClick={() => void grant()}>
              Grant access…
            </button>
          )}
          <button className="push" onClick={onClose}>
            Cancel
          </button>
          <button ref={startRef} className="push default" disabled={!ready || starting} onClick={() => void start()}>
            {starting ? 'Starting…' : 'Start recording'}
          </button>
        </div>
      </div>
    </div>
  );
}
