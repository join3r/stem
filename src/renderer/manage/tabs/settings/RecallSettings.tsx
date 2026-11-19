import { useEffect, useRef, useState } from 'react';
import { Plug, X, Check, Trash2, TriangleAlert, FolderInput, Pencil } from 'lucide-react';
import type {
  EmbeddingsMode,
  EmbeddingsSettings,
  LocalEmbedModelId,
  LocalEmbedStatus,
  LocalRerankModelId,
  LocalRerankStatus,
  MemorySettings,
  RerankerMode,
  RerankerSettings,
  RetrievalSettings,
  RetrievalTestResult,
  ImportedModelInfo,
  CustomEmbedModel,
  CustomImportCandidate,
  CustomRerankModel
} from '../../../../shared/types';
import { GTE_EMBED_MODELS, RECOMMENDED_FACT_MODEL, recallSetupStatus } from '../../../../shared/recall-recommended';
import { useRemoteServer } from '../../../hooks/useRemoteServer';
import { useFactRerankStatus, useRetrievalHealth } from '../../../hooks/useRetrievalHealth';
import { InfoTip } from '../../../ui/InfoTip';
import { ImportModelDialog } from '../../ImportModelDialog';
import { ServerFolderPicker } from '../../ServerFolderPicker';
import { SettingSection } from './rows';

/**
 * Settings → Models → Memory recall: the models that pick which facts ride along
 * with a message (embeddings find candidates, the reranker checks them), and how
 * many may. Moved here from the Memory tab, which now keeps only what memory
 * holds; a failed model still raises its banner there, and its Review setup
 * lands on this group (`focus`).
 */

const FACT_INJECT_PRESETS: { label: string; value: number }[] = [
  { label: '4', value: 4 },
  { label: '8', value: 8 },
  { label: '12', value: 12 },
  { label: '16', value: 16 }
];

// The curated local models, mirrored from server/recall/embed-catalog.ts (labels +
// sizes only — the specs live in main; the id is the contract).
const LOCAL_EMBED_MODELS: { id: LocalEmbedModelId; label: string; detail: string }[] = [
  { id: 'embeddinggemma-2', label: 'EmbeddingGemma 2', detail: '~315 MB · recommended · best measured' },
  { id: 'qwen3-embedding-0.6b', label: 'Qwen3 Embedding 0.6B', detail: '~640 MB · previous default' },
  { id: 'multilingual-e5-small', label: 'Multilingual E5 Small', detail: '~120 MB · smallest' }
];

const EMBED_MODES: { id: EmbeddingsMode; label: string; hint: string }[] = [
  { id: 'local', label: 'Built-in', hint: 'Bundled multilingual model, runs on this Mac' },
  { id: 'off', label: 'Off', hint: 'Rank facts by keywords/recency only' }
];

// The curated local rerankers, mirrored from server/recall/rerank-catalog.ts.
const LOCAL_RERANK_MODELS: { id: LocalRerankModelId; label: string; detail: string }[] = [
  { id: 'qwen3-reranker-0.6b', label: 'Qwen3 Reranker 0.6B', detail: '~1.2 GB · multilingual' },
  { id: 'bge-reranker-v2-m3', label: 'BGE Reranker v2 M3', detail: '~570 MB · multilingual' }
];

const GTE_FACT_MODEL = RECOMMENDED_FACT_MODEL;

/**
 * An imported model as a picker entry. Its size came off the disk it was copied
 * from and its dimension from the load probe, so the line says what is actually
 * known — no dimension yet simply means it has not run once.
 */
function customOption(m: CustomEmbedModel | CustomRerankModel): { id: string; label: string; detail: string } {
  const dim = 'dim' in m && m.dim ? ` · ${m.dim}-dim` : '';
  // An imported embedder that cosineScaleFor (server/recall/embed-scale.ts) has no
  // measured scale for borrows e5's similarity floors, which can over- or
  // under-fetch on another model, so the picker says so.
  const untuned = 'dim' in m && !/qwen3|embeddinggemma-2(?![0-9])/i.test(m.repo) ? ' · thresholds not tuned' : '';
  return { id: m.id, label: m.label, detail: `~${m.approxSizeMB} MB${dim} · imported${untuned}` };
}

