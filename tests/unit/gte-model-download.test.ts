import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGteModelDownloader } from '../../src/server/recall/gte-model-download';
import { GTE_MODEL_ARTIFACT, type GteModelArtifact } from '../../src/server/recall/gte-model-artifact';

const contents: Record<string, string> = { 'config.json': 'config', 'onnx/model_quantized.onnx': 'tiny fixture model' };
const artifact: GteModelArtifact = {
  repo: GTE_MODEL_ARTIFACT.repo,
  revision: GTE_MODEL_ARTIFACT.revision,
  files: Object.fromEntries(Object.entries(contents).map(([name, value]) => [name, {
    sha256: createHash('sha256').update(value).digest('hex'), size: Buffer.byteLength(value)
  }]))
};
const directories: string[] = [];
async function directory() {
  const result = await mkdtemp(join(tmpdir(), 'gte-download-test-'));
  directories.push(result);
  return result;
}
async function install(path: string, files = contents) {
  for (const [name, value] of Object.entries(files)) {
    await mkdir(dirname(join(path, name)), { recursive: true });
    await writeFile(join(path, name), value);
  }
}
const fakeFetch = () => vi.fn<typeof fetch>(async (input) => {
  const file = String(input).split(`/resolve/${artifact.revision}/`)[1];
  return new Response(contents[file]);
});
async function partials(path: string) {
  return (await readdir(path, { recursive: true })).filter((name) => name.endsWith('.part'));
}
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('Stem GTE Memory download', () => {
  it('verifies a complete cache without any network request', async () => {
    const path = await directory();
    await install(path);
    const fetch = fakeFetch();
    const progress: number[] = [];
    await createGteModelDownloader({ artifact, fetch })(path, { onProgress: (value) => progress.push(value) });
    expect(fetch).not.toHaveBeenCalled();
    expect(progress).toEqual([]);
  });

  it('repairs only a corrupt file and credits verified cached bytes', async () => {
    const path = await directory();
    await install(path, { ...contents, 'onnx/model_quantized.onnx': 'xxxx fixture model' });
    const fetch = fakeFetch();
    const progress: number[] = [];
    await createGteModelDownloader({ artifact, fetch })(path, { onProgress: (value) => progress.push(value) });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`https://huggingface.co/${artifact.repo}/resolve/${artifact.revision}/onnx/model_quantized.onnx`);
    expect(await readFile(join(path, 'onnx/model_quantized.onnx'), 'utf8')).toBe(contents['onnx/model_quantized.onnx']);
    expect(progress).toEqual([25, 100]);
    expect(await partials(path)).toEqual([]);
  });

  it('never installs a same-sized response with the wrong digest', async () => {
    const path = await directory();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('wrong!'));
    const progress: number[] = [];
    await expect(createGteModelDownloader({ artifact, fetch })(path, { onProgress: (value) => progress.push(value) }))
      .rejects.toThrow('failed verification: config.json');
    await expect(readFile(join(path, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(progress).not.toContain(100);
    expect(await partials(path)).toEqual([]);
  });

  it('cleans interrupted streams, preserves verified files, and retries successfully', async () => {
    const path = await directory();
    await install(path, { 'config.json': contents['config.json'] });
    let pulls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('tiny'));
        else controller.error(new Error('connection lost'));
      }
    })));
    await expect(createGteModelDownloader({ artifact, fetch })(path)).rejects.toThrow('connection lost');
    expect(await partials(path)).toEqual([]);
    expect(await readFile(join(path, 'config.json'), 'utf8')).toBe('config');
    const retry = fakeFetch();
    await createGteModelDownloader({ artifact, fetch: retry })(path);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(await readFile(join(path, 'onnx/model_quantized.onnx'), 'utf8')).toBe(contents['onnx/model_quantized.onnx']);
  });

  it('cancels one caller without poisoning another concurrent download', async () => {
    const path = await directory();
    const abort = new AbortController();
    let started!: () => void;
    const streaming = new Promise<void>((resolve) => { started = resolve; });
    const fetch = fakeFetch();
    fetch.mockImplementationOnce(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('con'));
        started();
      }
    })));
    const ensure = createGteModelDownloader({ artifact, fetch });
    const cancelled = ensure(path, { signal: abort.signal });
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await streaming;
    await ensure(path);
    abort.abort();
    await rejected;
    expect(await partials(path)).toEqual([]);
    expect(await readFile(join(path, 'config.json'), 'utf8')).toBe('config');
    expect(await readFile(join(path, 'onnx/model_quantized.onnx'), 'utf8')).toBe(contents['onnx/model_quantized.onnx']);
  });

  it('times out a stalled body and permits a clean retry', async () => {
    const path = await directory();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('con')); }
    })));
    await expect(createGteModelDownloader({ artifact, fetch, timeoutMs: 30 })(path)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await partials(path)).toEqual([]);
    await createGteModelDownloader({ artifact, fetch: fakeFetch() })(path);
    expect(await readFile(join(path, 'config.json'), 'utf8')).toBe('config');
  });

  it('rejects oversized responses and HTTP failures without leaving partial files', async () => {
    const path = await directory();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('too much data'));
    await expect(createGteModelDownloader({ artifact, fetch })(path)).rejects.toThrow('unexpected size');
    expect(await partials(path)).toEqual([]);
    fetch.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    await expect(createGteModelDownloader({ artifact, fetch })(path)).rejects.toThrow('HTTP 503');
    expect(await partials(path)).toEqual([]);
  });

  it('validates destination and rejects traversal in fixture manifests', async () => {
    const fetch = fakeFetch();
    await expect(createGteModelDownloader({ artifact, fetch })('relative')).rejects.toThrow('must be absolute');
    expect(() => createGteModelDownloader({ artifact: {
      ...artifact, files: { '../outside': artifact.files['config.json'] }
    }, fetch })).toThrow('Invalid GTE model artifact');
    expect(fetch).not.toHaveBeenCalled();
  });
});
