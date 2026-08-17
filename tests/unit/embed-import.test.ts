import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findImportableModels, importLocalModels } from '../../src/server/recall/embed-import';

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
});
