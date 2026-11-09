import { useEffect, useState } from 'react';
import { ChevronRight, Clock, Check, Copy, Eye, Link2, Link2Off, Lock, Mail, MessageSquare } from 'lucide-react';
import { SHARE_MAX_LINKS, type SharedLink } from '../../../../shared/share';
import { ConfirmDelete, DetailHeader, DetailIdent, Flag, Glyph, ListGroup, ListRow, ListSearch } from '../../ListDetail';
import { ValueRow } from './rows';

const SCOPE_LABEL: Record<string, string> = {
  thread: 'Whole thread',
  pair: 'Question and answer',
  answer: 'Answer only'
};

/** A link that stops in less than this shows a clock on its row. */
const SOON_MS = 3 * 24 * 60 * 60 * 1000;

const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });
const dateTime = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** "Only 2 people · opened by 1" for a locked link; null for a public one. */
function lockLine(l: SharedLink): string | null {
  const n = l.recipients?.length ?? 0;
  if (!n) return null;
  const opened = l.opens?.length ?? 0;
  const who = n === 1 ? l.recipients![0]! : `${n} people`;
  return `Only ${who} · ${opened ? `opened by ${opened === n && n > 1 ? 'all' : opened}` : 'not opened yet'}`;
}

const scopeLine = (l: SharedLink) => `${SCOPE_LABEL[l.scope] ?? 'Shared'}${l.source?.kind === 'mail' ? ' (mail)' : ''}`;

const errorText = (e: unknown) =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);

/**
 * Settings → Features → Shared links: one row with the count. It opens
 * SharedLinksPage, because the list can be long (up to SHARE_MAX_LINKS).
 * Hidden until there is a link.
 */
export function SharedLinksSection({ onOpen }: { onOpen: () => void }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    void window.stem.listShares().then(
      (l) => setCount(l.length),
      () => setCount(0)
    );
  }, []);

  if (!count) return null;

  return (
    <>
      <div className="grp-head">Shared links</div>
      <div className="group">
        <button type="button" className="set-vrow" onClick={onOpen}>
          <span className="vlab">
            Links you shared
            <em>Public links and links for chosen people · at most {SHARE_MAX_LINKS} at a time</em>
          </span>
          <span className="vval">{count}</span>
          <ChevronRight size={13} className="vchev" />
        </button>
      </div>
    </>
  );
}

/**
 * The public links this Stem published (docs/public-share-design.md), as a
 * searchable list. A link opens its own page with Copy and Revoke, the way
 * Manage opens a connected folder. It replaces the Features tab until Back.
 */
export function SharedLinksPage({ onBack }: { onBack: () => void }) {
  const [links, setLinks] = useState<SharedLink[] | null>(null);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.stem.listShares().then(setLinks, (e) => {
      setLinks([]);
      setError(errorText(e));
    });
  }, []);

  const copy = (l: SharedLink) => void navigator.clipboard.writeText(l.url).then(() => setCopied(l.id));

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      setLinks(await window.stem.revokeShare(id));
      setOpenId(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const opened = openId ? links?.find((l) => l.id === openId) : undefined;
  if (opened) {
    const fromMail = opened.source?.kind === 'mail';
    return (
      <div className="ld-detail">
        <DetailHeader backLabel="Shared links" onBack={() => setOpenId(null)}>
          {busy ? (
            <span className="muted">Revoking…</span>
          ) : (
            <>
              <button
                type="button"
                className="icon-action sm"
                title={copied === opened.id ? 'Copied' : 'Copy link'}
                aria-label="Copy link"
                onClick={() => copy(opened)}
              >
                {copied === opened.id ? <Check size={14} /> : <Copy size={14} />}
              </button>
              <ConfirmDelete label="Revoke link" icon={<Link2Off size={14} />} onConfirm={() => void revoke(opened.id)} />
            </>
          )}
        </DetailHeader>
        <DetailIdent
          glyph={<Glyph icon={fromMail ? <Mail size={17} /> : <MessageSquare size={17} />} tone="accent" size="lg" />}
          name={<strong>{opened.title}</strong>}
          caption={opened.recipients?.length ? 'Only the people below can open it' : 'Public link'}
        />
        {error && <p className="task-failed">{error}</p>}
        <div className="group">
          <ValueRow label="Shows">
            <span className="vval">{SCOPE_LABEL[opened.scope] ?? 'Shared'}</span>
          </ValueRow>
          <ValueRow label="From">
            <span className="vval">{fromMail ? 'Mail' : 'Chat'}</span>
          </ValueRow>
          <ValueRow label="Shared">
            <span className="vval">{date(opened.createdAt)}</span>
          </ValueRow>
          <ValueRow label="Works until" hint="Then the link stops opening">
            <span className="vval">{date(opened.expiresAt)}</span>
          </ValueRow>
          <ValueRow
            label="Link"
            hint={opened.recipients?.length ? 'Opens only after a code mailed to a person below' : 'Anyone with this link can read it'}
            stacked
          >
            <input className="vfield" readOnly value={opened.url} aria-label="Link" onFocus={(e) => e.target.select()} />
          </ValueRow>
        </div>
        {opened.recipients?.length ? (
          <>
            <div className="grp-head">Who can open it</div>
            <div className="group">
              {opened.recipients.map((r) => {
                const o = opened.opens?.find((x) => x.address === r);
                return (
                  <ValueRow
                    key={r}
                    label={r}
                    hint={
                      o
                        ? `First opened ${dateTime(o.firstAt)}${o.count > 1 ? ` · ${o.count} times, last ${dateTime(o.lastAt)}` : ''}`
                        : 'Not opened yet'
                    }
                  >
                    {o && (
                      <span className="vval" title="Opened">
                        <Eye size={14} aria-label="Opened" />
                      </span>
                    )}
                  </ValueRow>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const shown = (links ?? [])
    .filter(
      (l) =>
        !q ||
        l.title.toLowerCase().includes(q) ||
        scopeLine(l).toLowerCase().includes(q) ||
        l.recipients?.some((r) => r.includes(q))
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const now = Date.now();

  return (
    <div className="ld-list">
      <DetailHeader backLabel="Features" onBack={onBack} />
      <ListSearch value={query} onChange={setQuery} placeholder="Find a link or a person" />
      {error && <p className="task-failed">{error}</p>}
      {shown.length > 0 && (
        <ListGroup label={`Shared links · at most ${SHARE_MAX_LINKS}`} count={shown.length}>
          {shown.map((l) => {
            const lock = lockLine(l);
            const soon = l.expiresAt - now < SOON_MS;
            return (
              <ListRow
                key={l.id}
                glyph={<Glyph icon={lock ? <Lock size={14} /> : <Link2 size={14} />} tone="accent" />}
                name={l.title}
                sub={lock ? `${lock} · until ${date(l.expiresAt)}` : `${scopeLine(l)} · until ${date(l.expiresAt)}`}
                right={
                  soon || l.opens?.length ? (
                    <>
                      {l.opens?.length ? (
                        <Flag icon={<Eye size={12} />} tone="ok" label={`Opened by ${l.opens.map((o) => o.address).join(', ')}`} />
                      ) : null}
                      {soon && <Flag icon={<Clock size={12} />} tone="warn" label={`Stops on ${date(l.expiresAt)}`} />}
                    </>
                  ) : undefined
                }
                onOpen={() => setOpenId(l.id)}
              />
            );
          })}
        </ListGroup>
      )}
      {links && shown.length === 0 && (
        <p className="muted ld-empty">{q ? 'No link matches.' : 'No shared links. Share an answer from its hover actions.'}</p>
      )}
    </div>
  );
}
