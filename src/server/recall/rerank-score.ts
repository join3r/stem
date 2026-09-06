/** The experimental GTE export's full pair window, including special tokens. */
export const GTE_MAX_PAIR_TOKENS = 8192;

/** Reject malformed or oversized inputs before allocating the ONNX working set. */
export function validateGtePairTokens(inputIds: { dims: number[]; data: ArrayLike<unknown> }): void {
  const [batch, tokens] = inputIds.dims;
  if (
    inputIds.dims.length !== 2 || batch !== 1 ||
    !Number.isInteger(tokens) || tokens < 1 || inputIds.data.length !== tokens
  ) {
    throw new Error('GTE requires exactly one tokenized pair');
  }
  if (tokens > GTE_MAX_PAIR_TOKENS) {
    throw new Error(`GTE pair exceeds ${GTE_MAX_PAIR_TOKENS} tokens (${tokens}); truncation is disabled`);
  }
}

/** Preserve the export's raw scale: no sigmoid, pooling, or class selection. */
export function readGteScalarScore(logits: { dims: number[]; data: ArrayLike<number> }): number {
  if (logits.data.length !== 1 || logits.dims.some((size) => size !== 1)) {
    throw new Error('GTE requires exactly one scalar logit');
  }
  const score = logits.data[0];
  if (!Number.isFinite(score)) throw new Error('GTE returned a nonfinite scalar logit');
  return score;
}
