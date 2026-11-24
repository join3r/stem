import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Trash2, Eye, RefreshCw, Pin, RotateCcw, ShieldCheck, Lock, Send, Check, TriangleAlert, Image, Pause, Play, Search, ArrowUpRight } from 'lucide-react';
import type {
  ActivityEntry,
  ActivitySnapshot,
  MemoryContents,
  MemorySettings,
  ActiveFacts,
  FactTier,
  FactDetails,
  FactStatus,
  MemoryConflict,
  AutoResolvedConflict,
  MemoryRebuildStatus
} from '../../../shared/types';
import { MdxView } from '../../chat/MdxView';
import { useOffline } from '../../hooks/useServerReachable';
import { useRetrievalHealth } from '../../hooks/useRetrievalHealth';
import { HoverTip, InfoTip } from '../../ui/InfoTip';
import { createJobStore, holdFullSpin, useJob, type ActiveFactsViewProps } from './shared';
import { DeepCheckCard } from './DeepCheck';
import { UserSummaryCard } from './UserSummary';
import { plainLine } from '../../../shared/plain-text';

// Memory → Facts. Ordered by what asks something of the user: the switch and a
// one-line status, the summary of the user, the deep check (the one memory job worth starting by hand),
// conflicts waiting on an answer, then the facts themselves. Everything that
// runs by itself — tidy-up, provenance rebuild, what was replaced or settled
// automatically — folds into History and Housekeeping at the bottom. Which
// models memory runs on lives in Settings → Models.

// Module-level so a running consolidation survives the tab unmounting: leave for
// another tab mid-run and come back, and the button is still spinning — and the
// outcome message still lands — instead of the pass silently vanishing.
const consolidateJob = createJobStore();

// Auto tidy-up cadence, expressed as the new-fact count that triggers a pass
// (0 = manual only). Mirrors CONSOLIDATE defaults in the recall store.
const TIDY_PRESETS: { label: string; value: number; hint: string }[] = [
  { label: 'Frequent', value: 3, hint: 'after 3 new facts' },
  { label: 'Normal', value: 5, hint: 'after 5 new facts' },
  { label: 'Occasional', value: 10, hint: 'after 10 new facts' },
  { label: 'Manual', value: 0, hint: 'never automatically' }
];


/** Human label for a fact-selection tier, shown in the active-facts summary. */
function tierLabel(t: FactTier): string {
  switch (t) {
    case 'reranked':
      return 'rerank-gated';
    case 'hybrid':
      return 'semantic + lexical';
    case 'pinned-only':
      return 'pinned only';
    case 'none':
      return 'no match';
    case 'all':
      return 'all (under threshold)';
    case 'embedding':
      return 'embedding + rerank';
    case 'lexical':
      return 'lexical (BM25)';
    case 'recency':
      return 'recency';
  }
}

/**
 * The chip a non-active fact wears. 'conflicted' is the store's status name;
 * "conflicting" is the one word the user sees for it everywhere — this chip and
 * the docs.
 */
const FACT_STATUS_LABEL: Record<FactStatus, string> = {
  active: 'active',
  conflicted: 'conflicting',
  superseded: 'superseded'
};

/**
 * Evidence-origin wording for the expanded provenance rows. The store names are
 * fine for most origins, but 'assistant_claim_web' has to SAY what it means —
 * it marks evidence that may restate untrusted web content, which is exactly
 * what the user needs to see before confirming such a fact.
 */
const EVIDENCE_ORIGIN_LABEL: Record<string, string> = {
  explicit_user: 'you asked to remember',
  user_message: 'your message',
  assistant_claim: 'assistant claim',
  assistant_claim_web: 'assistant claim (turn used the web — unverified)',
  segment_context: 'surrounding conversation',
  legacy: 'legacy'
};

/**
 * [newer, older] — the same ordering `resolveMemoryConflict` applies in the store,
 * id as the tiebreak. "Keep newer" is unusable unless the card shows which is which.
 */
const AUTO_RESOLUTION_LABEL: Record<AutoResolvedConflict['resolution'], string> = {
  auto_supersede: 'One side superseded automatically',
  auto_keep_both: 'Both kept automatically',
  auto_rewrite: 'Rewritten into clearer facts automatically'
};

