// Embed-endpoint protocol: token gating, unavailable-client fast-fail, and the
// vector roundtrip — over a real unix socket in tmpdir (pure node:net, fine in
// the forks pool). The MCP-side consumer of this protocol is exercised by
// scripts/recall-mcp-probe.mjs against the real compiled MCP server.
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getEmbedEndpointToken, startEmbedEndpoint } from '../../src/server/recall/embed-endpoint';
import type { EmbeddingsClient } from '../../src/server/recall/embeddings';
import type { FactRerankClient } from '../../src/server/recall/retrieval';
import { recallStore as store } from '../../src/server/recall/store';

// A named pipe on Windows, as embedSocketPath() gives the real endpoint there.
const SOCK =
  process.platform === 'win32' ? `\\\\.\\pipe\\stem-embed-test-${process.pid}` : join(tmpdir(), `stem-embed-test-${process.pid}.sock`);

function request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(SOCK);
    let buf = '';
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      socket.destroy();
      resolve(JSON.parse(buf.slice(0, nl)));
    });
    socket.on('connect', () => socket.write(`${JSON.stringify(body)}\n`));
  });
}

const goodClient: EmbeddingsClient = {
  available: async () => true,
  modelId: async () => 'fake-model',
  embed: async (texts, kind) => texts.map(() => Float32Array.from(kind === 'query' ? [1, 0] : [0, 1]))
};

let client: EmbeddingsClient | null = goodClient;
/** Scores a fact by the number in its text ("score 3"); floor 0. */
const gate: FactRerankClient = {
  available: async () => true,
  factGateScore: async () => 0,
  rerank: async (_q, docs) => docs.map((doc, index) => ({ index, score: Number(/score (-?\d+)/.exec(doc)?.[1] ?? -9) }))
};
let factGate: FactRerankClient | null = gate;
const endpoint = startEmbedEndpoint({ socketPath: SOCK, getClient: () => client, getFactGate: async () => factGate });

afterAll(async () => {
  await endpoint.close();
});

describe('fact gate op (search_facts)', () => {
  it('returns the ids that clear the floor, sensitive ones only past the margin, in search order', async () => {
    store.resetFacts();
    const high = store.upsertFact('The user owns a bike, score 3', 'explicit')!;
    const low = store.upsertFact('The user likes jazz, score -1', 'explicit')!;
    const sensLow = store.upsertFact('The user has asthma, score 1', 'explicit', { sensitivity: 'sensitive' })!;
    const sensHigh = store.upsertFact('The user lives in Brno, score 4', 'explicit', { sensitivity: 'sensitive' })!;
    const token = getEmbedEndpointToken();
    const res = await request({ id: 4, op: 'factGate', query: 'q', ids: [sensHigh, low, high, sensLow], token });
    expect(res).toEqual({ id: 4, ok: true, pass: [sensHigh, high] });
  });

  it('says it cannot gate when there is no calibrated fact reranker, and refuses bad requests', async () => {
    const token = getEmbedEndpointToken();
    factGate = { ...gate, factGateScore: async () => null };
    expect(await request({ id: 1, op: 'factGate', query: 'q', ids: [1], token })).toMatchObject({ ok: false, error: 'fact gate unavailable' });
    factGate = null;
    expect(await request({ id: 2, op: 'factGate', query: 'q', ids: [1], token })).toMatchObject({ ok: false });
    factGate = gate;
    for (const bad of [
      { id: 3, op: 'factGate', query: '', ids: [1], token },
      { id: 4, op: 'factGate', query: 'q', ids: Array.from({ length: 31 }, (_, i) => i), token },
      { id: 5, op: 'factGate', query: 'q', ids: ['1'], token }
    ]) {
      expect(await request(bad)).toMatchObject({ ok: false, error: 'bad request' });
    }
  });
});

describe('embed endpoint', () => {
  it('round-trips a query embedding with model + dim', async () => {
    const res = await request({ id: 7, op: 'embed', kind: 'query', texts: ['hello'], token: getEmbedEndpointToken() });
    expect(res).toEqual({ id: 7, ok: true, model: 'fake-model', dim: 2, vectors: [[1, 0]] });
  });

  it('rejects a bad token without touching the client', async () => {
    const res = await request({ id: 1, op: 'embed', kind: 'query', texts: ['x'], token: 'wrong' });
    expect(res).toMatchObject({ ok: false, error: 'bad token' });
  });

  it('rejects malformed requests (no texts / too many / wrong op)', async () => {
    const token = getEmbedEndpointToken();
    for (const bad of [
      { id: 1, op: 'embed', texts: [], token },
      { id: 2, op: 'embed', texts: Array.from({ length: 9 }, () => 'x'), token },
      { id: 3, op: 'delete', texts: ['x'], token }
    ]) {
      const res = await request(bad);
      expect(res).toMatchObject({ ok: false, error: 'bad request' });
    }
  });

  it('answers ok:false fast when embeddings are off or unavailable', async () => {
    const token = getEmbedEndpointToken();
    client = null;
    expect(await request({ id: 1, op: 'embed', texts: ['x'], token })).toMatchObject({
      ok: false,
      error: 'embeddings unavailable'
    });
    client = { ...goodClient, available: async () => false };
    expect(await request({ id: 2, op: 'embed', texts: ['x'], token })).toMatchObject({
      ok: false,
      error: 'embeddings unavailable'
    });
    client = goodClient;
  });

  it('reports an embed failure as ok:false instead of dying', async () => {
    client = {
      ...goodClient,
      embed: async () => {
        throw new Error('worker crashed');
      }
    };
    const res = await request({ id: 1, op: 'embed', texts: ['x'], token: getEmbedEndpointToken() });
    expect(res).toMatchObject({ ok: false, error: 'worker crashed' });
    client = goodClient;
  });
});
