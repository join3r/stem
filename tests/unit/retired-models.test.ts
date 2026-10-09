import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneRetiredModels } from '../../src/server/recall/retired-models';
import type { RetrievalSettings } from '../../src/shared/types';

let cache: string;
const model = (repo: string) => {
  mkdirSync(join(cache, repo, 'onnx'), { recursive: true });
  writeFileSync(join(cache, repo, 'onnx', 'model_quantized.onnx'), 'x');
};
const retrieval = (importedRepos: string[] = []) =>
  ({
    customEmbedModels: importedRepos.map((repo) => ({ id: `custom:${repo}`, repo })),
    customRerankModels: []
  }) as unknown as RetrievalSettings;

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'retired-models-'));
});
afterEach(() => rmSync(cache, { recursive: true, force: true }));

describe('pruneRetiredModels', () => {
  it('deletes the retired embedders and nothing else', async () => {
    model('Xenova/multilingual-e5-base');
    model('Xenova/multilingual-e5-small');
    model('onnx-community/embeddinggemma-300m-ONNX');
    expect(await pruneRetiredModels(cache, retrieval())).toEqual([
      'Xenova/multilingual-e5-base',
      'onnx-community/embeddinggemma-300m-ONNX'
    ]);
    expect(existsSync(join(cache, 'Xenova/multilingual-e5-base'))).toBe(false);
    expect(existsSync(join(cache, 'Xenova/multilingual-e5-small'))).toBe(true);
    // The emptied owner dir goes with its last model.
    expect(existsSync(join(cache, 'onnx-community'))).toBe(false);
  });

  it('spares a retired model the user imported back as a custom one', async () => {
    model('onnx-community/embeddinggemma-300m-ONNX');
    expect(await pruneRetiredModels(cache, retrieval(['onnx-community/embeddinggemma-300m-ONNX']))).toEqual([]);
    expect(existsSync(join(cache, 'onnx-community/embeddinggemma-300m-ONNX'))).toBe(true);
  });

  it('is a no-op on a cache that never had them', async () => {
    expect(await pruneRetiredModels(cache, retrieval())).toEqual([]);
  });
});
