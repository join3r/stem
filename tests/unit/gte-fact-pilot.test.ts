import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalRerankStatus, RetrievalSettings } from '../../src/shared/types';
import type { EmbedWorkerManager } from '../../src/server/recall/embed-manager';
import {
  createGteFactPilot, GTE_FACT_PILOT_FLOOR, GTE_FACT_PILOT_ID, GTE_SKILL_FLOOR,
  gteFactPilotEligible, verifyGteFactModel
} from '../../src/server/recall/gte-fact-pilot';
import { createLocalRerankClient } from '../../src/server/recall/rerank-local';
import { RerankUnavailableError } from '../../src/server/recall/rerank';
import {
  getFactRerankClient, getFactRerankStatus, getRerankClient, getSkillRerankClient, setRetrievalClients
} from '../../src/server/recall/retrieval';

function settings(): RetrievalSettings {
  return {
    embeddings: { mode: 'local', localModel: 'qwen3-embedding-0.6b', baseUrl: '', model: '', apiKey: null },
    reranker: { mode: 'local', localModel: 'qwen3-reranker-0.6b', factModel: GTE_FACT_PILOT_ID, baseUrl: '', model: '', apiKey: null },
    customEmbedModels: [], customRerankModels: []
  };
}

function manager(model = GTE_FACT_PILOT_ID) {
  let status: LocalRerankStatus = { model, state: 'ready' };
  const fake = {
    ensureRerank: vi.fn(),
    reconfigureRerank: vi.fn(),
    dispose: vi.fn(),
    rerankStatus: vi.fn(() => status),
    rerank: vi.fn(async (_query: string, _docs: string[], _topN: number) => [{ index: 0, score: 2.5 }])
  };
  return {
    fake,
    manager: fake as unknown as EmbedWorkerManager,
    setStatus: (next: LocalRerankStatus) => { status = next; }
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(verify = vi.fn(async (_directory: string): Promise<void> => undefined)) {
  const current = settings();
  const h = manager();
  const onFailure = vi.fn();
  const pilot = createGteFactPilot({
    directory: '/synthetic/offline-gte', manager: h.manager,
    getSettings: async () => current, onFailure, verify
  });
  return { ...h, current, pilot, verify, onFailure };
}

afterEach(() => { setRetrievalClients({}); });

describe('GTE fact pilot eligibility', () => {
  it('requires explicit GTE selection even when the model is installed and ready', async () => {
    const h = harness();
    delete h.current.reranker.factModel;
    h.pilot.start();
    await flush();
    expect(gteFactPilotEligible(h.current)).toBe(false);
    expect(await h.pilot.resolve()).toBeNull();
    expect(h.fake.ensureRerank).not.toHaveBeenCalled();
    expect(await h.pilot.status()).toEqual({ installed: true, status: { model: GTE_FACT_PILOT_ID, state: 'idle' } });
  });

  it('switches both facts and skills between GTE and Qwen', async () => {
    const h = harness();
    const qwen = { available: async () => true, rerank: vi.fn(async () => [{ index: 0, score: 1 }]) };
    setRetrievalClients({ rerank: qwen, factRerank: h.pilot.resolve, factStatus: h.pilot.status });
    h.pilot.start();
    await flush();
    expect((await getFactRerankClient())?.modelId).toBe(GTE_FACT_PILOT_ID);
    expect((await getSkillRerankClient())?.modelId).toBe(GTE_FACT_PILOT_ID);
    expect((await getFactRerankStatus()).status.state).toBe('ready');
    h.current.reranker.factModel = 'configured';
    expect(await getFactRerankClient()).toBe(qwen);
    expect(await getSkillRerankClient()).toBe(qwen);
    expect(getRerankClient()).toBe(qwen);
    expect(h.fake.reconfigureRerank).toHaveBeenCalledWith(null);
    expect((await getFactRerankStatus()).status.state).toBe('idle');
    h.current.reranker.factModel = GTE_FACT_PILOT_ID;
    expect((await getFactRerankClient())?.modelId).toBe(GTE_FACT_PILOT_ID);
    expect((await getSkillRerankClient())?.modelId).toBe(GTE_FACT_PILOT_ID);
    expect(getRerankClient()).toBe(qwen);
  });

  it('reports unavailable capability when no pilot is installed', async () => {
    expect(await getFactRerankStatus()).toEqual({ installed: false, status: { model: GTE_FACT_PILOT_ID, state: 'idle' } });
  });

  it('requires both exact measured Qwen models in local mode', () => {
    expect(gteFactPilotEligible(settings())).toBe(true);
    for (const stage of ['embeddings', 'reranker'] as const) {
      for (const mode of ['off', 'remote'] as const) {
        const config = settings();
        config[stage].mode = mode;
        expect(gteFactPilotEligible(config)).toBe(false);
      }
      const config = settings();
      config[stage].localModel = 'custom:unmeasured-model';
      expect(gteFactPilotEligible(config)).toBe(false);
    }
  });

  it('can verify while disabled, but loads only when the measured setup is selected', async () => {
    const h = harness();
    h.current.embeddings.localModel = 'multilingual-e5-small';
    h.pilot.start();
    await flush();
    expect(h.verify).toHaveBeenCalledOnce();
    expect(h.fake.ensureRerank).not.toHaveBeenCalled();
    expect(await h.pilot.resolve()).toBeNull();
    h.current.embeddings.localModel = 'qwen3-embedding-0.6b';
    expect(await h.pilot.resolve()).not.toBeNull();
    expect(h.fake.ensureRerank).toHaveBeenCalledOnce();
    h.current.reranker.mode = 'off';
    expect(await h.pilot.resolve()).toBeNull();
    expect(h.fake.ensureRerank).toHaveBeenCalledOnce();
    expect(h.fake.reconfigureRerank).toHaveBeenCalledWith(null);
  });
});

describe('GTE fact pilot validation and client', () => {
  it('shows verification progress and failure only while GTE is selected', async () => {
    const pending = deferred();
    const h = harness(vi.fn(() => pending.promise));
    expect((await h.pilot.status()).status.state).toBe('loading');
    pending.reject(new Error('wrong model hash'));
    await flush();
    expect((await h.pilot.status()).status).toEqual({ model: GTE_FACT_PILOT_ID, state: 'error', error: 'wrong model hash' });
    h.current.reranker.factModel = 'configured';
    expect((await h.pilot.status()).status.state).toBe('idle');
  });

  it('explains incompatible embeddings instead of showing the GTE worker as ready', async () => {
    const h = harness();
    h.current.embeddings.localModel = 'multilingual-e5-small';
    expect((await h.pilot.status()).status).toMatchObject({ state: 'error', error: expect.stringContaining('Qwen3 Embedding') });
  });
  it('does not load or expose even a ready backend until verification completes', async () => {
    const pending = deferred();
    const h = harness(vi.fn((_directory: string) => pending.promise));
    h.pilot.start();
    h.pilot.start();
    expect(await h.pilot.resolve()).toBeNull();
    expect(h.verify).toHaveBeenCalledExactlyOnceWith('/synthetic/offline-gte');
    expect(h.fake.ensureRerank).not.toHaveBeenCalled();
    pending.resolve();
    await flush();
    expect(h.fake.ensureRerank).toHaveBeenCalledWith(expect.objectContaining({
      id: GTE_FACT_PILOT_ID, localPath: '/synthetic/offline-gte',
      dtype: 'q8', scoring: 'gte-scalar', factGateScore: GTE_FACT_PILOT_FLOOR
    }));
    const client = await h.pilot.resolve();
    expect(client).not.toBeNull();
    expect(await client!.available()).toBe(true);
    expect(client!.modelId).toBe(GTE_FACT_PILOT_ID);
    expect(client!.maxFacts).toBe(16);
    expect(await client!.factGateScore!()).toBe(-1.6370911598205566);
    expect(await client!.minRelevantScore!()).toBe(GTE_SKILL_FLOOR);
    expect(client!.factQuery!('What next?', ['discarded', 'Earlier one', 'Earlier two'])).toBe(
      'Earlier messages from the user in this conversation:\n- Earlier one\n- Earlier two\n\nCurrent message: What next?'
    );
    expect(client!.factQuery!('Only current', [])).toBe('Only current');
    expect(await client!.rerank('contextual query', ['fact one', 'fact two'], 2)).toEqual([{ index: 0, score: 2.5 }]);
    expect(h.fake.rerank).toHaveBeenCalledExactlyOnceWith('contextual query', ['fact one', 'fact two'], 2);
    expect(await client!.rerank('empty', [], 0)).toEqual([]);
    expect(h.fake.rerank).toHaveBeenCalledOnce();
  });

  it('reports a verification failure once and never loads the rejected model', async () => {
    const pending = deferred();
    const h = harness(vi.fn((_directory: string) => pending.promise));
    h.pilot.start();
    const error = new Error('pinned tokenizer mismatch');
    pending.reject(error);
    await flush();
    expect(h.onFailure).toHaveBeenCalledExactlyOnceWith(error);
    expect(await h.pilot.resolve()).toBeNull();
    h.pilot.start();
    expect(await h.pilot.resolve()).toBeNull();
    expect(h.verify).toHaveBeenCalledOnce();
    expect(h.fake.ensureRerank).not.toHaveBeenCalled();
  });

  it('withdraws the floor and refuses inference if a resolved backend later fails', async () => {
    const h = harness();
    h.pilot.start();
    await flush();
    const client = await h.pilot.resolve();
    h.setStatus({ model: GTE_FACT_PILOT_ID, state: 'error', error: 'worker exited' });
    expect(await client!.available()).toBe(false);
    expect(await client!.factGateScore!()).toBeNull();
    await expect(client!.rerank('query', ['doc'], 1)).rejects.toBeInstanceOf(RerankUnavailableError);
    expect(h.fake.rerank).not.toHaveBeenCalled();
  });

  it('explicitly retries a failed worker while respecting the current selection', async () => {
    const h = harness();
    h.pilot.start();
    await flush();
    h.setStatus({ model: GTE_FACT_PILOT_ID, state: 'error', error: 'worker exited' });
    h.pilot.retry();
    await h.pilot.resolve();
    expect(h.fake.ensureRerank).toHaveBeenLastCalledWith(expect.objectContaining({ id: GTE_FACT_PILOT_ID }), { force: true });
    h.fake.ensureRerank.mockClear();
    h.pilot.retry();
    h.current.reranker.factModel = 'configured';
    await h.pilot.resolve();
    expect(h.fake.ensureRerank).not.toHaveBeenCalled();
  });
});

describe('GTE fact pilot shutdown', () => {
  it.each(['success', 'failure'] as const)('does not restart after pending verification finishes with %s', async (outcome) => {
    const pending = deferred();
    const h = harness(vi.fn((_directory: string) => pending.promise));
    h.pilot.start();
    expect(h.verify).toHaveBeenCalledOnce();
    h.pilot.dispose();
    h.pilot.dispose();
    expect(h.fake.dispose).toHaveBeenCalledOnce();
    if (outcome === 'success') pending.resolve();
    else pending.reject(new Error('verification ended after shutdown'));
    await flush();
    h.pilot.start();
    expect(await h.pilot.resolve()).toBeNull();
    expect(h.verify).toHaveBeenCalledOnce();
    expect(h.fake.ensureRerank).not.toHaveBeenCalled();
    expect(h.fake.reconfigureRerank).not.toHaveBeenCalled();
    expect(h.onFailure).not.toHaveBeenCalled();
  });

  it('blocks startup and resolution when their pending settings reads finish after disposal', async () => {
    const pending = deferred();
    const h = manager();
    const getSettings = vi.fn(async () => { await pending.promise; return settings(); });
    const verify = vi.fn(async () => undefined);
    const pilot = createGteFactPilot({
      directory: '/synthetic/offline-gte', manager: h.manager, getSettings, verify, onFailure: vi.fn()
    });
    pilot.start();
    await flush();
    expect(getSettings).toHaveBeenCalledOnce();
    const resolving = pilot.resolve();
    expect(getSettings).toHaveBeenCalledTimes(2);
    pilot.dispose();
    pending.resolve();
    expect(await resolving).toBeNull();
    await flush();
    pilot.start();
    expect(await pilot.resolve()).toBeNull();
    pilot.dispose();
    expect(getSettings).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledOnce();
    expect(h.fake.dispose).toHaveBeenCalledOnce();
    expect(h.fake.ensureRerank).not.toHaveBeenCalled();
    expect(h.fake.reconfigureRerank).not.toHaveBeenCalled();
  });

  it('invalidates an already resolved client and disposes its manager exactly once', async () => {
    const h = harness();
    h.pilot.start();
    await flush();
    const client = await h.pilot.resolve();
    expect(await client!.available()).toBe(true);
    h.fake.ensureRerank.mockClear();
    h.pilot.dispose();
    h.pilot.dispose();
    expect(h.fake.dispose).toHaveBeenCalledOnce();
    expect(await client!.available()).toBe(false);
    expect(await client!.factGateScore!()).toBeNull();
    await expect(client!.rerank('query', ['fact'], 1)).rejects.toBeInstanceOf(RerankUnavailableError);
    expect(await h.pilot.resolve()).toBeNull();
    h.pilot.start();
    expect(h.fake.ensureRerank).not.toHaveBeenCalled();
    expect(h.fake.rerank).not.toHaveBeenCalled();
  });
});

describe('selected reranker registry', () => {
  it('uses one GTE worker for facts and skills with separately calibrated floors', async () => {
    const h = harness();
    const qwenManager = manager('qwen3-reranker-0.6b');
    const qwen = createLocalRerankClient(async () => h.current, qwenManager.manager);
    setRetrievalClients({ rerank: qwen, factRerank: h.pilot.resolve });
    h.pilot.start();
    await flush();
    const facts = await getFactRerankClient();
    expect(facts).not.toBe(qwen);
    expect(facts!.modelId).toBe(GTE_FACT_PILOT_ID);
    const skills = await getSkillRerankClient();
    expect(skills).toBe(facts);
    expect(await skills!.minRelevantScore!()).toBe(GTE_SKILL_FLOOR);
    expect(await skills!.factGateScore!()).toBe(GTE_FACT_PILOT_FLOOR);
    await skills!.rerank('skill query', ['skill description'], 1);
    expect(h.fake.rerank).toHaveBeenCalledExactlyOnceWith('skill query', ['skill description'], 1);
    expect(qwenManager.fake.rerank).not.toHaveBeenCalled();
  });

  it('falls back to the normal client while validation is pending or fails', async () => {
    const pending = deferred();
    const h = harness(vi.fn((_directory: string) => pending.promise));
    const qwen = createLocalRerankClient(async () => h.current, manager('qwen3-reranker-0.6b').manager);
    setRetrievalClients({ rerank: qwen, factRerank: h.pilot.resolve });
    expect(await getFactRerankClient()).toBe(qwen);
    expect(await getSkillRerankClient()).toBe(qwen);
    pending.reject(new Error('missing model'));
    await flush();
    expect(await getFactRerankClient()).toBe(qwen);
    expect(await getSkillRerankClient()).toBe(qwen);
    expect(getRerankClient()).toBe(qwen);
    expect(h.fake.ensureRerank).not.toHaveBeenCalled();
  });

  it('falls back for absent, warming, errored, or wrong-model backends and disabled settings', async () => {
    const h = harness();
    const qwen = createLocalRerankClient(async () => h.current, manager('qwen3-reranker-0.6b').manager);
    setRetrievalClients({ rerank: qwen, factRerank: h.pilot.resolve });
    h.pilot.start();
    await flush();
    for (const state of ['idle', 'loading', 'downloading', 'error'] as const) {
      h.setStatus({ model: GTE_FACT_PILOT_ID, state });
      expect(await getFactRerankClient()).toBe(qwen);
    expect(await getSkillRerankClient()).toBe(qwen);
    }
    h.setStatus({ model: 'different-model', state: 'ready' });
    expect(await getFactRerankClient()).toBe(qwen);
    expect(await getSkillRerankClient()).toBe(qwen);
    h.setStatus({ model: GTE_FACT_PILOT_ID, state: 'ready' });
    h.current.reranker.localModel = 'bge-reranker-v2-m3';
    expect(await getFactRerankClient()).toBe(qwen);
    expect(await getSkillRerankClient()).toBe(qwen);
    setRetrievalClients({});
    expect(await getFactRerankClient()).toBeNull();
  });
});

describe('pinned GTE file verification', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });
  async function directory() {
    const path = await mkdtemp(join(tmpdir(), 'stem-gte-verification-test-'));
    directories.push(path);
    return path;
  }

  it('rejects a relative model path before attempting file access', async () => {
    await expect(verifyGteFactModel('relative/model')).rejects.toThrow('must be absolute');
  });

  it('rejects an absent artifact in an absolute model directory', async () => {
    await expect(verifyGteFactModel(await directory())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects wrong file bytes without trusting a model directory name', async () => {
    const path = await directory();
    await writeFile(join(path, 'config.json'), '{"model_type":"new"}\n');
    await expect(verifyGteFactModel(path)).rejects.toThrow('does not match the measured pilot: config.json');
  });
});