function orderedConflictFacts(c: MemoryConflict): [FactDetails, FactDetails] {
  const aIsNewer =
    c.factA.updatedAt > c.factB.updatedAt ||
    (c.factA.updatedAt === c.factB.updatedAt && c.factA.id > c.factB.id);
  return aIsNewer ? [c.factA, c.factB] : [c.factB, c.factA];
}

type FactFilter = 'all' | 'chat' | 'pinned' | 'unconfirmed';

const FACT_FILTERS: { id: FactFilter; label: string; title: string }[] = [
  { id: 'all', label: 'All', title: 'Every active fact' },
  { id: 'chat', label: 'This chat', title: "Facts this chat's last message used, or your draft would use" },
  { id: 'pinned', label: 'Pinned', title: 'Facts sent with every message' },
  { id: 'unconfirmed', label: 'Unconfirmed', title: 'Facts Stem is unsure of — confirm or forget them' }
];

/** Facts drawn at a time; the store can hold a thousand, and the list is open by default. */
const PAGE = 50;

/** "3 h ago" style, for the last tidy-up. */
function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** The newest tidy-up pass the activity log knows of (running first). */
function latestTidy(snapshot: ActivitySnapshot): ActivityEntry | null {
  return (
    snapshot.running.find((e) => e.kind === 'memory.consolidate') ??
    snapshot.history.find((e) => e.kind === 'memory.consolidate') ??
    null
  );
}

