import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The harness bridge (coding_agent) holds one ctx.ui.input elicitation open for
// an entire external coding-agent turn, which can run for HOURS. Every earlier
// bridge held one for minutes at most (an exec approval plus the command), so
// nothing anywhere proved that pi itself never times a held elicitation out.
// This file is that proof, against the real pinned pi, as a real process.
//
// Two halves:
//
// 1. A behavioral tripwire. Real pi in RPC mode, a scripted OpenAI-compatible
//    provider on loopback, one tool whose execute() awaits ctx.ui.input. The
//    child runs under a preloaded shim that makes any timer armed by pi's own
//    dialog/agent code fire almost immediately, so a hypothetical elicitation
//    timeout at ANY horizon (ten minutes or ten hours) would expire during the
//    few seconds the test holds the answer back. Provider-SDK timers (request
//    timeout, retry backoff) are left at real speed, since compressing those
//    aborts the fake model call itself. If the tool result still carries the
//    held answer, no pi-side timer can ever cancel a held elicitation.
//
// 2. A drift guard on the pinned pi source. The only timeout mechanism on a
//    dialog promise is the caller's opts.timeout (rpc-mode.js arms a timer only
//    under `opts?.timeout`), and Stem's bridge extension never passes opts. An
//    upgrade of the exact-pinned pi that changes either shape fails here, at
//    the version boundary, instead of hours into somebody's harness run.

const repoRoot = join(__dirname, '..', '..');
const piDist = join(repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist');

const PROBE_EXTENSION = `
export default function holdProbe(pi) {
  pi.registerTool({
    name: 'hold_probe',
    label: 'Hold probe',
    description: 'Test tool that waits on a UI elicitation.',
    parameters: { type: 'object', properties: {} },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const value = await ctx.ui.input('elicitation-hold-probe', 'held');
      return { content: [{ type: 'text', text: 'hold-resolved:' + (value === undefined ? '(cancelled)' : value) }], details: {} };
    }
  });
}
`;

// Preloaded into the pi child. Timers armed from pi's own dist (dialog promise,
// extension runner, agent loop) fire at once; everything else runs real time.
const TIME_SHIM = `
const realSetTimeout = global.setTimeout;
const PI_FRAMES = /pi-coding-agent[\\/\\\\]dist[\\/\\\\](modes[\\/\\\\]rpc|core|extensions)|pi-agent-core[\\/\\\\]dist/;
const fast = function (fn, ms, ...args) {
  if (typeof ms === 'number' && ms >= 250) {
    const stack = new Error().stack || '';
    if (PI_FRAMES.test(stack)) return realSetTimeout(fn, 1, ...args);
  }
  return realSetTimeout(fn, ms, ...args);
};
Object.assign(fast, realSetTimeout);
global.setTimeout = fast;
`;

/**
 * The other half of the conversation: an OpenAI chat-completions endpoint that
 * answers the first call with a hold_probe tool call and any later call with
 * plain text, inlined here so the whole protocol is legible in one screen.
 */
function fakeOpenAI(): Promise<{ server: Server; port: number }> {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const base = { id: `chatcmpl-${calls}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'hold-model' };
      if (calls === 1) {
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_hold_1', type: 'function', function: { name: 'hold_probe', arguments: '{}' } }] },
              finish_reason: null
            }
          ]
        });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      } else {
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe('pi elicitation hold', () => {
  it(
    'never times out a held ctx.ui.input, even with pi-side timers compressed to nothing',
    async () => {
      const { server, port } = await fakeOpenAI();
      cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));

      const home = await mkdtemp(join(tmpdir(), 'stem-hold-'));
      cleanups.push(() => rm(home, { recursive: true, force: true }));
      const agentDir = join(home, 'agent');
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, 'models.json'),
        JSON.stringify({
          providers: {
            holdfake: {
              baseUrl: `http://127.0.0.1:${port}/v1`,
              api: 'openai-completions',
              apiKey: 'test-key',
              models: [{ id: 'hold-model', name: 'Hold Model', contextWindow: 128000, maxTokens: 8192 }]
            }
          }
        })
      );
      const extensionPath = join(home, 'probe-extension.mjs');
      const shimPath = join(home, 'shim.cjs');
      await writeFile(extensionPath, PROBE_EXTENSION);
      await writeFile(shimPath, TIME_SHIM);

      const child: ChildProcessWithoutNullStreams = spawn(
        process.execPath,
        [join(piDist, 'cli.js'), '--mode', 'rpc', '-e', extensionPath, '--provider', 'holdfake', '--model', 'hold-model'],
        {
          cwd: home,
          env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, NODE_OPTIONS: `--require ${shimPath}` },
          stdio: ['pipe', 'pipe', 'pipe']
        }
      );
      cleanups.push(() => {
        child.kill('SIGKILL');
      });

      const HOLD_MS = 3_000;
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      const outcome = await new Promise<string>((resolve, reject) => {
        let buf = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            let ev: Record<string, unknown>;
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            if (ev.type === 'extension_ui_request' && ev.method === 'input' && ev.title === 'elicitation-hold-probe') {
              const id = ev.id;
              setTimeout(() => {
                child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id, value: 'answered-after-hold' })}\n`);
              }, HOLD_MS);
            }
            const text = JSON.stringify(ev);
            if (ev.type === 'message_end' && text.includes('hold-resolved:')) {
              resolve(text);
              return;
            }
          }
        });
        child.on('exit', (code, signal) => reject(new Error(`pi exited before the tool settled (code ${code}, signal ${signal}): ${stderr.slice(-500)}`)));
        // Boot first, then prompt; a session_start elicitation would deadlock
        // pi's startup (bindExtensions awaits handlers before the stdin reader
        // attaches), so the elicitation must come from a tool inside a turn.
        setTimeout(() => {
          child.stdin.write(`${JSON.stringify({ type: 'prompt', id: 'p1', message: 'call the hold_probe tool' })}\n`);
        }, 1_200);
      });

      expect(outcome).toContain('hold-resolved:answered-after-hold');
      expect(outcome).not.toContain('(cancelled)');
    },
    120_000
  );

  it('pi arms a dialog timer only when the caller passes opts.timeout, and the bridges never do', async () => {
    const rpcMode = await readFile(join(piDist, 'modes', 'rpc', 'rpc-mode.js'), 'utf8');
    // The one setTimeout in the dialog promise sits behind `if (opts?.timeout)`.
    expect(rpcMode).toMatch(/if \(opts\?\.timeout\) \{\s*timeoutId = setTimeout\(/);
    // And no other timer is armed anywhere in the dialog/response plumbing.
    expect(rpcMode.match(/setTimeout\(/g)).toHaveLength(1);

    const extension = await readFile(join(repoRoot, 'src', 'server', 'pi', 'stem-mcp-extension.mjs'), 'utf8');
    const inputCalls = [...extension.matchAll(/ctx\.ui\.input\((.*)\);/g)].map((m) => m[1]);
    expect(inputCalls.length).toBeGreaterThan(0);
    for (const args of inputCalls) {
      // Two arguments (title, payload) and never a third opts argument, which
      // is the only way a bridge elicitation could acquire a timeout.
      expect(args).toMatch(/^[A-Za-z_$][\w$]*,\s*JSON\.stringify\([\w$]+\)$/);
    }
  });
});
