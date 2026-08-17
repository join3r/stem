// The import dialog's prefills are copies of catalog data — the renderer cannot
// import main-process modules, so the numbers and strings it offers are written
// out a second time. Copies drift; these assertions are what stops that.
//
// They matter differently per field. A prefix scheme that no longer matches the
// catalog would offer the user "E5 style" and hand them something else, and
// nothing about a wrong prefix ever errors — it just costs recall. A stale floor
// would seed an imported reranker with a number that was never measured for
// ANY model, which is worse than the honest "borrowed from ours" it claims to be.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CURATED_RERANK_FLOORS,
  ImportModelDialog,
  PREFIX_SCHEMES,
  QWEN3_RERANK_INSTRUCT
} from '../../src/renderer/manage/ImportModelDialog';
import { EMBED_CATALOG } from '../../src/server/recall/embed-catalog';
import { RERANK_CATALOG } from '../../src/server/recall/rerank-catalog';
import type { CustomImportCandidate } from '../../src/shared/types';

function scheme(id: string) {
  return PREFIX_SCHEMES.find((s) => s.id === id)!;
}

const candidate: CustomImportCandidate = {
  repo: 'BAAI/bge-small-en-v1.5',
  label: 'bge-small-en-v1.5',
  dtype: 'q8',
  approxSizeMB: 133,
  sourceDir: '/tmp/models/BAAI/bge-small-en-v1.5'
};

function markup(stage: 'embed' | 'rerank'): string {
  return renderToStaticMarkup(
    createElement(ImportModelDialog, { stage, candidate, onSaved: () => {}, onClose: () => {} })
  );
}

describe('import dialog prefills', () => {
  it('offers the E5 and EmbeddingGemma prefixes the catalog actually uses', () => {
    expect(scheme('e5').prefixes).toEqual(EMBED_CATALOG['multilingual-e5-small'].prefixes);
    expect(scheme('gemma').prefixes).toEqual(EMBED_CATALOG['embeddinggemma-300m'].prefixes);
  });

  it('offers "none" as real empty prefixes, not as an absent scheme', () => {
    // A model that takes plain text is a choice the user makes, so it has to be
    // storable — an undefined prefix pair would fall back to whatever coercion
    // defaults to instead.
    expect(scheme('none').prefixes).toEqual({ query: '', passage: '' });
  });

  it('borrows each scoring mode’s floors from the curated model that scores that way', () => {
    for (const spec of Object.values(RERANK_CATALOG)) {
      expect(CURATED_RERANK_FLOORS[spec.scoring]).toEqual({
        minRelevantScore: spec.minRelevantScore,
        factGateScore: spec.factGateScore
      });
    }
  });

  it('prefills the instruct line the Qwen3 floors were measured against', () => {
    expect(QWEN3_RERANK_INSTRUCT).toBe(RERANK_CATALOG['qwen3-reranker-0.6b'].instruct);
  });
});

describe('import dialog', () => {
  it('states what it derived and asks an embedder only about prefixes', () => {
    const html = markup('embed');
    expect(html).toContain('BAAI/bge-small-en-v1.5');
    expect(html).toContain('133 MB');
    for (const s of PREFIX_SCHEMES) expect(html).toContain(s.label);
    // Nothing about scoring belongs on an embedder.
    expect(html).not.toContain('Score floors');
  });

  it('says a reranker’s floors are unmeasured for this model, and how to measure them', () => {
    // The one claim this dialog must never make quietly: the numbers it offers
    // were measured against OTHER weights (see rerank-catalog.ts).
    const html = markup('rerank');
    expect(html).toContain('unmeasured for this model');
    expect(html).toContain('eval:skill-retrieval');
    expect(html).toContain(String(CURATED_RERANK_FLOORS.classifier.minRelevantScore));
  });
});
