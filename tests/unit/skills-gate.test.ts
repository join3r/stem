// The cut: which ranked skills get their bodies inlined. Pure arithmetic, so
// unlike skills-inject.test.ts this needs no skills dir, no fake embedder and no
// filesystem — every case states the scores it wants directly.
//
// What these assert is mostly INVARIANTS rather than tuned numbers. Whether
// minZ should be 2.0 is a question for scripts/skill-retrieval-eval.mjs against
// real inference; whether a flat score profile inlines nothing is a question
// about the code, and that is what belongs here.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_INLINED,
  DEFAULT_SHORTLIST_SIZE,
  LEGACY_MIN_COSINE,
  queryHasSignal,
  selectCut,
  type ScoredSkill
} from '../../src/server/skills/gate';

/** The floor production reads from RERANK_CATALOG; stated here, not defaulted. */
const BGE_FLOOR = -8;

/** A candidate list from bare cosines, best first. */
function cands(...cosines: number[]): ScoredSkill[] {
  return cosines.map((cosine, i) => ({ slug: `s${i + 1}`, cosine }));
}

/** A flat pack of `n` candidates around `base`, so tests can supply a background. */
function pack(n: number, base = 0.4): ScoredSkill[] {
  return Array.from({ length: n }, (_, i) => ({
    slug: `bg${i + 1}`,
    // Deliberately not identical: a zero-variance background is its own case.
    cosine: base + (i % 2 === 0 ? 0.005 : -0.005)
  }));
}

describe('selectCut — degenerate inputs', () => {
  it('returns empty for an empty library', () => {
    expect(selectCut([])).toEqual({ inlined: [], reason: 'empty' });
  });

  it('returns empty when maxInlined is zero', () => {
    expect(selectCut(cands(0.9, 0.2), { maxInlined: 0 }).reason).toBe('empty');
  });

  it('sorts defensively rather than trusting caller order', () => {
    const out = selectCut(
      [
        { slug: 'low', cosine: 0.1 },
        { slug: 'high', cosine: 0.9 }
      ],
      { strategy: 'topk', maxInlined: 1 }
    );
    expect(out.inlined).toEqual(['high']);
  });
});

describe('selectCut — relative', () => {
  it('inlines a candidate that stands clear of the pack', () => {
    const out = selectCut([{ slug: 'win', cosine: 0.8 }, ...pack(8)], { strategy: 'relative' });
    expect(out.reason).toBe('separated');
    expect(out.inlined).toEqual(['win']);
  });

  it('inlines nothing when the profile is flat, however high the scores', () => {
    // Every score is high in absolute terms and none stands out. An absolute
    // gate inlines two here; the whole point of the relative cut is that it
    // does not, because "high" is not a property a cosine has on its own.
    const out = selectCut(pack(10, 0.85), { strategy: 'relative' });
    expect(out.reason).toBe('no-separation');
    expect(out.inlined).toEqual([]);
  });

  it('can take two bodies when two candidates share a lead', () => {
    const out = selectCut([{ slug: 'a', cosine: 0.82 }, { slug: 'b', cosine: 0.8 }, ...pack(8)], {
      strategy: 'relative'
    });
    expect(out.inlined).toEqual(['a', 'b']);
  });

  it('never exceeds maxInlined', () => {
    const out = selectCut(
      [{ slug: 'a', cosine: 0.9 }, { slug: 'b', cosine: 0.89 }, { slug: 'c', cosine: 0.88 }, ...pack(8)],
      { strategy: 'relative', maxInlined: 2 }
    );
    expect(out.inlined).toHaveLength(2);
  });

  it('reports the background stats it decided on', () => {
    const out = selectCut([{ slug: 'win', cosine: 0.8 }, ...pack(8)], { strategy: 'relative' });
    // 9 candidates, cut points at ranks 1 and 2, so the background is everything
    // from rank 4 down — the six no cut point can reach.
    expect(out.stats?.backgroundSize).toBe(6);
    expect(out.stats?.topZ).toBeGreaterThan(2);
    expect(out.stats?.gapSigma).toHaveLength(DEFAULT_MAX_INLINED);
  });

  it('treats a zero-variance background as no evidence, not as infinite evidence', () => {
    // Dividing by this sigma would manufacture separation out of a broken
    // embedder returning one vector for everything.
    const flat: ScoredSkill[] = [
      { slug: 'top', cosine: 0.9 },
      ...Array.from({ length: 8 }, (_, i) => ({ slug: `f${i}`, cosine: 0.5 }))
    ];
    const out = selectCut(flat, { strategy: 'relative' });
    expect(out.reason).toBe('no-separation');
    expect(out.inlined).toEqual([]);
  });

  it('falls back to top-k when the library is too small to sample a background', () => {
    const out = selectCut(cands(0.9, 0.5, 0.4), { strategy: 'relative' });
    expect(out.reason).toBe('small-library');
    expect(out.inlined).toEqual(['s1', 's2']);
  });

  it('is scale-free: multiplying every score leaves the decision unchanged', () => {
    // The property that makes this survive an embedding-model swap. A cosine
    // gate fails exactly here.
    const base = [{ slug: 'win', cosine: 0.8 }, ...pack(8)];
    const squashed = base.map((c) => ({ ...c, cosine: 0.7 + c.cosine * 0.3 }));
    expect(selectCut(squashed, { strategy: 'relative' }).inlined).toEqual(
      selectCut(base, { strategy: 'relative' }).inlined
    );
  });
});

