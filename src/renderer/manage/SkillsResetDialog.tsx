import { useEffect, useRef, useState } from 'react';
import { GraduationCap } from 'lucide-react';
import type { SkillsMode, SkillsResetResult } from '../../shared/types';

// The one-time migration question, asked once per user and never again.
//
// Skills written before the rebuild cannot be carried forward (see
// server/skills/reset.ts for why), so this dialog is not a choice about whether —
// it is where the user is told what is happening, gets the chance to keep a
// readable copy, and answers the one question the rebuild newly needs an answer
// to: how automatic saving should be from now on.
//
// There is deliberately no Cancel, no Escape-to-close and no backdrop dismissal.
// The old library is unusable either way; a "later" button would delete the same
// files tomorrow and only buys a second showing of this dialog.

// Same three labels as the Skills tab's mode picker. One vocabulary for one
// setting — a user who meets it here and again in Settings must not have to work
// out that "Ask first" and some second phrasing are the same thing.
const MODE_LABELS: Record<SkillsMode, string> = {
  off: 'Only when I ask',
  ask: 'Ask first',
  auto: 'Save automatically'
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function SkillsResetDialog() {
  // null while the status IPC is in flight, and for everyone who never needs the
  // dialog at all — a fresh install has no library, so main marks the schema
  // current and answers `needed: false` without asking anything.
  const [count, setCount] = useState<number | null>(null);
  const [exportFirst, setExportFirst] = useState(true);
  const [mode, setMode] = useState<SkillsMode>('auto');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SkillsResetResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    window.stem
      .skillsResetStatus()
      .then((status) => {
        if (!cancelled && status.needed) setCount(status.count);
      })
      .catch(() => {
        // A status probe that fails means we don't know whether to ask, and a
        // migration dialog raised on a guess is worse than one shown next launch.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Focus the only button, in both states, so Enter carries the dialog through
  // without a trip to the mouse.
  useEffect(() => {
    if (count !== null) primaryRef.current?.focus();
  }, [count, result]);

  if (count === null) return null;

  async function proceed() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await window.stem.resetSkills(exportFirst, mode));
    } catch (e) {
      // Leave the dialog as it was so the button can simply be pressed again;
      // main exports before deleting, so a failure here has lost nothing.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mcp-approval-backdrop" role="dialog" aria-modal="true">
      <div className="mcp-approval-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <GraduationCap size={15} />
          </span>
          <strong>{result ? 'Skills reset' : 'Skills have been rebuilt'}</strong>
        </div>

        {result ? (
          <>
            <p className="muted">
              {`Removed ${plural(result.removed, 'skill', 'skills')}.`}
              {result.exported > 0 &&
                ` ${plural(result.exported, 'copy', 'copies')} ${
                  result.exported === 1 ? 'is' : 'are'
                } in Files › ${result.exportFolder}.`}
            </p>
            <p className="muted">
              Saving skills is set to “{MODE_LABELS[mode]}”. You can change that under Skills.
            </p>
            <div className="mcp-approval-actions">
              <button ref={primaryRef} className="push default" onClick={() => setCount(null)}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">
              Stem’s skills were rebuilt. The {plural(count, 'skill', 'skills')} saved by the older
              version can’t be carried over: they were written to no fixed shape, so Stem can no
              longer rank them or follow them reliably. They are about to be deleted.
            </p>

            <label className="set-check">
              <input
                type="checkbox"
                checked={exportFirst}
                onChange={(e) => setExportFirst(e.target.checked)}
                disabled={busy}
              />
              Save a copy in Files first
            </label>
            <p className="muted">
              They land as plain Markdown in a dated “Saved skills” folder, to read or re-add by
              hand.
            </p>

            <p className="muted">How should Stem save skills from now on?</p>
            <div className="seg-ctl" role="group" aria-label="Saving skills">
              {(['off', 'ask', 'auto'] as SkillsMode[]).map((m) => (
                <button
                  key={m}
                  className={mode === m ? 'active' : ''}
                  onClick={() => setMode(m)}
                  disabled={busy}
                >
                  {MODE_LABELS[m]}
                </button>
              ))}
            </div>
            <p className="muted">
              Asking Stem to save a skill always works, whichever of these you pick — the setting
              only limits what Stem does unprompted.
            </p>

            {error && <p className="error">{error}</p>}

            <div className="mcp-approval-actions">
              {/* The button says what the click does, including the deletion —
                  this is the last moment either can be reconsidered. */}
              <button ref={primaryRef} className="push default" onClick={proceed} disabled={busy}>
                {exportFirst ? 'Save copies, then delete' : 'Delete without saving'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
