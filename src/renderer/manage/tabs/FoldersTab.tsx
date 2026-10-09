import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Code2,
  EyeOff,
  FileText,
  Folder,
  FolderOpen,
  Lock,
  NotebookPen,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
  Unplug
} from 'lucide-react';
import type {
  ConnectedFolder,
  ConnectedFolderKind,
  ConnectedFolderPatch,
  FolderIndexStatus,
  FolderSuggestion,
  ModelSummary
} from '../../../shared/types';
import { resolveMemoryModel } from '../../../shared/modelRoles';
import { useClientDeviceId, useRemoteServer } from '../../hooks/useRemoteServer';
import { ConnectFolderWizard, KINDS } from '../ConnectFolderWizard';
import {
  ConfirmDelete,
  DetailFooter,
  DetailHeader,
  DetailIdent,
  DetailTabs,
  Field,
  Flag,
  Glyph,
  ListGroup,
  ListHeader,
  ListRow,
  ListSearch,
  ToggleRow,
  shortPath,
  type GlyphTone
} from '../ListDetail';
import { InfoTip } from '../../ui/InfoTip';
import { ModelPicker } from '../../ui/ModelPicker';
import { FilesTab } from './FilesTab';
import { useRememberedTab } from '../../hooks/useRememberedTab';

const SUBS = ['files', 'folders'] as const;

// ---- Sources tab: everywhere the assistant can read from ----
// Two kinds, split into sub-tabs because they are different things wearing the
// same word "files". Files holds *copies* inside Stem's workspace and every name
// is listed to the assistant each turn — a small, always-in-view pile, so its
// surface is a file browser. Connected folders are *references* to folders that
// stay where they live; nothing is enumerated (a vault has thousands of files),
// so the assistant searches them instead — and each one carries settings that
// govern how far it may go.
export function SourcesTab({ models }: { models: ModelSummary[] }) {
  const [sub, setSub] = useRememberedTab('stem.sources.sub', SUBS, 'files');
  return (
    <div>
      <div className="seg-ctl">
        <button className={sub === 'files' ? 'active' : ''} onClick={() => setSub('files')}>
          Files
        </button>
        <button className={sub === 'folders' ? 'active' : ''} onClick={() => setSub('folders')}>
          Connected folders
        </button>
      </div>
      {sub === 'files' ? <FilesTab /> : <ConnectedFoldersTab models={models} />}
    </div>
  );
}

// ---- Connected folders: external folders the assistant reads in place ----
// The user connects folders (an Obsidian vault, a financials folder) by absolute
// path; Stem reads them live, never copying. Per folder: a write toggle (read-only
// is enforced in the backend), a memorize toggle (off keeps its contents out of
// cross-chat memory — the intended default for a client's private vault), an
// index toggle (a local search index so relevant files surface in recall), and —
// when indexed and memorized — a "Learn facts" mode governing whether Stem
// distills durable facts from the folder's files.
//
// The list is one line per folder (its kind's icon, name, path, state icons);
// opening one replaces the list with its editor — About / Access / Search &
// learning — and nothing reaches the server until Save. A state summary on
// every row used to be a sentence; the icons say the same at a glance.

type LearnMode = NonNullable<ConnectedFolder['learnMode']>;

const LEARN_LABELS: Record<LearnMode, string> = {
  off: 'Off',
  use: 'On use',
  new: 'New & changed',
  all: 'Full history'
};

/** What each mode does, shown under the select so the choice reads without a hover. */
const LEARN_HINTS: Record<LearnMode, string> = {
  off: 'Stem never learns facts from this folder. Search and recall still work.',
  use: 'Learns only from excerpts that come up in your chats. No extra model calls.',
  new: 'Also reads files added or edited from now on, in the background. Existing files are left alone.',
  all: 'Reads every file already in the folder once (Save shows the cost first), then keeps up with new and edited files.'
};

/** Average prompt chars one learning call consumes (MAX_TRANSCRIPT_CHARS-ish). */
const LEARN_CHARS_PER_CALL = 14_000;