describe('selectCut — rerank', () => {
  const withScores = (pairs: Array<[string, number, number]>): ScoredSkill[] =>
    pairs.map(([slug, cosine, rerankScore]) => ({ slug, cosine, rerankScore }));

  it('inlines what clears the cross-encoder floor, ordered by the cross-encoder', () => {
    const out = selectCut(
      withScores([
        ['a', 0.9, -9],
        ['b', 0.8, -2],
        ['c', 0.7, -11]
      ]),
      { strategy: 'rerank', minRerankScore: BGE_FLOOR }
    );
    // b wins despite ranking second on cosine — that reordering is the reason
    // the cross-encoder stage exists.
    expect(out.inlined).toEqual(['b']);
    expect(out.reason).toBe('above-floor');
  });

  it('inlines nothing when everything sits at the saturation floor', () => {
    const out = selectCut(
      withScores([
        ['a', 0.9, -11],
        ['b', 0.8, -11.02]
      ]),
      { strategy: 'rerank', minRerankScore: BGE_FLOOR }
    );
    expect(out).toMatchObject({ inlined: [], reason: 'below-floor' });
  });

  it('distinguishes "reranker said no" from "reranker never ran"', () => {
    // Both produce an empty list; only one of them means the caller should
    // degrade to the cosine-only cut, so they must not share a reason.
    const out = selectCut(cands(0.9, 0.8, 0.7), { strategy: 'rerank', minRerankScore: BGE_FLOOR });
    expect(out.reason).toBe('no-rerank-score');
  });

  it('refuses to cut when the backend has no calibrated floor', () => {
    // A remote /rerank server returns scores on an unknown scale. Guessing a
    // floor for it is how a per-model constant escapes into shared logic.
    const scored: ScoredSkill[] = [
      { slug: 'a', cosine: 0.9, rerankScore: 0.98 },
      { slug: 'b', cosine: 0.5, rerankScore: 0.02 }
    ];
    expect(selectCut(scored, { strategy: 'rerank' }).reason).toBe('no-rerank-score');
  });

  it('only considers the cosine shortlist', () => {
    // A skill the bi-encoder ranked last cannot be rescued by a high
    // cross-encoder score: that is what bounds both cost and false loads.
    const many: ScoredSkill[] = Array.from({ length: 10 }, (_, i) => ({
      slug: `s${i}`,
      cosine: 0.9 - i * 0.05,
      rerankScore: i === 9 ? 0 : -11
    }));
    expect(selectCut(many, { strategy: 'rerank', minRerankScore: BGE_FLOOR }).inlined).toEqual([]);
    expect(
      selectCut(many, { strategy: 'rerank', minRerankScore: BGE_FLOOR, shortlistSize: 10 }).inlined
    ).toEqual(['s9']);
  });

  it('keeps no floor of its own — that constant belongs to the model', async () => {
    expect(DEFAULT_SHORTLIST_SIZE).toBe(4);
    const mod = await import('../../src/server/skills/gate');
    expect(Object.keys(mod)).not.toContain('DEFAULT_MIN_RERANK_SCORE');
  });
});

describe('selectCut — fixed (legacy) and topk', () => {
  it('fixed reproduces the shipped absolute-cosine behaviour', () => {
    const out = selectCut(cands(0.75, 0.71, 0.4), { strategy: 'fixed' });
    expect(out.inlined).toEqual(['s1']);
    expect(LEGACY_MIN_COSINE).toBe(0.72);
  });

  it('fixed inlines nothing once the model’s scale shifts below the floor', () => {
    // The production failure, reproduced: identical ranking, every score
    // shifted down by a model swap, nothing survives.
    const out = selectCut(cands(0.66, 0.6, 0.5), { strategy: 'fixed' });
    expect(out).toMatchObject({ inlined: [], reason: 'below-floor' });
    // The relative cut is unmoved by the same shift.
    expect(selectCut([{ slug: 'win', cosine: 0.66 }, ...pack(8, 0.3)], { strategy: 'relative' }).inlined).toEqual([
      'win'
    ]);
  });

  it('topk always inlines, and is the upper bound on both recall and noise', () => {
    const out = selectCut(pack(10, 0.4), { strategy: 'topk' });
    expect(out.inlined).toHaveLength(DEFAULT_MAX_INLINED);
    expect(out.reason).toBe('topk');
  });
});

describe('queryHasSignal — the low-signal gate', () => {
  it('refuses one- and two-word acknowledgements in either language', () => {
    // "Try now" is verbatim from the 2026-08-22 session where it cleared the
    // calibrated cross-encoder floor; the rest are the observed shapes around it.
    for (const q of ['Try now', 'Áno', 'ok', 'skús teraz', '', '   ', '?!', 'try ... now']) {
      expect(queryHasSignal(q), q).toBe(false);
    }
  });

  it('passes anything that names an actual task', () => {
    for (const q of [
      'implement docx indexing',
      'nahlás poistnú udalosť na aute',
      'summarise this youtube video for me'
    ]) {
      expect(queryHasSignal(q), q).toBe(true);
    }
  });

  it('counts words, not characters or punctuation', () => {
    expect(queryHasSignal('a b c')).toBe(true);
    expect(queryHasSignal('supercalifragilisticexpialidocious')).toBe(false);
  });
});
