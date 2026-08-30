import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiRuntime } from '../../src/server/pi/runtime';
import type { PiWorker } from '../../src/server/pi/worker';

// The worker pool: the property under test is ISOLATION — a thread is bound to
// one worker, two threads stream in parallel on two workers sharing no mutable
// session/model/gate/turn state, and the pool bound holds. Everything runs on
// fake procs (no pi child): ensureWorkerStarted is stubbed to attach one per
// worker, exactly as the spawn would.

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type FakeWorker = Omit<PiWorker, 'proc'> & {
  proc: {
    running: boolean;
    send: (command: unknown) => void;
    request: (cmd: Record<string, unknown>) => Promise<{ success: boolean; error?: string; data?: unknown }>;
  } | null;
};

interface Harness {
  runtime: PiRuntime;
  internal: {
    workers: FakeWorker[];
    onPiEvent: (worker: FakeWorker, event: Record<string, unknown>) => void;
    threadWorkers: Map<string, FakeWorker>;
    pendingStarts: Map<string, unknown>;
  };
  /** Every request each worker's fake proc received, keyed by worker id. */
  requestsByWorker: Map<number, Array<Record<string, unknown>>>;
  piHome: string;
}

async function poolRuntime(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'stem-runtime-pool-'));
  cleanup.push(root);
  const piHome = join(root, 'pi');
  const sessions = join(piHome, 'sessions');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(sessions, { recursive: true }), mkdir(workspace, { recursive: true })]);
  const runtime = new PiRuntime({ piHome, sessionsDir: sessions, workspaceRoot: workspace, seedGlobalAuth: false });
  const requestsByWorker = new Map<number, Array<Record<string, unknown>>>();
  const internal = runtime as unknown as Harness['internal'] & {
    ensureWorkerStarted: (worker: FakeWorker) => Promise<void>;
    buildMessage: () => Promise<{ message: string; images: unknown[] }>;
  };
  let nextSession = 0;
  internal.ensureWorkerStarted = async (worker) => {
    if (worker.proc?.running) return;
    const requests: Array<Record<string, unknown>> = [];
    requestsByWorker.set(worker.id, requests);
    worker.proc = {
      running: true,
      send: () => undefined,
      request: async (cmd) => {
        requests.push(cmd);
        if (cmd.type === 'get_state') {
          nextSession += 1;
          return { success: true, data: { sessionId: `session-${nextSession}` } };
        }
        return { success: true };
      }
    };
  };
  internal.buildMessage = async () => ({ message: 'prompt', images: [] });
  return { runtime, internal, requestsByWorker, piHome };
}

/** Drive one worker's live turn to settled (terminal event + pi idle). */
function settle(harness: Harness, worker: FakeWorker): void {
  harness.internal.onPiEvent(worker, { type: 'agent_end' });
  harness.internal.onPiEvent(worker, { type: 'agent_settled' });
}

describe('runtime worker pool', () => {
  it('streams two threads in parallel on two isolated workers', async () => {
    const harness = await poolRuntime();
    const { runtime, internal } = harness;

    const a = await runtime.startTurn({ input: 'first thread', webSearch: true });
    const b = await runtime.startTurn({ input: 'second thread', webSearch: false });
    expect(a.threadId).toBeDefined();
    expect(b.threadId).toBeDefined();
    expect(a.threadId).not.toBe(b.threadId);

    // Two workers, each streaming its own turn — nothing queued behind anything.
    expect(internal.workers).toHaveLength(2);
    const [w1, w2] = internal.workers;
    expect(w1.currentTurn?.threadId).toBe(a.threadId);
    expect(w2.currentTurn?.threadId).toBe(b.threadId);
    expect(harness.requestsByWorker.get(w1.id)!.map((r) => r.type)).toContain('prompt');
    expect(harness.requestsByWorker.get(w2.id)!.map((r) => r.type)).toContain('prompt');

    // Per-turn state stays per worker: capture suppression on one thread's turn
    // never reads the other worker's turn.
    w1.currentTurn!.memoryTainted = true;
    expect(runtime.isCaptureSuppressed(a.threadId!)).toBe(true);
    expect(runtime.isCaptureSuppressed(b.threadId!)).toBe(false);

    // The per-turn web-search gate landed in each worker's OWN gate directory,
    // with each turn's own setting — the file the bridge polls per process.
    const gate = async (w: FakeWorker) =>
      JSON.parse(await readFile(join(w.gateDir, 'native-search.json'), 'utf8')) as { enabled: boolean };
    await expect(gate(w1)).resolves.toEqual({ enabled: true });
    await expect(gate(w2)).resolves.toEqual({ enabled: false });

    settle(harness, w1);
    settle(harness, w2);
  });

  it('keeps a thread on its bound worker across turns', async () => {
    const harness = await poolRuntime();
    const { runtime, internal } = harness;

    const first = await runtime.startTurn({ input: 'hello' });
    const worker = internal.workers[0];
    expect(internal.threadWorkers.get(first.threadId!)).toBe(worker);
    settle(harness, worker);

    const second = await runtime.startTurn({ input: 'again', threadId: first.threadId! });
    expect(second.threadId).toBe(first.threadId);
    expect(internal.workers).toHaveLength(1);
    // Same session, same worker: no switch_session was needed for the follow-up.
    expect(worker.activeThreadId).toBe(first.threadId);
    settle(harness, worker);
  });

  it('holds a start past the pool bound until a worker settles', async () => {
    const harness = await poolRuntime();
    const { runtime, internal } = harness;
    (runtime as unknown as { maxWorkers: number }).maxWorkers = 2;

    const a = await runtime.startTurn({ input: 'one' });
    await runtime.startTurn({ input: 'two' });
    expect(internal.workers).toHaveLength(2);

    let settled = false;
    const third = runtime.startTurn({ input: 'three' }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Bound respected: no third worker, and the start is still waiting.
    expect(internal.workers).toHaveLength(2);
    expect(settled).toBe(false);

    // One turn finishes → the waiting start lands on the freed worker.
    const freed = internal.workers.find((w) => w.currentTurn?.threadId === a.threadId)!;
    settle(harness, freed);
    const result = await third;
    expect(settled).toBe(true);
    expect(internal.workers).toHaveLength(2);
    expect(freed.currentTurn?.threadId).toBe(result.threadId);
    for (const w of internal.workers) settle(harness, w);
  });

  it('serializes turns of ONE thread while other threads run free', async () => {
    const harness = await poolRuntime();
    const { runtime, internal } = harness;

    const a = await runtime.startTurn({ input: 'first' });
    const worker = internal.workers[0];

    // A second send to the SAME thread queues behind its worker's live turn…
    let secondDone = false;
    const second = runtime.startTurn({ input: 'follow-up', threadId: a.threadId! }).then((r) => {
      secondDone = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondDone).toBe(false);

    // …while a different thread starts immediately on another worker.
    const other = await runtime.startTurn({ input: 'unrelated' });
    expect(other.threadId).toBeDefined();
    expect(internal.workers).toHaveLength(2);

    settle(harness, worker);
    await second;
    expect(secondDone).toBe(true);
    for (const w of internal.workers) if (w.currentTurn) settle(harness, w);
  });
});
