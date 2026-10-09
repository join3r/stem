import { useCallback, useEffect, useState } from 'react';
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Plus,
  Download,
  FolderOpen,
  FolderPlus,
  Trash2,
  File as FileIcon
} from 'lucide-react';
import { FILES_CONTEXT_LIMIT, type FileEntry, type FilesListing } from '../../../shared/types';
import { useRemoteServer } from '../../hooks/useRemoteServer';
import { InfoTip } from '../../ui/InfoTip';

// ---- Files sub-tab: the persistent drop-place inside Stem's own workspace ----
// Unlike a connected folder (a reference to files that stay where they live),
// Files holds copies, and every name is listed to the assistant each turn — so
// this surface is a plain file browser, not a settings list: what's in there,
// how big, and a way to take something back out. Subfolders are one level deep
// on purpose — each one becomes a band in the drag-to-place overlay.

/** "1.2 MB" / "834 KB" / "512 B" — one significant decimal above KB. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * One section per top-level subfolder, root first then alphabetical. Driven by
 * `dirs` (not just the dirs that happen to hold files) so a folder you just
 * created stays on screen while it is still empty.
 */
function buildGroups(listing: FilesListing | null): { dir: string; files: FileEntry[] }[] {
  if (!listing) return [];
  const groups = new Map<string, FileEntry[]>([['', []], ...listing.dirs.map((d): [string, FileEntry[]] => [d, []])]);
  for (const f of listing.files) {
    const list = groups.get(f.dir);
    if (list) list.push(f);
    else groups.set(f.dir, [f]); // a dir that appeared between list and render
  }
  return [...groups.entries()]
    .filter(([dir, files]) => dir !== '' || files.length > 0) // no empty "Top level"
    .sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0].localeCompare(b[0])))
    .map(([dir, files]) => ({ dir, files }));
}

