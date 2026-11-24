import { useEffect, useState, type ReactNode } from 'react';
import { Bot, ChevronRight, FileText, Globe, GraduationCap, ImageIcon, Pencil, Search, Shrink, Terminal, Wrench } from 'lucide-react';
import type { ActivityItem, SourceRef } from '../../shared/types';
import { activityLabel, settledActivityLabel } from '../../shared/activity';

// Per-turn tool activity, rendered above the assistant reply. While the turn runs
// every tool call is a live row in a small card (the running one spins and counts
// up); once the turn settles the card folds into one summary line, expandable on
// click. A turn with a single tool call names it in that line instead of the
// count, since "Used 1 tool" says less than the row it hides.

type IconKind = 'skill' | 'web' | 'edit' | 'compact' | 'agent' | 'image' | 'read' | 'search' | 'command' | 'tool';

function iconKind(item: ActivityItem): IconKind {
  const n = (item.name ?? '').toLowerCase();
  if (item.kind === 'skill') return 'skill';
  if (item.type === 'webSearch') return 'web';
  if (item.type === 'fileChange') return 'edit';
  if (item.type === 'compaction') return 'compact';
  if (item.type === 'codingAgent') return 'agent';
  if (item.type === 'imageGeneration') return 'image';
  if (n === 'read') return 'read';
  if (n === 'grep' || n === 'glob' || n === 'ls') return 'search';
  if (item.type === 'commandExecution') return 'command';
  return 'tool';
}

function KindIcon({ kind, size = 12 }: { kind: IconKind; size?: number }) {
  // The same cap the skills migration dialog uses, so the two surfaces that talk
  // about skills look like they are talking about the same thing.
  if (kind === 'skill') return <GraduationCap size={size} />;
  if (kind === 'web') return <Globe size={size} />;
  if (kind === 'edit') return <Pencil size={size} />;
  if (kind === 'compact') return <Shrink size={size} />;
  if (kind === 'agent') return <Bot size={size} />;
  if (kind === 'image') return <ImageIcon size={size} />;
  if (kind === 'read') return <FileText size={size} />;
  if (kind === 'search') return <Search size={size} />;
  if (kind === 'command') return <Terminal size={size} />;
  return <Wrench size={size} />;
}

// Targets that are code-shaped (a command, a path, a pattern) read best in mono;
// a search query or an MCP argument stays in the body face.
const MONO_KINDS = new Set<IconKind>(['command', 'read', 'edit', 'search']);

/**
 * The label with its target picked out, so the verb stays quiet and the thing
 * it acted on carries the weight. Falls back to the plain label when the
 * phrasing does not contain the detail verbatim.
 */
