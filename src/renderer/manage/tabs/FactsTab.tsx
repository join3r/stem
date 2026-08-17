import { useEffect, useRef, useState } from 'react';
import { Plug, ChevronRight, X, Check, Trash2, Wand2, Eye, RefreshCw, Pin, RotateCcw, ShieldCheck, Lock, Send, TriangleAlert, FolderInput } from 'lucide-react';
import type {
  DefaultsSettings,
  MemoryContents,
  MemorySettings,
  ModelSummary,
  EmbeddingsMode,
  EmbeddingsSettings,
  LocalEmbedModelId,
  LocalEmbedStatus,
  LocalRerankModelId,
  LocalRerankStatus,
  RerankerMode,
  RerankerSettings,
  RetrievalSettings,
  RetrievalTestResult,
  ActiveFacts,
  FactTier,
  FactDetails,
  FactStatus,
  MemoryConflict,
  AutoResolvedConflict,
  MemoryRebuildStatus,
  ImportedModelInfo,
  CustomEmbedModel,
  CustomImportCandidate,
  CustomRerankModel
} from '../../../shared/types';
import { resolveMemoryModel } from '../../../shared/modelRoles';
import { clampEffort, EffortSelect, effortsOf } from '../../ui/EffortSelect';
import { MdxView } from '../../chat/MdxView';
import { useOffline } from '../../hooks/useServerReachable';
import { useRemoteServer } from '../../hooks/useRemoteServer';
import { ImportModelDialog } from '../ImportModelDialog';
import { ServerFolderPicker } from '../ServerFolderPicker';
import { useRetrievalHealth } from '../../hooks/useRetrievalHealth';
import { HoverTip, InfoTip } from '../../ui/InfoTip';
import { ModelPicker } from '../../ui/ModelPicker';
import { createJobStore, holdFullSpin, useJob, type ActiveFactsViewProps } from './shared';

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

const FACT_INJECT_PRESETS: { label: string; value: number }[] = [
  { label: '4', value: 4 },
  { label: '8', value: 8 },
  { label: '12', value: 12 },
  { label: '16', value: 16 }
];

// The curated local models, mirrored from server/recall/embed-catalog.ts (labels +
// sizes only — the specs live in main; the id is the contract).
const LOCAL_EMBED_MODELS: { id: LocalEmbedModelId; label: string; detail: string }[] = [
  { id: 'multilingual-e5-small', label: 'Multilingual E5 Small', detail: '~120 MB · recommended' },
  { id: 'multilingual-e5-base', label: 'Multilingual E5 Base', detail: '~280 MB · higher quality' },
  { id: 'embeddinggemma-300m', label: 'EmbeddingGemma 300M', detail: '~330 MB · largest' }
];

const EMBED_MODES: { id: EmbeddingsMode; label: string; hint: string }[] = [
  { id: 'local', label: 'Built-in', hint: 'Bundled multilingual model, runs on this Mac' },
  { id: 'remote', label: 'Server', hint: 'Your own OpenAI-compatible endpoint (Ollama, LM Studio…)' },
  { id: 'off', label: 'Off', hint: 'Rank facts by keywords/recency only' }
];

// The curated local rerankers, mirrored from server/recall/rerank-catalog.ts.
const LOCAL_RERANK_MODELS: { id: LocalRerankModelId; label: string; detail: string }[] = [
  { id: 'qwen3-reranker-0.6b', label: 'Qwen3 Reranker 0.6B', detail: '~1.2 GB · multilingual · best recall measured' },
  { id: 'bge-reranker-v2-m3', label: 'BGE Reranker v2 M3', detail: '~570 MB · multilingual · fastest' }
];

/**
 * An imported model as a picker entry. Its size came off the disk it was copied
 * from and its dimension from the load probe, so the line says what is actually
 * known — no dimension yet simply means it has not run once.
 */
function customOption(m: CustomEmbedModel | CustomRerankModel): { id: string; label: string; detail: string } {
  const dim = 'dim' in m && m.dim ? ` · ${m.dim}-dim` : '';
  return { id: m.id, label: m.label, detail: `~${m.approxSizeMB} MB${dim} · imported` };
}

