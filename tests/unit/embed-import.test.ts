import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  findCustomImportables,
  findImportableModels,
  importCustomModel,
  importLocalModels,
  repoFromPath
} from '../../src/server/recall/embed-import';

// Importing weights the user brought themselves. The three layouts are the three
// ways someone actually ends up holding a model, and the refusals matter as much
// as the copies: the machine this is for cannot download the missing piece.

const REPO = 'Xenova/multilingual-e5-small';
const WEIGHTS = 'onnx/model_quantized.onnx';

let src: string;
let cache: string;

function write(root: string, rel: string, body = 'x'): void {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

/** A complete e5-small under `prefix`, in whichever layout the caller wants. */
function completeModel(root: string, prefix: string): void {
  for (const rel of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) write(root, `${prefix}/${rel}`);
  write(root, `${prefix}/${WEIGHTS}`, 'X'.repeat(4 * 1024 * 1024));
}

beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), 'stem-import-src-'));
  cache = mkdtempSync(join(tmpdir(), 'stem-import-cache-'));
});

afterEach(() => {
  rmSync(src, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});

describe('findImportableModels', () => {
  it('recognises a Stem cache folder', () => {
    completeModel(src, REPO);
    expect(findImportableModels(src).map((m) => m.id)).toEqual(['multilingual-e5-small']);
  });

  it('recognises a Hugging Face snapshot folder', () => {
    completeModel(src, 'models--Xenova--multilingual-e5-small/snapshots/abc123');
    const found = findImportableModels(src);
    expect(found).toHaveLength(1);
    expect(found[0]!.repo).toBe(REPO);
  });

  it('recognises one model on its own', () => {
    completeModel(src, 'Xenova/multilingual-e5-small');
    expect(findImportableModels(join(src, 'Xenova'))).toHaveLength(1);
  });

  it('ignores a folder with the name but no weights', () => {
    write(src, `${REPO}/config.json`);
    expect(findImportableModels(src)).toEqual([]);
  });
});

describe('importLocalModels', () => {
  it('copies a complete model into the cache', () => {
    completeModel(src, REPO);
    const result = importLocalModels(src, cache);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models[0]).toMatchObject({ id: 'multilingual-e5-small', stage: 'embed', alreadyPresent: false });
    expect(readFileSync(join(cache, 'Xenova', 'multilingual-e5-small', 'config.json'), 'utf8')).toBe('x');
  });

  it('refuses and names the file when the folder is half a model', () => {
    completeModel(src, REPO);
    rmSync(join(src, 'Xenova', 'multilingual-e5-small', 'tokenizer.json'));
    const result = importLocalModels(src, cache);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('tokenizer.json');
  });

  it('refuses a folder with no model Stem knows about, and says what it takes', () => {
    write(src, 'some-other-model/onnx/model.onnx');
    const result = importLocalModels(src, cache);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Multilingual E5 Small');
  });

  it('never overwrites what is already in the cache', () => {
    completeModel(src, REPO);
    importLocalModels(src, cache);
    // Whatever is in the cache wins — on Windows a loaded model's ONNX is open
    // and cannot be replaced, and there is nothing to gain from trying.
    writeFileSync(join(cache, 'Xenova', 'multilingual-e5-small', 'config.json'), 'mine');
    const again = importLocalModels(src, cache);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.models[0]!.alreadyPresent).toBe(true);
    expect(readFileSync(join(cache, 'Xenova', 'multilingual-e5-small', 'config.json'), 'utf8')).toBe('mine');
  });

  it('says so when the folder is not there', () => {
    const result = importLocalModels(join(src, 'nope'), cache);
    expect(result.ok).toBe(false);
  });

  // The refusal that isn't a dead end: the folder holds a model, just not one of
  // ours, and the caller can offer to describe it instead of sending the user
  // away to find a catalogued model.
  it('hands back an unrecognised model as a candidate, not just a refusal', () => {
    completeModel(src, 'BAAI/bge-small-en-v1.5');
    const result = importLocalModels(src, cache);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown![0]).toMatchObject({ repo: 'BAAI/bge-small-en-v1.5', dtype: 'q8' });
  });
});

// A model Stem has no entry for. Everything the dialog does NOT ask about is
// inferred here, so this is where a wrong inference has to be caught: the repo id
// becomes the folder under the cache, and the dtype decides which weights file
// the worker (and the offline gate) will look for.
describe('findCustomImportables', () => {
  it('reads the repo id from a Hub cache path, however deep the snapshot sits', () => {
    expect(repoFromPath(join('/tmp', 'models--BAAI--bge-m3', 'snapshots', 'abc123'))).toBe('BAAI/bge-m3');
  });

  it('reads the repo id from a plain org/name folder', () => {
    expect(repoFromPath(join('/tmp', 'hub', 'BAAI', 'bge-m3'))).toBe('BAAI/bge-m3');
  });

  it('reduces a folder name to something that can safely BE a folder', () => {
    // The repo id names a directory under the model cache, so what it may
    // contain is the same question as what a path segment may contain.
    expect(repoFromPath(join('/tmp', 'my models', 'bge m3 (copy)'))).toBe('my-models/bge-m3-copy');
    // Nothing above the folder to read as an org — say so rather than invent one.
    expect(repoFromPath(join('/', 'bge-m3'))).toBe('imported/bge-m3');
  });

  it('derives the dtype from the weights file that is actually there', () => {
    for (const [file, dtype] of [
      ['model_quantized.onnx', 'q8'],
      ['model_q4.onnx', 'q4'],
      ['model.onnx', 'fp32']
    ] as const) {
      const root = join(src, dtype);
      write(root, 'mine/model/config.json');
      write(root, `mine/model/onnx/${file}`, 'X'.repeat(4 * 1024 * 1024));
      expect(findCustomImportables(root)[0]).toMatchObject({ repo: 'mine/model', dtype });
    }
  });

  it('ignores a folder the catalog already claims, so it keeps the named refusal', () => {
    // Half a catalogued model: importLocalModels says which file is missing,
    // which is far more use than being asked to describe it from scratch.
    write(src, `${REPO}/config.json`);
    write(src, `${REPO}/${WEIGHTS}`, 'X'.repeat(4 * 1024 * 1024));
    expect(findCustomImportables(src)).toEqual([]);
  });

  it('ignores a folder with no config.json — nothing there names a model', () => {
    write(src, 'mine/model/onnx/model.onnx', 'X'.repeat(4 * 1024 * 1024));
    expect(findCustomImportables(src)).toEqual([]);
  });

  it('reports the size on disk and the folder name', () => {
    completeModel(src, 'mine/bge-small');
    const [found] = findCustomImportables(src);
    expect(found).toMatchObject({ label: 'bge-small' });
    expect(found!.approxSizeMB).toBeGreaterThanOrEqual(4);
  });
});

describe('importCustomModel', () => {
  it('copies into the cache under the repo id it was given', () => {
    completeModel(src, 'mine/bge-small');
    const result = importCustomModel(join(src, 'mine', 'bge-small'), 'mine/bge-small', 'q8', cache);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(cache, 'mine', 'bge-small', 'config.json'), 'utf8')).toBe('x');
  });

  it('refuses by name when the folder is half a model', () => {
    completeModel(src, 'mine/bge-small');
    rmSync(join(src, 'mine', 'bge-small', 'tokenizer_config.json'));
    const result = importCustomModel(join(src, 'mine', 'bge-small'), 'mine/bge-small', 'q8', cache);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('tokenizer_config.json');
  });
});
