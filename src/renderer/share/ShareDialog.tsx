import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Link2, Link2Off, Share2 } from 'lucide-react';
import {
  SHARE_CARD_DESC_MAX,
  SHARE_CARD_TITLE_MAX,
  SHARE_MAX_RECIPIENTS,
  SHARE_TTL_CHOICES,
  normalizeRecipient,
  type SharedLink,
  type ShareOptions,
  type SharePreview,
  type ShareScope,
  type ShareSource,
  type ShareStatus
} from '../../shared/share';
import { ShareView } from './ShareView';

// Publish an answer, the question and answer, or the whole chat / mail thread
// as a public link (docs/public-share-design.md). Opened from an answer's
// hover actions. The preview is the snapshot exactly as it will be uploaded,
// so what the user sees here is what a stranger sees.

const ttlLabel = (days: number) => (days === 1 ? 'Expires in 1 day' : `Expires in ${days} days`);

const cleanError = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);

/** The addresses typed in the "Only these people" field: valid ones, and the rest. */
export function parseRecipients(text: string): { ok: string[]; bad: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    if (!part) continue;
    const a = normalizeRecipient(part);
    if (!a) bad.push(part);
    else if (!ok.includes(a)) ok.push(a);
  }
  return { ok, bad };
}

function sizeLabel(bytes: number): string {
  return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function ShareDialog({
  source,
  anchorId,
  onClose,
  onOpenSettings
}: {
  source: ShareSource;
  /** The answer the user clicked Share on: a chat turn id or a mail item id. */
  anchorId: string;
  onClose: () => void;
  /** Settings → Features, where an address gets verified. */
  onOpenSettings: () => void;
}) {
  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [scope, setScope] = useState<ShareScope>('pair');
  const [includeAttachments, setIncludeAttachments] = useState(false);
  const [includeModel, setIncludeModel] = useState(true);
  const [ttlDays, setTtlDays] = useState<number>(SHARE_TTL_CHOICES[0]);
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<SharedLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoked, setRevoked] = useState(false);
  // The link preview (published in the clear): on by default, filled from the
  // snapshot until the user edits a field.
  const [cardOn, setCardOn] = useState(true);
  const [cardTitle, setCardTitle] = useState<string | null>(null);
  const [cardDesc, setCardDesc] = useState<string | null>(null);
  // Who can open it: anyone with the link, or only the people named here.
  const [locked, setLocked] = useState(false);
  const [recipientText, setRecipientText] = useState('');
  const recipients = parseRecipients(recipientText);
  const recipientsReady =
    !locked || (recipients.ok.length > 0 && recipients.bad.length === 0 && recipients.ok.length <= SHARE_MAX_RECIPIENTS);
  const title = cardTitle ?? preview?.card.title ?? '';
  const desc = cardDesc ?? preview?.card.description ?? '';

  const opts: ShareOptions = {
    scope,
    anchorId,
    includeAttachments,
    includeModel,
    ttlDays,
    card: cardOn ? { title, description: desc } : null,
    ...(locked ? { recipients: recipients.ok } : {})
  };

  useEffect(() => {
    void window.stem.shareStatus().then(setStatus, (e) => setError(cleanError(e)));
  }, []);

  useEffect(() => {
    let live = true;
    setPreview(null);
    window.stem
      .previewShare(source, { scope, anchorId, includeAttachments, includeModel })
      .then(
        (p) => live && (setPreview(p), setError(null)),
        (e) => live && setError(cleanError(e))
      );
    return () => {
      live = false;
    };
    // source is an object literal from the parent; its ids are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind, source.kind === 'chat' ? source.threadId : source.conversationId, anchorId, scope, includeAttachments, includeModel]);

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await window.stem.createShare(source, opts);
      setLink(made);
      try {
        await navigator.clipboard.writeText(made.url);
        setCopied(true);
      } catch {
        // The link is on screen with its own Copy button.
      }
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!link) return;
    setBusy(true);
    setError(null);
    try {
      await window.stem.revokeShare(link.id);
      setRevoked(true);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link.url);
    setCopied(true);
  };

  const thread = source.kind === 'mail' ? 'mail thread' : 'chat';
  const SCOPES: { id: ShareScope; label: string }[] = [
    { id: 'thread', label: `Whole ${thread}` },
    { id: 'pair', label: 'Question and answer' },
    { id: 'answer', label: 'Answer only' }
  ];

  return (
    <div
      className="mcp-approval-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Share as a link"
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
      <div className="mcp-approval-card share-dialog">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <Share2 size={15} />
          </span>
          <strong>
            {link
              ? revoked
                ? 'Link revoked'
                : link.recipients?.length
                  ? 'Only the people you chose can open it'
                  : 'Anyone with this link can see it'
              : 'Share as a link'}
          </strong>
        </div>

        {link ? (
          <>
            {revoked ? (
              <p className="muted">The link no longer opens. Anyone who already saved the page keeps their copy.</p>
            ) : (
              <>
                <div className="share-link-row">
                  <input className="vfield share-link" readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
                  <button className="icon-action" title={copied ? 'Copied' : 'Copy link'} aria-label="Copy link" onClick={() => void copy()}>
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                  <a className="icon-action" href={link.url} target="_blank" rel="noreferrer" title="Open in the browser" aria-label="Open in the browser">
                    <ExternalLink size={14} />
                  </a>
                </div>
                <p className="muted">
                  Works until {new Date(link.expiresAt).toLocaleDateString(undefined, { dateStyle: 'long' })}.{' '}
                  {link.recipients?.length
                    ? `Send the link to ${link.recipients.join(', ')} yourself. To open it, they enter a code that Stem mails to their address, so a forwarded link shows nothing. Stem tells you when each of them opens it.`
                    : 'The content is encrypted; the key is the part after # in the link, so only people you give the link to can read it.'}{' '}
                  Later messages are not added. Manage your links in Settings → Features.
                  {link.size >= 2 << 20 &&
                    ` At ${sizeLabel(link.size)}, the page takes a few seconds to open on a slow connection.`}
                </p>
              </>
            )}
            <div className="mcp-approval-actions">
              {!revoked && (
                <button className="push danger" disabled={busy} onClick={() => void revoke()}>
                  <Link2Off size={13} /> Revoke
                </button>
              )}
              <button className="push default" onClick={onClose} autoFocus>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            {status && !status.available && (
              <div className="share-unavailable">
                <p>{status.message}</p>
                {status.code === 'no_address' && (
                  <button className="push" onClick={onOpenSettings}>
                    Verify an address in Settings
                  </button>
                )}
              </div>
            )}

            <div className="seg-ctl share-scope" role="radiogroup" aria-label="What to share">
              {SCOPES.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={scope === o.id}
                  className={scope === o.id ? 'active' : ''}
                  onClick={() => setScope(o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>

            <div className="share-who">
              <div className="seg-ctl" role="radiogroup" aria-label="Who can open it">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!locked}
                  className={!locked ? 'active' : ''}
                  onClick={() => setLocked(false)}
                >
                  Anyone with the link
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={locked}
                  className={locked ? 'active' : ''}
                  onClick={() => {
                    // The preview card is not encrypted; a private link starts without one.
                    if (!locked) setCardOn(false);
                    setLocked(true);
                  }}
                >
                  Only people I choose
                </button>
              </div>
              {locked && (
                <>
                  <input
                    className="vfield"
                    type="text"
                    value={recipientText}
                    placeholder="martin@gmail.com, eva@company.sk"
                    aria-label="Email addresses"
                    autoFocus
                    onChange={(e) => setRecipientText(e.target.value)}
                  />
                  {recipients.bad.length > 0 ? (
                    <p className="task-failed">Not an email address: {recipients.bad.join(', ')}</p>
                  ) : recipients.ok.length > SHARE_MAX_RECIPIENTS ? (
                    <p className="task-failed">A link can name at most {SHARE_MAX_RECIPIENTS} people.</p>
                  ) : (
                    <p className="muted share-note">
                      To open the link, a person enters a code that Stem mails to their address. You send the link yourself.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="share-preview" aria-label="Preview">
              {preview ? (
                <ShareView snapshot={preview.snapshot} />
              ) : (
                !error && <p className="muted">Preparing the preview…</p>
              )}
            </div>

            <div className="share-options">
              <label>
                <input type="checkbox" checked={includeModel} onChange={(e) => setIncludeModel(e.target.checked)} />
                Show which model answered
              </label>
              {(includeAttachments || (preview?.omittedAttachments ?? 0) > 0) && (
                <label>
                  <input
                    type="checkbox"
                    checked={includeAttachments}
                    onChange={(e) => setIncludeAttachments(e.target.checked)}
                  />
                  Include my pictures
                  {!includeAttachments && preview ? ` (${preview.omittedAttachments} left out)` : ''}
                </label>
              )}
              <select className="vfield" value={ttlDays} onChange={(e) => setTtlDays(Number(e.target.value))} aria-label="Expiry">
                {SHARE_TTL_CHOICES.map((days) => (
                  <option key={days} value={days}>
                    {ttlLabel(days)}
                  </option>
                ))}
              </select>
            </div>

            <div className="share-card-edit">
              <label className="share-card-toggle">
                <input type="checkbox" checked={cardOn} onChange={(e) => setCardOn(e.target.checked)} />
                Show a preview when the link is pasted in a chat app
              </label>
              {cardOn && (
                <>
                  <div className="share-card" aria-label="Link preview">
                    <input
                      className="share-card-title"
                      value={title}
                      maxLength={SHARE_CARD_TITLE_MAX}
                      placeholder="Title"
                      aria-label="Preview title"
                      onChange={(e) => setCardTitle(e.target.value)}
                    />
                    <textarea
                      className="share-card-desc"
                      value={desc}
                      rows={2}
                      maxLength={SHARE_CARD_DESC_MAX}
                      placeholder="Description (optional)"
                      aria-label="Preview description"
                      onChange={(e) => setCardDesc(e.target.value)}
                    />
                    <span className="share-card-site">share.heystem.app</span>
                  </div>
                  <p className="muted share-note">
                    Unlike the page, this preview is not encrypted: the share server and anyone the link reaches can read
                    it. Search engines are told not to index any of it.
                  </p>
                </>
              )}
            </div>

            <p className="muted share-note">
              Tool steps, memory cards and in-app links are left out.{' '}
              {locked ? 'Only the people above can read what you see here' : 'Anyone with the link can read what you see above'}
              {status?.address ? `; it is published under ${status.address}` : ''}.
              {preview ? ` ${sizeLabel(preview.bytes)}.` : ''}
            </p>
            {error && <p className="task-failed">{error}</p>}

            <div className="mcp-approval-actions">
              <button className="push" onClick={onClose}>
                Cancel
              </button>
              <button
                className="push default"
                disabled={busy || !preview || !status?.available || !recipientsReady}
                onClick={() => void publish()}
                autoFocus
              >
                <Link2 size={13} /> {busy ? 'Publishing…' : 'Create link'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
