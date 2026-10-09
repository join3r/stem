import { rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { log } from '../log';
import type { RetrievalSettings } from '../../shared/types';

/**
 * Hub repos of embedders Stem used to offer and dropped in 0.6.0: EmbeddingGemma
 * 2 replaced EmbeddingGemma 300m outright, and e5-base was the same download as
 * Gemma 2 for older, weaker results. Their settings ids coerce to the default
 * embedder on read (settings.ts), so nothing references these weights again and
 * a few hundred MB each would sit in the model cache forever.
 */
export const RETIRED_EMBED_REPOS: readonly string[] = [
  'Xenova/multilingual-e5-base',
  'onnx-community/embeddinggemma-300m-ONNX'
];

/**
 * Delete retired models from the cache. A repo someone has since imported as a
 * custom model is spared: an import copies into this same `<cacheDir>/<repo>`
 * path, and deleting what the user deliberately brought back would make the
 * import vanish on every launch. Returns the repos actually deleted.
 */
export async function pruneRetiredModels(cacheDir: string, retrieval: RetrievalSettings): Promise<string[]> {
  const imported = new Set([...retrieval.customEmbedModels, ...retrieval.customRerankModels].map((m) => m.repo));
  const removed: string[] = [];
  for (const repo of RETIRED_EMBED_REPOS) {
    if (imported.has(repo)) continue;
    const dir = join(cacheDir, repo);
    try {
      await rm(dir, { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log('retrieval', 'could not delete retired model', { repo, error: String(err) });
      }
      continue;
    }
    removed.push(repo);
    // The owner dir (Xenova/, onnx-community/) goes too once it is empty.
    await rmdir(dirname(dir)).catch(() => {
      // quiet: ENOTEMPTY is the normal answer while another model shares the owner dir.
    });
  }
  if (removed.length) log('retrieval', 'deleted retired models', { repos: removed });
  return removed;
}
