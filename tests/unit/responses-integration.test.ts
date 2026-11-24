import { createServer, type Server, type IncomingMessage } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiRuntime } from '../../src/server/pi/runtime';
import { syncModelsConfig } from '../../src/server/pi/models-config';
import { updateChatsSettings, updateLocalProvider } from '../../src/server/workspace/settings';
import { settingsStorePath } from '../../src/server/workspace/paths';

// The whole point of the openai-responses flavor, proven against the REAL pinned
// pi rather than a stub, AND through Stem's own config path: a user who sets a
// custom endpoint to the Responses flavor ends up with a pi `--mode rpc` child
// that sends the turn — carrying its function tools — to POST /v1/responses, NOT
// /v1/chat/completions. That route is the exact thing gpt-6.1-sol rejected on
// completions, so it is the fix's load-bearing claim.
//
// The config is GENERATED, not hand-written: updateLocalProvider runs the same
// coerce() the fix touched, and syncModelsConfig writes the same block. On HEAD
// both drop the unknown flavor back to openai-completions, pi hits
// /v1/chat/completions, the mock 404s it, and this test fails — which is what
// makes it a real regression guard rather than a restatement of a pi fact.
//
// Scope on purpose: this asserts the ROUTE and that tools ride along, then shuts
// down. It does not replay a full Responses tool round-trip — pi owns that SSE
// parsing and tests it itself. Same real-pi spawn recipe as
// runtime-pool-live.test.ts.

interface Captured {
  path: string;
  auth?: string;
  body: string;
}

/**
 * A minimal OpenAI endpoint that records every request (path, auth, body). It
 * answers /v1/responses with a tiny valid streamed completion so the turn can
 * settle, and 404s /v1/chat/completions so a mis-route would fail loudly.
 */
function recordingOpenAI(): Promise<{
  server: Server;
  port: number;
  calls: Captured[];
  /** Resolves on the first POST to /v1/responses. */
  sawResponses: Promise<Captured>;
}> {
  const calls: Captured[] = [];
  let resolveSaw!: (c: Captured) => void;
  const sawResponses = new Promise<Captured>((resolve) => {
    resolveSaw = resolve;
  });
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => resolve(raw));
    });
  const server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const auth = req.headers.authorization;
      const call: Captured = { path, auth, body };
      calls.push(call);
      if (path.endsWith('/v1/responses')) {
        resolveSaw(call);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (type: string, payload: unknown) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
        const response = {
          id: 'resp_1',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'msg_1',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'hi', annotations: [] }]
            }
          ],
          usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 }
        };
        send('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
        send('response.completed', { type: 'response.completed', response });
        res.end();
        return;
      }
      // Any other route (notably /v1/chat/completions) must never be hit.
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unexpected ${path}` } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === 'object' && address ? address.port : 0,
        calls,
        sawResponses
      });
    });
  });
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe('openai-responses flavor against real pi', () => {
  it(
    'routes the turn and its tools to POST /v1/responses, not /v1/chat/completions',
    async () => {
      // No subject naming after the turn — it would spawn a child against the
      // unauthenticated default provider just to fail.
      await mkdir(dirname(settingsStorePath()), { recursive: true });
      await updateChatsSettings({ subjects: 'off' });

      const { server, port, calls, sawResponses } = await recordingOpenAI();
      cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

      const root = await mkdtemp(join(tmpdir(), 'stem-responses-live-'));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const piHome = join(root, 'pi');
      const sessions = join(piHome, 'sessions');
      const workspace = join(root, 'workspace');
      await Promise.all([mkdir(sessions, { recursive: true }), mkdir(workspace, { recursive: true })]);

      // Generate models.json through Stem's real path. updateLocalProvider runs
      // coerce() (must keep the flavor), syncModelsConfig writes the block (must
      // not clamp it onto completions). Point the writer at this child's home.
      const prevModelsEnv = process.env.STEM_PI_MODELS_CONFIG;
      process.env.STEM_PI_MODELS_CONFIG = join(piHome, 'models.json');
      cleanups.push(() => {
        if (prevModelsEnv === undefined) delete process.env.STEM_PI_MODELS_CONFIG;
        else process.env.STEM_PI_MODELS_CONFIG = prevModelsEnv;
      });
      // Hand-entered model id so the sync skips its live probe.
      await updateLocalProvider('custom', {
        enabled: true,
        baseUrl: `http://127.0.0.1:${port}/openai`,
        api: 'openai-responses',
        apiKey: 'test-key',
        models: ['gpt-6.1-sol']
      });
      await syncModelsConfig();

      const runtime = new PiRuntime({ piHome, sessionsDir: sessions, workspaceRoot: workspace, seedGlobalAuth: false });
      cleanups.push(() => runtime.shutdown());
      (runtime as unknown as { buildMessage: () => Promise<{ message: string; images: unknown[] }> }).buildMessage =
        async () => ({ message: 'say hello', images: [] });

      await runtime.startTurn({ input: 'hello', model: 'custom/gpt-6.1-sol' });

      // The load-bearing fact: pi hit the Responses route with a bearer token.
      const responsesCall = await sawResponses;
      expect(responsesCall.auth).toBe('Bearer test-key');

      // And the turn carried function tools — the exact combo gpt-6.1-sol
      // rejected on chat/completions. pi always declares tools, so the body
      // holds a non-empty `tools` array.
      const payload = JSON.parse(responsesCall.body) as { tools?: unknown[] };
      expect(Array.isArray(payload.tools) && payload.tools.length > 0).toBe(true);

      // Never the completions route. A single mis-route would 404 here.
      expect(calls.some((c) => c.path.endsWith('/v1/chat/completions'))).toBe(false);
    },
    120_000
  );
});