const RERANK_MODES: { id: RerankerMode; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'Rank facts by embedding similarity only' },
  { id: 'local', label: 'Built-in', hint: 'Bundled cross-encoder re-scores the top matches, runs on this Mac' },
  { id: 'remote', label: 'Server', hint: 'Your own /rerank endpoint (llama.cpp --reranking, vLLM, Infinity…)' }
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
              <button className="link-btn" onClick={() => setEditing(m)}>
                Edit
              </button>
              <button className="link-btn danger" onClick={() => void drop(m)}>
                Remove
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

// Embeddings-stage controls: an exclusive Built-in / Server / Off mode, the local
// model picker + live download/ready status, or the remote endpoint fields (free
// text — Stem just makes the HTTP call). Text edits stay local while typing and
// persist on blur; mode/model switches persist immediately.
function EmbeddingsFields({
  value,
  custom,
  onPatch,
  onRetrieval,
  remoteError
}: {
  value: EmbeddingsSettings;
  /** Embedders the user imported — they join the picker below the curated ones. */
  custom: CustomEmbedModel[];
  onPatch: (patch: Partial<EmbeddingsSettings>) => void;
  onRetrieval: (retrieval: RetrievalSettings) => void;
  /** Last recorded failure of the user's remote endpoint, shown under its fields. */
  remoteError?: string | null;
}) {
  const [local, setLocal] = useState(value);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<RetrievalTestResult | null>(null);
  const [status, setStatus] = useState<LocalEmbedStatus | null>(null);
  useEffect(() => setLocal(value), [value]);
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
      {mode === 'remote' && (
        <>
          <input
            className="ifield"
            placeholder="http://localhost:11434"
            aria-label="Embeddings base URL"
            value={local.baseUrl}
            onChange={(e) => setLocal({ ...local, baseUrl: e.target.value })}
            onBlur={() => onPatch({ baseUrl: local.baseUrl })}
          />
          <input
            className="ifield"
            placeholder="qwen3-embedding:4b"
            aria-label="Embeddings model"
            value={local.model}
            onChange={(e) => setLocal({ ...local, model: e.target.value })}
            onBlur={() => onPatch({ model: local.model })}
          />
          <p className="muted">
            Recommended with Ollama: <code>qwen3-embedding:4b</code> — the best cross-language fact
            recall we measured.
          </p>
          <input
            className="ifield"
            type="password"
            placeholder="API key (optional)"
            aria-label="Embeddings API key"
            value={local.apiKey ?? ''}
            onChange={(e) => setLocal({ ...local, apiKey: e.target.value })}
            onBlur={() => onPatch({ apiKey: local.apiKey })}
          />
          {remoteError && (
            <p className="retrieval-status-error">
              <TriangleAlert size={12} /> Error: {remoteError}
            </p>
          )}
        </>
      )}
      {mode !== 'off' && (
        <div className="retrieval-test">
          <button
            className="retrieval-test-btn"
            onClick={runTest}
            disabled={testing}
            title={testing ? 'Testing…' : 'Test connection'}
            aria-label="Test connection"
          >
            <Plug size={14} />
            <span>{testing ? 'Testing…' : 'Test connection'}</span>
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
// Built-in / Server mode, the local model + live download/ready status, or the
// remote endpoint fields. The reranker re-scores the embedding shortlist with a
// cross-encoder — the precision stage that catches cross-language matches
// cosine ranking misses.
function RerankerFields({
  value,
  custom,
  onPatch,
  onRetrieval,
  remoteError
}: {
  value: RerankerSettings;
  /** Rerankers the user imported — they join the picker below the curated ones. */
  custom: CustomRerankModel[];
  onPatch: (patch: Partial<RerankerSettings>) => void;
  onRetrieval: (retrieval: RetrievalSettings) => void;
  /** Last recorded failure of the user's remote endpoint, shown under its fields. */
  remoteError?: string | null;
}) {
  const [local, setLocal] = useState(value);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<RetrievalTestResult | null>(null);
  const [status, setStatus] = useState<LocalRerankStatus | null>(null);
  useEffect(() => setLocal(value), [value]);
  useEffect(() => {
    window.stem.getLocalRerankStatus().then(setStatus);
    return window.stem.onLocalRerankStatus(setStatus);
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

  return (
    <div className="set-block fg-divider">
      <div className="group-row">
        <span className="row-main">
          <strong>
            Reranker{' '}
            <InfoTip label="What the reranker does">
              A second, precision pass: a cross-encoder re-scores the top embedding matches before
              injection, which is what catches cross-language matches (a Slovak question finding an
              English fact). It applies whichever embeddings mode is active — Built-in or Server.
              While off or not ready, ranking uses embedding similarity alone.
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
            value={value.localModel}
            onChange={(e) => {
              setTest(null);
              onPatch({ localModel: e.target.value });
            }}
          >
            {[...LOCAL_RERANK_MODELS, ...custom.map(customOption)].map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.detail})
              </option>
            ))}
          </select>
          <LocalStatusLine status={status} />
          <ImportedModels stage="rerank" models={custom} onRetrieval={onRetrieval} />
        </>
      )}
      {mode === 'remote' && (
        <>
          <input
            className="ifield"
            placeholder="http://localhost:8080"
            aria-label="Reranker base URL"
            value={local.baseUrl}
            onChange={(e) => setLocal({ ...local, baseUrl: e.target.value })}
            onBlur={() => onPatch({ baseUrl: local.baseUrl })}
          />
          <input
            className="ifield"
            placeholder="bge-reranker-v2-m3"
            aria-label="Reranker model"
            value={local.model}
            onChange={(e) => setLocal({ ...local, model: e.target.value })}
            onBlur={() => onPatch({ model: local.model })}
          />
          <input
            className="ifield"
            type="password"
            placeholder="API key (optional)"
            aria-label="Reranker API key"
            value={local.apiKey ?? ''}
            onChange={(e) => setLocal({ ...local, apiKey: e.target.value })}
            onBlur={() => onPatch({ apiKey: local.apiKey })}
          />
          {remoteError && (
            <p className="retrieval-status-error">
              <TriangleAlert size={12} /> Error: {remoteError}
            </p>
          )}
        </>
      )}
      {mode !== 'off' && (
        <div className="retrieval-test">
          <button
            className="retrieval-test-btn"
            onClick={runTest}
            disabled={testing}
            title={testing ? 'Testing…' : 'Test connection'}
            aria-label="Test reranker"
          >
            <Plug size={14} />
            <span>{testing ? 'Testing…' : 'Test connection'}</span>
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
 * The measured-best retrieval setup, stated where it can be seen. Everything the
 * claim rests on lives in recall-bench/ (60 real turns, hand-adjudicated gold):
 * qwen3-embedding:4b via a server endpoint feeding the reranker gate beat the
 * bundled local embedders, every cosine gate, deeper candidate pools, and an
 * external memory system. The row sits outside the collapsed advanced section
 * on purpose — a recommendation hidden behind "advanced" reaches nobody who
 * hasn't already found it.
 */
function RecallQualityRow({
  retrieval,
  onReview
}: {
  retrieval: RetrievalSettings;
  onReview: () => void;
}) {
  const embedBest =
    retrieval.embeddings.mode === 'remote' &&
    /qwen3-embedding/i.test(retrieval.embeddings.model ?? '');
  const rerankOn = retrieval.reranker.mode !== 'off';
  const rerankBest =
    (retrieval.reranker.mode === 'local' && retrieval.reranker.localModel === 'qwen3-reranker-0.6b') ||
    (retrieval.reranker.mode === 'remote' && /qwen3-reranker/i.test(retrieval.reranker.model ?? ''));
  const best = embedBest && rerankBest;
  const hint = best
    ? 'Best measured setup — qwen3-embedding:4b with the Qwen3 reranker'
    : embedBest && !rerankOn
      ? 'Reranker is off — it measured best at choosing which facts to send'
      : embedBest
        ? 'Qwen3 Reranker 0.6B now measures best — switch the reranker model'
        : rerankOn
          ? 'Best measured: qwen3-embedding:4b via a server endpoint (Ollama)'
          : 'Best measured: qwen3-embedding:4b (Ollama) with the Qwen3 reranker';
  return (
    <div className="group-row">
      <span className="row-main">
        <strong>
          Recall quality{' '}
          <InfoTip label="How this was measured">
            Benchmarked on 60 real conversations with hand-labeled relevance:{' '}
            <code>qwen3-embedding:4b</code> (served via Ollama) feeding the Qwen3 Reranker 0.6B chose
            the right facts best — ahead of the bundled local models, larger embedders, similarity
            thresholds, wider candidate pools, and an external memory system. The reranker is what
            catches cross-language and association matches, like a Slovak question finding an
            English fact; the Qwen3 reranker separates those from noise markedly better than BGE.
          </InfoTip>
        </strong>
        <em>{hint}</em>
      </span>
      {best ? (
        <span className="retrieval-test-status ok" title="This is the configuration that measured best">
          <Check size={12} /> in use
        </span>
      ) : (
        <button className="link-btn" onClick={onReview}>
          Review setup
        </button>
      )}
    </div>
  );
}

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

export function FactsTab({ models, activeFacts }: { models: ModelSummary[]; activeFacts: ActiveFactsViewProps }) {
  const { activeThreadId, activeRunning, previewActive, previewDraft, onTogglePreview } = activeFacts;
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [contents, setContents] = useState<MemoryContents | null>(null);
  const offline = useOffline();
  const health = useRetrievalHealth();
  const [showTech, setShowTech] = useState(false);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [showMemories, setShowMemories] = useState(false);
  // Durable facts injected on this chat's last turn, and (when toggled) the set the
  // current draft would inject. Both annotate + sort the stored-facts list below.
  const [lastTurn, setLastTurn] = useState<ActiveFacts | null>(null);
  const [preview, setPreview] = useState<ActiveFacts | null>(null);

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

  // Reveal the stored list when preview turns on, so the re-sorted badges are visible.
  useEffect(() => {
    if (previewActive) setShowMemories(true);
  }, [previewActive]);

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
  // null => use the backend default model for distillation/tidy-up.
  const [memoryModel, setMemoryModel] = useState<string | null>(null);
  const [retrieval, setRetrieval] = useState<RetrievalSettings | null>(null);
  // How hard memory is allowed to think; null = the model's own default.
  const [memoryEffort, setMemoryEffort] = useState<string | null>(null);
  // What "Same as main" means today. Read here so the note under the picker is
  // the same answer the server will reach.
  const [defaults, setDefaults] = useState<DefaultsSettings>({
    model: null,
    backgroundModel: null,
    backgroundEffort: null
  });
  const [showRetrieval, setShowRetrieval] = useState(false);
  const [rebuild, setRebuild] = useState<MemoryRebuildStatus | null>(null);
  const [conflicts, setConflicts] = useState<MemoryConflict[]>([]);
  const [autoResolved, setAutoResolved] = useState<AutoResolvedConflict[]>([]);
  const [showAutoResolved, setShowAutoResolved] = useState(false);
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
    window.stem.getSettings().then((s) => {
      setMemoryModel(s.memory.model);
      setMemoryEffort(s.memory.effort);
      setRetrieval(s.retrieval);
      setDefaults(s.defaults);
    });
    loadTrustState();
  }, []);

  // The contents load rides the consolidation flag rather than mount alone: a
  // pass that ends while this tab is away has no component to hand its result
  // to, so re-read when the flag drops. (Runs on mount too, whatever the flag
  // says — that is the initial load.)
  useEffect(() => {
    loadContents();
  }, [consolidating]);

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

  function selectMemoryModel(id: string | null) {
    setMemoryModel(id);
    // A level the new model can't do is a setting that reads as chosen and isn't.
    const effort = clampEffort(models, resolveMemoryModel(id, defaults.model), memoryEffort);
    setMemoryEffort(effort);
    window.stem.updateMemorySettings({ model: id, effort }).then((s) => {
      setMemoryModel(s.memory.model);
      setMemoryEffort(s.memory.effort);
    });
  }

  function patchEmbeddings(patch: Partial<EmbeddingsSettings>) {
    window.stem.updateRetrievalSettings({ embeddings: patch }).then((s) => setRetrieval(s.retrieval));
  }

  function patchReranker(patch: Partial<RerankerSettings>) {
    window.stem.updateRetrievalSettings({ reranker: patch }).then((s) => setRetrieval(s.retrieval));
  }

  function selectTidyThreshold(n: number) {
    window.stem.setTidyThreshold(n).then(setSettings);
  }

  function selectFactThreshold(n: number) {
    window.stem.setMaxRelevantFacts(n).then(setSettings);
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
            : `Merged ${r.merged}, corrected ${r.corrected}, retired ${r.dropped} — retired facts move to Superseded below`;
        return r.failedChunks > 0
          ? `${outcome}. The memory model failed on ${r.failedChunks} ${r.failedChunks === 1 ? 'batch' : 'batches'} of facts — those weren't reviewed; try again.`
          : `${outcome}.`;
      } catch {
        return 'Consolidation failed — try again.';
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
  // belong in the live list or its count. They collapse into their own section.
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
  const orderedNotes = notes
    .map((f, i) => ({ f, i, g: groupOf(f.id) }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((x) => x.f);

  function renderNote(f: (typeof allNotes)[number]) {
    const active = f.id != null && draftIds?.has(f.id) ? 'draft' : f.id != null && lastIds.has(f.id) ? 'injected' : null;
    return (

              <div key={f.name} className={`memory-note${active ? ' active' : ''}`}>
                <div className="memory-note-body">
                  {f.statement ? (
                    <button className="memory-statement" onClick={() => f.id != null && void toggleDetails(f.id)}>
                      {f.statement}
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
                          {e.origin === 'folder_doc' ? `file ${e.relPath ?? '(unknown)'}` : EVIDENCE_ORIGIN_LABEL[e.origin] ?? e.origin}: {e.excerpt}
                        </blockquote>
                      ))}
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
                        {f.source !== 'On request' && (f.confidence ?? 1) < 0.7 && (
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
        // controls live in the collapsed advanced section below, and an error
        // only visible there is an error nobody sees. Recall keeps working
        // while this shows, just worse: the summary line names what the
        // ranking has degraded to. "Model" vs "server" per the failure's
        // source, so a dead Ollama isn't blamed on the bundled model.
        <div className="retrieval-alert" role="alert">
          <TriangleAlert size={16} />
          <div className="retrieval-alert-msg">
            {health.embed && (
              <span>
                <strong>{health.embed.remote ? 'Embeddings server failed.' : 'Embedding model failed.'}</strong>{' '}
                {health.embed.error}
              </span>
            )}
            {health.rerank && (
              <span>
                <strong>{health.rerank.remote ? 'Reranker server failed.' : 'Reranker model failed.'}</strong>{' '}
                {health.rerank.error}
              </span>
            )}
            <span className="muted">
              {health.embed
                ? 'Until this is fixed, memories are picked by keywords and recency alone — matches by meaning are missed.'
                : 'Until this is fixed, memories rank by embedding similarity alone — cross-language matches are missed.'}
            </span>
          </div>
          <button className="link-btn" onClick={() => setShowRetrieval(true)}>
            Review setup
          </button>
        </div>
      )}
      <div className="grp-head">Memory</div>
      <div className="group">
        <div className="group-row">
          <span className="row-main">
            <strong>Memory</strong>
            <em>Remember across conversations</em>
          </span>
          <button
            className={`switch${settings.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={settings.enabled}
            aria-label="Memory"
            onClick={toggle}
          />
        </div>
        {settings.enabled && retrieval && (
          <RecallQualityRow retrieval={retrieval} onReview={() => setShowRetrieval(true)} />
        )}
      </div>

      <div className="grp-head grp-head-row">
        Model
        <InfoTip label="About the memory model">
          Used to distill and tidy up memories in the background. Left unset it follows the model
          you chat with — deliberately <em>not</em> the shared Quick tasks model in Settings →
          Models, because this job reads a whole transcript plus everything already remembered, and
          a model too small to hold that stops learning without ever reporting an error. Pin a
          solid mid-tier model here if you would rather not spend your best one on it.
        </InfoTip>
      </div>
      <div className="formgroup">
        <ModelPicker
          models={models}
          value={memoryModel}
          onChange={selectMemoryModel}
          emptyLabel="Same as main"
          ariaLabel="Memory model"
          resolvedDefault={defaults.model}
        />
        <EffortSelect
          label="Memory effort"
          value={memoryEffort}
          efforts={effortsOf(models, resolveMemoryModel(memoryModel, defaults.model))}
          onChange={(effort) => {
            setMemoryEffort(effort);
            window.stem.updateMemorySettings({ effort }).then((s) => setMemoryEffort(s.memory.effort));
          }}
        />
        <div className="set-block fg-divider">
          <span className="set-sub">Tidy up automatically</span>
          <div className="seg-ctl">
            {TIDY_PRESETS.map((p) => (
              <button
                key={p.label}
                className={settings.tidyThreshold === p.value ? 'active' : ''}
                onClick={() => selectTidyThreshold(p.value)}
                title={`Tidy up ${p.hint}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="muted">Stem merges duplicates and drops stale facts once this many new ones accumulate.</p>
        </div>
      </div>

      {rebuild && rebuild.state !== 'complete' && (
        <>
          <div className="grp-head">Memory upgrade</div>
          <div className="formgroup memory-rebuild-card">
            <strong>Rebuild provenance for existing memory</strong>
            <p className="muted">
              {rebuild.totalMessages} stored messages can be reprocessed to attach evidence, sensitivity,
              validity, and conflict information. This uses the selected memory model; a remote model sends
              transcript segments to that provider and may incur usage costs. Existing memories remain usable.
            </p>
            {rebuild.state !== 'available' && (
              <p className="muted">
                {rebuild.processedMessages} of {rebuild.totalMessages} messages · {rebuild.state}
                {rebuild.lastError ? ` · ${rebuild.lastError}` : ''}
              </p>
            )}
            <div className="memory-view-actions">
              {rebuild.state === 'available' && (
                <button className="link-btn" onClick={() => window.stem.startMemoryRebuild().then(setRebuild)}>
                  Start rebuild
                </button>
              )}
              {rebuild.state === 'running' && (
                <button className="link-btn" onClick={() => window.stem.pauseMemoryRebuild().then(setRebuild)}>
                  Pause
                </button>
              )}
              {(rebuild.state === 'paused' || rebuild.state === 'failed') && (
                <button className="link-btn" onClick={() => window.stem.resumeMemoryRebuild().then(setRebuild)}>
                  {rebuild.state === 'failed' ? 'Retry' : 'Resume'}
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {conflicts.length > 0 && (
        <>
          <div className="grp-head">Conflicts ({conflicts.length})</div>
          <div className="formgroup memory-conflicts">
            {conflicts.map((c) => (
              <div key={c.id} className="memory-conflict">
                {orderedConflictFacts(c).map((f, i) => (
                  <div key={f.id} className="memory-conflict-side">
                    <span className="chip">{i === 0 ? 'Newer' : 'Older'}</span>
                    <p>{f.text}</p>
                    <span className="muted">
                      Learned {new Date(f.updatedAt * 1000).toLocaleDateString()}
                    </span>
                  </div>
                ))}
                <em>{c.reason}</em>
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

      {autoResolved.length > 0 && (
        <>
          <div className="grp-head grp-head-row">
            <button
              className="memory-view-toggle"
              aria-expanded={showAutoResolved}
              onClick={() => setShowAutoResolved((v) => !v)}
            >
              <ChevronRight size={14} className={showAutoResolved ? 'open' : ''} />
              <strong>Recently auto-resolved ({autoResolved.length})</strong>
            </button>
            <InfoTip label="About auto-resolved conflicts">
              Conflicts between non-protected memories are adjudicated in the background:
              one side superseded, both kept, or both rewritten into clearer facts.
              Anything superseded here is recoverable from the superseded list below.
            </InfoTip>
          </div>
          {showAutoResolved && (
            <div className="formgroup memory-conflicts">
              {autoResolved.map((c) => (
                <div key={c.id} className="memory-conflict">
                  {[c.factA, c.factB].map((f) => (
                    <div key={f.id} className="memory-conflict-side">
                      <span className="chip">{f.status === 'superseded' ? 'Superseded' : 'Kept'}</span>
                      <p className={f.status === 'superseded' ? 'muted' : undefined}>{f.text}</p>
                    </div>
                  ))}
                  <em>
                    {AUTO_RESOLUTION_LABEL[c.resolution]} ·{' '}
                    {new Date(c.resolvedAt * 1000).toLocaleDateString()}
                  </em>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {retrieval && (
        <>
          <div className="grp-head grp-head-row">
            <button
              className="memory-view-toggle"
              aria-expanded={showRetrieval}
              onClick={() => setShowRetrieval((v) => !v)}
            >
              <ChevronRight size={14} className={showRetrieval ? 'open' : ''} />
              <strong>Relevance ranking (advanced)</strong>
            </button>
            <InfoTip label="How facts are selected">
              Stem always selects relevant active facts instead of sending the whole memory store.
              Sensitive facts require a direct keyword match or a stronger semantic match, and expired
              or unconfirmed assistant claims are excluded. While two facts conflict, one side may still
              be sent — marked conflicting, so the model treats it as uncertain instead of forgetting both.
            </InfoTip>
          </div>
          {showRetrieval && (
            <div className="formgroup">
              <div className="set-block">
                <span className="set-sub">
                  Relevant facts per message{' '}
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
                      onClick={() => selectFactThreshold(p.value)}
                      title={`Select at most ${p.value} relevant facts, plus up to five pinned facts`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <EmbeddingsFields
                value={retrieval.embeddings}
                custom={retrieval.customEmbedModels}
                onPatch={patchEmbeddings}
                onRetrieval={setRetrieval}
                remoteError={health.embed?.remote ? health.embed.error : null}
              />
              <RerankerFields
                value={retrieval.reranker}
                custom={retrieval.customRerankModels}
                onPatch={patchReranker}
                onRetrieval={setRetrieval}
                remoteError={health.rerank?.remote ? health.rerank.error : null}
              />
            </div>
          )}
        </>
      )}

      <div className="memory-view">
        <div className="memory-view-head">
          <button
            className="memory-view-toggle"
            aria-expanded={showMemories}
            onClick={() => setShowMemories((v) => !v)}
          >
            <ChevronRight size={14} className={showMemories ? 'open' : ''} />
            <strong>Stored memory{notes.length ? ` (${notes.length})` : ''}</strong>
          </button>
          <span className="memory-view-actions">
            <button
              className={`link-btn icon-only${previewActive ? ' on' : ''}`}
              onClick={onTogglePreview}
              data-label="Preview draft"
              aria-label="Preview which facts your current draft would inject"
              aria-pressed={previewActive}
            >
              <Eye size={15} />
            </button>
            <button
              className="link-btn icon-only"
              onClick={consolidate}
              disabled={consolidating || !settings.enabled || notes.length < 2}
              data-label={consolidating ? 'Tidying…' : 'Tidy up'}
              aria-label="Tidy up: merge duplicates and drop stale facts"
            >
              <Wand2 size={15} className={consolidating ? 'spin' : undefined} />
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
        {activeThreadId && lastTurn && (
          <p className="muted active-facts-summary">
            Last turn: {lastTurn.facts.length} {lastTurn.facts.length === 1 ? 'fact' : 'facts'} via{' '}
            {tierLabel(lastTurn.tier)}.
          </p>
        )}
        {previewActive && (
          <p className="muted active-facts-summary">
            {preview
              ? `Draft preview: ${preview.facts.length} ${preview.facts.length === 1 ? 'fact' : 'facts'} via ${tierLabel(preview.tier)}.`
              : 'Draft preview: computing…'}
          </p>
        )}
        {consolidateMsg && <p className="muted">{consolidateMsg}</p>}
        {!contents && (
          <p className="muted">
            {offline ? 'Your memory lives on Stem’s server, which can’t be reached right now.' : 'Loading…'}
          </p>
        )}
        {showMemories && contents && notes.length === 0 && (
          <p className="muted">No memories stored yet — Stem builds these as you chat.</p>
        )}
        {showMemories && orderedNotes.map(renderNote)}

        {showMemories && supersededNotes.length > 0 && (
          <div className="memory-tech">
            <button
              className="memory-tech-head"
              aria-expanded={showSuperseded}
              onClick={() => setShowSuperseded((v) => !v)}
            >
              <ChevronRight size={14} className={showSuperseded ? 'open' : ''} />
              <span>Superseded ({supersededNotes.length})</span>
            </button>
            {showSuperseded && supersededNotes.map(renderNote)}
          </div>
        )}

        {techFiles.length > 0 && (
          <div className="memory-tech">
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
          <div className="memory-reset">
            {confirmReset ? (
              <span className="memory-reset-confirm">
                <span className="muted">
                  Erase all {notes.length} {notes.length === 1 ? 'fact' : 'facts'}? This can’t be undone.
                </span>
                <button className="link-btn danger" onClick={reset} disabled={resetting}>
                  {resetting ? 'Resetting…' : 'Erase facts'}
                </button>
                <button className="link-btn" onClick={() => setConfirmReset(false)} disabled={resetting}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                className="link-btn danger memory-reset-trigger"
                onClick={reset}
                title="Permanently erase all durable facts (keeps episodic recall + your files)"
              >
                <Trash2 size={12} /> Reset facts
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
