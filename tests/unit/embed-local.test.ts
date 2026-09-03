// The local embeddings client's traffic rules, pinned against the 2026-09-03
// incident: after switching a CPU server to the built-in Qwen3, the whole fact
// set went to the worker as one request against a flat timer, every request
// timed out, and the abandoned work held the cores. The contract: the local
// client packs passages into bounded batches on the long budget, gives a
// query the busy budget when a passage batch is out, and bisects a batch the
// worker could not finish in time — the same rules as the HTTP client.
import { describe, expect, it } from 'vitest';
import { createLocalEmbeddingsClient, LOCAL_EMBED_BUDGETS } from '../../src/server/recall/embed-local';
import type { EmbedWorkerManager } from '../../src/server/recall/embed-manager';
import { EmbeddingsTimeoutError, type EmbedKind } from '../../src/server/recall/embeddings';
import { createEmbedSchedule } from '../../src/server/recall/embed-schedule';
import type { RetrievalSettings } from '../../src/shared/types';

const settings: RetrievalSettings = {
  embeddings: { mode: 'local', localModel: 'multilingual-e5-small', baseUrl: '', model: '', apiKey: null },
  reranker: { mode: 'off', localModel: 'bge-reranker-v2-m3', baseUrl: '', model: '', apiKey: null },
  customEmbedModels: [],
  customRerankModels: []
};

interface Call {
  texts: string[];
  kind: EmbedKind;
  timeoutMs: number | undefined;
  resolve: (v: Float32Array[]) => void;
  reject: (e: unknown) => void;
}

/** A ready manager whose embed calls are held until the test answers them. */
function fakeManager() {
  const calls: Call[] = [];
  const manager = {
    ensure: () => undefined,
    status: () => ({ model: 'multilingual-e5-small', state: 'ready' as const }),
    embed: (texts: string[], kind: EmbedKind, opts?: { timeoutMs?: number }) =>
      new Promise<Float32Array[]>((resolve, reject) => {
        calls.push({ texts, kind, timeoutMs: opts?.timeoutMs, resolve, reject });
      })
  } as unknown as EmbedWorkerManager;
  const answer = (i: number) => calls[i].resolve(calls[i].texts.map((t) => new Float32Array([t.length])));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { manager, calls, answer, tick };
}

function client(m: ReturnType<typeof fakeManager>) {
  return createLocalEmbeddingsClient(async () => settings, m.manager, { schedule: createEmbedSchedule({ lullMs: 0 }) });
}

describe('local embeddings client', () => {
  it('packs a passage call into batches of at most 32, one at a time, on the passage budget', async () => {
    const m = fakeManager();
    const texts = Array.from({ length: 40 }, (_, i) => `t${i}`);
    const pending = client(m).embed(texts, 'passage');
    await m.tick();
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].texts).toHaveLength(32);
    expect(m.calls[0].kind).toBe('passage');
    expect(m.calls[0].timeoutMs).toBe(LOCAL_EMBED_BUDGETS.passageTimeoutMs);
    m.answer(0);
    await m.tick();
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1].texts).toHaveLength(8);
    m.answer(1);
    const out = await pending;
    expect(out).toHaveLength(40);
    expect(out[39][0]).toBe('t39'.length); // order preserved across batches
  });

  it('a query takes the short budget when the worker is idle and the busy budget behind a passage batch', async () => {
    const m = fakeManager();
    const c = client(m);
    const q1 = c.embed(['hello'], 'query');
    await m.tick();
    expect(m.calls[0]).toMatchObject({ kind: 'query', timeoutMs: LOCAL_EMBED_BUDGETS.timeoutMs });
    m.answer(0);
    await q1;

    const passage = c.embed(['p1', 'p2'], 'passage');
    await m.tick();
    expect(m.calls[1].kind).toBe('passage');
    const q2 = c.embed(['again'], 'query');
    await m.tick();
    expect(m.calls[2]).toMatchObject({ kind: 'query', timeoutMs: LOCAL_EMBED_BUDGETS.busyQueryTimeoutMs });
    m.answer(2);
    await q2;
    m.answer(1);
    await passage;
  });

  it('bisects a passage batch the worker timed out on instead of resending it whole', async () => {
    const m = fakeManager();
    const pending = client(m).embed(['a', 'b', 'c', 'd'], 'passage');
    await m.tick();
    expect(m.calls[0].texts).toEqual(['a', 'b', 'c', 'd']);
    m.calls[0].reject(new EmbeddingsTimeoutError('local embeddings: timed out after 120000ms'));
    await m.tick();
    expect(m.calls[1].texts).toEqual(['a', 'b']);
    m.answer(1);
    await m.tick();
    expect(m.calls[2].texts).toEqual(['c', 'd']);
    m.answer(2);
    expect(await pending).toHaveLength(4);
  });

  it('a timed-out query fails at once — the turn is waiting', async () => {
    const m = fakeManager();
    const pending = client(m).embed(['q'], 'query');
    await m.tick();
    m.calls[0].reject(new EmbeddingsTimeoutError('local embeddings: timed out after 60000ms'));
    await expect(pending).rejects.toThrow(/timed out/);
    expect(m.calls).toHaveLength(1);
  });

  it('a non-timeout worker error is not retried', async () => {
    const m = fakeManager();
    const pending = client(m).embed(['a', 'b'], 'passage');
    await m.tick();
    m.calls[0].reject(new Error('local embeddings: model not loaded'));
    await expect(pending).rejects.toThrow(/model not loaded/);
    expect(m.calls).toHaveLength(1);
  });
});

describe('local embeddings client: urgent passages', () => {
  it('an urgent passage is scheduled like a query: no lull wait, query budget, passage prefix', async () => {
    const m = fakeManager();
    // A lull that would otherwise hold every passage request for the whole test.
    const c = createLocalEmbeddingsClient(async () => settings, m.manager, {
      schedule: createEmbedSchedule({ lullMs: 60_000 })
    });
    const q = c.embed(['hello'], 'query');
    await m.tick();
    m.answer(0);
    await q; // lastQueryEndAt = now → an ordinary passage would now wait 60s
    const pending = c.embed(['new fact'], 'passage', { urgent: true });
    await m.tick();
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1]).toMatchObject({ kind: 'passage', timeoutMs: LOCAL_EMBED_BUDGETS.timeoutMs });
    m.answer(1);
    expect(await pending).toHaveLength(1);
  });
});
