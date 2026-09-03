// Manager suite — the utility-process lifecycle around the local embedding
// worker, driven through an in-memory fake transport (the vitest electron stub
// has no utilityProcess; the WorkerTransport seam exists exactly for this).
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { logFlushed } from '../../src/server/log';
import { logFilePath } from '../../src/server/workspace/paths';
import { EMBED_CATALOG } from '../../src/server/recall/embed-catalog';
import { RERANK_CATALOG } from '../../src/server/recall/rerank-catalog';
import { createEmbedWorkerManager } from '../../src/server/recall/embed-manager';
import { EmbeddingsTimeoutError } from '../../src/server/recall/embeddings';
import type { WorkerOutMessage } from '../../src/server/recall/embed-worker';
import type { WorkerTransport } from '../../src/server/recall/embed-worker-host';
import type { LocalEmbedStatus } from '../../src/shared/types';

const SPEC = EMBED_CATALOG['multilingual-e5-small'];
const RERANK_SPEC = RERANK_CATALOG['bge-reranker-v2-m3'];

interface FakeWorker extends WorkerTransport {
  sent: Array<Record<string, unknown>>;
  emit(msg: WorkerOutMessage): void;
  exit(code?: number): void;
  killed: boolean;
}

function fakeWorker(): FakeWorker {
  // Multi-listener like the real host (child.on): the manager attaches both the
  // main handler (at spawn) and a 'disposed' watcher (at stop).
  const onMsg: Array<(msg: unknown) => void> = [];
  let onExit: (code: number | undefined) => void = () => undefined;
  const w: FakeWorker = {
    sent: [],
    killed: false,
    send: (msg) => w.sent.push(msg as Record<string, unknown>),
    onMessage: (cb) => {
      onMsg.push(cb);
    },
    onExit: (cb) => {
      onExit = cb;
    },
    kill: () => {
      w.killed = true;
    },
    emit: (msg) => onMsg.forEach((cb) => cb(msg)),
    exit: (code) => onExit(code)
  };
  return w;
}

function manager(opts: { embedTimeoutMs?: number; rerankTimeoutMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const mgr = createEmbedWorkerManager({
    spawn: () => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    },
    cacheDir: () => '/tmp/models',
    ...opts
  });
  return { mgr, workers };
}

/** Every stem.log line so far. Taken as a before/after pair — one process runs
 * this whole file, so earlier cases' lines are still in the file. */
async function logLines(): Promise<string[]> {
  await logFlushed();
  const text = await readFile(logFilePath(), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean);
}

async function newLines(before: string[]): Promise<string[]> {
  return (await logLines()).slice(before.length);
}

const ready = (dim = 384): WorkerOutMessage => ({
  type: 'status',
  status: { model: SPEC.id, state: 'ready', dim }
});

const rerankReady = (): WorkerOutMessage => ({
  type: 'rerank-status',
  status: { model: RERANK_SPEC.id, state: 'ready' }
});

