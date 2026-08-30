import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiRuntime } from '../../src/server/pi/runtime';
import type { PiWorker } from '../../src/server/pi/worker';
import { updateChatsSettings } from '../../src/server/workspace/settings';
import { settingsStorePath } from '../../src/server/workspace/paths';

// The pool's parallelism claim, proven against the REAL pinned pi rather than a
// fake proc: two threads, two `pi --mode rpc` children spawned by PiRuntime
// itself, and a scripted OpenAI-compatible provider on loopback that refuses to
// answer EITHER model call until it has BOTH in flight at once. A runtime that
// still serialized turns through one process could never satisfy that barrier —
// the second request would sit queued behind the first's unanswered turn and
// the test would time out instead of passing. Same spawn recipe as
// pi-elicitation-hold.test.ts, which established that running the pinned pi as
// a real process inside the suite is worth its seconds.

/**
 * An OpenAI chat-completions endpoint that parks every response until
 * `barrier` requests are simultaneously in flight, then answers them all with
 * a short streamed completion. Later requests (there should be none) answer
 * immediately.
 */
function barrierOpenAI(barrier: number): Promise<{
  server: Server;
  port: number;
  /** Resolves when `barrier` requests have been concurrently in flight. */
  overlapped: Promise<void>;
  maxInFlight: () => number;
}> {
  let calls = 0;
  let inFlight = 0;
  let peak = 0;
  const parked: Array<() => void> = [];
  let sawOverlap!: () => void;
  const overlapped = new Promise<void>((resolve) => {
    sawOverlap = resolve;
  });
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const answer = (): void => {
        const id = calls;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        const base = {
          id: `chatcmpl-${id}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'pool-model'
        };
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: `reply-${id}` }, finish_reason: null }] });
        send({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
        });
        res.write('data: [DONE]\n\n');
        res.end();
        inFlight -= 1;
      };
      parked.push(answer);
      if (inFlight >= barrier) {
        sawOverlap();
        for (const release of parked.splice(0)) release();
      } else if (calls > barrier) {
        // Past the barrier (shouldn't happen in this test): answer directly.
        for (const release of parked.splice(0)) release();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === 'object' && address ? address.port : 0,
        overlapped,
        maxInFlight: () => peak
      });
    });
  });
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe('runtime pool against real pi', () => {
  it(
    'runs two threads genuinely in parallel: both model calls in flight at once',
    async () => {
      // No subject naming after the turns settle — it would spawn a complete()
      // child against the (unauthenticated) default provider just to fail.
      await mkdir(dirname(settingsStorePath()), { recursive: true });
      await updateChatsSettings({ subjects: 'off' });

      const { server, port, overlapped, maxInFlight } = await barrierOpenAI(2);
      cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

      const root = await mkdtemp(join(tmpdir(), 'stem-pool-live-'));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const piHome = join(root, 'pi');
      const sessions = join(piHome, 'sessions');
      const workspace = join(root, 'workspace');
      await Promise.all([mkdir(sessions, { recursive: true }), mkdir(workspace, { recursive: true })]);
      // The fake provider, in the models.json each pi child reads from its
      // agent dir (PI_CODING_AGENT_DIR = piHome). The spawn itself stays on the
      // built-in default provider — pi validates providers at spawn, and the
      // per-turn `model:` below is what routes the turn to this one.
      await writeFile(
        join(piHome, 'models.json'),
        JSON.stringify({
          providers: {
            poolfake: {
              baseUrl: `http://127.0.0.1:${port}/v1`,
              api: 'openai-completions',
              apiKey: 'test-key',
              models: [{ id: 'pool-model', name: 'Pool Model', contextWindow: 128000, maxTokens: 8192 }]
            }
          }
        })
      );

      const runtime = new PiRuntime({ piHome, sessionsDir: sessions, workspaceRoot: workspace, seedGlobalAuth: false });
      cleanups.push(() => runtime.shutdown());
      // The prompt itself is under test, not the recall/skills scaffolding
      // around it — keep the message build inert and instant.
      (runtime as unknown as { buildMessage: () => Promise<{ message: string; images: unknown[] }> }).buildMessage =
        async () => ({ message: 'say hello', images: [] });

      const settledThreads = new Set<string>();
      let sawBothSettled!: () => void;
      const bothSettled = new Promise<void>((resolve) => {
        sawBothSettled = resolve;
      });
      runtime.on('event', (event: { method: string; params?: { threadId?: string } }) => {
        if (event.method === 'turn/completed' && event.params?.threadId) {
          settledThreads.add(event.params.threadId);
          if (settledThreads.size >= 2) sawBothSettled();
        }
      });

      // Two new threads, dispatched together. Each start resolves once ITS pi
      // accepted the prompt — which, with the provider barrier holding both
      // answers back, can only happen for the second one because the first is
      // NOT blocking it.
      const [a, b] = await Promise.all([
        runtime.startTurn({ input: 'first conversation', model: 'poolfake/pool-model' }),
        runtime.startTurn({ input: 'second conversation', model: 'poolfake/pool-model' })
      ]);
      expect(a.threadId).toBeDefined();
      expect(b.threadId).toBeDefined();
      expect(a.threadId).not.toBe(b.threadId);

      // The load-bearing assertion: the provider saw both turns' model calls
      // concurrently in flight before it answered either.
      await overlapped;
      expect(maxInFlight()).toBe(2);

      // Two real pi children, one per thread, each on its own session.
      const workers = (runtime as unknown as { workers: PiWorker[] }).workers;
      expect(workers).toHaveLength(2);
      expect(new Set([workers[0].activeThreadId, workers[1].activeThreadId])).toEqual(
        new Set([a.threadId, b.threadId])
      );

      // Both turns stream to completion once the barrier releases.
      await bothSettled;
      expect(settledThreads).toEqual(new Set([a.threadId, b.threadId]));

      // Each worker wrote its per-turn gates into its OWN directory.
      expect(workers[0].gateDir).not.toBe(workers[1].gateDir);
    },
    120_000
  );
});
