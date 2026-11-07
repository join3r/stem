import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mail, MessageSquare, Folder, FolderInput, FolderSearch } from 'lucide-react';
import { dropTileLayout, orderDropDirs, recordDropDir, ROOT, OTHER } from './drop-layout';

// Full-window drag-to-place overlay. When the user drags a file anywhere onto the
// Stem window, the window dims and splits into two destinations:
//   • left  — "Add to this conversation" (the file is attached to the open chat)
//   • right — "Add to Files" (saved into the persistent files/ folder). The top
//             of the right half is a fixed "Top level" zone; below it every
//             top-level subfolder is a compact tile in a grid sized so all tiles
//             fit without scrolling (you can't scroll mid-drag). When there are
//             more folders than fit, the most recently used ones show and the
//             last tile, "Other folder…", opens a searchable picker after the drop.
// Hit-testing: left/right of the window midline picks chat-vs-Files; within the
// Files half the top zone is ROOT and otherwise the nearest tile wins, so the
// gaps between tiles never flicker to another target.

interface DropOverlayProps {
  /** Route an overlay drop on the left zone into the centre pane's draft —
   * the chat composer, or the open mail view's attachment draft. */
  onDropToChat: (files: File[]) => void;
  /** What the centre pane holds, so the left zone names (and reaches) it. */
  target: 'chat' | 'mail';
}

function addToFiles(paths: string[], subdir: string | undefined) {
  if (!paths.length) return;
  if (subdir) recordDropDir(subdir);
  window.stem
    .addFiles(paths, subdir)
    // The Files tab may be open behind the overlay — tell it to re-read.
    .then(() => window.dispatchEvent(new Event('stem:files-changed')))
    .catch(() => {});
}

