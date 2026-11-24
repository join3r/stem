import { forwardRef, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { SearchHarvestContext } from '../../../ui/searchHarvest';
import {
  collectEntries,
  searchTerms,
  snippet,
  type SettingsEntry,
  type SettingsHit,
  type SettingsSub
} from './searchIndex';

/**
 * The search field above the Settings sub-tabs. Esc clears the text, and a
 * second Esc takes the focus out of the field. Up, Down and Enter go through
 * the results.
 */
export const SettingsSearchField = forwardRef<
  HTMLInputElement,
  {
    query: string;
    onQuery: (q: string) => void;
    onKey: (e: KeyboardEvent<HTMLInputElement>) => void;
  }
>(function SettingsSearchField({ query, onQuery, onKey }, ref) {
  return (
    <div className="set-search">
      <Search size={13} className="set-search-icon" aria-hidden="true" />
      <input
        ref={ref}
        type="text"
        className="set-search-input"
        placeholder="Search settings"
        aria-label="Search settings"
        spellCheck={false}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Not also the app's Escape (stop a reply, close the panel).
            e.stopPropagation();
            e.preventDefault();
            if (query) onQuery('');
            else e.currentTarget.blur();
            return;
          }
          onKey(e);
        }}
      />
      {query && (
        <button type="button" className="set-search-clear" aria-label="Clear search" title="Clear search" onClick={() => onQuery('')}>
          <X size={12} />
        </button>
      )}
    </div>
  );
});

/**
 * A hidden copy of all four sub-tabs with every group open, read into the
 * index again each time its DOM changes (the rows load on their own, a moment
 * after the mount). Mounted only while there is text to search for.
 */
export function SettingsHarvest({
  subs,
  renderSub,
  onEntries
}: {
  subs: SettingsSub[];
  renderSub: (sub: SettingsSub) => ReactNode;
  onEntries: (entries: SettingsEntry[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onEntriesRef = useRef(onEntries);
  onEntriesRef.current = onEntries;

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const entries: SettingsEntry[] = [];
      for (const sub of subs) {
        const el = root.querySelector(`:scope > [data-sub="${sub}"]`);
        if (el) entries.push(...collectEntries(el, sub));
      }
      onEntriesRef.current(entries);
    };
    read();
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(read, 60);
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [subs]);

  return (
    <SearchHarvestContext.Provider value={true}>
      <div ref={ref} hidden aria-hidden="true" className="set-search-harvest">
        {subs.map((sub) => (
          <div key={sub} data-sub={sub}>
            {renderSub(sub)}
          </div>
        ))}
      </div>
    </SearchHarvestContext.Provider>
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `text` with each term marked. */
function Marked({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi');
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p))}
    </>
  );
}

/** The results, in place of the sub-tab while there is text in the field. */
export function SettingsSearchResults({
  query,
  hits,
  active,
  loading,
  subLabel,
  onPick,
  onHover
}: {
  query: string;
  hits: SettingsHit[];
  active: number;
  /** The hidden copy is still loading: an empty list is not an answer yet. */
  loading: boolean;
  subLabel: (sub: SettingsSub) => string;
  onPick: (entry: SettingsEntry) => void;
  onHover: (index: number) => void;
}) {
  const terms = searchTerms(query);
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!hits.length) {
    return <p className="muted set-search-empty">{loading ? 'Searching…' : `No settings match “${query.trim()}”.`}</p>;
  }

  const firstInfo = hits.findIndex((h) => h.tier === 2);
  const row = (hit: SettingsHit, i: number) => {
    const { entry } = hit;
    const place = [subLabel(entry.sub), entry.group, ...entry.chain].filter(Boolean).join(' › ');
    const second = hit.tier === 2 ? snippet(entry.info, terms) : entry.hint;
    return (
      <button
        key={entry.key}
        ref={i === active ? activeRef : undefined}
        type="button"
        className={`set-search-hit${i === active ? ' active' : ''}`}
        onClick={() => onPick(entry)}
        onMouseMove={() => i !== active && onHover(i)}
      >
        <span className="hit-label">
          <Marked text={entry.label} terms={terms} />
        </span>
        <span className="hit-place">{place}</span>
        {second && (
          <span className="hit-second">
            <Marked text={second} terms={terms} />
          </span>
        )}
      </button>
    );
  };

  const main = firstInfo < 0 ? hits : hits.slice(0, firstInfo);
  const info = firstInfo < 0 ? [] : hits.slice(firstInfo);
  return (
    <div className="set-search-results">
      {main.length > 0 && <div className="group">{main.map((h, i) => row(h, i))}</div>}
      {info.length > 0 && (
        <>
          <div className="grp-head">In explanations</div>
          <div className="group">{info.map((h, i) => row(h, i + main.length))}</div>
        </>
      )}
    </div>
  );
}