export function FactsTab({
  activeFacts,
  onOpenMail,
  onReviewRecall
}: {
  activeFacts: ActiveFactsViewProps;
  onOpenMail?: (conversationId: string) => void;
  /** Open Settings → Models at the Memory recall group. */
  onReviewRecall: () => void;
}) {
  const { activeThreadId, activeRunning, previewActive, previewDraft, onTogglePreview } = activeFacts;
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [contents, setContents] = useState<MemoryContents | null>(null);
  const offline = useOffline();
  const health = useRetrievalHealth();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FactFilter>('all');
  const [limit, setLimit] = useState(PAGE);
  const [showHistory, setShowHistory] = useState(false);
  const [historyView, setHistoryView] = useState<'replaced' | 'auto'>('replaced');
  const [showHousekeeping, setShowHousekeeping] = useState(false);
  const [showTech, setShowTech] = useState(false);
  const [lastTidy, setLastTidy] = useState<ActivityEntry | null>(null);
  // Durable facts injected on this chat's last turn, and (when toggled) the set the
  // current draft would inject. Both annotate + sort the facts list below.
  const [lastTurn, setLastTurn] = useState<ActiveFacts | null>(null);
  const [preview, setPreview] = useState<ActiveFacts | null>(null);
  const housekeepingRef = useRef<HTMLDivElement>(null);

  // Refetch the last injected set when the chat changes or finishes a turn (the row
  // is written at turn start, so a running-flag flip means a fresh set is available).
  useEffect(() => {
    let cancelled = false;
    window.stem.getActiveFacts(activeThreadId).then((r) => {
      if (!cancelled) setLastTurn(r);
    });
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, activeRunning]);

  // Debounced draft preview — only runs the (embedding/rerank) selection while the
  // toggle is on; clears immediately when off so stale draft badges don't linger.
  useEffect(() => {
    if (!previewActive) {
      setPreview(null);
      return;
    }
    const text = previewDraft;
    const t = setTimeout(() => {
      window.stem.previewFacts(text).then(setPreview);
    }, 400);
    return () => clearTimeout(t);
  }, [previewActive, previewDraft]);
  const { running: consolidating, msg: consolidateMsg } = useJob(consolidateJob);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [rebuild, setRebuild] = useState<MemoryRebuildStatus | null>(null);
  const [conflicts, setConflicts] = useState<MemoryConflict[]>([]);
  const [autoResolved, setAutoResolved] = useState<AutoResolvedConflict[]>([]);
  const [details, setDetails] = useState<Record<number, FactDetails | null>>({});
  const sensitivePinAcknowledged = useRef(false);

  const [refreshing, setRefreshing] = useState(false);

  function loadContents() {
    window.stem.readMemory().then(setContents);
  }

  async function refreshContents() {
    setRefreshing(true);
    try {
      setContents(await holdFullSpin(window.stem.readMemory()));
    } finally {
      setRefreshing(false);
    }
  }
  function loadTrustState() {
    window.stem.getMemoryRebuildStatus().then(setRebuild);
    window.stem.getMemoryConflicts().then(setConflicts);
    window.stem.getAutoResolvedConflicts().then(setAutoResolved);
  }

  useEffect(() => {
    window.stem.getMemorySettings().then(setSettings);
    loadTrustState();
  }, []);

  // The contents load rides the consolidation flag rather than mount alone: a
  // pass that ends while this tab is away has no component to hand its result
  // to, so re-read when the flag drops. (Runs on mount too, whatever the flag
  // says — that is the initial load.)
  useEffect(() => {
    loadContents();
  }, [consolidating]);

  // When the background tidy-up last ran, for the Housekeeping line. The
  // activity log is the one place that already knows, and it pushes changes.
  useEffect(() => {
    void window.stem.getActivity().then((s) => setLastTidy(latestTidy(s)));
    return window.stem.onActivity((s) => setLastTidy(latestTidy(s)));
  }, []);

  // Main pushes a status after every rebuild step, so the panel follows along
  // without a poll — and without a manual Refresh action to compensate for one.
  useEffect(() => {
    return window.stem.onMemoryRebuildStatus((next) => {
      setRebuild(next);
      if (next.state === 'complete') {
        loadContents();
        window.stem.getMemoryConflicts().then(setConflicts);
      }
    });
  }, []);

  // A new search or filter starts at the top of the list again.
  useEffect(() => {
    setLimit(PAGE);
  }, [query, filter]);

  function selectTidyThreshold(n: number) {
    window.stem.setTidyThreshold(n).then(setSettings);
  }

  async function toggle() {
    if (!settings) return;
    setSettings(await window.stem.setMemoryEnabled(!settings.enabled));
  }

  async function forget(id: number) {
    setContents(await window.stem.forgetMemory(id));
    loadTrustState();
  }

  async function pinFact(id: number, pinned: boolean, sensitivity?: string) {
    if (pinned && sensitivity === 'sensitive' && !sensitivePinAcknowledged.current) {
      const accepted = window.confirm(
        'Pinned memories are sent with every message. Pin this sensitive memory anyway?'
      );
      if (!accepted) return;
      sensitivePinAcknowledged.current = true;
    }
    setContents(await window.stem.setFactPinned(id, pinned));
  }

  async function confirmFact(id: number) {
    setContents(await window.stem.confirmFact(id));
  }

  async function restoreFact(id: number) {
    setContents(await window.stem.restoreSupersededFact(id));
  }

  async function resolveConflict(id: number, resolution: 'keep_newer' | 'keep_older' | 'keep_both') {
    setContents(await window.stem.resolveMemoryConflict(id, resolution));
    loadTrustState();
  }

  async function toggleDetails(id: number) {
    if (Object.prototype.hasOwnProperty.call(details, id)) return;
    const value = await window.stem.getFactDetails(id);
    setDetails((d) => ({ ...d, [id]: value }));
  }

  async function reset() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setResetting(true);
    consolidateJob.setMsg(null);
    try {
      setContents(await window.stem.resetFactsMemory());
      consolidateJob.setMsg('Facts cleared.');
    } catch {
      consolidateJob.setMsg('Reset failed — try again.');
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  }

  function consolidate() {
    consolidateJob.start(async () => {
      try {
        const r = await holdFullSpin(window.stem.consolidateMemory());
        const changed = r.merged + r.corrected + r.dropped;
        const outcome =
          changed === 0
            ? 'No duplicates or stale facts found'
            : `Merged ${r.merged}, corrected ${r.corrected}, retired ${r.dropped} — retired facts move to History`;
        return r.failedChunks > 0
          ? `${outcome}. The memory model failed on ${r.failedChunks} ${r.failedChunks === 1 ? 'batch' : 'batches'} of facts — those weren't reviewed; try again.`
          : `${outcome}.`;
      } catch {
        return 'Tidy-up failed — try again.';
      }
    });
  }

  // Everything on this tab is read from the server. When it cannot be reached
  // the calls above never resolve, and an eternal "Loading…" is a worse lie than
  // an empty list — it says "any second now" about something that is not coming.
  if (!settings) {
    return (
      <p className="muted">
        {offline ? 'Your memory lives on Stem’s server, which can’t be reached right now.' : 'Loading…'}
      </p>
    );
  }

  const allNotes = contents?.files.filter((f) => f.kind === 'note' && f.content.trim()) ?? [];
  // Superseded facts are history, not memory: they never inject, so they don't
  // belong in the live list or its count. They live under History.
  const notes = allNotes.filter((f) => f.status !== 'superseded');
  const supersededNotes = allNotes.filter((f) => f.status === 'superseded');
  const techFiles = contents?.files.filter((f) => f.kind === 'native' && f.exists && f.content.trim()) ?? [];

  // Which facts are "active": injected last turn, and (when preview is on) the set the
  // current draft would inject. Sort active facts to the top — draft above last-turn —
  // preserving recency order within each group, and badge each row accordingly.
  const lastIds = new Set((lastTurn?.facts ?? []).map((f) => f.id));
  const draftIds = previewActive ? new Set((preview?.facts ?? []).map((f) => f.id)) : null;
  const groupOf = (id?: number): number => {
    if (id == null) return 2;
    if (draftIds?.has(id)) return 0;
    if (lastIds.has(id)) return 1;
    return 2;
  };
  // Same rule the Confirm button uses: a guess Stem holds loosely, not something you asked it to keep.
  const unconfirmed = (f: (typeof allNotes)[number]) => f.source !== 'On request' && (f.confidence ?? 1) < 0.7;
  const needle = query.trim().toLowerCase();
  const visibleNotes = notes
    .filter((f) => {
      if (filter === 'chat' && groupOf(f.id) === 2) return false;
      if (filter === 'pinned' && !f.pinned) return false;
      if (filter === 'unconfirmed' && !unconfirmed(f)) return false;
      if (!needle) return true;
      return [f.statement ?? f.content, f.category, f.source].some((t) => t?.toLowerCase().includes(needle));
    })
    .map((f, i) => ({ f, i, g: groupOf(f.id) }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((x) => x.f);

  const dayStart = new Date().setHours(0, 0, 0, 0) / 1000;
  const learnedToday = notes.filter((f) => (f.createdAt ?? 0) >= dayStart).length;
  const status = !settings.enabled
    ? 'Off — nothing new is learned or recalled'
    : [
        contents ? `${notes.length.toLocaleString()} ${notes.length === 1 ? 'fact' : 'facts'}` : null,
        learnedToday ? `${learnedToday} learned today` : null,
        settings.tidyThreshold === 0 ? 'tidy-up is manual' : 'kept tidy automatically'
      ]
        .filter(Boolean)
        .join(' · ');

  const tidyLine = consolidating
    ? 'tidying now…'
    : lastTidy
      ? `last tidy-up ${ago(lastTidy.startedAt)}`
      : null;
  const rebuildBusy = rebuild && (rebuild.state === 'running' || rebuild.state === 'paused' || rebuild.state === 'failed');
  const housekeepingLine = rebuildBusy
    ? `adding sources · ${rebuild.processedMessages} of ${rebuild.totalMessages}${rebuild.state === 'running' ? '' : ` · ${rebuild.state}`}`
    : tidyLine;
  const tidyPreset = TIDY_PRESETS.find((p) => p.value === settings.tidyThreshold);

  function renderNote(f: (typeof allNotes)[number]) {
    const active = f.id != null && draftIds?.has(f.id) ? 'draft' : f.id != null && lastIds.has(f.id) ? 'injected' : null;
    return (
              <div key={f.name} className={`memory-note${active ? ' active' : ''}`}>
                <div className="memory-note-body">
                  {f.statement ? (
                    <button className="memory-statement" onClick={() => f.id != null && void toggleDetails(f.id)}>
                      {plainLine(f.statement)}
                    </button>
                  ) : <MdxView text={f.content} />}
                  {active && <span className={`chip active-${active}`}>{active}</span>}
                  {f.source && <span className="chip">{f.source}</span>}
                  {f.category && <span className="chip">{f.category}</span>}
                  {f.sensitivity === 'sensitive' && (
                    <HoverTip
                      className="chip sensitive"
                      ariaLabel="Sensitive"
                      tip="Sensitive — recalled only on a direct keyword match or a much stronger semantic match."
                    >
                      <Lock size={10} />
                    </HoverTip>
                  )}
                  {f.status && f.status !== 'active' && <span className="chip">{FACT_STATUS_LABEL[f.status]}</span>}
                  {f.pinned && <span className="chip"><Pin size={10} /> pinned</span>}
                  {(f.imageCount ?? 0) > 0 && (
                    <HoverTip
                      className="chip"
                      ariaLabel={`${f.imageCount} image${f.imageCount === 1 ? '' : 's'} saved with this note`}
                      tip="Saved with an image — click the fact to see it."
                    >
                      <Image size={10} /> {f.imageCount === 1 ? 'image' : `${f.imageCount} images`}
                    </HoverTip>
                  )}
                  {(f.timesInjected ?? 0) > 0 && (
                    <HoverTip
                      className="chip"
                      ariaLabel={`Injected ${f.timesInjected} times, used ${f.timesUsed ?? 0} times`}
                      tip={`Injected ${f.timesInjected}× — sent along with a message. Used ${f.timesUsed ?? 0}× — the reply visibly drew on it.`}
                    >
                      <Send size={10} /> {f.timesInjected}× · <Check size={10} /> {f.timesUsed ?? 0}×
                    </HoverTip>
                  )}
                  {f.id != null && details[f.id] && (
                    <div className="memory-evidence">
                      <span>Confidence {Math.round(details[f.id]!.confidence * 100)}%</span>
                      {details[f.id]!.validUntil && <span>Valid until {new Date(details[f.id]!.validUntil! * 1000).toLocaleDateString()}</span>}
                      {details[f.id]!.evidence.map((e) => (
                        <blockquote key={e.id}>
                          {new Date(e.timestamp * 1000).toLocaleDateString()} ·{' '}
                          {e.origin === 'folder_doc' ? `file ${e.relPath ?? '(unknown)'}` : EVIDENCE_ORIGIN_LABEL[e.origin] ?? e.origin}: {plainLine(e.excerpt)}
                        </blockquote>
                      ))}
                      {details[f.id]!.images.length > 0 && (
                        <div className="memory-images">
                          {details[f.id]!.images.map((img) => (
                            <figure key={img.id} className="memory-image">
                              <img src={img.dataUrl} alt={img.name} loading="lazy" />
                              <figcaption>{img.name}</figcaption>
                            </figure>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {f.id != null && (
                  <div className="memory-note-actions">
                    {f.status === 'superseded' ? (
                      <button
                        className="memory-note-action"
                        title="Restore"
                        aria-label="Restore this memory"
                        onClick={() => restoreFact(f.id!)}
                      >
                        <RotateCcw size={14} />
                      </button>
                    ) : (
                      <>
                        {unconfirmed(f) && (
                          <button
                            className="memory-note-action"
                            title="Confirm"
                            aria-label="Confirm this memory"
                            onClick={() => confirmFact(f.id!)}
                          >
                            <ShieldCheck size={14} />
                          </button>
                        )}
                        <button
                          className={`memory-note-action${f.pinned ? ' on' : ''}`}
                          title={f.pinned ? 'Unpin' : 'Pin for every message'}
                          aria-label={f.pinned ? 'Unpin this memory' : 'Pin this memory'}
                          aria-pressed={!!f.pinned}
                          onClick={() => pinFact(f.id!, !f.pinned, f.sensitivity)}
                        >
                          <Pin size={14} fill={f.pinned ? 'currentColor' : 'none'} />
                        </button>
                      </>
                    )}
                    <button
                      className="memory-note-action danger"
                      title="Forget permanently"
                      aria-label="Forget this memory permanently"
                      onClick={() => forget(f.id!)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
              </div>
    );
  }

  return (
    <div>
      {health.broken && (
        // A down retrieval stage, said out loud at the top of the tab — the
        // controls live in Settings → Models, and an error only visible there
        // is an error nobody sees. Recall keeps working while this shows, just
        // worse: the summary line names what the ranking has degraded to.
        <div className="retrieval-alert" role="alert">
          <TriangleAlert size={16} />
          <div className="retrieval-alert-msg">
            {health.embed && (
              <span>
                <strong>Embedding model failed.</strong>{' '}
                {health.embed.error}
              </span>
            )}
            {health.rerank && (
              <span>
                <strong>Reranker model failed.</strong>{' '}
                {health.rerank.error}
              </span>
            )}
            <span className="muted">
              {health.embed
                ? 'Until this is fixed, memories are picked by keywords and recency alone — matches by meaning are missed.'
                : 'Until this is fixed, memories rank by embedding similarity alone — cross-language matches are missed.'}
            </span>
          </div>
          <button className="link-btn" onClick={onReviewRecall}>
            Review setup
          </button>
        </div>
      )}
      <div className="group memory-switch">
        <div className="group-row">
          <span className="row-main">
            <strong>Memory</strong>
            <em>{status}</em>
          </span>
          <button
            className={`switch${settings.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={settings.enabled}
            aria-label="Memory"
            onClick={toggle}
          />
        </div>
      </div>

      <div className="grp-head">What Stem knows about you</div>
      <UserSummaryCard disabled={!settings.enabled} />

      <div className="grp-head">Check my memory</div>
      <DeepCheckCard disabled={!settings.enabled || notes.length < 2} onOpenMail={onOpenMail} />

      {conflicts.length > 0 && (
        <>
          <div className="grp-head grp-head-row">
            Needs your answer · {conflicts.length}
            <InfoTip label="About conflicts">
              Two facts that cannot both be true, which the background check could not settle on
              its own. Until you pick, either side may still be sent — marked as conflicting, so the
              model treats it as uncertain.
            </InfoTip>
          </div>
          <div className="formgroup memory-conflicts">
            {conflicts.map((c) => (
              <div key={c.id} className="memory-conflict">
                {orderedConflictFacts(c).map((f, i) => (
                  <div key={f.id} className="memory-conflict-side">
                    <span className="chip">{i === 0 ? 'Newer' : 'Older'}</span>
                    <p>{plainLine(f.text)}</p>
                    <span className="muted">
                      Learned {new Date(f.updatedAt * 1000).toLocaleDateString()}
                    </span>
                  </div>
                ))}
                <em>{plainLine(c.reason)}</em>
                <div className="memory-view-actions">
                  <button className="link-btn" onClick={() => resolveConflict(c.id, 'keep_newer')}>Keep newer</button>
                  <button className="link-btn" onClick={() => resolveConflict(c.id, 'keep_older')}>Keep older</button>
                  <button className="link-btn" onClick={() => resolveConflict(c.id, 'keep_both')}>Keep both</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="grp-head with-actions">
        Facts
        <span className="memory-view-actions">
          <button
            className={`link-btn icon-only${previewActive ? ' on' : ''}`}
            onClick={onTogglePreview}
            data-label="Preview draft"
            aria-label="Preview which facts your current draft would send"
            aria-pressed={previewActive}
          >
            <Eye size={15} />
          </button>
          <button
            className="link-btn icon-only"
            onClick={refreshContents}
            disabled={refreshing}
            data-label="Refresh"
            aria-label="Refresh facts"
          >
            <RefreshCw size={15} className={refreshing ? 'spin' : undefined} />
          </button>
        </span>
      </div>
      <div className="memory-facts-tools">
        <label className="memory-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search facts"
            placeholder={notes.length ? `Search ${notes.length.toLocaleString()} facts` : 'Search facts'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="seg-ctl">
          {FACT_FILTERS.map((x) => (
            <button key={x.id} className={filter === x.id ? 'active' : ''} onClick={() => setFilter(x.id)} title={x.title}>
              {x.label}
            </button>
          ))}
        </div>
        {activeThreadId && lastTurn && (
          <p className="muted active-facts-summary">
            This chat's last message used {lastTurn.facts.length} {lastTurn.facts.length === 1 ? 'fact' : 'facts'} via{' '}
            {tierLabel(lastTurn.tier)}.
          </p>
        )}
        {previewActive && (
          <p className="muted active-facts-summary">
            {preview
              ? `Your draft would use ${preview.facts.length} ${preview.facts.length === 1 ? 'fact' : 'facts'} via ${tierLabel(preview.tier)}` +
                (preview.parents?.length
                  ? `, plus ${preview.parents.length} broader ${preview.parents.length === 1 ? 'memory' : 'memories'}:`
                  : '.')
              : 'Draft preview: computing…'}
          </p>
        )}
        {previewActive && preview?.parents && preview.parents.length > 0 && (
          <ul className="muted active-facts-summary preview-parents">
            {preview.parents.map((p, i) => (
              <li key={i}>
                {p.text}
                {p.sensitive && (
                  <>
                    {' '}
                    <HoverTip
                      className="chip sensitive"
                      ariaLabel="Sensitive"
                      tip="Built from a sensitive fact — needs a much stronger match to be recalled."
                    >
                      <Lock size={10} />
                    </HoverTip>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {!contents && (
        <p className="muted">
          {offline ? 'Your memory lives on Stem’s server, which can’t be reached right now.' : 'Loading…'}
        </p>
      )}
      {contents && notes.length === 0 && (
        <p className="muted">No memories stored yet — Stem builds these as you chat.</p>
      )}
      {contents && notes.length > 0 && visibleNotes.length === 0 && (
        <p className="muted">No facts match.</p>
      )}
      {visibleNotes.slice(0, limit).map(renderNote)}
      {visibleNotes.length > limit && (
        <button className="link-btn memory-more" onClick={() => setLimit((n) => n + PAGE * 4)}>
          Show more ({(visibleNotes.length - limit).toLocaleString()} left)
        </button>
      )}

      <div className="memory-footer">
        {(supersededNotes.length > 0 || autoResolved.length > 0) && (
          <>
            <button
              className="memory-tech-head"
              aria-expanded={showHistory}
              onClick={() => setShowHistory((v) => !v)}
            >
              <ChevronRight size={14} className={showHistory ? 'open' : ''} />
              <span>
                <b>History</b>
                {supersededNotes.length > 0 && ` · ${supersededNotes.length.toLocaleString()} replaced`}
                {autoResolved.length > 0 && ` · ${autoResolved.length} settled automatically`}
              </span>
            </button>
            {showHistory && (
              <div className="memory-footer-body">
                {supersededNotes.length > 0 && autoResolved.length > 0 && (
                  <div className="seg-ctl">
                    <button className={historyView === 'replaced' ? 'active' : ''} onClick={() => setHistoryView('replaced')}>
                      Replaced
                    </button>
                    <button className={historyView === 'auto' ? 'active' : ''} onClick={() => setHistoryView('auto')}>
                      Settled automatically
                    </button>
                  </div>
                )}
                {(historyView === 'replaced' || autoResolved.length === 0) && supersededNotes.length > 0 ? (
                  <>
                    <p className="muted">Facts Stem no longer uses. Restore one to bring it back.</p>
                    {supersededNotes.map(renderNote)}
                  </>
                ) : (
                  <>
                    <p className="muted">
                      Conflicts between non-protected memories, settled in the background: one side
                      replaced, both kept, or both rewritten into clearer facts.
                    </p>
                    <div className="formgroup memory-conflicts">
                      {autoResolved.map((c) => (
                        <div key={c.id} className="memory-conflict">
                          {[c.factA, c.factB].map((f) => (
                            <div key={f.id} className="memory-conflict-side">
                              <span className="chip">{f.status === 'superseded' ? 'Replaced' : 'Kept'}</span>
                              <p className={f.status === 'superseded' ? 'muted' : undefined}>{plainLine(f.text)}</p>
                            </div>
                          ))}
                          <em>
                            {AUTO_RESOLUTION_LABEL[c.resolution]} ·{' '}
                            {new Date(c.resolvedAt * 1000).toLocaleDateString()}
                          </em>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}

        <button
          className="memory-tech-head"
          aria-expanded={showHousekeeping}
          onClick={() => setShowHousekeeping((v) => !v)}
        >
          <ChevronRight size={14} className={showHousekeeping ? 'open' : ''} />
          <span>
            <b>Housekeeping</b>
            {housekeepingLine && ` · ${housekeepingLine}`}
          </span>
        </button>
        {showHousekeeping && (
          <div className="group memory-footer-body" ref={housekeepingRef}>
            <div className="group-row">
              <span className="row-main">
                <strong>Tidy-up</strong>
                <em>
                  Runs by itself as Stem learns: merges duplicates and retires stale facts.
                  {lastTidy && !consolidating && ` Last pass ${ago(lastTidy.startedAt)}${lastTidy.detail ? `: ${plainLine(lastTidy.detail)}` : ''}.`}
                </em>
                {consolidateMsg && <em>{consolidateMsg}</em>}
              </span>
              <button
                className="link-btn"
                onClick={consolidate}
                disabled={consolidating || !settings.enabled || notes.length < 2}
              >
                {consolidating ? 'Tidying…' : 'Tidy now'}
              </button>
            </div>
            <div className="group-row">
              <span className="row-main">
                <strong>How often</strong>
                <em>{tidyPreset?.value ? `A pass starts ${tidyPreset.hint}.` : 'Only when you press Tidy now.'}</em>
              </span>
              <select
                className="vfield"
                aria-label="Automatic tidy-up"
                value={settings.tidyThreshold}
                onChange={(e) => selectTidyThreshold(Number(e.target.value))}
              >
                {TIDY_PRESETS.map((p) => (
                  <option key={p.label} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            {rebuild && rebuild.state !== 'complete' && (
              <div className="group-row">
                <span className="row-main">
                  <strong>Add sources to older memory</strong>
                  <em>
                    {rebuild.totalMessages} stored messages were learned before Stem kept sources.
                    Re-reading them attaches evidence, sensitivity, validity and conflicts, using the
                    memory model (a remote one sends transcript parts to its provider). Existing
                    memories stay usable meanwhile.
                  </em>
                  {rebuild.state !== 'available' && (
                    <em>
                      {rebuild.processedMessages} of {rebuild.totalMessages} messages · {rebuild.state}
                      {rebuild.lastError ? ` · ${rebuild.lastError}` : ''}
                    </em>
                  )}
                </span>
                {rebuild.state === 'available' && (
                  <button className="link-btn" onClick={() => window.stem.startMemoryRebuild().then(setRebuild)}>
                    Start
                  </button>
                )}
                {rebuild.state === 'running' && (
                  <button
                    className="link-btn icon-only"
                    data-label="Pause"
                    aria-label="Pause rebuild"
                    onClick={() => window.stem.pauseMemoryRebuild().then(setRebuild)}
                  >
                    <Pause size={13} />
                  </button>
                )}
                {(rebuild.state === 'paused' || rebuild.state === 'failed') && (
                  <button
                    className="link-btn icon-only"
                    data-label={rebuild.state === 'failed' ? 'Retry' : 'Resume'}
                    aria-label={rebuild.state === 'failed' ? 'Retry rebuild' : 'Resume rebuild'}
                    onClick={() => window.stem.resumeMemoryRebuild().then(setRebuild)}
                  >
                    {rebuild.state === 'failed' ? <RotateCcw size={13} /> : <Play size={13} />}
                  </button>
                )}
              </div>
            )}
            <div className="group-row">
              <span className="row-main">
                <strong>Models</strong>
                <em>What learns, tidies and picks relevant facts is set in Settings → Models.</em>
              </span>
              <button className="link-btn" onClick={onReviewRecall}>
                Open <ArrowUpRight size={12} />
              </button>
            </div>
            {techFiles.length > 0 && (
              <div className="group-row memory-tech-row">
                <button
                  className="memory-tech-head"
                  aria-expanded={showTech}
                  onClick={() => setShowTech((v) => !v)}
                >
                  <ChevronRight size={14} className={showTech ? 'open' : ''} />
                  <span>Technical details ({techFiles.length})</span>
                </button>
                {showTech &&
                  techFiles.map((f) => (
                    <div key={f.name} className="memory-doc">
                      <h4>{f.label}</h4>
                      <MdxView text={f.content} />
                    </div>
                  ))}
              </div>
            )}
            {(notes.length > 0 || techFiles.length > 0) && (
              <div className="group-row">
                {confirmReset ? (
                  <span className="memory-reset-confirm">
                    <span className="muted">
                      Erase all {notes.length} {notes.length === 1 ? 'fact' : 'facts'}? This can’t be undone.
                    </span>
                    <button className="link-btn danger" onClick={reset} disabled={resetting}>
                      {resetting ? 'Erasing…' : 'Erase facts'}
                    </button>
                    <button className="link-btn" onClick={() => setConfirmReset(false)} disabled={resetting}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <>
                    <span className="row-main">
                      <strong>Erase all facts</strong>
                      <em>Keeps past chats and your files. Can’t be undone.</em>
                    </span>
                    <button className="link-btn danger" onClick={reset}>
                      Erase…
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
