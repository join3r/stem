import { describe, expect, it } from 'vitest';
import { GTE_MAX_PAIR_TOKENS, readGteScalarScore, validateGtePairTokens } from '../../src/server/recall/rerank-score';

describe('GTE pair bounds', () => {
  const input = (tokens: number, dims = [1, tokens]) => ({ dims, data: new BigInt64Array(tokens) });

  it('accepts the full window and rejects the first token beyond it', () => {
    expect(() => validateGtePairTokens(input(GTE_MAX_PAIR_TOKENS))).not.toThrow();
    expect(() => validateGtePairTokens(input(GTE_MAX_PAIR_TOKENS + 1))).toThrow('exceeds 8192 tokens');
  });

  it('rejects batches, empty pairs, and inconsistent tensor dimensions', () => {
    for (const ids of [input(8, [2, 4]), input(0), input(4, [1, 8]), input(4, [4]), input(4, [1, NaN])]) {
      expect(() => validateGtePairTokens(ids)).toThrow('exactly one tokenized pair');
    }
  });
});

describe('GTE scalar logits', () => {
  it('preserves negative raw logits across scalar tensor shapes', () => {
    for (const dims of [[], [1], [1, 1]]) {
      expect(readGteScalarScore({ dims, data: new Float32Array([-7.25]) })).toBe(-7.25);
    }
  });

  it('rejects vector heads, empty output, and inconsistent tensor dimensions', () => {
    for (const logits of [
      { dims: [1, 2], data: new Float32Array([1, 2]) },
      { dims: [0], data: new Float32Array() },
      { dims: [2, 1], data: new Float32Array([1]) }
    ]) {
      expect(() => readGteScalarScore(logits)).toThrow('exactly one scalar logit');
    }
  });

  it.each([NaN, Infinity, -Infinity])('rejects a nonfinite raw logit: %s', (score) => {
    expect(() => readGteScalarScore({ dims: [1, 1], data: new Float32Array([score]) })).toThrow('nonfinite');
  });
});
