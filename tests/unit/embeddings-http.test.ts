// The HTTP embeddings client's timeout behaviour, pinned against a real
// incident (2026-08-18, qwen3-4b on a CPU-only Ollama): batches that ran
// seconds over the budget were cut off, surfaced as the abort's stock
// "This operation was aborted", and never retried — even though every one
// succeeded moments later. The contract under test: a timeout names itself as
// slowness (not a crash), passage work gets one retry on its long budget, and
// a query fails fast so the waiting turn can fall back to lexical selection.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpEmbeddingsClient } from '../../src/server/recall/embeddings';
import { createEmbedSchedule } from '../../src/server/recall/embed-schedule';

const CFG = async () => ({ baseUrl: 'http://embed.test', model: 'm' });

/** A client with a private zero-lull schedule, so tests can't gate each other. */
function makeClient(opts: Parameters<typeof createHttpEmbeddingsClient>[1] = {}) {
  return createHttpEmbeddingsClient(CFG, { schedule: createEmbedSchedule({ lullMs: 0 }), ...opts });
}

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
  it('retries a timed-out single-text passage once and returns its vector', async () => {
    const fetchMock = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce((_url, init) => hang(init!.signal as AbortSignal))
      .mockImplementation(async (_url, init) => okResponse(inputLength(init)));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient({ timeoutMs: 5, passageTimeoutMs: 5, busyQueryTimeoutMs: 5 });
    const vecs = await client.embed(['a'], 'passage');
    expect(vecs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Resending a mis-sized batch verbatim is doomed to the same overrun (observed
  // live 2026-08-19: 2m timeout, identical retry, 2m timeout, pass dead). The
  // retry that changes the outcome is a smaller request.
  it('bisects a timed-out multi-text passage batch instead of resending it', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (inputLength(init) > 2) return hang(init!.signal as AbortSignal);
      return okResponse(inputLength(init));
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient({ timeoutMs: 5, passageTimeoutMs: 5, busyQueryTimeoutMs: 5 });
    const vecs = await client.embed(['a', 'b', 'c', 'd'], 'passage');
    expect(vecs).toHaveLength(4);
    // 1 timed-out attempt at 4, then two successful halves of 2.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((c) => inputLength(c[1]))).toEqual([4, 2, 2]);
  });

  it('a passage batch that times out twice fails, named as slowness', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => hang(init!.signal as AbortSignal));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient({ timeoutMs: 5, passageTimeoutMs: 5, busyQueryTimeoutMs: 5 });
    await expect(client.embed(['a'], 'passage')).rejects.toThrow(/no response within/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a timed-out query fails on the first attempt — the turn is waiting', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => hang(init!.signal as AbortSignal));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient({ timeoutMs: 5, passageTimeoutMs: 5, busyQueryTimeoutMs: 5 });
    await expect(client.embed(['q'], 'query')).rejects.toThrow(/no response within/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-timeout failures', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient({ timeoutMs: 5, passageTimeoutMs: 5, busyQueryTimeoutMs: 5 });
    await expect(client.embed(['a'], 'passage')).rejects.toThrow(/HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('splits input into batches of at most 32', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => okResponse(inputLength(init)));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
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
    // incident shape. Under the 4k-token cap they must pack in pairs, never 9 at once.
    const client = makeClient();
    const vecs = await client.embed(Array.from({ length: 9 }, () => 'x'.repeat(6000)), 'passage');
    expect(vecs).toHaveLength(9);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map((c) => inputLength(c[1]))).toEqual([2, 2, 2, 2, 1]);
  });

  it('a single text over the token cap still ships, alone', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => okResponse(inputLength(init)));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const vecs = await client.embed(['x'.repeat(40_000), 'short'], 'passage');
    expect(vecs).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(inputLength(fetchMock.mock.calls[0][1])).toBe(1);
    expect(inputLength(fetchMock.mock.calls[1][1])).toBe(1);
  });
});

// Priority between interactive queries and background passages, pinned against
// the 2026-08-21 incident: folder indexing held a CPU Ollama for 1–2 minutes
// per batch, every recall query behind it blew its 30s budget, and the Memory
// tab called a merely-busy endpoint failed.
describe('http embeddings client query/passage priority', () => {
  it('a passage request started during a query waits for the query to finish', async () => {
    let releaseQuery!: () => void;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        await new Promise<void>((resolve) => (releaseQuery = resolve));
      }
      return okResponse(inputLength(init));
    });
    vi.stubGlobal('fetch', fetchMock);

    const schedule = createEmbedSchedule({ lullMs: 0 });
    const client = createHttpEmbeddingsClient(CFG, { schedule });
    const query = client.embed(['q'], 'query'); // in flight, held open
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const passage = client.embed(['p'], 'passage');
    // Give the passage every chance to (wrongly) send while the query holds.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseQuery();
    await expect(query).resolves.toHaveLength(1);
    await expect(passage).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a query behind an in-flight passage takes the busy budget instead of timing out', async () => {
    let releasePassage!: () => void;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      if (body.input[0] === 'p') {
        await new Promise<void>((resolve) => (releasePassage = resolve));
        return okResponse(1);
      }
      // The query answers slower than the idle budget but inside the busy one.
      await new Promise((resolve) => setTimeout(resolve, 30));
      return okResponse(1);
    });
    vi.stubGlobal('fetch', fetchMock);

    const schedule = createEmbedSchedule({ lullMs: 0 });
    const client = createHttpEmbeddingsClient(CFG, {
      schedule,
      timeoutMs: 5,
      busyQueryTimeoutMs: 5_000
    });
    const passage = client.embed(['p'], 'passage');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await expect(client.embed(['q'], 'query')).resolves.toHaveLength(1);
    releasePassage();
    await expect(passage).resolves.toHaveLength(1);
  });
});