describe('embed worker manager', () => {
  it('lazily spawns on ensure and sends the load message with the cache dir', () => {
    const { mgr, workers } = manager();
    expect(workers).toHaveLength(0);
    mgr.ensure(SPEC);
    expect(workers).toHaveLength(1);
    expect(workers[0].sent[0]).toMatchObject({ type: 'load', cacheDir: '/tmp/models' });
    mgr.ensure(SPEC); // idempotent while the same model is up
    expect(workers).toHaveLength(1);
  });

  it('queues embeds while loading and flushes them on ready', async () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    const pending = mgr.embed(['hello'], 'query');
    expect(workers[0].sent.filter((m) => m.type === 'embed')).toHaveLength(0);
    workers[0].emit(ready());
    const req = workers[0].sent.find((m) => m.type === 'embed')!;
    expect(req).toMatchObject({ texts: ['hello'], kind: 'query' });
    workers[0].emit({ type: 'result', id: req.id as number, dim: 384, vectors: [new Float32Array([1, 0])] });
    expect((await pending)[0]).toEqual(new Float32Array([1, 0]));
  });

  it('reports status transitions to listeners, including download progress', () => {
    const { mgr, workers } = manager();
    const seen: LocalEmbedStatus[] = [];
    mgr.onStatus((s) => seen.push(s));
    mgr.ensure(SPEC);
    workers[0].emit({ type: 'status', status: { model: SPEC.id, state: 'downloading', progressPct: 42 } });
    workers[0].emit(ready());
    expect(seen.map((s) => s.state)).toEqual(['loading', 'downloading', 'ready']);
    expect(mgr.status().dim).toBe(384);
  });

  it('rejects an in-flight embed on timeout, as a timeout, and tells the worker to drop it', async () => {
    vi.useFakeTimers();
    try {
      const { mgr, workers } = manager({ embedTimeoutMs: 1000 });
      mgr.ensure(SPEC);
      workers[0].emit(ready());
      const pending = mgr.embed(['x'], 'passage');
      vi.advanceTimersByTime(1500);
      await expect(pending).rejects.toThrow(/timed out after 1000ms/);
      await expect(pending).rejects.toBeInstanceOf(EmbeddingsTimeoutError);
      const embedMsg = workers[0].sent.find((m) => m.type === 'embed')!;
      expect(workers[0].sent).toContainEqual({ type: 'cancel', id: embedMsg.id });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a per-call budget overrides the default', async () => {
    vi.useFakeTimers();
    try {
      const { mgr, workers } = manager({ embedTimeoutMs: 1000 });
      mgr.ensure(SPEC);
      workers[0].emit(ready());
      const pending = mgr.embed(['x'], 'passage', { timeoutMs: 5000 });
      vi.advanceTimersByTime(1500);
      // The default would have fired by now; this request is on the long budget.
      const embedMsg = workers[0].sent.find((m) => m.type === 'embed')!;
      expect(workers[0].sent.some((m) => m.type === 'cancel')).toBe(false);
      workers[0].emit({ type: 'result', id: embedMsg.id as number, dim: 1, vectors: [new Float32Array([1])] });
      await expect(pending).resolves.toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends passage requests one at a time but queries straight through', async () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    workers[0].emit(ready());
    const w = workers[0];
    const sentEmbeds = () => w.sent.filter((m) => m.type === 'embed');
    const p1 = mgr.embed(['a'], 'passage');
    const p2 = mgr.embed(['b'], 'passage');
    expect(sentEmbeds()).toHaveLength(1); // p2 waits, timer not started
    const q = mgr.embed(['q'], 'query');
    expect(sentEmbeds()).toHaveLength(2); // the query did not wait behind p1
    expect(sentEmbeds()[1].kind).toBe('query');
    w.emit({ type: 'result', id: sentEmbeds()[1].id as number, dim: 1, vectors: [new Float32Array([3])] });
    await expect(q).resolves.toHaveLength(1);
    expect(sentEmbeds()).toHaveLength(2); // p2 still waiting: a query finishing frees nothing
    w.emit({ type: 'result', id: sentEmbeds()[0].id as number, dim: 1, vectors: [new Float32Array([1])] });
    await expect(p1).resolves.toHaveLength(1);
    expect(sentEmbeds()).toHaveLength(3); // p1 done → p2 sent
    expect(sentEmbeds()[2].texts).toEqual(['b']);
    w.emit({ type: 'result', id: sentEmbeds()[2].id as number, dim: 1, vectors: [new Float32Array([2])] });
    await expect(p2).resolves.toHaveLength(1);
  });

  it('a passage that times out lets the next waiting passage in', async () => {
    vi.useFakeTimers();
    try {
      const { mgr, workers } = manager({ embedTimeoutMs: 1000 });
      mgr.ensure(SPEC);
      workers[0].emit(ready());
      const w = workers[0];
      const p1 = mgr.embed(['a'], 'passage');
      const p2 = mgr.embed(['b'], 'passage');
      vi.advanceTimersByTime(1500);
      await expect(p1).rejects.toBeInstanceOf(EmbeddingsTimeoutError);
      const embeds = w.sent.filter((m) => m.type === 'embed');
      expect(embeds).toHaveLength(2);
      w.emit({ type: 'result', id: embeds[1].id as number, dim: 1, vectors: [new Float32Array([2])] });
      await expect(p2).resolves.toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a worker crash fails the waiting passages too', async () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    workers[0].emit(ready());
    const p1 = mgr.embed(['a'], 'passage');
    const p2 = mgr.embed(['b'], 'passage');
    workers[0].exit(1);
    await expect(p1).rejects.toThrow(/worker exited/);
    await expect(p2).rejects.toThrow(/worker exited/);
  });

  it('fails pending work and respawns when the worker crashes, settling into error after the cap', async () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    workers[0].emit(ready());
    const pending = mgr.embed(['x'], 'passage');
    workers[0].exit(1);
    await expect(pending).rejects.toThrow(/exited/);
    // 1 original + 3 capped respawns; the last crash lands in 'error', no 5th spawn.
    expect(workers).toHaveLength(2);
    workers[1].exit(1);
    workers[2].exit(1);
    workers[3].exit(1);
    expect(workers).toHaveLength(4);
    expect(mgr.status().state).toBe('error');
  });

  it('load errors reject queued embeds and land in error state', async () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    const pending = mgr.embed(['x'], 'passage');
    workers[0].emit({ type: 'status', status: { model: SPEC.id, state: 'error', error: 'no network' } });
    await expect(pending).rejects.toThrow(/no network/);
    expect(mgr.status()).toMatchObject({ state: 'error', error: 'no network' });
    // Re-kicks are rate-limited after an error…
    mgr.ensure(SPEC);
    expect(workers).toHaveLength(1);
    // …unless forced (Test button / settings change).
    mgr.ensure(SPEC, { force: true });
    expect(workers).toHaveLength(2);
  });

  it('reconfigure kills the old worker and loads the new model', () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    workers[0].emit(ready());
    mgr.reconfigure(EMBED_CATALOG['multilingual-e5-base']);
    // Graceful shutdown: dispose lets the worker release its ONNX session; the
    // manager SIGTERMs it on the 'disposed' ack (a self-exit would abort with
    // "mutex lock failed" while ORT threads wind down).
    expect(workers[0].sent.at(-1)).toMatchObject({ type: 'dispose' });
    expect(workers[0].killed).toBe(false);
    workers[0].emit({ type: 'disposed' });
    expect(workers[0].killed).toBe(true);
    expect(workers).toHaveLength(2);
    expect((workers[1].sent[0] as { spec: { id: string } }).spec.id).toBe('multilingual-e5-base');
    // The old worker's exit must not trigger a respawn — it was superseded.
    workers[0].exit(0);
    expect(workers).toHaveLength(2);
  });

  it('reconfigure(null) stops the worker and goes idle (mode left local)', () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    workers[0].emit(ready());
    mgr.reconfigure(null);
    expect(workers[0].sent.at(-1)).toMatchObject({ type: 'dispose' });
    expect(mgr.status().state).toBe('idle');
  });

  it('rejects embeds when the worker is not running instead of hanging', async () => {
    const { mgr } = manager();
    await expect(mgr.embed(['x'], 'query')).rejects.toThrow(/not running/);
  });

  it('turns a spawn failure into error state rather than throwing out of ensure', () => {
    const mgr = createEmbedWorkerManager({
      spawn: () => {
        throw new Error('utilityProcess unavailable');
      },
      cacheDir: () => '/tmp/models'
    });
    expect(() => mgr.ensure(SPEC)).not.toThrow();
    expect(mgr.status()).toMatchObject({ state: 'error', error: 'utilityProcess unavailable' });
  });
});