/** Below this many indexed files, dropping the index is cheap enough to skip the confirm. */
const CONFIRM_DROP_INDEX_MIN_DOCS = 100;

/**
 * "Indexed 3,412 · 214 skipped" with the skip breakdown in an InfoTip. Inventory
 * of what this folder's index holds — the scan/embed work that produced it is
 * reported by the toolbar activity indicator.
 */
function IndexStatusLine({ status }: { status: FolderIndexStatus }) {
  const skipped = Object.entries(status.skippedByExt).sort((a, b) => b[1] - a[1]);
  return (
    <div className="muted cfolder-index-status">
      {status.lastScanTs === null
        ? 'Not indexed yet'
        : `Indexed ${status.indexedCount.toLocaleString()} file${status.indexedCount === 1 ? '' : 's'}`}
      {status.skippedCount > 0 && (
        <>
          {' · '}
          {status.skippedCount.toLocaleString()} skipped
          <InfoTip label="Which files were skipped">
            Text files (.md, .txt), PDFs with a text layer, and Word documents (.doc, .docx) are
            indexed; scanned image-only PDFs are skipped (no OCR). Skipped here:{' '}
            {skipped.map(([ext, n]) => `${ext} ×${n}`).join(', ')}.
          </InfoTip>
        </>
      )}
    </div>
  );
}

/** Past this many, the "not mirrored" popover says only how many more there are. */
const MAX_SKIPPED_SHOWN = 12;

/**
 * "7 not mirrored" with the per-file reasons in an InfoTip — the expanded-card
 * counterpart of the collapsed summary's bare count. Fetched on mount (i.e. on
 * expand), not with the folder list: the report can run to hundreds of paths
 * and only matters once someone is looking at this card.
 */
