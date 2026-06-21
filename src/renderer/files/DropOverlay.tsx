import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare, Folder, FolderInput } from 'lucide-react';

// Full-window drag-to-place overlay. When the user drags a file anywhere onto the
// Stem window, the window dims and splits into two destinations:
//   • left  — "Add to this conversation" (the file is attached to the open chat)
//   • right — "Add to Files" (saved into the persistent files/ folder), which
//             subdivides into one horizontal band per top-level subfolder plus a
//             root band, so a drop can target a specific subfolder.
// Hit-testing: left/right of the window midline picks chat-vs-Files; within the
// Files half the band is picked by vertical position.

const ROOT = '__root__';

interface DropOverlayProps {
  /** Route an overlay drop on the left zone into the active chat's composer. */
  onDropToChat: (files: File[]) => void;
}

export function DropOverlay({ onDropToChat }: DropOverlayProps) {
  const [show, setShow] = useState(false);
  const [dirs, setDirs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);
  const bandRefs = useRef<Map<string, HTMLElement>>(new Map());
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

  // Which destination the cursor is over: 'chat', a subfolder name, or ROOT.
  const targetAt = useCallback((x: number, y: number): string => {
    const el = overlayRef.current;
    if (!el) return 'chat';
    const r = el.getBoundingClientRect();
    if (x - r.left < r.width / 2) return 'chat';
    for (const [id, node] of bandRefs.current) {
      const br = node.getBoundingClientRect();
      if (y >= br.top && y <= br.bottom) return id;
    }
    return ROOT;
  }, []);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      if (!showRef.current) {
        window.stem.listFiles().then((l) => setDirs(l.dirs)).catch(() => setDirs([]));
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
      const target = targetAt(e.clientX, e.clientY);
      close();
      if (!files.length) return;
      if (target === 'chat') {
        onDropToChat(files);
        return;
      }
      // A Files band: resolve to on-disk paths (overlay adds by path) and copy in.
      const subdir = target === ROOT ? undefined : target;
      const paths = files.map((f) => window.stem.getPathForFile(f)).filter(Boolean);
      if (paths.length) window.stem.addFiles(paths, subdir).catch(() => {});
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

  if (!show) return null;

  const bands = [...dirs, ROOT];

  return (
    <div className="drop-overlay" ref={overlayRef}>
      <div className="drop-zones">
        <div className={`drop-zone chat${active === 'chat' ? ' active' : ''}`}>
          <div className="dz-glyph">
            <MessageSquare size={36} />
          </div>
          <span className="dz-eyebrow">This chat</span>
          <h3>Add to this conversation</h3>
          <p>Stem reads it here, just for now.</p>
        </div>

        <div className="drop-divider" />

        <div className={`drop-files${dirs.length === 0 ? ' single' : ''}`}>
          {bands.map((id) => {
            const isRoot = id === ROOT;
            return (
              <div
                key={id}
                ref={(n) => {
                  if (n) bandRefs.current.set(id, n);
                  else bandRefs.current.delete(id);
                }}
                className={`drop-band${isRoot ? ' root' : ''}${active === id ? ' active' : ''}`}
              >
                <div className="dz-glyph sm">{isRoot ? <FolderInput size={26} /> : <Folder size={26} />}</div>
                <div className="dz-text">
                  <span className="dz-eyebrow">
                    {isRoot ? (dirs.length ? 'Files · root' : 'Your Files') : 'Files folder'}
                  </span>
                  <h4>{isRoot ? (dirs.length ? 'Top level' : 'Add to Files') : id}</h4>
                  <p>{isRoot ? 'Straight into your Files folder.' : `Into the ${id} subfolder.`}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="drop-foot">
        Drop on a destination · <kbd>Esc</kbd> to cancel
      </div>
    </div>
  );
}
