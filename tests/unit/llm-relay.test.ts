import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLlmRelay, type LlmRelay } from '../../src/server/llm-device/router';
import { createLlmHost, isLocalHost, refusal, type LlmHost } from '../../src/desktop/llm-host';
import { LLM_CANCEL_FRAME, LLM_REQUEST_FRAME, type DeviceLlmRequest } from '../../src/shared/types';

// The relay and the device host wired back to back, the transport replaced by
// direct calls: a frame pushed to the device is handed to the host, and the
// host's RPCs land in the relay. Everything else — the loopback listener, the
// fetch against a model server, the chunking — is real.

let model: Server | null = null;
let relay: LlmRelay | null = null;
let host: LlmHost | null = null;

afterEach(async () => {
  host?.close();
  relay?.close();
  await new Promise<void>((resolve) => (model ? model.close(() => resolve()) : resolve()));
  model = null;
});

async function startModel(handler: Parameters<typeof createServer>[1]): Promise<string> {
  model = createServer(handler);
  await new Promise<void>((resolve) => model!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
}

function wire(opts: { connected?: boolean } = {}) {
  const frames: { name: string; data: unknown }[] = [];
  relay = createLlmRelay({
    pushTo: (_deviceId, name, data) => {
      frames.push({ name, data });
      if (opts.connected === false) return 0;
      if (name === LLM_REQUEST_FRAME) host!.onRequest(data as DeviceLlmRequest);
      if (name === LLM_CANCEL_FRAME) host!.onCancel(data as { requestId: string });
      return 1;
    },
    connectedDevices: () => new Set(opts.connected === false ? [] : ['mac']),
    deviceLabel: async () => '“Vlado’s Mac”'
  });
  host = createLlmHost({
    invoke: async (channel, args) => {
      expect(channel).toBe('llmHost:chunk');
      return relay!.onChunk('mac', args[0]);
    }
  });
  return { frames };
}

describe('model server relay', () => {
  it('lists models and streams a completion from the device', async () => {
    const base = await startModel((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'swift-1.5-mlx' }] }));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        expect(JSON.parse(body).model).toBe('swift-1.5-mlx');
        expect(req.headers.authorization).toBe('Bearer local');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"delta":"Hel"}\n\n');
        setTimeout(() => res.end('data: {"delta":"lo"}\n\ndata: [DONE]\n\n'), 60);
      });
    });
    wire();
    relay!.setRoute('lmstudio', { deviceId: 'mac', baseUrl: base });
    const url = await relay!.baseFor('lmstudio');

    const list = await fetch(`${url}/v1/models`);
    expect(await list.json()).toEqual({ data: [{ id: 'swift-1.5-mlx' }] });

    const chat = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({ model: 'swift-1.5-mlx', stream: true })
    });
    expect(chat.status).toBe(200);
    expect(chat.headers.get('content-type')).toBe('text/event-stream');
    expect(await chat.text()).toBe('data: {"delta":"Hel"}\n\ndata: {"delta":"lo"}\n\ndata: [DONE]\n\n');
  });

  it('answers a sleeping computer with a sentence, not a hang', async () => {
    wire({ connected: false });
    relay!.setRoute('lmstudio', { deviceId: 'mac', baseUrl: 'http://localhost:1234' });
    const res = await fetch(`${await relay!.baseFor('lmstudio')}/v1/models`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('“Vlado’s Mac”');
  });

  it('refuses a request without the token or for an unknown route', async () => {
    wire();
    const url = await relay!.baseFor('lmstudio');
    expect((await fetch(`${url}/v1/models`)).status).toBe(404);
    expect((await fetch(url.replace(/\/[0-9a-f]{32}\//, '/nope/') + '/v1/models')).status).toBe(404);
  });

  it('passes the model server’s own error status through', async () => {
    const base = await startModel((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"model not loaded"}}');
    });
    wire();
    relay!.setRoute('lmstudio', { deviceId: 'mac', baseUrl: base });
    const res = await fetch(`${await relay!.baseFor('lmstudio')}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('model not loaded');
  });

  it('tells the device to stop when the caller hangs up', async () => {
    let aborted!: () => void;
    const gone = new Promise<void>((resolve) => (aborted = resolve));
    const base = await startModel((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      req.on('close', () => aborted());
    });
    const { frames } = wire();
    relay!.setRoute('lmstudio', { deviceId: 'mac', baseUrl: base });
    const controller = new AbortController();
    const res = await fetch(`${await relay!.baseFor('lmstudio')}/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
      signal: controller.signal
    });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await gone;
    expect(frames.some((f) => f.name === LLM_CANCEL_FRAME)).toBe(true);
  });
});

describe('device side of the relay', () => {
  it('does not follow a redirect off the checked address', async () => {
    const base = await startModel((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
    });
    wire();
    relay!.setRoute('lmstudio', { deviceId: 'mac', baseUrl: base });
    const res = await fetch(`${await relay!.baseFor('lmstudio')}/v1/models`);
    expect(res.status).toBe(502);
  });

  it('reaches only this computer and its local network', () => {
    for (const h of ['localhost', '127.0.0.1', '192.168.1.164', '10.0.0.2', '172.20.1.1', '100.101.1.2', 'gpubox', 'mac.local', '[::1]']) {
      expect(isLocalHost(h), h).toBe(true);
    }
    for (const h of ['api.openai.com', '8.8.8.8', '172.32.0.1', 'example.com', '169.254.169.254', '[fe80::1]']) {
      expect(isLocalHost(h), h).toBe(false);
    }
  });

  it('relays only model API paths', () => {
    const req = (url: string): DeviceLlmRequest => ({ requestId: 'x', url, method: 'GET', headers: {} });
    expect(refusal(req('http://localhost:1234/v1/models'))).toBeNull();
    expect(refusal(req('http://localhost:11434/api/show'))).toBeNull();
    // A reasoning model on a paired computer turns through /v1/responses; the
    // host must relay it, or every turn 502s while /v1/models discovery passes.
    expect(refusal(req('http://localhost:1234/v1/responses'))).toBeNull();
    expect(refusal(req('http://localhost:8080/admin'))).toMatch(/model API/);
    expect(refusal(req('http://localhost:8080/v1/admin/users'))).toMatch(/model API/);
    expect(refusal(req('http://localhost:1234/lmstudio/v1/chat/completions'))).toBeNull();
    expect(refusal(req('http://localhost:8080/admin.php/v1/models'))).toMatch(/model API/);
    expect(refusal(req('http://localhost:8080/x;y/v1/models'))).toMatch(/model API/);
    // The URL parser resolves an escaped ".." the same way fetch does, so this IS /v1/models.
    expect(refusal(req('http://localhost:8080/%2e%2e/v1/models'))).toBeNull();
    expect(refusal(req('http://localhost:8080/a%2Fb/v1/models'))).toMatch(/model API/);
    expect(refusal(req('https://api.openai.com/v1/models'))).toMatch(/local network/);
  });

  it('sends a refused request back as an error the caller sees', async () => {
    wire();
    relay!.setRoute('custom', { deviceId: 'mac', baseUrl: 'https://api.example.com' });
    const res = await fetch(`${await relay!.baseFor('custom')}/v1/models`);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('not on this computer');
  });
});
