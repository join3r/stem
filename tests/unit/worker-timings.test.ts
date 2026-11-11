// What a turn's preparation cost, stage by stage: the worker's run clock, the
// per-turn sink the manager fills, and the columns it all lands in.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { createRunClock, finishRunStats, newRunStats } from '../../src/server/recall/run-clock';
import { createEmbedQueue } from '../../src/server/recall/embed-queue';
import { createEmbedWorkerManager } from '../../src/server/recall/embed-manager';
import { EMBED_CATALOG } from '../../src/server/recall/embed-catalog';
import { RERANK_CATALOG } from '../../src/server/recall/rerank-catalog';
import { newWorkerTimings, noteWorkerRequest, withWorkerTimings } from '../../src/server/recall/worker-timings';
import { RecallStore } from '../../src/server/recall/store';
import type { WorkerOutMessage } from '../../src/server/recall/embed-worker';
import type { WorkerTransport } from '../../src/server/recall/embed-worker-host';

const dir = mkdtempSync(join(tmpdir(), 'stem-worker-timings-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A promise the test settles by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe('the run clock', () => {
  it('charges a run its own time, and the shared part only while another run is in flight', async () => {
    let t = 0;
    const clock = createRunClock(() => t);
    const a = newRunStats();
    const b = newRunStats();
    const ga = gate();
    const gb = gate();
    const runA = clock.run(() => ga.promise, a); // A alone from 0
    t = 100;
    const runB = clock.run(() => gb.promise, b); // B joins at 100
    t = 250;
    ga.open(); // A ends at 250: 150 of its 250 were shared
    await runA;
    t = 400;
    gb.open(); // B ends at 400: shared only until A left
    await runB;
    expect(a).toEqual({ runMs: 250, sharedMs: 150 });
    expect(b).toEqual({ runMs: 300, sharedMs: 150 });
  });

  it('counts a failed run too', async () => {
    let t = 0;
    const clock = createRunClock(() => t);
    const s = newRunStats();
    await expect(clock.run(async () => { t = 40; throw new Error('onnx'); }, s)).rejects.toThrow('onnx');
    expect(s).toEqual({ runMs: 40, sharedMs: 0 });
  });

  it('reports the wait as the time since arrival that was not its own runs', () => {
    expect(finishRunStats({ runMs: 120.4, sharedMs: 30.6 }, 1000, 1500)).toEqual({ runMs: 120, sharedMs: 31, waitMs: 380 });
    // Rounding must not produce a negative wait.
    expect(finishRunStats({ runMs: 500.4, sharedMs: 0 }, 1000, 1500).waitMs).toBe(0);
  });
});

describe('the embed queue', () => {
  it('hands each finished request its stats, the wait behind an earlier job included', async () => {
    const clock = createRunClock();
    const done: Array<{ id: number; runMs: number; waitMs: number }> = [];
    const finished = gate();
    const queue = createEmbedQueue({
      run: (texts, stats) =>
        clock.run(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return texts.map(() => new Float32Array(1));
        }, stats),
      stepSize: () => 8,
      done: (id, _vectors, stats) => {
        done.push({ id, runMs: stats.runMs, waitMs: stats.waitMs });
        if (done.length === 2) finished.open();
      },
      fail: () => undefined
    });
    queue.push({ id: 1, kind: 'passage', texts: ['a'] });
    queue.push({ id: 2, kind: 'passage', texts: ['b'] });
    await finished.promise;
    const [first, second] = done;
    expect(first!.id).toBe(1);
    expect(first!.runMs).toBeGreaterThanOrEqual(25);
    // The second waited for the first's step before its own.
    expect(second!.waitMs).toBeGreaterThanOrEqual(25);
    expect(first!.waitMs).toBeLessThan(second!.waitMs);
  });
});

function fakeWorker(): WorkerTransport & { sent: Array<Record<string, unknown>>; emit(msg: WorkerOutMessage): void } {
  const onMsg: Array<(msg: unknown) => void> = [];
  const w = {
    sent: [] as Array<Record<string, unknown>>,
    send: (msg: unknown) => void w.sent.push(msg as Record<string, unknown>),
    onMessage: (cb: (msg: unknown) => void) => void onMsg.push(cb),
    onExit: () => undefined,
    kill: () => undefined,
    emit: (msg: WorkerOutMessage) => onMsg.forEach((cb) => cb(msg))
  };
  return w;
}