describe('separate rerank worker', () => {
  it('loads the reranker in its own process so it cannot abort the embedder', () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    workers[0].emit(ready());
    mgr.ensureRerank(RERANK_SPEC);
    expect(workers).toHaveLength(2);
    expect(workers[0].sent.map((m) => m.type)).toEqual(['load']);
    expect(workers[1].sent.map((m) => m.type)).toEqual(['load-rerank']);
    expect(mgr.rerankStatus().state).toBe('loading');
    mgr.ensureRerank(RERANK_SPEC); // idempotent while the same model is up
    expect(workers).toHaveLength(2);
  });

  it('spawns rerank-only when embeddings are not local, then adds the embedder as a second process', () => {
    const { mgr, workers } = manager();
    mgr.ensureRerank(RERANK_SPEC);
    expect(workers).toHaveLength(1);
    expect(workers[0].sent.map((m) => m.type)).toEqual(['load-rerank']);
    mgr.ensure(SPEC);
    expect(workers).toHaveLength(2);
    expect(workers[1].sent.map((m) => m.type)).toEqual(['load']);
  });

  it('queues reranks while loading, flushes on ready, and resolves results', async () => {
    const { mgr, workers } = manager();
    mgr.ensureRerank(RERANK_SPEC);
    const pending = mgr.rerank('q', ['a', 'b'], 2);
    expect(workers[0].sent.filter((m) => m.type === 'rerank')).toHaveLength(0);
    workers[0].emit(rerankReady());
    const req = workers[0].sent.find((m) => m.type === 'rerank')!;
    expect(req).toMatchObject({ query: 'q', docs: ['a', 'b'], topN: 2 });
    workers[0].emit({
      type: 'rerank-result',
      id: req.id as number,
      results: [
        { index: 1, score: 0.9 },
        { index: 0, score: 0.1 }
      ]
    });
    expect(await pending).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.1 }
    ]);
  });

  it('keeps embed and rerank failure domains separate: a rerank load error only fails reranks', async () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    mgr.ensureRerank(RERANK_SPEC);
    workers[0].emit(ready());
    const embedPending = mgr.embed(['x'], 'passage');
    const rerankPending = mgr.rerank('q', ['a'], 1);
    workers[1].emit({ type: 'rerank-status', status: { model: RERANK_SPEC.id, state: 'error', error: 'oom' } });
    await expect(rerankPending).rejects.toThrow(/oom/);
    expect(mgr.rerankStatus().state).toBe('error');
    // The embed side is untouched and still completes.
    expect(mgr.status().state).toBe('ready');
    const req = workers[0].sent.find((m) => m.type === 'embed')!;
    workers[0].emit({ type: 'result', id: req.id as number, dim: 384, vectors: [new Float32Array([1])] });
    expect((await embedPending).length).toBe(1);
  });

  it('a rerank-worker crash respawns only the reranker', async () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    mgr.ensureRerank(RERANK_SPEC);
    workers[0].emit(ready());
    workers[1].emit(rerankReady());
    const pending = mgr.rerank('q', ['a'], 1);
    workers[1].exit(1);
    await expect(pending).rejects.toThrow(/exited/);
    expect(workers).toHaveLength(3);
    expect(workers[2].sent.map((m) => m.type)).toEqual(['load-rerank']);
    expect(mgr.status().state).toBe('ready');
  });

  it('a rerank abort while loading leaves the embedder running', () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    mgr.ensureRerank(RERANK_SPEC);
    workers[0].emit(ready());
    workers[1].exit(5);
    // Embedder untouched; reranker gets its own respawn.
    expect(mgr.status().state).toBe('ready');
    expect(workers).toHaveLength(3);
    expect(workers[2].sent.map((m) => m.type)).toEqual(['load-rerank']);
  });

  it('force-retry after a rerank crash-loop restarts only the rerank worker', () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    mgr.ensureRerank(RERANK_SPEC);
    workers[0].emit(ready());
    workers[1].exit(5);
    workers[2].exit(5);
    workers[3].exit(5);
    workers[4].exit(5);
    expect(mgr.rerankStatus().state).toBe('error');
    expect(mgr.status().state).toBe('ready');
    mgr.ensureRerank(RERANK_SPEC, { force: true });
    expect(workers.at(-1)!.sent.map((m) => m.type)).toEqual(['load-rerank']);
    expect(mgr.rerankStatus().state).toBe('loading');
  });

  it('names Qwen3-Reranker-0.6B and points at BGE when that worker crash-loops', () => {
    const qwen = RERANK_CATALOG['qwen3-reranker-0.6b'];
    const { mgr, workers } = manager();
    mgr.ensureRerank(qwen);
    workers[0].exit(5);
    workers[1].exit(5);
    workers[2].exit(5);
    workers[3].exit(5);
    expect(mgr.rerankStatus()).toMatchObject({
      state: 'error',
      error: expect.stringMatching(/too large for this machine.*BGE/i)
    });
  });

  it('an embed model switch restarts only the embedder', () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    mgr.ensureRerank(RERANK_SPEC);
    workers[0].emit(ready());
    workers[1].emit(rerankReady());
    mgr.reconfigure(EMBED_CATALOG['multilingual-e5-base']);
    expect(workers).toHaveLength(3);
    expect(workers[2].sent.map((m) => m.type)).toEqual(['load']);
    expect((workers[2].sent[0] as { spec: { id: string } }).spec.id).toBe('multilingual-e5-base');
    expect(mgr.rerankStatus().state).toBe('ready');
  });

  it('reconfigureRerank(null) stops the reranker and leaves the embedder up', () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    mgr.ensureRerank(RERANK_SPEC);
    workers[0].emit(ready());
    workers[1].emit(rerankReady());
    mgr.reconfigureRerank(null);
    expect(mgr.rerankStatus().state).toBe('idle');
    expect(mgr.status().state).toBe('ready');
    expect(workers).toHaveLength(2);
  });

  it('rejects reranks when the worker is not running instead of hanging', async () => {
    const { mgr } = manager();
    await expect(mgr.rerank('q', ['a'], 1)).rejects.toThrow(/not running/);
  });

  it('rejects an in-flight rerank on timeout', async () => {
    vi.useFakeTimers();
    try {
      const { mgr, workers } = manager({ rerankTimeoutMs: 1000 });
      mgr.ensureRerank(RERANK_SPEC);
      workers[0].emit(rerankReady());
      const pending = mgr.rerank('q', ['a'], 1);
      vi.advanceTimersByTime(1500);
      await expect(pending).rejects.toThrow(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  // A worker that purged a corrupt weights cache asks (via purgedCorruptCache)
  // for a NEW process to redo the download in — a failed ONNX load poisons
  // transformers.js state for every later load in the same one.
  it('restarts only the embedder after a corrupt-cache purge instead of surfacing the error', () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    mgr.ensureRerank(RERANK_SPEC);
    workers[1].emit(rerankReady());
    workers[0].emit({
      type: 'status',
      status: { model: SPEC.id, state: 'error', error: 'Protobuf parsing failed', purgedCorruptCache: true }
    });
    expect(workers).toHaveLength(3);
    // Silent recovery: never an 'error' the restart is about to fix.
    expect(mgr.status().state).toBe('loading');
    expect(workers[2].sent.map((m) => m.type)).toEqual(['load']);
    // The reranker is still the original process.
    expect(mgr.rerankStatus().state).toBe('ready');
    workers[2].emit(ready());
    expect(mgr.status().state).toBe('ready');
  });

  it('caps corrupt-cache restarts so a persistently bad download settles into error', () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    const corrupt = (w: (typeof workers)[number]) =>
      w.emit({
        type: 'status',
        status: { model: SPEC.id, state: 'error', error: 'Protobuf parsing failed', purgedCorruptCache: true }
      });
    corrupt(workers[0]);
    corrupt(workers[1]);
    expect(workers).toHaveLength(3);
    corrupt(workers[2]); // budget (2) exhausted — no third restart
    expect(workers).toHaveLength(3);
    expect(mgr.status().state).toBe('error');
  });

  // The two events that never reach a status callback, and so exist nowhere a
  // user could send them from: a process that died (status goes back to
  // 'loading' while respawns are left) and a corrupt-cache purge (hidden from
  // the UI on purpose). Both leave the UI showing a message that names nothing —
  // "worker exited", "worker keeps crashing" — so stem.log is the only record.
  it('logs the lifecycle events the status channel hides', async () => {
    const { mgr, workers } = manager();
    const before = await logLines();
    mgr.ensure(SPEC);
    expect(await newLines(before)).toContainEqual(
      expect.stringContaining(`[embed-worker] spawned {"embed":"${SPEC.id}","rerank":null}`)
    );

    workers[0].exit(9);
    const afterExit = await newLines(before);
    const exited = afterExit.filter((l) => l.includes('worker exited unexpectedly'));
    expect(exited).toHaveLength(1);
    // The reason died with the child's stderr; the code and the respawn decision
    // are what separate "aborted mid-load" from "settled into error".
    expect(exited[0]).toContain('"code":9');
    expect(exited[0]).toContain('"respawning":true');

    workers[1].emit({
      type: 'status',
      status: { model: SPEC.id, state: 'error', error: 'Protobuf parsing failed', purgedCorruptCache: true }
    });
    const purged = (await newLines(before)).filter((l) => l.includes('purged corrupt weights cache'));
    expect(purged).toHaveLength(1);
    expect(purged[0]).toContain('"attempt":1');
    expect(purged[0]).toContain('Protobuf parsing failed');
  });

  it('logs a fork that fails outright rather than only failing the status', async () => {
    const before = await logLines();
    const mgr = createEmbedWorkerManager({
      spawn: () => {
        throw new Error('utilityProcess unavailable');
      },
      cacheDir: () => '/tmp/models'
    });
    mgr.ensure(SPEC);
    expect(mgr.status()).toMatchObject({ state: 'error', error: 'utilityProcess unavailable' });
    expect(await newLines(before)).toContainEqual(
      expect.stringContaining('[embed-worker] fork failed {"error":"utilityProcess unavailable","kind":"embed"}')
    );
  });
});
