import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Folder, FolderSearch, House } from 'lucide-react';
import type { ServerFolderListing } from '../../shared/types';

// The folder picker for a Stem whose server is another machine. The native
// directory dialog (window.stem.pickDirectory) opens on THIS computer, and a
// path picked here means nothing to the disk the assistant will read — so this
// dialog walks the SERVER's directories instead, one cfolders:browse call per
// level, and hands back a path that exists where it matters.
//
// The path field is editable on purpose: dot-directories are filtered from the
// list (as every OS picker filters them), and someone connecting a server they
// administer often has the absolute path on their clipboard anyway. Enter (or
// Go) navigates to whatever is typed; connecting is always the separate,
// explicit button, so a typo lands on an error line rather than in the registry.

export function ServerFolderPicker({
  onConnect,
  onClose,
  title = 'Choose a folder on Stem’s server',
  hint = 'This Stem’s server is another machine, so its folders are what can be connected — browse below, or paste a path the server knows.',
  confirmLabel = 'Connect this folder'
}: {
  /** The user chose the folder currently listed. The caller closes the dialog. */
  onConnect: (path: string) => void;
  onClose: () => void;
  /** Dialog heading; the default is the connected-folders wording. */
  title?: string;
  /** Explainer under the heading. */
  hint?: string;
  /** The confirm button's label. */
  confirmLabel?: string;
}) {
  const [listing, setListing] = useState<ServerFolderListing | null>(null);
  // The path field's draft. Follows navigation; diverges while the user types.
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  /** A browse call that itself failed (server unreachable) — distinct from a listing with `error`. */
  const [failed, setFailed] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  async function open(path?: string) {
    setBusy(true);
    setFailed(null);
    try {
      const next = await window.stem.browseServerFolders(path);
      setListing(next);
      setDraft(next.path);
      listRef.current?.scrollTo(0, 0);
    } catch (e) {
      const message = String((e as Error)?.message ?? e).replace(/^Error(?: invoking remote method '[^']*')?:\s*/, '');
      // A server from before this dialog existed doesn't answer cfolders:browse
      // at all, and the transport's "No handler registered" is not a sentence to
      // put in front of a person. Connecting a typed path still works — the add
      // channel is as old as connected folders — so say exactly that.
      setFailed(
        /No handler registered/i.test(message)
          ? 'This Stem’s server is an older version that can’t list its folders yet. Update the server, or type the folder’s full path above and connect it.'
          : message
      );
    } finally {
      setBusy(false);
    }
  }

  // Mount-only: the dialog opens at the server user's home.
  useEffect(() => {
    void open();
  }, []);

  // Connectable once something is listed, even a directory that answered with an
  // error: an EACCES folder the server's *user* can't read is still one the user
  // may want connected before fixing permissions — the add path canonicalizes
  // and stores it exactly like a typed path. With no listing at all (a server too
  // old to browse), the typed path is the whole interface, so it is what connects.
  const path = listing?.path ?? (failed ? draft.trim() || null : null);

  return (
    <div
      className="mcp-approval-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mcp-approval-card folder-picker-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <FolderSearch size={15} />
          </span>
          <strong>{title}</strong>
        </div>
        <p className="muted folder-picker-hint">{hint}</p>

        <div className="folder-picker-path">
          <button
            type="button"
            className="icon-action sm"
            disabled={busy || !listing?.parent}
            onClick={() => listing?.parent && void open(listing.parent)}
            title="Up one level"
            aria-label="Up one level"
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="icon-action sm"
            disabled={busy || !listing || listing.path === listing.home}
            onClick={() => listing && void open(listing.home)}
            title="Server home folder"
            aria-label="Server home folder"
          >
            <House size={14} />
          </button>
          <input
            className="ifield"
            value={draft}
            disabled={busy}
            aria-label="Folder path on the server"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void open(draft);
            }}
          />
          {/* Only while the draft has left the listed path — otherwise it duplicates the state on screen. */}
          {listing && draft !== listing.path && (
            <button type="button" className="push" disabled={busy} onClick={() => void open(draft)}>
              Go
            </button>
          )}
        </div>

        {(failed ?? listing?.error) && <p className="folder-picker-error">{failed ?? listing?.error}</p>}

        <div className="folder-picker-list" ref={listRef}>
          {listing && !listing.error && listing.dirs.length === 0 && !busy && (
            <p className="muted folder-picker-none">No subfolders here.</p>
          )}
          {listing?.dirs.map((d) => (
            <button
              key={d.path}
              type="button"
              className="folder-picker-row"
              disabled={busy}
              onClick={() => void open(d.path)}
              title={d.path}
            >
              <Folder size={14} />
              <span>{d.name}</span>
            </button>
          ))}
        </div>

        <div className="mcp-approval-actions">
          <button type="button" className="push" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="push default"
            disabled={busy || !path}
            onClick={() => path && onConnect(path)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
