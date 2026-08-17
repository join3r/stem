import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  overlayPatchFromSource,
  previewPiModelsJson,
  previewPiModelsSource,
  resolveModelsPath
} from '../../src/server/pi/models-copy';
import type { LocalProviderSettings } from '../../src/shared/types';

const emptyCustom: LocalProviderSettings = { enabled: false, baseUrl: '' };

const vllmBlock = {
  baseUrl: 'http://localhost:8000/v1',
  api: 'openai-completions',
  apiKey: 'local',
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    thinkingFormat: 'qwen-chat-template'
  },
  models: [
    {
      id: 'qwen3-32b',
      reasoning: true,
      maxTokens: 32768,
      contextWindow: 131072,
      compat: { thinkingFormat: 'qwen-chat-template' }
    },
    { id: 'glm-4.5', reasoning: true, maxTokens: 16384, compat: { thinkingFormat: 'zai' } }
  ]
};

describe('previewPiModelsJson', () => {
  it('lists providers from a full models.json', () => {
    const res = previewPiModelsJson(JSON.stringify({ providers: { vllm: vllmBlock, ollama: { models: [{ id: 'llama' }] } } }));
    expect(res.ok).toBe(true);
    expect(res.providers).toEqual([
      { id: 'vllm', modelIds: ['qwen3-32b', 'glm-4.5'], baseUrl: 'http://localhost:8000/v1' },
      { id: 'ollama', modelIds: ['llama'] }
    ]);
  });

  it('treats a single provider block as custom', () => {
    const res = previewPiModelsJson(JSON.stringify(vllmBlock));
    expect(res.ok).toBe(true);
    expect(res.providers).toEqual([
      { id: 'custom', modelIds: ['qwen3-32b', 'glm-4.5'], baseUrl: 'http://localhost:8000/v1' }
    ]);
  });

  it('rejects corrupt JSON without writing', () => {
    expect(previewPiModelsJson('{not json')).toEqual({ ok: false, error: 'That is not valid JSON.' });
  });

  it('rejects JSON with no models', () => {
    expect(previewPiModelsJson(JSON.stringify({ providers: { empty: { baseUrl: 'http://x' } } })).ok).toBe(false);
  });
});

describe('overlayPatchFromSource', () => {
  it('copies a vllm provider onto custom extras and leaves source fields intact', async () => {
    const res = await overlayPatchFromSource(
      { json: JSON.stringify({ providers: { vllm: vllmBlock } }) },
      'vllm',
      emptyCustom
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.patch.enabled).toBe(true);
    expect(res.patch.baseUrl).toBe('http://localhost:8000');
    expect(res.patch.api).toBe('openai-completions');
    expect(res.patch.models).toEqual(['qwen3-32b', 'glm-4.5']);
    expect(res.patch.preserveModelsConfig).toBe(true);
    expect(res.patch.modelExtras[0]).toMatchObject({
      id: 'qwen3-32b',
      reasoning: true,
      maxTokens: 32768,
      compat: { thinkingFormat: 'qwen-chat-template' }
    });
    expect(res.patch.providerCompat).toEqual(vllmBlock.compat);
  });

  it('keeps a $ENV apiKey out of settings and uses the form URL when the overlay has none', async () => {
    const res = await overlayPatchFromSource(
      {
        json: JSON.stringify({
          providers: {
            vllm: { models: [{ id: 'q' }], apiKey: '$MY_KEY' }
          }
        })
      },
      'vllm',
      { enabled: false, baseUrl: 'http://box:9000', apiKey: 'from-form' }
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.patch.baseUrl).toBe('http://box:9000');
    expect(res.patch.apiKey).toBe('from-form');
  });

  it('errors when the named provider is missing', async () => {
    const res = await overlayPatchFromSource(
      { json: JSON.stringify({ providers: { vllm: vllmBlock } }) },
      'other',
      emptyCustom
    );
    expect(res.ok).toBe(false);
  });
});

describe('previewPiModelsSource path', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads a models.json file and an agent/ folder', async () => {
    dir = mkdtempSync(join(tmpdir(), 'stem-pi-overlay-'));
    const file = join(dir, 'models.json');
    writeFileSync(file, JSON.stringify({ providers: { vllm: vllmBlock } }));
    const fromFile = await previewPiModelsSource({ path: file });
    expect(fromFile.ok).toBe(true);
    expect(fromFile.providers?.[0].id).toBe('vllm');

    const agent = join(dir, 'agent');
    mkdirSync(agent);
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { glm: { models: [{ id: 'glm' }] } } }));
    const fromHome = await previewPiModelsSource({ path: dir });
    // dir has models.json at the root, so that wins over agent/
    expect(fromHome.providers?.[0].id).toBe('vllm');

    const fromAgent = await resolveModelsPath(agent);
    expect(fromAgent.ok).toBe(true);
    if (fromAgent.ok) expect(fromAgent.path).toBe(join(agent, 'models.json'));
  });

  it('fails on a missing path without writing', async () => {
    const res = await previewPiModelsSource({ path: join(tmpdir(), 'does-not-exist-stem-overlay.json') });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/does not exist/i);
  });
});
