import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import type { CustomInstructionsSettings, InstructionsProposal } from '../../shared/types';

type Surface = 'main' | 'quickChat';

// Compute the resulting full text for a surface from the assistant's proposed action.
// The card writes the WHOLE surface string (main is the sole writer), so append is
// resolved here against the current value rather than in the backend.
function resolvedText(
  action: InstructionsProposal['action'],
  incomingText: string,
  current: string
): string {
  if (action === 'clear') return '';
  if (action === 'replace') return incomingText;
  // append
  return current ? `${current}\n${incomingText}` : incomingText;
}

// Modal confirm card shown when the assistant proposes a custom-instructions change
// (the `set_custom_instructions` tool). The user edits the final text and picks the
// surface; nothing is written until Apply — the backend holds the tool call open.
export function InstructionsApprovalCard() {
  const [proposal, setProposal] = useState<InstructionsProposal | null>(null);
  const [current, setCurrent] = useState<CustomInstructionsSettings>({ main: '', quickChat: '' });
  const [surface, setSurface] = useState<Surface>('main');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    return window.stem.onInstructionsApproval((p) => {
      setBusy(false);
      setProposal(p);
      const initialSurface: Surface = p.suggestedSurface ?? 'main';
      setSurface(initialSurface);
      // Fetch current values so append previews correctly and surface-switching recomputes.
      window.stem.getSettings().then((s) => {
        setCurrent(s.customInstructions);
        setText(resolvedText(p.action, p.incomingText, s.customInstructions[initialSurface]));
      });
    });
  }, []);

  if (!proposal) return null;

  function pickSurface(next: Surface) {
    if (!proposal) return;
    setSurface(next);
    // Recompute the proposed text for the newly chosen surface (append depends on it).
    setText(resolvedText(proposal.action, proposal.incomingText, current[next]));
  }

  async function decide(accept: boolean) {
    if (!proposal || busy) return;
    setBusy(true);
    try {
      await window.stem.respondInstructionsApproval(proposal.id, accept, surface, text);
    } finally {
      setProposal(null);
      setBusy(false);
    }
  }

  const actionLabel =
    proposal.action === 'clear' ? 'Clear instructions' : proposal.action === 'replace' ? 'Replace instructions' : 'Add to instructions';

  return (
    <div className="mcp-approval-backdrop" role="dialog" aria-modal="true">
      <div className="mcp-approval-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <Pencil size={15} />
          </span>
          <strong>{actionLabel}</strong>
        </div>

        <p className="muted">The assistant wants to update your standing custom instructions. Choose where they apply and edit the text before applying.</p>

        <div className="seg-ctl" role="group" aria-label="Which surface">
          <button className={surface === 'main' ? 'active' : ''} onClick={() => pickSurface('main')} disabled={busy}>
            Main (everywhere)
          </button>
          <button className={surface === 'quickChat' ? 'active' : ''} onClick={() => pickSurface('quickChat')} disabled={busy}>
            Quick Chat only
          </button>
        </div>
        <p className="muted">
          {surface === 'main'
            ? 'Applies in the main app and in Quick Chat.'
            : 'An extra layered only on the Quick Chat overlay (on top of Main).'}
        </p>

        <textarea
          className="instructions-approval-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          disabled={busy}
          placeholder="(empty — clears these instructions)"
        />

        <div className="mcp-approval-actions">
          <button className="push" onClick={() => decide(false)} disabled={busy}>
            Cancel
          </button>
          <button className="push default" onClick={() => decide(true)} disabled={busy}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
