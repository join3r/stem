import { useEffect, useState } from 'react';
import { Plug, Globe, HardDrive } from 'lucide-react';
import type { McpAdminProposal } from '../../shared/types';

// A modal confirm card shown when the chat assistant proposes adding or removing
// an MCP server (the `stem-admin` self-management tools). Nothing is written to
// config until the user approves — codex holds the tool call open until then.
export function McpApprovalCard() {
  const [proposal, setProposal] = useState<McpAdminProposal | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Show the latest proposal. Concurrent proposals are vanishingly rare (one
    // assistant turn at a time); the newest simply replaces any prior card.
    return window.stem.onMcpAdminApproval((p) => {
      setProposal(p);
      setBusy(false);
    });
  }, []);

  if (!proposal) return null;

  async function decide(accept: boolean) {
    if (!proposal || busy) return;
    setBusy(true);
    try {
      await window.stem.respondMcpAdminApproval(proposal.id, accept);
    } finally {
      setProposal(null);
      setBusy(false);
    }
  }

  const input = proposal.input;
  const remote = input?.transport === 'http';
  const envKeys = input?.env ? Object.keys(input.env) : [];

  return (
    <div className="mcp-approval-backdrop" role="dialog" aria-modal="true">
      <div className="mcp-approval-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            {proposal.action === 'add' ? (remote ? <Globe size={15} /> : <HardDrive size={15} />) : <Plug size={15} />}
          </span>
          <strong>
            {proposal.action === 'add' ? 'Add MCP server' : 'Remove MCP server'}
            {proposal.name ? ` “${proposal.name}”` : ''}
          </strong>
        </div>

        {proposal.action === 'add' && input ? (
          <dl className="mcp-approval-detail">
            <dt>Transport</dt>
            <dd>{remote ? 'Remote (http)' : 'Local (stdio)'}</dd>
            {remote ? (
              <>
                <dt>URL</dt>
                <dd>{input.url || <em>—</em>}</dd>
              </>
            ) : (
              <>
                <dt>Command</dt>
                <dd>
                  <code>{`${input.command ?? ''} ${(input.args ?? []).join(' ')}`.trim() || '—'}</code>
                </dd>
              </>
            )}
            {envKeys.length > 0 && (
              <>
                <dt>Env</dt>
                <dd>{envKeys.join(', ')}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="muted">The assistant wants to remove this server from your configuration.</p>
        )}

        {!remote && proposal.action === 'add' && (
          <p className="muted">A local server runs this command on your machine when reloaded. Approve only if you trust it.</p>
        )}

        <div className="mcp-approval-actions">
          <button className="push" onClick={() => decide(false)} disabled={busy}>
            Reject
          </button>
          <button className="push default" onClick={() => decide(true)} disabled={busy}>
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
