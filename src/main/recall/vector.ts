// Tiny vector helpers shared by the recall retrieval paths — fact ranking
// (inject) and consolidation clustering. Brute-force is fine: fact counts are
// small and the embedding round-trip dominates any arithmetic here.

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function magnitude(a: Float32Array): number {
  return Math.sqrt(dot(a, a));
}

/** Cosine similarity in [-1, 1]; 0 when the lengths differ or either vector is zero. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  const m = magnitude(a) * magnitude(b);
  return m === 0 ? 0 : dot(a, b) / m;
}