export function DropOverlay({ onDropToChat, target }: DropOverlayProps) {
  const [show, setShow] = useState(false);
  const [dirs, setDirs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  // Files dropped on "Other folder…", waiting for the picker.
  const [pending, setPending] = useState<string[] | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef<Map<string, HTMLElement>>(new Map());
  const dragDepth = useRef(0);
  const showRef = useRef(false);
  const setShown = (v: boolean) => {
    showRef.current = v;
    setShow(v);
  };

  const close = useCallback(() => {
    dragDepth.current = 0;
    setShown(false);
    setActive(null);
  }, []);

  // Which destination the cursor is over: 'chat', ROOT, OTHER or a subfolder name.
  const targetAt = useCallback((x: number, y: number): string => {
    const el = overlayRef.current;
    if (!el) return 'chat';
    const r = el.getBoundingClientRect();
    if (x - r.left < r.width / 2) return 'chat';
    const root = rootRef.current?.getBoundingClientRect();
    if (!root || y <= root.bottom) return ROOT;
    let best = ROOT;
    let bestDist = Infinity;
    for (const [id, node] of tileRefs.current) {
      const t = node.getBoundingClientRect();
      const dx = Math.max(t.left - x, 0, x - t.right);
      const dy = Math.max(t.top - y, 0, y - t.bottom);
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = id;
      }
    }
    return best;
  }, []);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      if (!showRef.current) {
        window.stem.listFiles().then((l) => setDirs(l.dirs)).catch(() => setDirs([]));
        setSize({ w: window.innerWidth, h: window.innerHeight });
        setShown(true);
      }
    };
    const onOver = (e: DragEvent) => {
      if (!showRef.current) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setActive(targetAt(e.clientX, e.clientY));
    };
    const onLeave = () => {
      if (!showRef.current) return;
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) close();
    };
    const onDropEv = (e: DragEvent) => {
      if (!showRef.current) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      const dest = targetAt(e.clientX, e.clientY);
      close();
      if (!files.length) return;
      if (dest === 'chat') {
        onDropToChat(files);
        return;
      }
      // A Files destination: resolve to on-disk paths (overlay adds by path) and copy in.
      const paths = files.map((f) => window.stem.getPathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      if (dest === OTHER) setPending(paths);
      else addToFiles(paths, dest === ROOT ? undefined : dest);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showRef.current) close();
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDropEv);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDropEv);
      window.removeEventListener('keydown', onKey);
    };
  }, [close, targetAt, onDropToChat]);

  const layout = useMemo(() => dropTileLayout(dirs.length, size.w / 2, size.h), [dirs.length, size]);
  const shown = useMemo(() => {
    if (!layout.overflow) return dirs;
    return orderDropDirs(dirs).slice(0, layout.capacity - 1);
  }, [dirs, layout]);

  const picker = pending && (
    <FolderPicker
      dirs={dirs}
      onPick={(dir) => {
        addToFiles(pending, dir);
        setPending(null);
      }}
      onCancel={() => setPending(null)}
    />
  );

  if (!show) return picker || null;

  const tiles = layout.overflow ? [...shown, OTHER] : shown;
  const single = dirs.length === 0;

  return (
    <div className="drop-overlay" ref={overlayRef}>
      <div className="drop-zones">
        <div className={`drop-zone chat${active === 'chat' ? ' active' : ''}`}>
          <div className="dz-glyph">
            {target === 'mail' ? <Mail size={36} /> : <MessageSquare size={36} />}
          </div>
          <span className="dz-eyebrow">{target === 'mail' ? 'This mail' : 'This chat'}</span>
          <h3>{target === 'mail' ? 'Attach to this mail' : 'Add to this conversation'}</h3>
          <p>{target === 'mail' ? 'Goes out with the draft you’re writing.' : 'Stem reads it here, just for now.'}</p>
        </div>

        <div className="drop-divider" />

        <div className={`drop-files${single ? ' single' : ''}`}>
          <div ref={rootRef} className={`drop-band root${active === ROOT ? ' active' : ''}`}>
            <div className="dz-glyph sm">
              <FolderInput size={26} />
            </div>
            <div className="dz-text">
              <span className="dz-eyebrow">{single ? 'Your Files' : 'Files · root'}</span>
              <h4>{single ? 'Add to Files' : 'Top level'}</h4>
              <p>Straight into your Files folder.</p>
            </div>
          </div>

          {!single && (
            <div
              className={`drop-tiles${layout.roomy ? ' roomy' : ''}`}
              style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))` }}
            >
              {tiles.map((id) => {
                const isOther = id === OTHER;
                return (
                  <div
                    key={id}
                    ref={(n) => {
                      if (n) tileRefs.current.set(id, n);
                      else tileRefs.current.delete(id);
                    }}
                    className={`drop-tile${isOther ? ' other' : ''}${active === id ? ' active' : ''}`}
                    title={isOther ? "Drop here to pick any folder" : id}
                  >
                    {isOther ? <FolderSearch size={18} /> : <Folder size={18} />}
                    <span className="drop-tile-name">
                      {isOther ? `${dirs.length - shown.length} more…` : id}
                    </span>
                    {layout.roomy && !isOther && <span className="drop-tile-sub">Into this subfolder</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="drop-foot">
        Drop on a destination · <kbd>Esc</kbd> to cancel
      </div>
    </div>
  );
}

/** After a drop on "Other folder…": pick any subfolder by typing or clicking. */
function FolderPicker({
  dirs,
  onPick,
  onCancel
}: {
  dirs: string[];
  onPick: (dir: string | undefined) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? dirs.filter((d) => d.toLowerCase().includes(needle)) : orderDropDirs(dirs);
    return [...list.map((d) => ({ id: d, label: d })), { id: ROOT, label: 'Top level' }];
  }, [dirs, q]);
  const cur = Math.min(sel, matches.length - 1);
  const pick = (id: string) => onPick(id === ROOT ? undefined : id);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(Math.min(cur + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(cur - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(matches[cur].id);
    }
  }

  return (
    <div
      className="mcp-approval-backdrop"
      role="dialog"
      aria-modal="true"
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="mcp-approval-card drop-picker">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <FolderSearch size={15} />
          </span>
          <strong>Save into which folder?</strong>
        </div>
        <input
          ref={inputRef}
          className="drop-picker-search"
          placeholder="Search folders…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
        />
        <div className="drop-picker-list" role="listbox">
          {matches.map((m, i) => (
            <button
              key={m.id}
              role="option"
              aria-selected={i === cur}
              className={`drop-picker-row${i === cur ? ' sel' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(m.id)}
            >
              {m.id === ROOT ? <FolderInput size={15} /> : <Folder size={15} />}
              <span>{m.label}</span>
            </button>
          ))}
        </div>
        <div className="mcp-approval-actions">
          <button className="push" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
