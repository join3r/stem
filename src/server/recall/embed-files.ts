import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalEmbedModelSpec } from './embed-catalog';

// What a local model looks like on disk, and whether the worker still needs the
// Hub for it. Kept free of transformers.js so it is unit-testable and shared by
// the worker (which decides whether to go offline) and the import path (which
// decides whether a folder someone handed us is usable) — those two must agree
// about what "complete" means, or import accepts a model that will not load.

export type EmbedDtype = LocalEmbedModelSpec['dtype'];

/** The weights filename transformers.js resolves for each catalog dtype. */
export function weightsFile(dtype: EmbedDtype): string {
  return dtype === 'q8' ? 'model_quantized.onnx' : dtype === 'q4' ? 'model_q4.onnx' : 'model.onnx';
}

/**
 * An ONNX whose weights live in an external `_data` sidecar is just the graph:
 * a few hundred KB against the hundreds of MB of a self-contained one. Every
 * model we ship is ≥120 MB, so anything under this is missing its weights, and
 * the sidecar is required rather than optional. Cheaper and more general than a
 * per-model flag — it holds for imported models nobody has catalogued.
 */
const GRAPH_ONLY_ONNX_MAX_BYTES = 2 * 1024 * 1024;

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * Every file transformers.js reads before this model can run, as paths relative
 * to the repo dir. The `.onnx` alone is NOT a model: without config.json and the
 * tokenizer, a load fails with "not found locally" — which, with the Hub turned
 * off, is a dead end no retry recovers from.
 */
export function requiredModelFiles(root: string, repo: string, dtype: EmbedDtype): string[] {
  const weights = `onnx/${weightsFile(dtype)}`;
  const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', weights];
  const bytes = sizeOf(join(root, repo, weights));
  if (bytes !== null && bytes <= GRAPH_ONLY_ONNX_MAX_BYTES) files.push(`${weights}_data`);
  return files;
}

/** Which of those are absent under `root` — empty means the model is ready to load. */
export function missingModelFiles(root: string, repo: string, dtype: EmbedDtype): string[] {
  try {
    return requiredModelFiles(root, repo, dtype).filter((rel) => !existsSync(join(root, repo, ...rel.split('/'))));
  } catch {
    return requiredModelFiles(root, repo, dtype);
  }
}

/**
 * True when `root` holds a complete copy of this model. The worker uses it to
 * decide whether the Hub is still needed: a cache copied from another machine
 * (or imported from a folder) must not re-check huggingface.co on a laptop that
 * cannot reach it. Deliberately strict — going offline against a half-copied
 * cache is worse than one wasted request, because a failed load poisons
 * transformers.js for the rest of the process (see purgeIfCorrupt).
 */
export function modelPresent(root: string, repo: string, dtype: EmbedDtype): boolean {
  return missingModelFiles(root, repo, dtype).length === 0;
}

/**
 * ONNX error text often uses the other slash than `path.join` on this OS.
 * Match either so a truncated Windows download still counts as "our" file.
 */
export function pathAppearsInMessage(message: string, filePath: string): boolean {
  if (message.includes(filePath)) return true;
  const forward = filePath.replaceAll('\\', '/');
  const back = filePath.replaceAll('/', '\\');
  return message.includes(forward) || message.includes(back);
}
