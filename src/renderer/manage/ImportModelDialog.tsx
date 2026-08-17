import { useState } from 'react';
import { FolderInput } from 'lucide-react';
import type {
  CustomEmbedModel,
  CustomImportCandidate,
  CustomRerankModel,
  RetrievalSettings
} from '../../shared/types';

// The questions a model folder cannot answer.
//
// Importing a model Stem HAS an entry for asks nothing — the catalog already
// knows what the weights need. This dialog is what stands in for that entry when
// the folder holds something else: everything derivable is derived before it
// opens (repo id and quantization from the layout, size from disk, name from the
// folder), so what is left is only what no directory listing could tell us.
//
// For an embedder that is one thing: the prompt prefixes it was trained with.
// They cannot be guessed and a wrong answer NEVER errors — it just quietly costs
// recall on every search from then on, which is why it is a question rather than
// a default.
//
// For a reranker it is three: how the model turns a pair into a logit, the
// instruction a yes/no reranker judges against, and the two score floors. The
// floors are the uncomfortable part and the dialog says so: they are
// measurements taken against specific weights (see the long comments in
// server/recall/rerank-catalog.ts), so all anyone can honestly offer here is the
// curated model's numbers as a starting point.

/** Prompt-prefix schemes, mirrored from server/recall/embed-catalog.ts. */
export const PREFIX_SCHEMES: {
  id: 'none' | 'e5' | 'gemma' | 'custom';
  label: string;
  hint: string;
  prefixes: { query: string; passage: string } | null;
}[] = [
  {
    id: 'none',
    label: 'None',
    hint: 'The model takes plain text (BGE, GTE, MiniLM and most sentence-transformers).',
    prefixes: { query: '', passage: '' }
  },
  {
    id: 'e5',
    label: 'E5 style',
    hint: 'Prepends “query: ” and “passage: ” — the E5 and multilingual-E5 family.',
    prefixes: { query: 'query: ', passage: 'passage: ' }
  },
  {
    id: 'gemma',
    label: 'EmbeddingGemma',
    hint: 'The task-prefixed form EmbeddingGemma was trained with.',
    prefixes: { query: 'task: search result | query: ', passage: 'title: none | text: ' }
  },
  { id: 'custom', label: 'Custom', hint: 'Type the two prefixes from the model card.', prefixes: null }
];

/**
 * Starting floors for an imported reranker, mirrored from the curated model with
 * the same scoring mode (server/recall/rerank-catalog.ts). Borrowed, not
 * measured — the labels below say so, and the same numbers are what settings
 * coercion falls back to.
 */
export const CURATED_RERANK_FLOORS: Record<
  CustomRerankModel['scoring'],
  { minRelevantScore: number; factGateScore: number }
> = {
  classifier: { minRelevantScore: -9, factGateScore: -8 },
  'causal-yes-no': { minRelevantScore: -4, factGateScore: -1.5 }
};

/** The instruct line the Qwen3 reranker's floors were measured against. */
export const QWEN3_RERANK_INSTRUCT =
  'Given a user message to a personal assistant, judge whether this stored fact about the user is relevant to answering it';

const SCORING_MODES: { id: CustomRerankModel['scoring']; label: string; hint: string }[] = [
  {
    id: 'classifier',
    label: 'Classifier',
    hint: 'A cross-encoder with a scoring head — the usual reranker (BGE, mxbai, jina).'
  },
  {
    id: 'causal-yes-no',
    label: 'Yes / no',
    hint: 'A chat model asked whether the document answers the query (Qwen3-Reranker and kin).'
  }
];

/** Which scheme these prefixes are, so editing an entry reopens on the right one. */
function schemeOf(prefixes: { query: string; passage: string }): (typeof PREFIX_SCHEMES)[number]['id'] {
  const match = PREFIX_SCHEMES.find(
    (s) => s.prefixes && s.prefixes.query === prefixes.query && s.prefixes.passage === prefixes.passage
  );
  return match?.id ?? 'custom';
}

