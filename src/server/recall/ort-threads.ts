// ONNX Runtime intra-op threads for one retrieval-model session
// (embed-worker.ts says why it is half the cores). Pure, so it can be tested
// without loading the worker.

export function ortIntraOpThreads(cores: number, override: string | undefined): number {
  const forced = Number(override);
  if (Number.isInteger(forced) && forced > 0) return forced;
  return Math.max(1, Math.floor(cores / 2));
}
