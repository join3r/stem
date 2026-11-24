import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Download, ImageIcon, TriangleAlert, X } from 'lucide-react';
import type { ActivityItem, GeneratedImageRef } from '../../shared/types';

// Pictures generate_image made, shown under the assistant reply. The history
// and the event stream carry only refs; each card fetches its bytes once over
// `chats:image` and keeps them in a small module-level cache, so scrolling back
// through a chat does not refetch megabytes per render.

const CACHE_MAX_ENTRIES = 48;
const CACHE_MAX_CHARS = 96 * 1024 * 1024;
const cache = new Map<string, string>();
let cacheChars = 0;
const inflight = new Map<string, Promise<string | null>>();

function remember(key: string, dataUrl: string): void {
  cache.delete(key);
  cache.set(key, dataUrl);
  cacheChars += dataUrl.length;
  while (cache.size > CACHE_MAX_ENTRIES || cacheChars > CACHE_MAX_CHARS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheChars -= cache.get(oldest)?.length ?? 0;
    cache.delete(oldest);
  }
}

function loadImage(ref: GeneratedImageRef): Promise<string | null> {
  const key = `${ref.threadId}/${ref.id}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  let pending = inflight.get(key);
  if (!pending) {
    pending = window.stem
      .getChatImage(ref.threadId, ref.id)
      .then((res) => {
        if (res?.dataUrl) remember(key, res.dataUrl);
        return res?.dataUrl ?? null;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

/** The bytes of one image as a data URL; undefined while loading, null when gone. */
export function useChatImage(ref: GeneratedImageRef): string | null | undefined {
  const key = `${ref.threadId}/${ref.id}`;
  const [url, setUrl] = useState<string | null | undefined>(() => cache.get(key));
  useEffect(() => {
    let live = true;
    const hit = cache.get(key);
    if (hit) {
      setUrl(hit);
      return;
    }
    setUrl(undefined);
    loadImage(ref).then(
      (u) => live && setUrl(u),
      () => live && setUrl(null)
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ref's identity
  }, [key]);
  return url;
}

function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The "Creating image…" placeholder while a generate_image call runs. */
export function PendingImageCard({ item, live }: { item: ActivityItem; live: boolean }) {
  const [firstSeen] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (!live) {
    // A row still "running" in a settled turn: the turn stopped under it.
    return (
      <div className="gen-image-card gen-image-failed">
        <TriangleAlert size={16} />
        <span>Stopped before the image was ready</span>
      </div>
    );
  }
  return (
    <div className="gen-image-card gen-image-pending" aria-live="polite">
      <ImageIcon size={18} />
      <span>Creating image…</span>
      <span className="gen-image-timer">{elapsed(item.startedAt ?? firstSeen, now)}</span>
    </div>
  );
}

/** A full-window view of one picture. It renders into document.body, so no ancestor transform or overflow clips it. */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  return createPortal(
    <div
      className="gen-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
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
      <img src={src} alt={alt} />
      <button ref={closeRef} type="button" className="gen-image-close" aria-label="Close" onClick={onClose}>
        <X size={18} />
      </button>
    </div>,
    document.body
  );
}

/** A picture thumbnail that opens the full-window view on click (for example, an image the user attached). */
export function ZoomableImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="zoomable-image"
        title="Show larger"
        aria-label={`Show ${alt} larger`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <img className={className} src={src} alt={alt} />
      </button>
      {open && <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Download / Copy, under one image. */
function ImageActions({ image, url }: { image: GeneratedImageRef; url: string }) {
  const [flash, setFlash] = useState<string | null>(null);
  const say = (text: string) => {
    setFlash(text);
    setTimeout(() => setFlash((cur) => (cur === text ? null : cur)), 1800);
  };
  const run = (label: string, fn: () => Promise<unknown>) => () =>
    void fn().then(
      () => say(label),
      (e) => say(String((e as Error)?.message ?? e))
    );
  return (
    <div className="gen-image-actions">
      <button
        type="button"
        title="Save to Downloads"
        aria-label="Save image to Downloads"
        onClick={run('Saved to Downloads', () => window.stem.saveImageToDownloads(url, image.prompt || 'Stem image'))}
      >
        <Download size={13} />
      </button>
      <button type="button" title="Copy" aria-label="Copy image" onClick={run('Copied', () => window.stem.copyImage(url))}>
        <Copy size={13} />
      </button>
      {flash && (
        <span className="gen-image-flash">
          <Check size={12} /> {flash}
        </span>
      )}
    </div>
  );
}

export function GeneratedImageCard({ image }: { image: GeneratedImageRef }) {
  const url = useChatImage(image);
  const [open, setOpen] = useState(false);
  const alt = image.revisedPrompt || image.prompt || 'Generated image';
  const ratio = image.width && image.height ? `${image.width} / ${image.height}` : '1 / 1';
  if (url === null) {
    return (
      <div className="gen-image-card gen-image-failed">
        <TriangleAlert size={16} />
        <span>This image is no longer available</span>
      </div>
    );
  }
  return (
    <div className="gen-image-wrap">
      <button
        type="button"
        className="gen-image"
        style={{ aspectRatio: ratio }}
        title={alt}
        onClick={() => url && setOpen(true)}
      >
        {url ? <img src={url} alt={alt} /> : <span className="gen-image-loading" aria-label="Loading image" />}
      </button>
      {url && <ImageActions image={image} url={url} />}
      {open && url && <ImageLightbox src={url} alt={alt} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** A file name for a picture saved from a share page. */
function downloadName(alt: string, mime: string): string {
  const base = alt.replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim().replace(/\s+/g, ' ').slice(0, 60) || 'Stem image';
  const ext = { 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' }[mime] ?? 'png';
  return `${base}.${ext}`;
}

/**
 * A generated picture on a share page: the app's card, with the bytes from
 * the snapshot. The page has no Stem to save or copy through, so Download is
 * a plain download and Copy is there only where the browser can copy a PNG.
 */
export function SharedImageCard({ src, alt, mime, width, height }: { src: string; alt?: string; mime: string; width?: number; height?: number }) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const label = alt || 'Generated image';
  const ratio = width && height ? `${width} / ${height}` : '1 / 1';
  const canCopy = mime === 'image/png' && typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;
  const copy = () => {
    // Decoded here, not fetched: the share page's CSP allows no fetch of a data: URL.
    const bin = atob(src.slice(src.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    void navigator.clipboard
      .write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
      .then(
        () => setFlash('Copied'),
        () => setFlash('Could not copy')
      );
    setTimeout(() => setFlash(null), 1800);
  };
  return (
    <div className="gen-image-wrap">
      <button type="button" className="gen-image" style={{ aspectRatio: ratio }} title={label} onClick={() => setOpen(true)}>
        <img src={src} alt={label} />
      </button>
      <div className="gen-image-actions">
        <button
          type="button"
          title="Download"
          aria-label="Download image"
          onClick={() => {
            const a = document.createElement('a');
            a.href = src;
            a.download = downloadName(label, mime);
            a.click();
          }}
        >
          <Download size={13} />
        </button>
        {canCopy && (
          <button type="button" title="Copy" aria-label="Copy image" onClick={copy}>
            <Copy size={13} />
          </button>
        )}
        {flash && (
          <span className="gen-image-flash">
            <Check size={12} /> {flash}
          </span>
        )}
      </div>
      {open && <ImageLightbox src={src} alt={label} onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * Every picture of one assistant turn: the finished ones, then a placeholder
 * per call still running. `live` is whether this turn is still in flight.
 */
export function GeneratedImages({
  images,
  activity,
  live
}: {
  images?: GeneratedImageRef[];
  activity?: ActivityItem[];
  live: boolean;
}) {
  const done = images ?? [];
  const pending = (activity ?? []).filter((a) => a.type === 'imageGeneration' && a.status === 'running');
  if (!done.length && !pending.length) return null;
  return (
    <div className="gen-images">
      {done.map((img) => (
        <GeneratedImageCard key={img.id} image={img} />
      ))}
      {pending.map((a) => (
        <PendingImageCard key={a.id} item={a} live={live} />
      ))}
    </div>
  );
}
