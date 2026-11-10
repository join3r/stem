import { useEffect, useState } from 'react';
import { ImageIcon } from 'lucide-react';
import { useMdxStatic, useMdxThread } from './ActionContext';

// A picture a reply links to on the web. The CSP keeps the renderer from
// loading it, so the server fetches it over `chats:remoteImage` — and only
// when the URL reached the chat from a tool's output or the user, never when a
// model wrote it (src/server/chats/remote-image.ts). Anything refused renders
// as a link to the picture, which the user can open in the browser. A share
// page takes the bytes from its snapshot (MdxStaticContext), which carries
// exactly the pictures the app showed.

const CACHE_MAX_CHARS = 64 * 1024 * 1024;
const cache = new Map<string, string | null>();
let cacheChars = 0;
const inflight = new Map<string, Promise<string | null>>();

function remember(key: string, dataUrl: string | null): void {
  cache.set(key, dataUrl);
  cacheChars += dataUrl?.length ?? 0;
  for (const [old, value] of cache) {
    if (cacheChars <= CACHE_MAX_CHARS) break;
    cacheChars -= value?.length ?? 0;
    cache.delete(old);
  }
}

function load(threadId: string, url: string): Promise<string | null> {
  const key = `${threadId}\n${url}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = window.stem
      .getRemoteImage(threadId, url)
      .catch(() => null)
      .then((dataUrl) => {
        remember(key, dataUrl);
        return dataUrl;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function RemoteLink({ src, alt, loading }: { src: string; alt: string; loading?: boolean }) {
  return (
    <a className={`mdx-remote-link${loading ? ' loading' : ''}`} href={src} target="_blank" rel="noreferrer" title={src}>
      <ImageIcon size={14} aria-hidden />
      <span>{alt || 'Image'}</span>
      <span className="mdx-remote-host">{hostOf(src)}</span>
    </a>
  );
}

export function RemoteImage({ src, alt }: { src: string; alt: string }) {
  const shared = useMdxStatic();
  if (shared) {
    const dataUrl = shared.webImage(src);
    return dataUrl ? <img className="mdx-remote-image" src={dataUrl} alt={alt} /> : <RemoteLink src={src} alt={alt} />;
  }
  return <LiveRemoteImage src={src} alt={alt} />;
}

function LiveRemoteImage({ src, alt }: { src: string; alt: string }) {
  const threadId = useMdxThread();
  const key = threadId ? `${threadId}\n${src}` : '';
  const [dataUrl, setDataUrl] = useState<string | null | undefined>(() => (key && cache.has(key) ? cache.get(key) : threadId ? undefined : null));

  useEffect(() => {
    if (!threadId) {
      setDataUrl(null);
      return;
    }
    if (cache.has(key)) {
      setDataUrl(cache.get(key));
      return;
    }
    let live = true;
    setDataUrl(undefined);
    void load(threadId, src).then((u) => live && setDataUrl(u));
    return () => {
      live = false;
    };
  }, [threadId, src, key]);

  if (dataUrl) return <img className="mdx-remote-image" src={dataUrl} alt={alt} />;
  return <RemoteLink src={src} alt={alt} loading={dataUrl === undefined} />;
}
