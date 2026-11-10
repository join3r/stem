import { useMemo, type ReactNode } from 'react';
import { Sparkles, User } from 'lucide-react';
import { MdxView } from '../chat/MdxView';
import { SourcesList } from '../chat/ActivityRows';
import { SharedImageCard, ZoomableImage } from '../chat/GeneratedImage';
import { ChatAudioCard } from '../chat/ChatAudio';
import { MdxStaticContext, type MdxStatic } from '../mdx/ActionContext';
import type { ShareImage, ShareMessage, ShareSnapshot } from '../../shared/share';

// A share snapshot drawn with the chat's own markup, classes and parts
// (renderer/chat/ChatView.tsx renderMessage), so a shared answer looks like it
// does in Stem. Used by the share dialog's preview and by the
// share.heystem.app viewer (src/share), so it must stay web-safe: no
// window.stem, no app stores. Whatever the app fetches from Stem as it draws a
// reply (pictures, sounds, site icons) comes from the snapshot instead
// (MdxStaticContext). Interactive MDX renders inert here because no action
// context is provided (forms read-only, Replies hidden).

const AVATAR: Record<ShareMessage['role'], { cls: string; icon: ReactNode; label: string }> = {
  user: { cls: 'you', icon: <User size={12} />, label: 'Question' },
  assistant: { cls: 'stem', icon: <Sparkles size={12} />, label: 'Stem' }
};

const IMAGE_DATA_RE = /^data:image\/(png|jpeg|gif|webp|avif);base64,/i;
const AUDIO_DATA_RE = /^data:audio\/[a-z0-9.+-]+;base64,/i;
const ICON_DATA_RE = /^data:image\/(x-icon|vnd\.microsoft\.icon|png|gif|jpeg|webp);base64,/i;
const httpUrl = (u: string): boolean => /^https?:\/\//i.test(u);

function stampOf(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A picture a model made. Snapshots from before the flag only had those on answers. */
function isGenerated(img: ShareImage, role: ShareMessage['role']): boolean {
  return img.generated ?? role === 'assistant';
}

export function ShareMessageView({ m }: { m: ShareMessage }) {
  const a = AVATAR[m.role];
  const stamp = stampOf(m.createdAt);
  const images = (m.images ?? []).filter((i) => IMAGE_DATA_RE.test(i.dataUrl));
  const generated = images.filter((i) => isGenerated(i, m.role));
  const attached = images.filter((i) => !isGenerated(i, m.role));
  const audio = (m.audio ?? []).filter((s) => AUDIO_DATA_RE.test(s.dataUrl));
  const sources = (m.sources ?? [])
    .filter((s) => httpUrl(s.url))
    .map((s) => ({ url: s.url, title: s.title, icon: s.icon && ICON_DATA_RE.test(s.icon) ? s.icon : undefined }));
  const statik = useMemo<MdxStatic>(() => {
    const pictures = new Map((m.webImages ?? []).filter((w) => IMAGE_DATA_RE.test(w.dataUrl)).map((w) => [w.url, w.dataUrl]));
    return { webImage: (url) => pictures.get(url) };
  }, [m.webImages]);
  return (
    <div className={`message message-${m.role}`}>
      <div className="message-body">
        <div className="message-who">
          <div className={`msg-avatar ${a.cls}`}>{a.icon}</div>
          <span className="message-who-name">{m.author ?? a.label}</span>
          {m.model && <span className="message-meta">{m.model}</span>}
          {stamp && <span className="message-timing">{stamp}</span>}
        </div>
        {m.role === 'assistant'
          ? m.text && (
              <MdxStaticContext.Provider value={statik}>
                <MdxView text={m.text} />
              </MdxStaticContext.Provider>
            )
          : m.text && <div className="message-plain">{m.text}</div>}
        {generated.length > 0 && (
          <div className="gen-images">
            {generated.map((img, i) => (
              <SharedImageCard key={i} src={img.dataUrl} alt={img.alt} mime={img.mime} width={img.width} height={img.height} />
            ))}
          </div>
        )}
        {audio.length > 0 && (
          <div className="chat-audio-list">
            {audio.map((s, i) => (
              <ChatAudioCard key={i} audio={{ id: `shared-${i}`, threadId: '', mime: s.mime, title: s.title }} src={s.dataUrl} />
            ))}
          </div>
        )}
        {sources.length > 0 && <SourcesList sources={sources} />}
        {attached.length > 0 && (
          <div className="message-attachments">
            {attached.map((img, i) => (
              <ZoomableImage key={i} className="message-image" src={img.dataUrl} alt={img.alt ?? 'picture'} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ShareView({ snapshot, header = true }: { snapshot: ShareSnapshot; header?: boolean }) {
  const shared = new Date(snapshot.sharedAt);
  return (
    <article className="share-view">
      {header && (
        <header className="share-head">
          <h1>{snapshot.title}</h1>
          <p className="muted">
            {snapshot.kind === 'answer' ? 'An answer' : 'A conversation'} shared from Stem
            {Number.isNaN(shared.getTime()) ? '' : ` · ${shared.toLocaleDateString(undefined, { dateStyle: 'long' })}`}
          </p>
        </header>
      )}
      <div className="share-messages">
        {snapshot.messages.map((m, i) => (
          <ShareMessageView key={i} m={m} />
        ))}
      </div>
    </article>
  );
}