// Built-in first, as under Embeddings: it is the default, and Off is the exception.
const RERANK_MODES: { id: RerankerMode; label: string; hint: string }[] = [
  { id: 'local', label: 'Built-in', hint: 'Bundled cross-encoder re-scores the top matches, runs on this Mac' },
  { id: 'off', label: 'Off', hint: 'Rank facts by embedding similarity only' }
];

/**
 * One line describing where a local retrieval model (embedder/reranker) is right
 * now. Deliberately state-only: the download percentage and the play-by-play
 * belong to the toolbar activity indicator, which is the single place that
 * answers "is Stem busy". What stays here is what this panel is for — did my
 * model switch take effect, what dimension did it produce, and did it break.
 */
function localStatusLabel(
  status: { state: LocalEmbedStatus['state']; dim?: number; error?: string } | null
): string {
  switch (status?.state) {
    case 'downloading':
    case 'loading':
      return 'Preparing model…';
    case 'ready':
      return `Ready${status.dim ? ` · ${status.dim}-dim` : ''}`;
    case 'error':
      return `Error: ${status.error ?? 'model failed to load'}`;
    default:
      // 'idle' is transient in local mode (the startup kick lands ~1.5 s after
      // launch), and we can't tell cached-from-not-yet-downloaded from here — so
      // don't claim either.
      return 'Starting up… (first use downloads the model once)';
  }
}

/** The status line under a local model picker — red with a warning mark on error,
 *  muted otherwise. Errors here must not look like just another muted state: a
 *  down model silently degrades every recall pass until someone notices. */
function LocalStatusLine({
  status
}: {
  status: { state: LocalEmbedStatus['state']; dim?: number; error?: string } | null;
}) {
  if (status?.state === 'error') {
    return (
      <p className="retrieval-status-error">
        <TriangleAlert size={12} /> {localStatusLabel(status)}
      </p>
    );
  }
  return <p className="muted">{localStatusLabel(status)}</p>;
}

/** What to say after an import that worked. */
function importedSummary(models: ImportedModelInfo[]): string {
  const names = models.map((m) => m.label).join(', ');
  return models.every((m) => m.alreadyPresent) ? `${names} was already here.` : `Imported ${names}.`;
}

/**
 * Bring model weights in from a folder the user already has, and keep whatever
 * came in that way. Stem does not ship or download models on anyone's behalf, so
 * on a machine that cannot reach Hugging Face this is the only way a local model
 * ever loads: point at a copy of someone else's cache, a `huggingface-cli
 * download`, or a USB stick.
 *
 * A model Stem has an entry for is copied and that is the whole interaction. One
 * it doesn't — any other ONNX embedder or cross-encoder — comes back as a
 * candidate instead of a refusal, and {@link ImportModelDialog} asks the few
 * things the folder could not say. What that produces is listed here afterwards,
 * to edit or to forget.
 *
 * The folder has to be on the machine that RUNS the models. When that is another
 * computer, the native dialog would browse the wrong disk — same branch the
 * connected-folders picker takes.
 */