export function ImportModelDialog({
  stage,
  candidate,
  model,
  onSaved,
  onClose
}: {
  stage: 'embed' | 'rerank';
  /** The folder to import from. Absent when editing a model already imported. */
  candidate?: CustomImportCandidate;
  /** The entry being edited. Absent on a fresh import. */
  model?: CustomEmbedModel | CustomRerankModel;
  /** Saved: the retrieval config as it now stands, dropdown lists included. */
  onSaved: (retrieval: RetrievalSettings) => void;
  onClose: () => void;
}) {
  // What the folder already told us, or what the entry being edited holds.
  const known = candidate ?? model!;
  const embedding = model && 'prefixes' in model ? model : null;
  const reranking = model && 'scoring' in model ? model : null;

  const [label, setLabel] = useState(known.label);
  const [scheme, setScheme] = useState(embedding ? schemeOf(embedding.prefixes) : 'none');
  const [query, setQuery] = useState(embedding?.prefixes.query ?? '');
  const [passage, setPassage] = useState(embedding?.prefixes.passage ?? '');
  const [scoring, setScoring] = useState<CustomRerankModel['scoring']>(reranking?.scoring ?? 'classifier');
  const [instruct, setInstruct] = useState(reranking?.instruct ?? QWEN3_RERANK_INSTRUCT);
  const [minRelevant, setMinRelevant] = useState(
    String(reranking?.minRelevantScore ?? CURATED_RERANK_FLOORS.classifier.minRelevantScore)
  );
  const [factGate, setFactGate] = useState(
    String(reranking?.factGateScore ?? CURATED_RERANK_FLOORS.classifier.factGateScore)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Switching scoring mode re-prefills the floors it borrows — they belong to that mode. */
  function chooseScoring(next: CustomRerankModel['scoring']): void {
    setScoring(next);
    setMinRelevant(String(CURATED_RERANK_FLOORS[next].minRelevantScore));
    setFactGate(String(CURATED_RERANK_FLOORS[next].factGateScore));
  }

  function describe(): CustomEmbedModel | CustomRerankModel | null {
    const base = {
      id: `custom:${known.repo}`,
      repo: known.repo,
      label: label.trim() || known.repo,
      dtype: known.dtype,
      approxSizeMB: known.approxSizeMB
    };
    if (stage === 'embed') {
      const preset = PREFIX_SCHEMES.find((s) => s.id === scheme)?.prefixes;
      return {
        ...base,
        // Kept across an edit: it was measured by the load probe, and nothing
        // else on this screen can know it.
        dim: embedding?.dim ?? null,
        prefixes: preset ?? { query, passage }
      };
    }
    const min = Number(minRelevant);
    const gate = Number(factGate);
    if (!Number.isFinite(min) || !Number.isFinite(gate)) {
      setError('Both score floors have to be numbers — they are raw logits, so negatives are normal.');
      return null;
    }
    return {
      ...base,
      scoring,
      ...(scoring === 'causal-yes-no' && instruct.trim() ? { instruct: instruct.trim() } : {}),
      minRelevantScore: min,
      factGateScore: gate
    };
  }

  async function save(): Promise<void> {
    if (busy) return;
    setError(null);
    const described = describe();
    if (!described) return;
    setBusy(true);
    try {
      const result = candidate
        ? await window.stem.importCustomModel(candidate.sourceDir, stage, described)
        : await window.stem.saveCustomModel(stage, described);
      if (result.ok) onSaved(result.retrieval);
      else setError(result.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mcp-approval-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={candidate ? 'Import a model Stem does not know' : 'Edit an imported model'}
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
      <div className="mcp-approval-card custom-model-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <FolderInput size={15} />
          </span>
          <strong>{candidate ? 'Import a model Stem doesn’t know' : 'Edit imported model'}</strong>
        </div>

        <p className="muted">
          {candidate ? 'Stem has no entry for this model, so it read what it could from the folder: ' : 'From the folder: '}
          <code>{known.repo}</code>, {known.dtype} weights, about {known.approxSizeMB} MB.{' '}
          {stage === 'embed'
            ? 'The one thing a folder can’t say is the prompt prefixes it was trained with.'
            : 'What a folder can’t say is how it scores, and where its scores stop meaning “relevant”.'}
        </p>

        <div className="set-block">
          <span className="set-sub">Name</span>
          <input
            className="ifield"
            value={label}
            aria-label="Model name"
            disabled={busy}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        {stage === 'embed' ? (
          <div className="set-block">
            <span className="set-sub">Prompt prefixes</span>
            <div className="seg-ctl" role="group" aria-label="Prompt prefixes">
              {PREFIX_SCHEMES.map((s) => (
                <button
                  key={s.id}
                  className={scheme === s.id ? 'active' : ''}
                  onClick={() => setScheme(s.id)}
                  disabled={busy}
                  title={s.hint}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <p className="muted">{PREFIX_SCHEMES.find((s) => s.id === scheme)?.hint}</p>
            {scheme === 'custom' && (
              <>
                <input
                  className="ifield"
                  placeholder="Query prefix"
                  aria-label="Query prefix"
                  value={query}
                  disabled={busy}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <input
                  className="ifield"
                  placeholder="Passage prefix"
                  aria-label="Passage prefix"
                  value={passage}
                  disabled={busy}
                  onChange={(e) => setPassage(e.target.value)}
                />
              </>
            )}
            <p className="muted">
              The model card says which of these it wants. Getting it wrong doesn’t fail — searches
              just quietly find less — so it is worth a look.
            </p>
          </div>
        ) : (
          <>
            <div className="set-block">
              <span className="set-sub">How it scores</span>
              <div className="seg-ctl" role="group" aria-label="Scoring">
                {SCORING_MODES.map((m) => (
                  <button
                    key={m.id}
                    className={scoring === m.id ? 'active' : ''}
                    onClick={() => chooseScoring(m.id)}
                    disabled={busy}
                    title={m.hint}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <p className="muted">{SCORING_MODES.find((m) => m.id === scoring)?.hint}</p>
            </div>

            {scoring === 'causal-yes-no' && (
              <div className="set-block">
                <span className="set-sub">The question it answers</span>
                <textarea
                  className="ifield"
                  rows={3}
                  aria-label="Relevance instruction"
                  value={instruct}
                  disabled={busy}
                  onChange={(e) => setInstruct(e.target.value)}
                />
                <p className="muted">
                  Prefilled with the line Stem’s own Qwen3 reranker uses. Rewording it re-poses the
                  question the yes/no scores answer, which moves their scale — so change it and the
                  two floors below stop matching.
                </p>
              </div>
            )}

            <div className="set-block">
              <span className="set-sub">Score floors</span>
              <label className="custom-model-floor">
                <span>Relevant above</span>
                <input
                  className="ifield"
                  type="number"
                  step="0.5"
                  aria-label="Minimum relevant score"
                  value={minRelevant}
                  disabled={busy}
                  onChange={(e) => setMinRelevant(e.target.value)}
                />
              </label>
              <label className="custom-model-floor">
                <span>Send a memory above</span>
                <input
                  className="ifield"
                  type="number"
                  step="0.5"
                  aria-label="Fact gate score"
                  value={factGate}
                  disabled={busy}
                  onChange={(e) => setFactGate(e.target.value)}
                />
              </label>
              <p className="muted">
                Raw logits, not percentages — negative numbers are normal. These are the floors
                Stem measured for its own {scoring === 'causal-yes-no' ? 'Qwen3' : 'BGE'} reranker
                and are <strong>unmeasured for this model</strong>: they are a starting point, not a
                calibration. To get real ones, run <code>npm run eval:skill-retrieval</code> against
                this model.
              </p>
            </div>
          </>
        )}

        {error && <p className="error">{error}</p>}

        <div className="mcp-approval-actions">
          <button type="button" className="push" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="push default" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : candidate ? 'Import this model' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