function Label({ text, item }: { text: string; item: ActivityItem }) {
  const detail = item.detail?.trim();
  const at = detail ? text.indexOf(detail) : -1;
  if (!detail || at === -1) return <>{text}</>;
  const mono = MONO_KINDS.has(iconKind(item));
  return (
    <>
      {text.slice(0, at)}
      <span className={`activity-target${mono ? ' mono' : ''}`}>{detail}</span>
      {text.slice(at + detail.length)}
    </>
  );
}

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 90) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** A live row's counter: whole seconds, so it ticks calmly rather than flickers. */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// When each running row was first seen. Only generate_image calls carry a
// server-side start time; for the rest the first render is close enough, and
// keeping it here leaves the shared reducer pure.
const firstSeen = new Map<string, number>();
function startOf(item: ActivityItem): number {
  if (item.startedAt !== undefined) return item.startedAt;
  let at = firstSeen.get(item.id);
  if (at === undefined) {
    at = Date.now();
    firstSeen.set(item.id, at);
  }
  return at;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function Row({ item, live, now }: { item: ActivityItem; live: boolean; now: number }) {
  const label = live
    ? activityLabel(item.type, item.name, item.detail).replace(/…$/, '')
    : settledActivityLabel(item.type, item.name, item.detail);
  const failed = item.status === 'error';
  const elapsed = live ? now - startOf(item) : undefined;
  let time: ReactNode = null;
  if (failed) time = <span className="activity-row-tag">failed</span>;
  else if (elapsed !== undefined && elapsed >= 1000) time = formatElapsed(elapsed);
  // Only the slow ones once settled: a turn that felt slow should say where it
  // went, without turning every file read into a stopwatch.
  else if (!live && item.ms !== undefined && item.ms >= 2000) time = formatDuration(item.ms);
  return (
    <div className={`activity-row-item${failed ? ' error' : ''}${live ? ' live' : ''}`}>
      <span className="activity-glyph" aria-hidden="true">
        <KindIcon kind={iconKind(item)} />
      </span>
      <span className="activity-row-label" title={label}>
        <Label text={label} item={item} />
      </span>
      {item.freshSession && <span className="activity-row-note">new session</span>}
      {time && <span className="activity-row-ms">{time}</span>}
    </div>
  );
}

export function ActivityRows({ items, running }: { items: ActivityItem[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const anyLive = running && items.some((i) => i.status === 'running');
  const now = useNow(anyLive);
  if (!items.length) return null;
  const expanded = running || open;
  const rows = (
    <div className="activity-card">
      {items.map((item) => (
        <Row key={item.id} item={item} live={running && item.status === 'running'} now={now} />
      ))}
    </div>
  );
  if (running) return <div className="activity-rows open">{rows}</div>;

  // Skills are counted apart from tools. Folding them into "Used 3 tools" would
  // be a lie about a row that is right there saying otherwise, and a turn whose
  // only row is a skill would read "Used 1 tool" with no tool in sight.
  const tools = items.filter((i) => i.kind !== 'skill').length;
  const skills = items.length - tools;
  const counts: string[] = [];
  if (tools) counts.push(`${tools} ${tools === 1 ? 'tool' : 'tools'}`);
  if (skills) counts.push(`${skills} ${skills === 1 ? 'skill' : 'skills'}`);
  const single = items.length === 1 ? items[0] : null;
  const failures = items.filter((i) => i.status === 'error').length;
  const totalMs = items.reduce((sum, i) => sum + (i.ms ?? 0), 0);
  // Distinct kinds, in order of first use: the turn's shape at a glance.
  const kinds = [...new Set(items.map(iconKind))].slice(0, 4);
  const singleLabel = single ? settledActivityLabel(single.type, single.name, single.detail) : '';
  return (
    <div className={`activity-rows${expanded ? ' open' : ''}`}>
      <button
        type="button"
        className="activity-rows-summary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={single ? singleLabel : undefined}
      >
        <ChevronRight size={12} className="activity-rows-chevron" />
        <span className="activity-stack" aria-hidden="true">
          {kinds.map((k) => (
            <span key={k} className="activity-glyph">
              <KindIcon kind={k} size={11} />
            </span>
          ))}
        </span>
        <span className="activity-summary-text">
          {single ? <Label text={singleLabel} item={single} /> : `Used ${counts.join(' and ')}`}
        </span>
        {failures > 0 && (
          <span className="activity-row-tag">{single ? 'failed' : `${failures} failed`}</span>
        )}
        {totalMs >= 1000 && <span className="activity-row-ms">{formatDuration(totalMs)}</span>}
      </button>
      {open && rows}
    </div>
  );
}

/** Only ever link out to http(s) — citations come from a teed provider stream. */
function safeSourceUrl(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

// One fetch per site per app run, shared by every Sources panel that cites it.
const faviconCache = new Map<string, Promise<string | null>>();
function favicon(host: string): Promise<string | null> {
  let hit = faviconCache.get(host);
  if (!hit) {
    // quiet: no icon is the letter tile, which is what the card shows meanwhile.
    hit = window.stem.sourceFavicon(host).catch(() => null);
    faviconCache.set(host, hit);
  }
  return hit;
}

/** "www.nytimes.com" → "nytimes.com": the name people know the site by. */
function siteName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** A site's icon: `icon` when the caller has it (a share page's snapshot), else fetched from Stem. */
function SourceIcon({ url, icon }: { url: string; icon?: string }) {
  const host = siteName(url);
  const [src, setSrc] = useState<string | null>(icon ?? null);
  useEffect(() => {
    if (icon) {
      setSrc(icon);
      return;
    }
    // A share page has no Stem to ask: the letter tile stands in.
    if (!window.stem?.sourceFavicon) return;
    let live = true;
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      return;
    }
    void favicon(hostname).then((got) => {
      if (live) setSrc(got);
    });
    return () => {
      live = false;
    };
  }, [url, icon]);
  return src ? (
    <img className="source-icon" src={src} alt="" />
  ) : (
    <span className="source-icon source-icon-letter" aria-hidden="true">
      {host.charAt(0).toUpperCase()}
    </span>
  );
}

export function SourcesList({ sources }: { sources: (SourceRef & { icon?: string })[] }) {
  const [open, setOpen] = useState(false);
  const safe = sources.filter((s) => safeSourceUrl(s.url));
  if (!safe.length) return null;
  return (
    <div className={`sources${open ? ' open' : ''}`}>
      <button
        type="button"
        className="activity-rows-summary sources-summary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight size={12} className="activity-rows-chevron" />
        {/* The first few sites at a glance, before the list is opened. */}
        <span className="sources-stack" aria-hidden="true">
          {safe.slice(0, 4).map((s) => (
            <SourceIcon key={s.url} url={s.url} icon={s.icon} />
          ))}
        </span>
        Sources ({safe.length})
      </button>
      {open && (
        <ul className="sources-cards">
          {safe.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noreferrer" title={s.url} className="source-card">
                <span className="source-site">
                  <SourceIcon url={s.url} icon={s.icon} />
                  {siteName(s.url)}
                </span>
                <span className="source-title">{s.title?.trim() || s.url}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