function ImportedModels({
  stage,
  models,
  onRetrieval
}: {
  stage: 'embed' | 'rerank';
  /** This stage's imported models, as retrieval settings hold them. */
  models: (CustomEmbedModel | CustomRerankModel)[];
  /** Anything that changed the lists — the picker above is rebuilt from it. */
  onRetrieval: (retrieval: RetrievalSettings) => void;
}) {
  const remote = useRemoteServer();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  // Unrecognised folders wait their turn: one dialog each, in order, so pointing
  // Stem at a directory of several models is not a choice between them.
  const [queue, setQueue] = useState<CustomImportCandidate[]>([]);
  const [editing, setEditing] = useState<CustomEmbedModel | CustomRerankModel | null>(null);

  async function importFrom(dir: string): Promise<void> {
    setPicking(false);
    setBusy(true);
    setResult(null);
    try {
      const r = await window.stem.importModels(dir);
      if (r.ok) setResult({ ok: true, text: importedSummary(r.models) });
      else if (r.unknown?.length) setQueue(r.unknown);
      else setResult({ ok: false, text: r.error });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function choose(): Promise<void> {
    if (remote) {
      setPicking(true);
      return;
    }
    const dirs = await window.stem.pickDirectory();
    if (dirs[0]) await importFrom(dirs[0]);
  }

  async function drop(model: CustomEmbedModel | CustomRerankModel): Promise<void> {
    const r = await window.stem.removeCustomModel(stage, model.id);
    if (r.ok) {
      onRetrieval(r.retrieval);
      setResult({ ok: true, text: `Removed ${model.label}. Its files are still on disk.` });
    } else {
      setResult({ ok: false, text: r.error });
    }
  }

  return (
    <>
      {models.length > 0 && (
        <div className="custom-models">
          {models.map((m) => (
            <div key={m.id} className="custom-model-row">
              <span className="muted">{m.label}</span>
              <button className="link-btn icon-only" data-label="Edit" aria-label="Edit" onClick={() => setEditing(m)}>
                <Pencil size={13} />
              </button>
              <button
                className="link-btn icon-only danger"
                data-label="Remove"
                aria-label="Remove"
                onClick={() => void drop(m)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="retrieval-test">
        {picking && (
          <ServerFolderPicker onConnect={(path) => void importFrom(path)} onClose={() => setPicking(false)} />
        )}
        {(queue[0] || editing) && (
          <ImportModelDialog
            stage={stage}
            candidate={editing ? undefined : queue[0]}
            model={editing ?? undefined}
            onSaved={(retrieval) => {
              onRetrieval(retrieval);
              setResult({ ok: true, text: editing ? `Saved ${editing.label}.` : `Imported ${queue[0]!.label}.` });
              if (editing) setEditing(null);
              else setQueue((q) => q.slice(1));
            }}
            onClose={() => (editing ? setEditing(null) : setQueue((q) => q.slice(1)))}
          />
        )}
        <button
          className="retrieval-test-btn"
          onClick={() => void choose()}
          disabled={busy}
          title="Copy model files in from a folder instead of downloading them"
          aria-label="Import model files"
        >
          <FolderInput size={14} />
          <span>{busy ? 'Importing…' : 'Import model files'}</span>
        </button>
        {!busy && result && (
          <span className={`retrieval-test-status ${result.ok ? 'ok' : 'err'}`} title={result.text}>
            {result.ok ? <Check size={12} /> : <X size={12} />}
            {result.text}
          </span>
        )}
      </div>
    </>
  );
}

// Embeddings-stage controls: an exclusive Built-in / Off mode plus the local
// model picker + live download/ready status. Mode/model switches persist
// immediately.
function EmbeddingsFields({
  value,
  custom,
  onPatch,
  onRetrieval
}: {
  value: EmbeddingsSettings;
  /** Embedders the user imported — they join the picker below the curated ones. */
  custom: CustomEmbedModel[];
  onPatch: (patch: Partial<EmbeddingsSettings>) => void;
  onRetrieval: (retrieval: RetrievalSettings) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<RetrievalTestResult | null>(null);
  const [status, setStatus] = useState<LocalEmbedStatus | null>(null);
  useEffect(() => {
    window.stem.getLocalEmbedStatus().then(setStatus);
    return window.stem.onLocalEmbedStatus(setStatus);
  }, []);

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await window.stem.testRetrievalEndpoint('embeddings'));
    } catch {
      setTest({ ok: false, detail: 'request failed' });
    } finally {
      setTesting(false);
    }
  }

  const mode = value.mode;

  return (
    <div className="set-block fg-divider">
      <div className="group-row">
        <span className="row-main">
          <strong>Embeddings</strong>
          <em>{EMBED_MODES.find((m) => m.id === mode)?.hint}</em>
        </span>
      </div>
      <div className="seg-ctl">
        {EMBED_MODES.map((m) => (
          <button
            key={m.id}
            className={mode === m.id ? 'active' : ''}
            onClick={() => {
              setTest(null);
              onPatch({ mode: m.id });
            }}
            title={m.hint}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode === 'local' && (
        <>
          <select
            className="ifield"
            aria-label="Local embedding model"
            value={value.localModel}
            onChange={(e) => {
              setTest(null);
              onPatch({ localModel: e.target.value });
            }}
          >
            {[...LOCAL_EMBED_MODELS, ...custom.map(customOption)].map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.detail})
              </option>
            ))}
          </select>
          <LocalStatusLine status={status} />
          <ImportedModels stage="embed" models={custom} onRetrieval={onRetrieval} />
        </>
      )}
      {mode !== 'off' && (
        <div className="retrieval-test">
          <button
            className="retrieval-test-btn"
            onClick={runTest}
            disabled={testing}
            title={testing ? 'Testing…' : 'Test model'}
            aria-label="Test embeddings"
          >
            <Plug size={14} />
            <span>{testing ? 'Testing…' : 'Test model'}</span>
          </button>
          {!testing && test && (
            <span className={`retrieval-test-status ${test.ok ? 'ok' : 'err'}`} title={test.detail}>
              {test.ok ? <Check size={12} /> : <X size={12} />}
              {test.detail}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Reranker-stage controls, mirroring EmbeddingsFields: an exclusive Off /
// Built-in mode plus the local model + live download/ready status. The
// reranker re-scores the embedding shortlist with a cross-encoder — the
// precision stage that catches cross-language matches cosine ranking misses.
function RerankerFields({
  value,
  embeddings,
  custom,
  onPatch,
  onRetrieval
}: {
  value: RerankerSettings;
  embeddings: EmbeddingsSettings;
  /** Rerankers the user imported — they join the picker below the curated ones. */
  custom: CustomRerankModel[];
  onPatch: (patch: Partial<RerankerSettings>) => void;
  onRetrieval: (retrieval: RetrievalSettings) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<RetrievalTestResult | null>(null);
  const [status, setStatus] = useState<LocalRerankStatus | null>(null);
  const factStatus = useFactRerankStatus();
  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const off = window.stem.onLocalRerankStatus((next) => {
      receivedEvent = true;
      if (active) setStatus(next);
    });
    window.stem.getLocalRerankStatus().then((next) => {
      if (active && !receivedEvent) setStatus(next);
    }).catch(() => {});
    return () => {
      active = false;
      off();
    };
  }, []);

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await window.stem.testRetrievalEndpoint('reranker'));
    } catch {
      setTest({ ok: false, detail: 'request failed' });
    } finally {
      setTesting(false);
    }
  }

  const mode = value.mode;
  const gteSelected = value.factModel === GTE_FACT_MODEL;
  const gteEmbedding = embeddings.mode === 'local' && GTE_EMBED_MODELS.includes(embeddings.localModel);
  const gteAvailable = (factStatus?.installed === true || factStatus?.downloadable === true) && gteEmbedding;

  return (
    <div className="set-block fg-divider">
      <div className="group-row">
        <span className="row-main">
          <strong>
            Reranker{' '}
            <InfoTip label="What the reranker does">
              A second, precision pass: a cross-encoder re-scores the top embedding matches before
              injection, which is what catches cross-language matches (a Slovak question finding an
              English fact). While off or not ready, ranking uses embedding similarity alone.
            </InfoTip>
          </strong>
          <em>{RERANK_MODES.find((m) => m.id === mode)?.hint}</em>
        </span>
      </div>
      <div className="seg-ctl">
        {RERANK_MODES.map((m) => (
          <button
            key={m.id}
            className={mode === m.id ? 'active' : ''}
            onClick={() => {
              setTest(null);
              onPatch({ mode: m.id });
            }}
            title={m.hint}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode === 'local' && (
        <>
          <select
            className="ifield"
            aria-label="Local reranker model"
            value={gteSelected ? GTE_FACT_MODEL : value.localModel}
            onChange={(e) => {
              setTest(null);
              onPatch(e.target.value === GTE_FACT_MODEL
                ? { factModel: GTE_FACT_MODEL }
                : { localModel: e.target.value, factModel: 'configured' });
            }}
          >
            {[...LOCAL_RERANK_MODELS, ...custom.map(customOption)].map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.detail})
              </option>
            ))}
            <option value={GTE_FACT_MODEL} disabled={!gteAvailable}>
              Stem GTE Memory (~342 MB · recommended · fastest · CS/SK/DE/EN){!gteAvailable ? ' — unavailable' : ''}
            </option>
          </select>
          {gteSelected ? (
            <>
              <p className="muted">
                Trained for Czech, Slovak, German, and English. In Stem benchmarks it picked fewer
                wrong memories than Qwen3 and ran about 10× faster; the default for new installs.
              </p>
              {!factStatus ? <p className="muted">Checking GTE availability…</p>
                : !factStatus.installed && !factStatus.downloadable ? <p className="retrieval-status-error">Stem GTE Memory is unavailable on the connected host. Update Stem to download this model.</p>
                  : !gteEmbedding ? <p className="retrieval-status-error">Stem GTE Memory requires built-in EmbeddingGemma 2 or Qwen3 Embedding 0.6B. Choose one of those embedding models to use GTE.</p>
                    : factStatus.status.state === 'idle' ? <p className="muted">Starting Stem GTE Memory…</p>
                      : <LocalStatusLine status={factStatus.status} />}
            </>
          ) : <LocalStatusLine status={status?.model === value.localModel ? status : { state: 'loading' }} />}
          {!gteSelected && !gteAvailable && (
            <p className="muted">{!factStatus ? 'Checking GTE availability…' : !factStatus.installed && !factStatus.downloadable
              ? 'Update the connected Stem host to download Stem GTE Memory.'
              : 'To try Stem GTE Memory, select built-in EmbeddingGemma 2 above.'}</p>
          )}
          <ImportedModels stage="rerank" models={custom} onRetrieval={onRetrieval} />
        </>
      )}
      {mode !== 'off' && (
        <div className="retrieval-test">
          <button
            className="retrieval-test-btn"
            onClick={runTest}
            disabled={testing}
            title={testing ? 'Testing…' : 'Test model'}
            aria-label="Test reranker"
          >
            <Plug size={14} />
            <span>{testing ? 'Testing…' : 'Test model'}</span>
          </button>
          {!testing && test && (
            <span className={`retrieval-test-status ${test.ok ? 'ok' : 'err'}`} title={test.detail}>
              {test.ok ? <Check size={12} /> : <X size={12} />}
              {test.detail}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Nudge toward the recommended recall setup (EmbeddingGemma 2 → Stem GTE
 * Memory), or null when the configured models already match it — a
 * setup that matches has nothing to review, so no line confirms the default back.
 */
function recallHint(retrieval: RetrievalSettings): string | null {
  const { embedOk: embedBest, rerankOk: rerankBest } = recallSetupStatus(retrieval);
  if (embedBest && rerankBest) return null;
  const rerankOn = retrieval.reranker.mode !== 'off';
  return embedBest && rerankOn
    ? 'Stem GTE Memory is recommended — fewer wrong memories, fastest'
    : embedBest && !rerankOn
      ? 'Reranker is off'
      : embedBest
        ? 'Compare reranker models for your conversations'
        : rerankOn
          ? 'EmbeddingGemma 2 is recommended — finds more of the memories that matter'
          : 'Compare embedding and reranker models for your conversations';
}

/** The closed group's answer: which models run, and how many facts may ride along. */
function recallSummary(retrieval: RetrievalSettings, maxFacts: number | undefined): string {
  const embed =
    retrieval.embeddings.mode === 'off'
      ? 'Keywords only'
      : LOCAL_EMBED_MODELS.find((m) => m.id === retrieval.embeddings.localModel)?.label ??
        retrieval.customEmbedModels.find((m) => m.id === retrieval.embeddings.localModel)?.label ??
        retrieval.embeddings.localModel;
  const rerank =
    retrieval.reranker.mode === 'off'
      ? 'no reranker'
      : retrieval.reranker.factModel === GTE_FACT_MODEL
        ? 'Stem GTE Memory'
        : LOCAL_RERANK_MODELS.find((m) => m.id === retrieval.reranker.localModel)?.label ??
          retrieval.customRerankModels.find((m) => m.id === retrieval.reranker.localModel)?.label ??
          retrieval.reranker.localModel;
  return `${embed} → ${rerank}${maxFacts ? ` · ${maxFacts} facts` : ''}`;
}

export function MemoryRecallSection({ focus }: { focus?: number }) {
  const [retrieval, setRetrieval] = useState<RetrievalSettings | null>(null);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [open, setOpen] = useState(false);
  const health = useRetrievalHealth();
  const headRef = useRef<HTMLDivElement>(null);
  const handledFocus = useRef(0);
  const loaded = retrieval !== null;

  useEffect(() => {
    void window.stem.getSettings().then((s) => setRetrieval(s.retrieval));
    void window.stem.getMemorySettings().then(setSettings);
  }, []);

  // Arrived from the Memory tab's Review setup: open the group and bring it
  // into view — it sits below the roles, out of sight on a short panel. Waits
  // for the settings to load, since nothing renders to scroll to before that.
  useEffect(() => {
    if (!focus || !loaded || handledFocus.current === focus) return;
    handledFocus.current = focus;
    setOpen(true);
    setTimeout(() => headRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }, [focus, loaded]);

  function patchEmbeddings(patch: Partial<EmbeddingsSettings>) {
    window.stem.updateRetrievalSettings({ embeddings: patch }).then((s) => setRetrieval(s.retrieval));
  }

  function patchReranker(patch: Partial<RerankerSettings>) {
    window.stem.updateRetrievalSettings({ reranker: patch }).then((s) => setRetrieval(s.retrieval));
  }

  if (!retrieval) return null;
  const hint = recallHint(retrieval);
  const summary = health.embed
    ? '! embedding model failed'
    : health.rerank
      ? '! reranker failed'
      : recallSummary(retrieval, settings?.maxRelevantFacts);

  return (
    <>
      <div className="grp-head grp-head-row" ref={headRef} id="memory-retrieval-setup">
        Memory recall
        <InfoTip label="How facts are selected">
          Stem always selects relevant active facts instead of sending the whole memory store.
          Embeddings find candidate facts, and the reranker checks each one against your message.
          Sensitive facts require a direct keyword match or a stronger semantic match, and expired
          or unconfirmed assistant claims are excluded. While two facts conflict, one side may still
          be sent — marked conflicting, so the model treats it as uncertain instead of forgetting both.
          The memory model itself (what learns and tidies) is under Judgment work above.
        </InfoTip>
      </div>
      <SettingSection title="Finding relevant facts" summary={summary} open={open} onOpenChange={setOpen}>
        {hint && <em className="mp-resolved">{hint}</em>}
        {settings && (
          <div className="set-block">
            <span className="set-sub">
              Facts per message{' '}
              <InfoTip label="About pinned facts and matching">
                Up to five facts can be pinned for every message. All other memories need a
                positive semantic or lexical match; there is no recency filler.
              </InfoTip>
            </span>
            <div className="seg-ctl">
              {FACT_INJECT_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className={settings.maxRelevantFacts === p.value ? 'active' : ''}
                  onClick={() => window.stem.setMaxRelevantFacts(p.value).then(setSettings)}
                  title={`Select at most ${p.value} relevant facts, plus up to five pinned facts`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <EmbeddingsFields
          value={retrieval.embeddings}
          custom={retrieval.customEmbedModels}
          onPatch={patchEmbeddings}
          onRetrieval={setRetrieval}
        />
        <RerankerFields
          value={retrieval.reranker}
          embeddings={retrieval.embeddings}
          custom={retrieval.customRerankModels}
          onPatch={patchReranker}
          onRetrieval={setRetrieval}
        />
      </SettingSection>
    </>
  );
}