function MirrorSkippedNote({ folderId, count }: { folderId: string; count: number }) {
  const [skipped, setSkipped] = useState<{ rel: string; reason: string }[]>([]);
  useEffect(() => {
    let stale = false;
    window.stem
      .mirrorSkippedFiles(folderId)
      .then((s) => {
        if (!stale) setSkipped(s);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [folderId, count]);
  return (
    <>
      {' · '}
      {count.toLocaleString()} not mirrored
      <InfoTip label="Which files were not mirrored">
        The sync copies regular, readable files up to the size limit; symbolic links and anything
        unreadable stay on their computer.
        {skipped.length > 0 && (
          <>
            {' '}Not mirrored:{' '}
            {skipped
              .slice(0, MAX_SKIPPED_SHOWN)
              .map((s) => `${s.rel} (${s.reason})`)
              .join(', ')}
            {skipped.length > MAX_SKIPPED_SHOWN && ` — and ${skipped.length - MAX_SKIPPED_SHOWN} more`}
            .
          </>
        )}
      </InfoTip>
    </>
  );
}

/** "Learned 38 facts · 12 Mar" — what this folder has contributed to memory so far. */
function LearnStatusLine({ status }: { status: FolderIndexStatus }) {
  const { facts, lastTs } = status.learn;
  if (facts > 0) {
    return (
      <div className="muted cfolder-index-status">
        Learned {facts.toLocaleString()} fact{facts === 1 ? '' : 's'}
        {lastTs != null && ` · ${new Date(lastTs * 1000).toLocaleDateString()}`}
      </div>
    );
  }
  if (lastTs != null) {
    return <div className="muted cfolder-index-status">No durable facts found yet</div>;
  }
  return null;
}

/** Everything the editor can change about a folder, as the form holds it. */
interface FolderDraft {
  label: string;
  note: string;
  kind: ConnectedFolderKind | null;
  writable: boolean;
  memorize: boolean;
  index: boolean;
  learnMode: LearnMode;
  learnModel: string | null;
}

function draftOf(f: ConnectedFolder): FolderDraft {
  return {
    label: f.label,
    note: f.note ?? '',
    kind: f.kind ?? null,
    writable: f.mode === 'readwrite',
    memorize: f.memorize,
    index: !!f.index,
    learnMode: f.learnMode ?? 'use',
    learnModel: f.learnModel ?? null
  };
}

/** Only what changed, so a save never rewrites a field someone else just set. */
function patchOf(f: ConnectedFolder, d: FolderDraft): ConnectedFolderPatch {
  const base = draftOf(f);
  const patch: ConnectedFolderPatch = {};
  if (d.label.trim() !== base.label) patch.label = d.label.trim();
  if (d.note.trim() !== base.note) patch.note = d.note.trim();
  if (d.kind !== base.kind) patch.kind = d.kind;
  if (d.writable !== base.writable) patch.mode = d.writable ? 'readwrite' : 'read';
  if (d.memorize !== base.memorize) patch.memorize = d.memorize;
  if (d.index !== base.index) patch.index = d.index;
  if (d.learnMode !== base.learnMode) patch.learnMode = d.learnMode;
  if (d.learnModel !== base.learnModel) patch.learnModel = d.learnModel ?? '';
  return patch;
}

const KIND_ICON: Record<ConnectedFolderKind, (size: number) => ReactNode> = {
  notes: (n) => <NotebookPen size={n} />,
  code: (n) => <Code2 size={n} />,
  docs: (n) => <FileText size={n} />,
  private: (n) => <Lock size={n} />
};

function FolderGlyph({ kind, size = 'md', tone = 'plain' }: { kind?: ConnectedFolderKind | null; size?: 'sm' | 'md' | 'lg'; tone?: GlyphTone }) {
  const n = size === 'lg' ? 17 : size === 'sm' ? 12 : 14;
  return <Glyph icon={kind ? KIND_ICON[kind](n) : <Folder size={n} />} tone={kind === 'code' ? 'accent' : tone} size={size} />;
}

type FolderTab = 'about' | 'access' | 'search';

function ConnectedFoldersTab({ models }: { models: ModelSummary[] }) {
  const [folders, setFolders] = useState<ConnectedFolder[]>([]);
  const [indexStatus, setIndexStatus] = useState<Record<string, FolderIndexStatus>>({});
  // THIS machine's mirror engine, by folder id — the only place a failed sync
  // round is visible (the server just never hears from a client that errors).
  const [localSync, setLocalSync] = useState<Record<string, { phase: string; lastError?: string }>>({});
  // The folder whose editor replaces the list (null = the list), its tab, and
  // the unsaved form. Changes reach the server on Save, like every other tab.
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<FolderTab>('about');
  const [draft, setDraft] = useState<FolderDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // After a disconnect that leaves learned facts behind: offer to forget them.
  const [forgetOffer, setForgetOffer] = useState<{ id: string; label: string; facts: number } | null>(null);
  // "Suggest settings": the model's answer once applied to the draft (its
  // reason stays on show until Save or leaving), and the call in flight.
  const [advice, setAdvice] = useState<FolderSuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  // A connected folder is a path on the SERVER's disk. When that isn't this
  // machine, revealing it here would open whatever happens to sit at the same
  // path locally — so the buttons that do it are not offered at all. Adding is
  // the same fact in the other direction: the native picker browses THIS disk,
  // so a remote server gets the server-side picker dialog instead.
  const remote = useRemoteServer();
  const deviceId = useClientDeviceId();
  // New opens the connect wizard (false = closed; a kind = preselected there).
  const [adding, setAdding] = useState<false | { kind?: ConnectedFolderKind }>(false);
  // What "Memory default" on a folder's model picker actually means today: the
  // memory model if one is set, else whatever the backend defaults to. Read here
  // rather than passed in, because Sources knows nothing about Memory's settings.
  const [memoryModel, setMemoryModel] = useState<string | null>(null);

  useEffect(() => {
    void window.stem
      .getSettings()
      .then((s) => setMemoryModel(resolveMemoryModel(s.memory.model, s.defaults.model)));
  }, []);

  const refreshStatus = useCallback(() => {
    window.stem.folderIndexStatus().then(setIndexStatus).catch(() => undefined);
  }, []);

  useEffect(() => {
    window.stem.listConnectedFolders().then(setFolders);
    refreshStatus();
  }, [refreshStatus]);

  // While any folder is indexed, poll the status line lazily (scans/embeds/learn
  // batches run in the background; counts drift without user action).
  useEffect(() => {
    if (!folders.some((f) => f.index)) return;
    const timer = setInterval(refreshStatus, 10_000);
    return () => clearInterval(timer);
  }, [folders, refreshStatus]);

  // A client folder's state changes without user action — the first sync
  // landing, the root vanishing, its device reconnecting — so the list itself is
  // polled while one is on screen (else "Waiting for first sync" outlives the
  // sync it waits for), and the local mirror engine is asked for the error a
  // failed round leaves behind.
  const hasClientFolders = folders.some((f) => f.origin);
  useEffect(() => {
    if (!hasClientFolders) return;
    const tick = () => {
      window.stem.listConnectedFolders().then(setFolders).catch(() => undefined);
      window.stem
        .mirrorLocalState()
        .then((states) =>
          setLocalSync(Object.fromEntries(states.map((s) => [s.folderId, { phase: s.phase, ...(s.lastError ? { lastError: s.lastError } : {}) }])))
        )
        .catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, 10_000);
    return () => clearInterval(timer);
  }, [hasClientFolders]);

  function open(f: ConnectedFolder, at: FolderTab = 'about') {
    setDraft(draftOf(f));
    setTab(at);
    setOpenId(f.id);
    setError(null);
    setForgetOffer(null);
    setAdvice(null);
  }

  function back() {
    setOpenId(null);
    setDraft(null);
    setError(null);
    setAdvice(null);
  }

  /**
   * Have the memory model look at the folder and fill the form with what suits
   * it. Nothing is saved: the changes show as unsaved, the reason beside them.
   * A folder on this computer is looked at here (its mirror may not have synced
   * yet); anything else on the server.
   */
  async function suggest(f: ConnectedFolder, d: FolderDraft) {
    setSuggesting(true);
    setError(null);
    try {
      const note = d.note.trim() || undefined;
      const s = await window.stem.suggestFolderSettings(
        f.origin && f.origin.deviceId === deviceId
          ? { path: f.origin.clientPath, local: true, ...(note ? { note } : {}) }
          : { folderId: f.id }
      );
      setDraft((cur) =>
        cur && {
          ...cur,
          kind: s.kind,
          writable: s.writable,
          memorize: s.memorize,
          index: s.index,
          learnMode: s.learnMode,
          note: cur.note.trim() ? cur.note : s.note
        }
      );
      setAdvice(s);
    } catch (e) {
      setError(String((e as Error)?.message ?? e).replace(/^(Error:\s*)?(Error invoking remote method '[^']+':\s*)?(Error:\s*)?/, ''));
    } finally {
      setSuggesting(false);
    }
  }

  /** The wizard connected a folder: open it. */
  function adopt(next: ConnectedFolder[], id: string) {
    setAdding(false);
    setFolders(next);
    const f = next.find((x) => x.id === id);
    if (f) open(f);
    setTimeout(refreshStatus, 1_500); // An indexed folder's first scan starts ~0.5s later.
  }

  async function save(f: ConnectedFolder, d: FolderDraft) {
    const patch = patchOf(f, d);
    setSaving(true);
    setError(null);
    try {
      const next = await window.stem.updateConnectedFolder(f.id, patch);
      setFolders(next);
      const saved = next.find((x) => x.id === f.id);
      if (saved) setDraft(draftOf(saved));
      setAdvice(null);
      // Index and learning work starts a moment after the write.
      if (patch.index !== undefined || patch.learnMode !== undefined) setTimeout(refreshStatus, 2_000);
    } catch (e) {
      setError(String((e as Error)?.message ?? e).replace(/^(Error:\s*)?(Error invoking remote method '[^']+':\s*)?(Error:\s*)?/, ''));
    } finally {
      setSaving(false);
    }
  }

  async function remove(f: ConnectedFolder) {
    const facts = indexStatus[f.id]?.learn.facts ?? 0;
    setFolders(await window.stem.removeConnectedFolder(f.id));
    back();
    // Facts are memories, not an index — keeping them is the default. Offer the
    // cleanup, since the folder tag now points at a disconnected source.
    if (facts > 0) setForgetOffer({ id: f.id, label: f.label, facts });
  }

  const learnCalls = (status: FolderIndexStatus | undefined): number | null =>
    status ? Math.max(1, Math.ceil(status.totalTextChars / LEARN_CHARS_PER_CALL)) : null;

  /** The mirror's state for a client folder, in a few words; null for a server folder. */
  function syncLine(f: ConnectedFolder): string | null {
    if (!f.origin) return null;
    if (f.orphaned) return 'Its computer is no longer paired — the mirror is frozen as it last synced.';
    if (localSync[f.id]?.phase === 'syncing') return 'Syncing now…';
    if (f.syncState === 'root-missing') return 'Sync frozen — the folder is unreachable on its computer.';
    if (f.syncState === 'awaiting-sync') return 'Waiting for the first sync.';
    if (f.lastSyncedAt) return `Synced ${new Date(f.lastSyncedAt).toLocaleString()}.`;
    return null;
  }

  /**
   * Folders grouped by the machine they live on — the McpTab placeGroups shape:
   * one group per owning device, orphans last; a single "Folders" group when
   * nothing lives on another computer.
   */
  const groups = ((): { key: string; head: string; offline?: boolean; items: ConnectedFolder[] }[] => {
    if (!folders.some((f) => f.origin)) return [{ key: 'all', head: 'Folders', items: folders }];
    const out: { key: string; head: string; offline?: boolean; items: ConnectedFolder[] }[] = [];
    const server = folders.filter((f) => !f.origin);
    if (server.length) {
      out.push({ key: 'server', head: remote ? 'On your Stem server' : 'On this computer', items: server });
    }
    const byDevice = new Map<string, ConnectedFolder[]>();
    const orphans: ConnectedFolder[] = [];
    for (const f of folders) {
      if (!f.origin) continue;
      if (f.orphaned) {
        orphans.push(f);
        continue;
      }
      byDevice.set(f.origin.deviceId, [...(byDevice.get(f.origin.deviceId) ?? []), f]);
    }
    out.push(
      ...[...byDevice.entries()]
        .map(([id, items]) => {
          const offline = items[0]!.deviceConnected === false;
          return {
            key: id,
            head:
              (id === deviceId ? 'On this computer' : `On ${items[0]!.deviceLabel ?? 'another computer'}`) +
              (offline ? ' · offline' : ''),
            offline,
            items
          };
        })
        .sort((a, b) => a.head.localeCompare(b.head))
    );
    if (orphans.length) out.push({ key: 'orphans', head: 'Nowhere — that computer is gone', offline: true, items: orphans });
    return out;
  })();

  const wizard = adding && (
    <ConnectFolderWizard
      remote={remote}
      existing={folders}
      initialKind={adding.kind}
      onDone={adopt}
      onCancel={() => setAdding(false)}
    />
  );

  const opened = openId ? folders.find((x) => x.id === openId) : undefined;
  if (opened && draft) {
    const f = opened;
    const d = draft;
    const status = indexStatus[f.id];
    const dirty = Object.keys(patchOf(f, d)).length > 0;
    const learnRows = d.index && d.memorize;
    const docs = status?.indexedCount ?? 0;
    const dropsIndex = !!f.index && !d.index && docs >= CONFIRM_DROP_INDEX_MIN_DOCS;
    const startsSweep = learnRows && d.learnMode === 'all' && (f.learnMode ?? 'use') !== 'all';
    const calls = learnCalls(status);
    const sync = syncLine(f);
    const where = f.origin ? `on ${f.deviceLabel ?? 'its computer'}` : remote ? 'on your Stem server' : 'on this computer';
    const kindLabel = KINDS.find((k) => k.value === d.kind)?.label;
    return (
      <div className="ld-detail">
        <DetailHeader backLabel="Connected folders" onBack={back}>
          <button
            type="button"
            className="icon-action sm"
            disabled={suggesting || !!f.missing || (f.syncState === 'awaiting-sync' && f.origin?.deviceId !== deviceId)}
            onClick={() => void suggest(f, d)}
            title={suggesting ? 'Looking at the folder…' : 'Suggest settings from what’s in the folder'}
            aria-label="Suggest settings"
          >
            <Sparkles size={14} className={suggesting ? 'suggesting' : undefined} />
          </button>
          {(!remote || f.origin?.deviceId === deviceId) && (
            <button
              type="button"
              className="icon-action sm"
              onClick={() => window.stem.revealConnectedFolder(f.id)}
              title="Reveal in Finder"
              aria-label="Reveal in Finder"
            >
              <FolderOpen size={14} />
            </button>
          )}
          <ConfirmDelete label="Disconnect folder" icon={<Unplug size={14} />} onConfirm={() => void remove(f)} />
        </DetailHeader>
        <DetailIdent
          glyph={<FolderGlyph kind={d.kind} size="lg" />}
          name={
            <input
              className="ld-name-input"
              aria-label="Folder name"
              value={d.label}
              onChange={(e) => setDraft({ ...d, label: e.target.value })}
            />
          }
          caption={`${kindLabel ? `${kindLabel} · ` : ''}${f.origin ? 'mirrored from' : ''} ${where}`.replace(/^\s+/, '')}
        />
        {error && <p className="task-failed">{error}</p>}
        {advice && (
          <p className="ld-advice" role="status">
            <Sparkles size={13} />
            <span>
              Suggested from what’s in the folder{advice.reason ? `: ${advice.reason}` : '.'} Review the tabs, then Save.
            </span>
          </p>
        )}
        <DetailTabs
          tabs={[
            { key: 'about', label: 'About' },
            { key: 'access', label: 'Access' },
            { key: 'search', label: 'Search & learning' }
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="ld-body">
          {tab === 'about' && (
            <>
              <Field label="Folder">
                <span className="ld-path" title={f.origin?.clientPath ?? f.path}>
                  {f.origin?.clientPath ?? f.path}
                  {f.missing && <span className="error"> · missing</span>}
                </span>
              </Field>
              <Field label="What’s in it" htmlFor="cfolder-note">
                <textarea
                  id="cfolder-note"
                  className="ci-textarea"
                  aria-label="What the folder holds"
                  placeholder="Tell Stem what this folder holds"
                  rows={2}
                  value={d.note}
                  onChange={(e) => setDraft({ ...d, note: e.target.value })}
                />
              </Field>
              <p className="ld-hint">Stem is told this, so it knows when the folder is worth a look.</p>
              <Field label="Kind" htmlFor="cfolder-kind">
                <select
                  id="cfolder-kind"
                  className="vfield"
                  value={d.kind ?? ''}
                  onChange={(e) => setDraft({ ...d, kind: (e.target.value || null) as ConnectedFolderKind | null })}
                >
                  <option value="">Not set</option>
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="ld-hint">Sets the folder’s icon. It changes nothing else.</p>
              {f.origin && (
                <div className="ld-stat">
                  <RefreshCw size={13} />
                  <span>
                    Mirrored one way from {f.deviceLabel ?? 'its computer'}. {sync}
                    {!!f.skippedCount && <MirrorSkippedNote folderId={f.id} count={f.skippedCount} />}
                    {localSync[f.id]?.lastError && (
                      <span className="error"> Last sync failed: {localSync[f.id]!.lastError}</span>
                    )}
                  </span>
                </div>
              )}
            </>
          )}
          {tab === 'access' && (
            <div className="ld-toggles">
              <ToggleRow
                title="Writable"
                hint={
                  f.origin
                    ? `Stem may modify this folder by running commands on ${f.deviceLabel ?? 'its computer'}. The server’s mirror is never written.`
                    : 'Stem may create, edit and delete files here. Off = read-only, enforced by Stem.'
                }
                on={d.writable}
                tone="warn"
                onChange={(on) => setDraft({ ...d, writable: on })}
              />
              <ToggleRow
                title="Remember what it reads"
                hint="What Stem reads here can come back in later chats. Off keeps the folder private."
                on={d.memorize}
                onChange={(on) => setDraft({ ...d, memorize: on })}
              />
            </div>
          )}
          {tab === 'search' && (
            <>
              <div className="ld-toggles">
                <ToggleRow
                  title={
                    <>
                      Search index{' '}
                      <InfoTip label="What indexing does">
                        A private local search index (keyword + semantic) over this folder’s .md, .txt, .pdf and
                        Word files, so relevant notes surface in conversations and the assistant can search them.
                        The folder itself is never modified, and turning this off deletes the index. Folders kept
                        in sync by an external tool re-index automatically as files change.
                      </InfoTip>
                    </>
                  }
                  hint="Lets Stem search the folder and bring up relevant notes on its own."
                  on={d.index}
                  onChange={(on) => setDraft({ ...d, index: on })}
                />
              </div>
              {f.index && d.index && status && <IndexStatusLine status={status} />}
              {dropsIndex && (
                <p className="persona-warn" role="status">
                  Saving deletes its search index ({docs.toLocaleString()} files). Turning it back on later
                  re-scans and re-embeds everything
                  {(f.learnMode === 'new' || f.learnMode === 'all') && ', and sends every file through the learning model again'}
                  .
                </p>
              )}
              {learnRows ? (
                <Field
                  label={
                    <>
                      Learn facts{' '}
                      <InfoTip label="How fact learning works">
                        Whether Stem distills durable facts (amounts, dates, clients, plans) from this folder into
                        its memory. Learned facts appear in the Memory tab attributed to this folder and are kept
                        even if a file is later deleted.
                      </InfoTip>
                    </>
                  }
                >
                  <div className="ld-radio" role="radiogroup" aria-label="Learn facts mode">
                    {(['off', 'use', 'new', 'all'] as LearnMode[]).map((m) => (
                      <label key={m} className={d.learnMode === m ? 'on' : ''}>
                        <input
                          type="radio"
                          name="cfolder-learn"
                          checked={d.learnMode === m}
                          onChange={() => setDraft({ ...d, learnMode: m })}
                        />
                        <span>
                          <strong>{LEARN_LABELS[m]}</strong>
                          <em>{LEARN_HINTS[m]}</em>
                        </span>
                      </label>
                    ))}
                  </div>
                </Field>
              ) : (
                <p className="ld-hint">
                  {!d.memorize
                    ? 'Learning facts needs “Remember what it reads” (Access tab).'
                    : 'Learning facts needs the search index.'}
                </p>
              )}
              {learnRows && (d.learnMode === 'new' || d.learnMode === 'all') && (
                <Field label="Model">
                  <ModelPicker
                    models={models}
                    value={d.learnModel}
                    onChange={(id) => setDraft({ ...d, learnModel: id })}
                    emptyLabel="Memory default"
                    ariaLabel="Fact-learning model"
                    resolvedDefault={memoryModel}
                  />
                </Field>
              )}
              {startsSweep && (
                <p className="persona-warn" role="status">
                  Saving starts a sweep of {status ? status.indexedCount.toLocaleString() : 'all'} files
                  {calls != null && ` (≈${calls.toLocaleString()} model calls)`}.
                </p>
              )}
              {learnRows && (f.learnMode === 'new' || f.learnMode === 'all') && status && (
                <LearnStatusLine status={status} />
              )}
            </>
          )}
        </div>
        <DetailFooter
          dirty={dirty}
          saving={saving}
          canSave={!!d.label.trim()}
          saveLabel={startsSweep ? 'Save and start' : 'Save'}
          onCancel={back}
          onSave={() => void save(f, d)}
        />
        {wizard}
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const matches = (f: ConnectedFolder) =>
    !q || f.label.toLowerCase().includes(q) || (f.origin?.clientPath ?? f.path).toLowerCase().includes(q) || (f.note ?? '').toLowerCase().includes(q);

  function flags(f: ConnectedFolder) {
    const mode = f.learnMode ?? 'use';
    const failed = localSync[f.id]?.lastError;
    return (
      <>
        {(f.missing || failed) && <Flag icon={<AlertTriangle size={12} />} tone="danger" label={failed ? `Last sync failed: ${failed}` : 'The folder is missing'} />}
        {f.syncState === 'root-missing' && <Flag icon={<AlertTriangle size={12} />} tone="warn" label="Sync frozen — unreachable on its computer" />}
        {f.syncState === 'awaiting-sync' && <Flag icon={<RefreshCw size={12} />} label="Waiting for the first sync" />}
        {f.mode === 'readwrite' && <Flag icon={<Pencil size={12} />} tone="warn" label="Writable" />}
        {!f.memorize && <Flag icon={<EyeOff size={12} />} label="Private: nothing remembered" />}
        {f.index && (
          <Flag
            icon={<Search size={12} />}
            label={
              indexStatus[f.id]?.lastScanTs != null
                ? `Indexed ${indexStatus[f.id]!.indexedCount.toLocaleString()} files`
                : 'Search index (not built yet)'
            }
          />
        )}
        {f.index && f.memorize && (mode === 'new' || mode === 'all') && (
          <Flag icon={<Sparkles size={12} />} tone="ok" label={`Learns facts: ${LEARN_LABELS[mode]}`} />
        )}
      </>
    );
  }

  return (
    <div className="ld-list">
      {wizard}
      <ListHeader
        title="Connected folders"
        newAriaLabel="Add folder"
        extra={
          !remote && (
            <button
              className="grp-head-add"
              onClick={() => window.stem.openWorkspaceFolder()}
              title="Open Stem's own folder in Finder"
              aria-label="Open Stem's folder"
            >
              <FolderOpen size={13} />
            </button>
          )
        }
        templates={[
          ...KINDS.map((k) => ({
            key: k.value,
            icon: KIND_ICON[k.value](12),
            tone: (k.value === 'code' ? 'accent' : 'plain') as GlyphTone,
            label: k.label,
            hint: k.body,
            onPick: () => setAdding({ kind: k.value })
          })),
          { key: 'other', icon: <Folder size={12} />, label: 'Something else', hint: 'Answer each setting yourself', onPick: () => setAdding({}) }
        ]}
      />
      <ListSearch value={query} onChange={setQuery} placeholder="Find a folder" />
      {forgetOffer && (
        <div className="mcp-approval">
          <span className="set-sub">Also forget what Stem learned from “{forgetOffer.label}”?</span>
          <p className="muted">
            {forgetOffer.facts.toLocaleString()} fact{forgetOffer.facts === 1 ? '' : 's'} came from it. Keeping them is
            the default; pinned facts are always kept.
          </p>
          <div className="push-row">
            <button type="button" className="link-btn" onClick={() => setForgetOffer(null)}>
              Keep them
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                void window.stem.forgetConnectedFolderFacts(forgetOffer.id).catch(() => undefined);
                setForgetOffer(null);
              }}
            >
              Forget them
            </button>
          </div>
        </div>
      )}
      {folders.length === 0 ? (
        <p className="muted ld-empty">
          Connect a folder — an Obsidian vault, a project folder — and Stem can read its files in place (never
          copied). Read-only by default; turn off Memorize to keep a private folder's contents out of Stem's memory.
        </p>
      ) : (
        groups.map((group) => {
          const items = group.items.filter(matches);
          if (items.length === 0) return null;
          return (
            <ListGroup key={group.key} label={group.head} count={items.length}>
              {items.map((f) => (
                <ListRow
                  key={f.id}
                  glyph={<FolderGlyph kind={f.kind} tone={f.missing ? 'danger' : 'plain'} />}
                  name={f.label}
                  sub={shortPath(f.origin?.clientPath ?? f.path)}
                  subTail
                  right={flags(f)}
                  dim={group.offline}
                  onOpen={() => open(f)}
                />
              ))}
            </ListGroup>
          );
        })
      )}
    </div>
  );
}
