// The HTTP embeddings client's timeout behaviour, pinned against a real
// incident (2026-08-18, qwen3-4b on a CPU-only Ollama): batches that ran
// seconds over the budget were cut off, surfaced as the abort's stock
// "This operation was aborted", and never retried — even though every one
// succeeded moments later. The contract under test: a timeout names itself as
// slowness (not a crash), passage work gets one retry on its long budget, and
// a query fails fast so the waiting turn can fall back to lexical selection.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpEmbeddingsClient } from '../../src/server/recall/embeddings';

const CFG = async () => ({ baseUrl: 'http://embed.test', model: 'm' });

function okResponse(n: number): Response {
  return {
    ok: true,
    json: async () => ({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [i] })) })
  } as unknown as Response;
}

/** A request that never answers — rejects only when the client's timer aborts it. */
function hang(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted.', 'AbortError')));
  });
}

function inputLength(init: RequestInit | undefined): number {
  return (JSON.parse(String(init?.body)) as { input: string[] }).input.length;
}

afterEach(() => vi.unstubAllGlobals());

describe('http embeddings client timeouts', () => {
  it('retries a timed-out passage batch once and returns its vectors', async () => {
    const fetchMock = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce((_url, init) => hang(init!.signal as AbortSignal))
      .mockImplementation(async (_url, init) => okResponse(inputLength(init)));
    vi.stubGlobal('fetch', fetchMock);

    const client = createHttpEmbeddingsClient(CFG, { timeoutMs: 5, passageTimeoutMs: 5 });
    const vecs = await client.embed(['a', 'b'], 'passage');
    expect(vecs).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a passage batch that times out twice fails, named as slowness', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => hang(init!.signal as AbortSignal));
    vi.stubGlobal('fetch', fetchMock);

    const client = createHttpEmbeddingsClient(CFG, { timeoutMs: 5, passageTimeoutMs: 5 });
    await expect(client.embed(['a'], 'passage')).rejects.toThrow(/no response within/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a timed-out query fails on the first attempt — the turn is waiting', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => hang(init!.signal as AbortSignal));
    vi.stubGlobal('fetch', fetchMock);

    const client = createHttpEmbeddingsClient(CFG, { timeoutMs: 5, passageTimeoutMs: 5 });
    await expect(client.embed(['q'], 'query')).rejects.toThrow(/no response within/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-timeout failures', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const client = createHttpEmbeddingsClient(CFG, { timeoutMs: 5, passageTimeoutMs: 5 });
    await expect(client.embed(['a'], 'passage')).rejects.toThrow(/HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('splits input into batches of at most 32', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => okResponse(inputLength(init)));
    vi.stubGlobal('fetch', fetchMock);

    const client = createHttpEmbeddingsClient(CFG);
    const vecs = await client.embed(Array.from({ length: 33 }, (_, i) => `t${i}`), 'passage');
    expect(vecs).toHaveLength(33);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(inputLength(fetchMock.mock.calls[0][1])).toBe(32);
    expect(inputLength(fetchMock.mock.calls[1][1])).toBe(1);
  });

  it('splits long texts by estimated tokens, not just count', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => okResponse(inputLength(init)));
    vi.stubGlobal('fetch', fetchMock);

    // 9 texts of ~1500 est. tokens each (6000 chars / 4) — the 2026-08-18
    // incident shape. Under the 8k-token cap they must pack 5+4, never 9 at once.
    const client = createHttpEmbeddingsClient(CFG);
    const vecs = await client.embed(Array.from({ length: 9 }, () => 'x'.repeat(6000)), 'passage');
    expect(vecs).toHaveLength(9);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(inputLength(fetchMock.mock.calls[0][1])).toBe(5);
    expect(inputLength(fetchMock.mock.calls[1][1])).toBe(4);
  });

  it('a single text over the token cap still ships, alone', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => okResponse(inputLength(init)));
    vi.stubGlobal('fetch', fetchMock);

    const client = createHttpEmbeddingsClient(CFG);
    const vecs = await client.embed(['x'.repeat(40_000), 'short'], 'passage');
    expect(vecs).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(inputLength(fetchMock.mock.calls[0][1])).toBe(1);
    expect(inputLength(fetchMock.mock.calls[1][1])).toBe(1);
  });
});