describe('GTE managed download lifecycle', () => {
  function managed() {
    const current = settings();
    const h = manager();
    const pending = deferred();
    const prepare = vi.fn(async (_directory: string, _options: { signal: AbortSignal; onProgress: (percent: number) => void }) => pending.promise);
    const verify = vi.fn(async () => undefined);
    const onFailure = vi.fn();
    const onProgress = vi.fn();
    const pilot = createGteFactPilot({ directory: '/synthetic/cache/gte', manager: h.manager,
      getSettings: async () => current, prepare, verify, onFailure, onProgress });
    return { ...h, current, pending, prepare, verify, onFailure, onProgress, pilot };
  }

  it('advertises download capability without downloading until selected', async () => {
    const h = managed();
    delete h.current.reranker.factModel;
    h.pilot.start();
    await flush();
    expect(await h.pilot.status()).toEqual({ installed: false, downloadable: true,
      status: { model: GTE_FACT_PILOT_ID, state: 'idle' } });
    expect(h.prepare).not.toHaveBeenCalled();
    h.current.reranker.factModel = GTE_FACT_PILOT_ID;
    await h.pilot.resolve();
    await flush();
    expect(h.prepare).toHaveBeenCalledOnce();
    h.prepare.mock.calls[0][1].onProgress(47);
    expect((await h.pilot.status()).status).toMatchObject({ state: 'downloading', progressPct: 47 });
    expect(h.onProgress).toHaveBeenCalledOnce();
    expect(h.fake.ensureRerank).not.toHaveBeenCalled();
    h.pending.resolve();
    await flush();
    expect(h.verify).toHaveBeenCalledOnce();
    expect(await h.pilot.status()).toMatchObject({ installed: true, downloadable: true, status: { state: 'ready' } });
    h.pilot.dispose();
  });

  it('cancels a deselected download and ignores its late completion', async () => {
    const h = managed();
    await h.pilot.resolve();
    await flush();
    const options = h.prepare.mock.calls[0][1];
    h.current.reranker.factModel = 'configured';
    await h.pilot.resolve();
    expect(options.signal.aborted).toBe(true);
    options.onProgress(99);
    expect(h.onProgress).not.toHaveBeenCalled();
    h.pending.resolve();
    await flush();
    expect(h.fake.ensureRerank).not.toHaveBeenCalled();
    h.current.reranker.factModel = GTE_FACT_PILOT_ID;
    await h.pilot.resolve();
    await flush();
    expect(h.prepare).toHaveBeenCalledTimes(2);
    expect(h.fake.ensureRerank).toHaveBeenCalled();
    h.pilot.dispose();
  });

  it('reports a failed download without retry storms and retries on request', async () => {
    const h = managed();
    await h.pilot.resolve();
    await flush();
    h.pending.reject(new Error('Download interrupted'));
    await flush();
    expect((await h.pilot.status()).status).toMatchObject({ state: 'error', error: 'Download interrupted' });
    await h.pilot.resolve();
    expect(h.prepare).toHaveBeenCalledOnce();
    h.prepare.mockResolvedValueOnce();
    h.pilot.retry();
    await flush();
    expect(h.prepare).toHaveBeenCalledTimes(2);
    expect((await h.pilot.status()).status.state).toBe('ready');
    h.pilot.dispose();
  });

  it('aborts managed preparation on shutdown without loading or reporting failure', async () => {
    const h = managed();
    await h.pilot.resolve();
    await flush();
    h.pilot.dispose();
    expect(h.prepare.mock.calls[0][1].signal.aborted).toBe(true);
    h.pending.reject(new Error('aborted'));
    await flush();
    expect(h.onFailure).not.toHaveBeenCalled();
    expect(h.fake.ensureRerank).not.toHaveBeenCalled();
  });
});
