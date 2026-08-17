import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  missingModelFiles,
  modelPresent,
  pathAppearsInMessage,
  weightsFile
} from '../../src/server/recall/embed-files';

// What counts as a complete model on disk. The worker turns the Hub OFF when
// this says yes, so a false yes strands the embedder in error on exactly the
// machines that cannot download anything.

const REPO = 'Xenova/multilingual-e5-small';

describe('weightsFile', () => {
  it('maps each dtype to the file transformers.js resolves', () => {
    expect(weightsFile('q8')).toBe('model_quantized.onnx');
    expect(weightsFile('q4')).toBe('model_q4.onnx');
    expect(weightsFile('fp32')).toBe('model.onnx');
  });
});

describe('modelPresent', () => {
  let root: string;

  function write(rel: string, bytes = 32): void {
    const abs = join(root, REPO, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.alloc(bytes));
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stem-embed-files-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is false for a cache that has only the weights', () => {
    write('onnx/model_quantized.onnx', 4 * 1024 * 1024);
    expect(modelPresent(root, REPO, 'q8')).toBe(false);
    expect(missingModelFiles(root, REPO, 'q8')).toEqual([
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json'
    ]);
  });

  it('is true once the config and tokenizer are there too', () => {
    write('config.json');
    write('tokenizer.json');
    write('tokenizer_config.json');
    write('onnx/model_quantized.onnx', 4 * 1024 * 1024);
    expect(modelPresent(root, REPO, 'q8')).toBe(true);
    expect(missingModelFiles(root, REPO, 'q8')).toEqual([]);
  });

  it('wants the _data sidecar when the onnx is only a graph', () => {
    // EmbeddingGemma and friends keep the weights outside the .onnx; the graph
    // on its own loads to an error that no amount of retrying fixes.
    write('config.json');
    write('tokenizer.json');
    write('tokenizer_config.json');
    write('onnx/model_q4.onnx', 200 * 1024);
    expect(missingModelFiles(root, REPO, 'q4')).toEqual(['onnx/model_q4.onnx_data']);
    write('onnx/model_q4.onnx_data', 1024);
    expect(modelPresent(root, REPO, 'q4')).toBe(true);
  });

  it('reports everything missing for a cache that is not there at all', () => {
    expect(missingModelFiles(root, REPO, 'q8')).toHaveLength(4);
    expect(modelPresent(root, REPO, 'q8')).toBe(false);
  });
});

describe('pathAppearsInMessage', () => {
  it('matches whichever slash the ONNX error happened to use', () => {
    const win = 'C:\\Users\\me\\embed-models\\Xenova\\multilingual-e5-small';
    expect(pathAppearsInMessage(`load failed: ${win}\\onnx\\model.onnx`, win)).toBe(true);
    expect(pathAppearsInMessage('load failed: C:/Users/me/embed-models/Xenova/multilingual-e5-small', win)).toBe(
      true
    );
    expect(pathAppearsInMessage('load failed: D:\\somewhere\\else', win)).toBe(false);
  });
});
