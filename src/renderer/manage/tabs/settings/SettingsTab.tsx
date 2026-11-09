import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useRetrievalHealth } from '../../../hooks/useRetrievalHealth';
import { useRememberedTab } from '../../../hooks/useRememberedTab';
import { AppSettings } from './AppSettings';
import { FeaturesSettings } from './FeaturesSettings';
import { ServerSettings } from './ServerSettings';
import { ModelsSettings } from './ModelsSettings';
import type { ModelTabProps } from '../shared';
import { useManageIntent } from '../../intents';
import { SettingsHarvest, SettingsSearchField, SettingsSearchResults } from './SettingsSearch';
import { matchEntries, revealEntry, type SettingsEntry } from './searchIndex';

/**
 * Settings, as four sub-tabs rather than one very long scroll.
 *
 * Ordered by how often you would want to change something: App is using Stem
 * day to day (the conversation, its look, keys, notifications), Features is
 * what it may do beyond answering (mail, commands, coding agents, computer
 * control), Server and Models are setup you do once and then forget. Only one sub-tab is mounted at a time, so
 * each loads the slice of settings it actually shows — cheap, and it means a
 * change made in another window is picked up simply by coming back.
 */
type Sub = SettingsEntry['sub'];

const SUBS: { id: Sub; label: string }[] = [
  { id: 'app', label: 'App' },
  { id: 'features', label: 'Features' },
  { id: 'server', label: 'Server' },
  { id: 'models', label: 'Models' }
];

const SUB_IDS = SUBS.map((s) => s.id);
const subLabel = (sub: Sub) => SUBS.find((s) => s.id === sub)?.label ?? sub;

export function SettingsTab({
  models,
  modelId,
  onSelectModel,
  deadProvider,
  recallFocus
}: ModelTabProps & {
  deadProvider?: string | null;
  /** Bumped by the Memory tab's Review setup: land on Models with Memory recall open. */
  recallFocus?: number;
}) {
  // A new key since the Chat/App → App/Features rename (2026-09-27): under the
  // old one a remembered 'app' would now open Features.
  const [sub, setSub] = useRememberedTab<Sub>('stem.settings.tab', SUB_IDS, 'app');

  // A provider whose credential died is the one reason Settings gets opened
  // without being asked for — the rail grows a red dot and you click it. Landing
  // on the remembered sub-tab would hide the thing the dot is about, so a dead
  // sign-in pulls the panel to Models. Once, on the transition: reselecting
  // it every render would make the other sub-tabs unreachable until it's fixed.
  // An explicit jump (Quick Chat's browser-control Set up) is not undone by a
  // dead sign-in reported a moment after the panel opened.
  const askedAt = useRef(0);
  useEffect(() => {
    if (deadProvider && Date.now() - askedAt.current > 3_000) setSub('models');
  }, [deadProvider, setSub]);

  useEffect(() => {
    if (recallFocus) setSub('models');
  }, [recallFocus, setSub]);

  // Quick Chat's "Set up browser control" lands in Features. After the two
  // above: on a fresh mount theirs run too, and an explicit ask wins.
  useManageIntent(
    'browser-control',
    () => {
      askedAt.current = Date.now();
      setSub('features');
    },
    false
  );

  // Search. The field gets the focus when Settings is opened on purpose (the
  // shortcut, the menu, the rail button), not when the panel comes back open
  // at launch. The results stand in for the sub-tab while there is text; the
  // sub-tab stays mounted under them, so a draft in it is not lost.
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<SettingsEntry[]>([]);
  const [harvestReady, setHarvestReady] = useState(false);
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const subRoot = useRef<HTMLDivElement>(null);
  const stopReveal = useRef<(() => void) | null>(null);
  const searching = query.trim() !== '';

  useManageIntent('settings-search', () => {
    searchRef.current?.focus();
    searchRef.current?.select();
  });

  // An empty list in the first moment means "still loading", not "no match".
  useEffect(() => {
    if (!searching) {
      setEntries([]);
      setHarvestReady(false);
      return;
    }
    const t = setTimeout(() => setHarvestReady(true), 800);
    return () => clearTimeout(t);
  }, [searching]);

  const hits = useMemo(() => matchEntries(entries, query, subLabel), [entries, query]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => () => stopReveal.current?.(), []);

  const pick = useCallback(
    (entry: SettingsEntry) => {
      setQuery('');
      setSub(entry.sub);
      stopReveal.current?.();
      // Only the sub-tab the row is in: the old one is still in the DOM for a frame.
      stopReveal.current = revealEntry(
        () => (subRoot.current?.dataset.sub === entry.sub ? subRoot.current : null),
        entry
      );
    },
    [setSub]
  );

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!hits.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(hits[Math.min(active, hits.length - 1)].entry);
    }
  };

  // `live` is false for the hidden copy the search reads: no jump to a dead
  // sign-in or to the recall models there.
  const renderSub = (id: Sub, live = true) => {
    if (id === 'app') return <AppSettings models={models} />;
    if (id === 'features') return <FeaturesSettings />;
    if (id === 'server') return <ServerSettings />;
    return (
      <ModelsSettings
        models={models}
        modelId={modelId}
        onSelectModel={onSelectModel}
        deadProvider={live ? deadProvider : null}
        recallFocus={live ? recallFocus : undefined}
      />
    );
  };

  // The recall models live under Models now, so a failed one marks that segment
  // the way a dead sign-in does (the Memory rail keeps its own dot and banner).
  const retrievalBroken = useRetrievalHealth().broken;

  return (
    <div>
      <SettingsSearchField ref={searchRef} query={query} onQuery={setQuery} onKey={onSearchKey} />
      <div className="seg-ctl">
        {SUBS.map(({ id, label }) => (
          <button
            key={id}
            className={sub === id && !searching ? 'active' : ''}
            onClick={() => {
              setQuery('');
              setSub(id);
            }}
          >
            {label}
            {id === 'models' && (deadProvider || retrievalBroken) && <span className="seg-alert-dot" />}
          </button>
        ))}
      </div>
      {searching && (
        <>
          <SettingsSearchResults
            query={query}
            hits={hits}
            active={active}
            loading={!harvestReady}
            subLabel={subLabel}
            onPick={pick}
            onHover={setActive}
          />
          <SettingsHarvest subs={SUB_IDS} renderSub={(id) => renderSub(id, false)} onEntries={setEntries} />
        </>
      )}
      <div ref={subRoot} data-sub={sub} hidden={searching}>
        {renderSub(sub)}
      </div>
    </div>
  );
}