export function FilesTab() {
  const [listing, setListing] = useState<FilesListing | null>(null);
  const [busy, setBusy] = useState(false);
  // Non-null while the inline "new folder" row is open; holds its draft name.
  const [newDir, setNewDir] = useState<string | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);
  /** What a download said when it went wrong; cleared by the next attempt. */
  const [error, setError] = useState<string | null>(null);
  // The Files folder is the server's. On a machine that isn't the server's, a
  // file manager here cannot open it — so Download replaces "reveal" rather than
  // sitting beside a button that could only ever fail.
  const remote = useRemoteServer();
  // Subfolder groups folded shut. Every group starts open; the header's
  // chevrons fold or unfold them all at once.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = (dir: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  const refresh = useCallback(() => {
    window.stem.listFiles().then(setListing).catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);

  // The drop overlay writes into files/ without going through this tab, and the
  // folder is a real directory the user can also edit in Finder — so re-read on
  // an overlay drop and whenever the window regains focus.
  useEffect(() => {
    window.addEventListener('stem:files-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('stem:files-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  async function add() {
    setBusy(true);
    try {
      const paths = await window.stem.openFiles();
      // Picked files land at the root; the drop overlay is how you target a
      // subfolder (it turns each one into a band).
      if (paths.length) setListing(await window.stem.addFiles(paths));
    } finally {
      setBusy(false);
    }
  }

  /** Save a copy where downloads go and show it there. */
  async function download(f: FileEntry) {
    setBusy(true);
    setError(null);
    try {
      await window.stem.downloadFile(f.rel);
    } catch (e) {
      setError(String((e as Error)?.message ?? e).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
    }
  }

  async function remove(f: FileEntry) {
    if (!window.confirm(`Delete “${f.name}” from your Files folder?\n\nThis removes it from disk.`)) return;
    setListing(await window.stem.removeFile(f.rel));
  }

  async function removeDir(dir: string, count: number) {
    const contents =
      count === 0
        ? '\n\nIt is empty.'
        : `\n\nThe ${count} file${count === 1 ? '' : 's'} inside ${count === 1 ? 'is' : 'are'} removed from disk with it.`;
    if (!window.confirm(`Delete the “${dir}” subfolder?${contents}`)) return;
    setListing(await window.stem.removeFilesSubdir(dir));
  }

  async function commitNewDir() {
    const name = (newDir ?? '').trim();
    if (!name) {
      setNewDir(null);
      setDirError(null);
      return;
    }
    // Main rejects these too (files/store.ts) — checking here turns a thrown IPC
    // error into an inline message instead of a silently dropped click.
    if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
      setDirError('Use a plain name — no slashes, and not starting with a dot.');
      return;
    }
    try {
      setListing(await window.stem.createFilesSubdir(name));
      setNewDir(null);
      setDirError(null);
    } catch {
      setDirError("That name can't be used as a folder.");
    }
  }

  const files = listing?.files ?? [];
  const groups = buildGroups(listing);
  const empty = files.length === 0 && (listing?.dirs.length ?? 0) === 0;
  // Groups only get a foldable head when there is more than the top level.
  const headed = groups.some((g) => g.dir !== '') || groups.length > 1;
  const allCollapsed = headed && groups.every((g) => collapsed.has(g.dir));
  /** Show a file or subfolder in Finder (only when the Files folder is on this disk). */
  const reveal = (rel: string) => {
    setError(null);
    window.stem.revealFiles(rel).catch((e: unknown) => setError(String((e as Error)?.message ?? e).replace(/^Error:\s*/, '')));
  };

  return (
    <div>
      <div className="grp-head cfolders-head">
        Files
        <span className="grp-head-actions">
          {headed && (
            <button
              className="grp-head-add"
              onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.dir)))}
              title={allCollapsed ? 'Expand all folders' : 'Collapse all folders'}
              aria-label={allCollapsed ? 'Expand all folders' : 'Collapse all folders'}
            >
              {allCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
            </button>
          )}
          {!remote && (
            <button
              className="grp-head-add"
              onClick={() => window.stem.revealFiles()}
              title="Open the Files folder in Finder"
              aria-label="Open Files folder"
            >
              <FolderOpen size={14} />
            </button>
          )}
          <button
            className={`grp-head-add${newDir !== null ? ' active' : ''}`}
            onClick={() => {
              setNewDir(newDir === null ? '' : null);
              setDirError(null);
            }}
            title="Create a subfolder (it also becomes a drop destination)"
            aria-label="New subfolder"
          >
            <FolderPlus size={14} />
          </button>
          <button
            className="grp-head-add"
            onClick={add}
            disabled={busy}
            title="Copy files into your Files folder"
            aria-label="Add files"
          >
            <Plus size={14} />
          </button>
        </span>
      </div>

      {newDir !== null && (
        <div className="files-newdir">
          <input
            className="ifield"
            autoFocus
            placeholder="Subfolder name"
            aria-label="New subfolder name"
            value={newDir}
            onChange={(e) => {
              setNewDir(e.target.value);
              setDirError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitNewDir();
              else if (e.key === 'Escape') {
                setNewDir(null);
                setDirError(null);
              }
            }}
          />
          <button type="button" className="push default" onClick={() => void commitNewDir()}>
            Create
          </button>
          {dirError && <span className="files-newdir-error">{dirError}</span>}
        </div>
      )}

      {error && <p className="files-error">{error}</p>}

      {empty ? (
        <p className="muted">
          Drop a file anywhere on the Stem window and choose “Add to Files”, and a copy is kept
          here for good. Stem is told the name of every file in this folder at the start of each
          turn, and reads the ones it needs — so keep it to things worth having on hand.
        </p>
      ) : (
        <>
          {groups.map(({ dir, files: entries }) => (
            <div key={dir || '__root__'}>
              {headed && (
                <div className="grp-head files-group-head">
                  <button
                    className="files-group-toggle"
                    onClick={() => toggleGroup(dir)}
                    aria-expanded={!collapsed.has(dir)}
                  >
                    <ChevronRight size={12} className={`chat-caret${collapsed.has(dir) ? '' : ' open'}`} />
                    <span>{dir === '' ? 'Top level' : dir}</span>
                    {collapsed.has(dir) && <em className="files-group-count">{entries.length}</em>}
                  </button>
                  {dir !== '' && (
                    <span className="files-group-actions">
                      {!remote && (
                        <button
                          className="grp-head-add"
                          onClick={() => reveal(dir)}
                          title="Open in Finder"
                          aria-label={`Open subfolder ${dir} in Finder`}
                        >
                          <FolderOpen size={13} />
                        </button>
                      )}
                      <button
                        className="grp-head-add"
                        onClick={() => void removeDir(dir, entries.length)}
                        title={`Delete the ${dir} subfolder`}
                        aria-label={`Delete subfolder ${dir}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </span>
                  )}
                </div>
              )}
              {!(headed && collapsed.has(dir)) && (
                <div className="group">
                  {entries.length === 0 ? (
                    <div className="group-row files-row">
                      <span className="muted">Empty — drop files here to fill it.</span>
                    </div>
                  ) : (
                    entries.map((f) => (
                      <div key={f.rel} className="group-row files-row">
                        <span className="row-icon">
                          <FileIcon size={14} />
                        </span>
                        <span className="row-main">
                          <strong title={f.rel}>{f.name}</strong>
                          <em>{formatSize(f.size)}</em>
                        </span>
                        {!remote && (
                          <button
                            className="icon-action sm row-action"
                            onClick={() => reveal(f.rel)}
                            title="Show in Finder"
                            aria-label={`Show ${f.name} in Finder`}
                          >
                            <FolderOpen size={14} />
                          </button>
                        )}
                        <button
                          className="icon-action sm row-action"
                          onClick={() => void download(f)}
                          disabled={busy}
                          title="Save a copy to your Downloads folder"
                          aria-label={`Download ${f.name}`}
                        >
                          <Download size={14} />
                        </button>
                        <button
                          className="icon-action sm row-action"
                          onClick={() => void remove(f)}
                          title="Delete from Files"
                          aria-label={`Delete ${f.name}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
          <p className="muted files-foot">
            {files.length.toLocaleString()} file{files.length === 1 ? '' : 's'}
            {files.length > FILES_CONTEXT_LIMIT && (
              <>
                {' · '}
                only the first {FILES_CONTEXT_LIMIT} are named to the assistant
                <InfoTip label="Why only the first 100">
                  Every turn, Stem lists the names of the files in this folder so the assistant
                  knows what it can read. That list is capped at {FILES_CONTEXT_LIMIT} names to
                  keep the prompt small — files past the cap are still on disk and still readable
                  if you mention them, but the assistant won't know they exist on its own. For a
                  pile this size, a connected folder with indexing on is the better fit.
                </InfoTip>
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}
