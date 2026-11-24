// The gate canary: synthetic pairs with the scores the gate model gave them
// where its floors were measured, and the rule that says a run has moved.
import { describe, expect, it } from 'vitest';
import {
  DRIFT_PAIR_LOGITS,
  GATE_CANARY,
  compareGateScores,
  describeGateDrift,
  gateDrift,
  scoreGateCanary,
  type GateCanary
} from '../../src/server/recall/gate-canary';
import { GTE_MODEL_VERSION } from '../../src/server/recall/gte-model-artifact';
import { checkGateScores } from '../../src/server/startup/retrieval';
import { degradations } from '../../src/server/degrade';

describe('the shipped canary', () => {
  it('is for the model release the app ships', () => {
    // A new release changes every score. Measure its floors, then record new
    // references (scripts/gate-canary.mjs --write) — this failing is the reminder.
    expect(GATE_CANARY.model).toBe(GTE_MODEL_VERSION);
  });

  it('has one score per pair on each measured platform, and no pair twice', () => {
    expect(GATE_CANARY.pairs.length).toBeGreaterThanOrEqual(40);
    expect(new Set(GATE_CANARY.pairs.map((p) => `${p.query}\u0000${p.doc}`)).size).toBe(GATE_CANARY.pairs.length);
    expect(Object.keys(GATE_CANARY.reference).sort()).toEqual(['darwin-arm64', 'linux-x64']);
    for (const scores of Object.values(GATE_CANARY.reference)) {
      expect(scores).toHaveLength(GATE_CANARY.pairs.length);
      expect(scores.every((s) => Number.isFinite(s))).toBe(true);
    }
  });

  it('reaches both ends of the score range and the middle a floor decides', () => {
    for (const scores of Object.values(GATE_CANARY.reference)) {
      expect(scores.some((s) => s < -5.5)).toBe(true);
      expect(scores.some((s) => s > 4.5)).toBe(true);
      expect(scores.filter((s) => s > -5 && s < 3).length).toBeGreaterThanOrEqual(6);
    }
  });

  it('records that the two measured platforms are not interchangeable', () => {
    // Same weights, same runtime: about a third of the pairs half a logit apart.
    // If this ever stops holding, the strict rule below can be relaxed.
    const d = compareGateScores(GATE_CANARY.reference['darwin-arm64']!, GATE_CANARY.reference['linux-x64']!)!;
    expect(d.moved).toBeGreaterThan(0.2);
    expect(d.drifted).toBe(true);
  });
});

const SET: GateCanary = {
  model: 'm',
  pairs: Array.from({ length: 10 }, (_, i) => ({ query: `q${i}`, doc: `d${i}` })),
  reference: { 'darwin-arm64': [-6, -6, -5, -4, -2, 0, 2, 4, 5, 6], 'linux-x64': [-6, -6, -5, -3, -1, 1, 2, 4, 5, 6] }
};

describe('the drift rule', () => {
  it('passes a run that repeats its platform’s reference, noise included', () => {
    const scores = SET.reference['darwin-arm64']!.map((s) => s + 0.004);
    expect(gateDrift(scores, 'darwin-arm64', SET)).toMatchObject({ against: 'darwin-arm64', ownPlatform: true, drifted: false, moved: 0 });
  });

  it('flags a run whose scores moved, by the share of moved pairs or by the median', () => {
    const fewBig = SET.reference['darwin-arm64']!.map((s, i) => (i === 4 ? s + 3 : s)); // 1 of 10 moved
    expect(gateDrift(fewBig, 'darwin-arm64', SET)).toMatchObject({ drifted: true, moved: 0.1, max: 3 });
    const allSmall = SET.reference['darwin-arm64']!.map((s) => s + 0.2); // nothing moved, everything shifted
    expect(gateDrift(allSmall, 'darwin-arm64', SET)).toMatchObject({ drifted: true, moved: 0 });
    expect(DRIFT_PAIR_LOGITS).toBe(0.5);
  });

  it('holds a platform to its own reference even when another one is nearer', () => {
    const scores = SET.reference['linux-x64']!;
    expect(gateDrift(scores, 'darwin-arm64', SET)).toMatchObject({ against: 'darwin-arm64', drifted: true });
  });

  it('holds an unmeasured platform to the nearest reference and says so', () => {
    const d = gateDrift(SET.reference['linux-x64']!, 'win32-x64', SET)!;
    expect(d).toMatchObject({ against: 'linux-x64', ownPlatform: false, drifted: false });
    expect(describeGateDrift(d, 'win32-x64')).toMatchObject({ platform: 'win32-x64', against: 'linux-x64', floorsMeasuredHere: false });
  });

  it('judges nothing without a usable reference', () => {
    expect(gateDrift([1, 2], 'darwin-arm64', SET)).toBeNull();
    expect(gateDrift([], 'darwin-arm64', { ...SET, reference: {} })).toBeNull();
    expect(compareGateScores([], [])).toBeNull();
  });

  it('scores the pairs one at a time, in order', async () => {
    const seen: string[] = [];
    let inFlight = 0;
    const scores = await scoreGateCanary(async (query, doc) => {
      expect(++inFlight).toBe(1);
      await Promise.resolve();
      inFlight -= 1;
      seen.push(`${query}/${doc}`);
      return seen.length;
    }, SET);
    expect(scores).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(seen[0]).toBe('q0/d0');
  });
});

describe('the check at start', () => {
  const manager = (score: (i: number) => number, state: 'ready' | 'loading' = 'ready') => {
    let i = 0;
    return {
      calls: () => i,
      rerankStatus: () => ({ model: 'gte', state }),
      rerank: async () => [{ index: 0, score: score(i++) }]
    };
  };
  const gateNotes = () => degradations().filter((d) => d.scope === 'retrieval.gate').length;

  it('stays quiet when the model repeats this platform’s reference', async () => {
    const before = gateNotes();
    const m = manager((i) => GATE_CANARY.reference['linux-x64']![i]!);
    await checkGateScores(m as never, 'linux-x64');
    expect(m.calls()).toBe(GATE_CANARY.pairs.length);
    expect(gateNotes()).toBe(before);
  });

  it('notes it when the scores moved, and never throws', async () => {
    const before = gateNotes();
    await checkGateScores(manager((i) => GATE_CANARY.reference['linux-x64']![i]! + 1.2) as never, 'linux-x64');
    expect(gateNotes()).toBe(before + 1);
    const failing = { rerankStatus: () => ({ model: 'gte', state: 'ready' }), rerank: async () => { throw new Error('worker exited'); } };
    await expect(checkGateScores(failing as never, 'linux-x64')).resolves.toBeUndefined();
    expect(gateNotes()).toBe(before + 1);
  });

  it('does not run against a model that is not loaded', async () => {
    const m = manager(() => 0, 'loading');
    await checkGateScores(m as never, 'linux-x64');
    expect(m.calls()).toBe(0);
  });
});
