import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeLocalProvider, syncModelsConfig } from '../../src/server/pi/models-config';
import { updateLocalProvider } from '../../src/server/workspace/settings';
import { settingsStorePath } from '../../src/server/workspace/paths';

const piCli = join(__dirname, '../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const modelId = 'gpt6.1sol';
const apiKey = 'sk-responses-test';
const cleanups: Array<() => Promise<void>> = [];

interface RequestRecord {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface RpcEvent {
  type: string;
  id?: string;
  success?: boolean;
  error?: string;
  message?: { role?: string; stopReason?: string; errorMessage?: string; content?: Array<Record<string, unknown>> };
  assistantMessageEvent?: { type?: string; delta?: string };
}

const probeExtension = `
export default function responsesProbe(pi) {
  pi.registerTool({
    name: 'responses_probe',
    label: 'Responses probe',
    description: 'Return the supplied marker for a protocol test.',
    parameters: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] },
    async execute(_id, params) {
      return { content: [{ type: 'text', text: 'probe:' + params.marker }], details: {} };
    }
  });
}
`;

async function responsesServer(rejectResponses = false): Promise<{
  baseUrl: string;
  requests: RequestRecord[];
}> {
  const requests: RequestRecord[] = [];
  let turns = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { raw += chunk; });
    req.on('end', () => {
      let body: Record<string, unknown>;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        res.writeHead(400).end('invalid JSON');
        return;
      }
      requests.push({ method: req.method, path: req.url, headers: req.headers, body });
      if (req.headers.authorization !== `Bearer ${apiKey}`) {
        res.writeHead(401).end('wrong bearer token');
        return;
      }
      if (req.method === 'GET' && req.url === '/openai/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: modelId }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/openai/v1/responses' || rejectResponses) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Responses unavailable' } }));
        return;
      }
      if (++turns > 2) {
        res.writeHead(400).end('unexpected extra turn');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let sequence = 0;
      const send = (type: string, data: Record<string, unknown>) => {
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
      };
      const response = { id: `resp_${turns}`, object: 'response', model: modelId, status: 'in_progress', output: [] };
      send('response.created', { response });
      let item: Record<string, unknown>;
      if (turns === 1) {
        item = { type: 'function_call', id: 'fc_probe_1', call_id: 'call_probe_1', name: 'responses_probe', arguments: '', status: 'in_progress' };
        send('response.output_item.added', { output_index: 0, item });
        for (const delta of ['{"marker":', '"round-trip"}']) {
          send('response.function_call_arguments.delta', { output_index: 0, item_id: item.id, delta });
        }
        item = { ...item, arguments: '{"marker":"round-trip"}', status: 'completed' };
        send('response.function_call_arguments.done', { output_index: 0, item_id: item.id, arguments: item.arguments });
      } else {
        item = { type: 'message', id: 'msg_final', role: 'assistant', status: 'in_progress', content: [] };
        send('response.output_item.added', { output_index: 0, item });
        send('response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        for (const delta of ['Responses ', 'round-trip complete']) {
          send('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta });
        }
        const text = 'Responses round-trip complete';
        send('response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text });
        item = { ...item, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      }
      send('response.output_item.done', { output_index: 0, item });
      send('response.completed', {
        response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } }
      });
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing loopback port');
  return { baseUrl: `http://127.0.0.1:${address.port}/openai/v1`, requests };
}

async function configuredHome(baseUrl: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'stem-responses-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  vi.stubEnv('STEM_STATE_DIR', join(home, 'state'));
  vi.stubEnv('STEM_PI_MODELS_CONFIG', join(home, 'agent/models.json'));
  await mkdir(dirname(settingsStorePath()), { recursive: true });
  await updateLocalProvider('custom', { enabled: true, baseUrl, api: 'openai-responses', apiKey, models: [modelId] });
  expect(await syncModelsConfig()).toBe(true);
  return home;
}

async function runPiTurn(home: string): Promise<RpcEvent[]> {
  const extensionPath = join(home, 'responses-probe.mjs');
  await writeFile(extensionPath, probeExtension);
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [
    piCli, '--mode', 'rpc', '--no-extensions', '-e', extensionPath,
    '--no-skills', '--no-prompt-templates', '--tools', 'responses_probe',
    '--provider', 'custom', '--model', modelId
  ], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, 'agent'), PI_OFFLINE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  cleanups.push(async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const events: RpcEvent[] = [];
  try {
    return await new Promise<RpcEvent[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`pi turn timed out: ${stderr}`)), 30_000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('exit', (code, signal) => fail(new Error(`pi exited (${code}, ${signal}): ${stderr}`)));
      child.stdin.on('error', fail);
      lines.on('line', (line) => {
        let event: RpcEvent;
        try { event = JSON.parse(line); } catch { return; }
        events.push(event);
        if (event.type === 'response' && event.success === false) {
          fail(new Error(`RPC failed: ${event.error}`));
        } else if (event.type === 'response' && event.id === 'ready') {
          child.stdin.write(`${JSON.stringify({ type: 'prompt', id: 'turn', message: 'Call responses_probe with marker round-trip, then report completion.' })}\n`);
        } else if (event.type === 'agent_end') {
          clearTimeout(timer);
          resolve(events);
        }
      });
      // Wait for an RPC readiness response rather than guessing startup duration.
      child.stdin.write(`${JSON.stringify({ type: 'get_state', id: 'ready' })}\n`);
    });
  } finally {
    lines.close();
  }
}

afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  vi.unstubAllEnvs();
  if (errors.length) throw new AggregateError(errors, 'Responses integration cleanup failed');
});

describe('generated Responses config against real pi', () => {
  it('streams a tool call, executes it, and replays its result through authenticated Responses requests', async () => {
    const { baseUrl, requests } = await responsesServer();
    const home = await configuredHome(baseUrl);
    const events = await runPiTurn(home);

    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ['POST', '/openai/v1/responses'],
      ['POST', '/openai/v1/responses']
    ]);
    for (const request of requests) {
      expect(request.headers.authorization).toBe(`Bearer ${apiKey}`);
      expect(request.body).toMatchObject({ model: modelId, stream: true, store: false });
    }
    expect(requests[0].body.tools).toEqual([
      expect.objectContaining({ type: 'function', name: 'responses_probe', parameters: expect.objectContaining({ required: ['marker'] }) })
    ]);
    const replay = requests[1].body.input as Array<Record<string, unknown>>;
    const call = replay.find((item) => item.type === 'function_call');
    expect(call).toMatchObject({ name: 'responses_probe', arguments: '{"marker":"round-trip"}', call_id: expect.any(String) });
    expect(replay).toContainEqual({ type: 'function_call_output', call_id: call!.call_id, output: 'probe:round-trip' });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'message_update', assistantMessageEvent: expect.objectContaining({ type: 'toolcall_delta' })
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'message_end', message: expect.objectContaining({ role: 'toolResult', content: [{ type: 'text', text: 'probe:round-trip' }] })
    }));
    expect(events.filter((e) => e.assistantMessageEvent?.type === 'text_delta').map((e) => e.assistantMessageEvent?.delta).join(''))
      .toBe('Responses round-trip complete');
    expect(events.filter((e) => e.type === 'message_end' && e.message?.role === 'assistant').at(-1)?.message)
      .toMatchObject({ stopReason: 'stop', content: [expect.objectContaining({ type: 'text', text: 'Responses round-trip complete' })] });
  }, 60_000);

  it('surfaces a rejected Responses turn even when Test connection lists the model', async () => {
    const { baseUrl, requests } = await responsesServer(true);
    const home = await configuredHome(baseUrl);
    expect(await probeLocalProvider(baseUrl, apiKey, 'openai-responses'))
      .toEqual({ ok: true, api: 'openai-responses', models: [modelId] });

    const events = await runPiTurn(home);
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ['GET', '/openai/v1/models'],
      ['POST', '/openai/v1/responses']
    ]);
    expect(events.filter((e) => e.type === 'message_end' && e.message?.role === 'assistant').at(-1)?.message)
      .toMatchObject({ stopReason: 'error', errorMessage: expect.stringContaining('Responses unavailable') });
    expect(events.some((e) => e.type === 'tool_execution_start')).toBe(false);
  }, 60_000);
});