describe('a turn’s worker timings', () => {
  it('adds up what the turn’s own requests cost, and nothing from outside it', async () => {
    const w = fakeWorker();
    const mgr = createEmbedWorkerManager({ spawn: () => w, cacheDir: () => '/tmp/models' });
    const spec = EMBED_CATALOG['multilingual-e5-small'];
    const rr = RERANK_CATALOG['bge-reranker-v2-m3'];
    mgr.ensure(spec);
    mgr.ensureRerank(rr);
    w.emit({ type: 'status', status: { model: spec.id, state: 'ready' } });
    w.emit({ type: 'rerank-status', status: { model: rr.id, state: 'ready' } });

    const sink = newWorkerTimings();
    const inTurn = withWorkerTimings(sink, async () => {
      const e = mgr.embed(['q'], 'query');
      const r = mgr.rerank('q', ['d'], 1);
      return Promise.all([e, r]);
    });
    // A background request made outside any turn.
    const background = mgr.embed(['p'], 'passage');
    const ids = w.sent.filter((m) => m.type === 'embed' || m.type === 'rerank').map((m) => m.id as number);
    expect(ids).toHaveLength(3);
    w.emit({ type: 'result', id: ids[0]!, dim: 1, vectors: [new Float32Array(1)], stats: { runMs: 40, sharedMs: 10, waitMs: 5 } });
    w.emit({ type: 'rerank-result', id: ids[1]!, results: [{ index: 0, score: 1 }], stats: { runMs: 300, sharedMs: 0, waitMs: 80 } });
    w.emit({ type: 'result', id: ids[2]!, dim: 1, vectors: [new Float32Array(1)], stats: { runMs: 999, sharedMs: 999, waitMs: 999 } });
    await inTurn;
    await background;
    expect(sink.requests).toBe(2);
    expect(sink.runMs).toBe(340);
    expect(sink.sharedMs).toBe(10);
    mgr.dispose();
  });

  it('takes the wait from the caller’s own clock, so a hold before the worker counts', () => {
    const sink = newWorkerTimings();
    // The caller waited 900 ms; the worker ran 200 ms and saw 50 ms of queue.
    noteWorkerRequest(sink, 900, { runMs: 200, sharedMs: 0, waitMs: 50 });
    expect(sink).toEqual({ requests: 1, waitMs: 700, runMs: 200, sharedMs: 0 });
    // A worker that sent no stats is counted, and guessed at nowhere.
    noteWorkerRequest(sink, 400, undefined);
    expect(sink).toEqual({ requests: 2, waitMs: 700, runMs: 200, sharedMs: 0 });
    noteWorkerRequest(undefined, 400, { runMs: 1, sharedMs: 1, waitMs: 1 });
  });
});

describe('stage timings in turn_timings', () => {
  const stages = {
    recallFactsMs: 1400, recallEmbedMs: 90, recallRerankMs: 1250, recallSearchMs: 310,
    skillsMs: 1500, workerWaitMs: 220, workerRunMs: 2600, workerSharedMs: 40
  };
  const base = { threadId: 't', totalMs: 9000, thinkingMs: 0, toolMs: 0, answerMs: 2000, ttftMs: 600, buildMs: 3400, recallMs: 1800 };
  const read = (path: string, id: string): Record<string, unknown> => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db.prepare(`SELECT * FROM turn_timings WHERE turn_entry_id = ?`).get(id) as Record<string, unknown>;
    } finally {
      db.close();
    }
  };

  it('stores them, leaves them null on a turn that measured none, and replaces them on a rewrite', () => {
    const path = join(dir, 'fresh.sqlite');
    const store = new RecallStore(() => path);
    try {
      store.upsertTurnTiming({ turnEntryId: 'u1', ...base, stages });
      store.upsertTurnTiming({ turnEntryId: 'u2', ...base });
      expect(read(path, 'u1')).toMatchObject({
        recall_facts_ms: 1400, recall_embed_ms: 90, recall_rerank_ms: 1250, recall_search_ms: 310,
        skills_ms: 1500, worker_wait_ms: 220, worker_run_ms: 2600, worker_shared_ms: 40
      });
      expect(read(path, 'u2')).toMatchObject({ skills_ms: null, worker_wait_ms: null });
      store.upsertTurnTiming({ turnEntryId: 'u1', ...base, stages: { ...stages, skillsMs: 7, workerWaitMs: null } });
      expect(read(path, 'u1')).toMatchObject({ skills_ms: 7, worker_wait_ms: null, recall_rerank_ms: 1250 });
      // The chat's own reading of the table is unchanged.
      expect(store.getTurnTimingsByThread('t').get('u1')).toMatchObject({ buildMs: 3400, recallMs: 1800 });
    } finally {
      store.close();
    }
  });

  it('adds the columns to a table created before them', () => {
    const path = join(dir, 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE turn_timings (
      turn_entry_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, total_ms INTEGER,
      thinking_ms INTEGER NOT NULL, tool_ms INTEGER NOT NULL, answer_ms INTEGER NOT NULL,
      ttft_ms INTEGER, build_ms INTEGER, recall_ms INTEGER, created_at INTEGER NOT NULL)`);
    old.prepare(`INSERT INTO turn_timings VALUES ('u0', 't', 1000, 0, 0, 800, 200, NULL, NULL, 0)`).run();
    old.close();
    const store = new RecallStore(() => path);
    try {
      store.upsertTurnTiming({ turnEntryId: 'u1', ...base, stages });
      expect(read(path, 'u0')).toMatchObject({ skills_ms: null });
      expect(read(path, 'u1')).toMatchObject({ skills_ms: 1500, worker_run_ms: 2600 });
    } finally {
      store.close();
    }
  });
});
