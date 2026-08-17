// models.json writer for local providers (Ollama / LM Studio): URL normalizing,
// the /v1/models probe, and syncModelsConfig's write/merge semantics — including
// keeping last-known models when a probe fails and preserving hand-added
// third-party provider blocks. Runs against a throwaway models.json via the
// STEM_PI_MODELS_CONFIG env seam; fetch is stubbed per test.
//
// syncModelsConfig takes no settings argument — it reads them inside its own
// lock, which is what stops a stale snapshot resurrecting a disconnected
// provider — so the settings module is mocked here and `use()` sets what the
// next read will see.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeLocalBaseUrl,
  probeLocalProvider,
  providerIsSpawnable,
  syncModelsConfig
} from '../../src/server/pi/models-config';
import type { LocalProvidersSettings } from '../../src/shared/types';

const store = vi.hoisted(() => ({ localProviders: null as LocalProvidersSettings | null }));

vi.mock('../../src/server/workspace/settings', () => ({
  readSettings: async () => ({ localProviders: store.localProviders ?? emptySettings() })
}));

function emptySettings(): LocalProvidersSettings {
  return {
    ollama: { enabled: false, baseUrl: 'http://localhost:11434' },
    lmstudio: { enabled: false, baseUrl: 'http://localhost:1234' },
    custom: { enabled: false, baseUrl: '' }
  };
}

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stem-models-config-'));
  configPath = join(dir, 'models.json');
  process.env.STEM_PI_MODELS_CONFIG = configPath;
  store.localProviders = null;
});

afterEach(() => {
  delete process.env.STEM_PI_MODELS_CONFIG;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function settings(patch?: Partial<LocalProvidersSettings>): LocalProvidersSettings {
  return { ...emptySettings(), ...patch };
}

/** Point the mocked settings store at `patch` for the next sync. */
function use(patch?: Partial<LocalProvidersSettings>): void {
  store.localProviders = settings(patch);
}

function stubModels(ids: string[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 }))
  );
}

function readConfig(): { providers: Record<string, { baseUrl: string; models?: { id: string }[] }> } {
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

describe('normalizeLocalBaseUrl', () => {
  it('strips trailing slashes and a trailing /v1', () => {
    expect(normalizeLocalBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(normalizeLocalBaseUrl('http://localhost:1234/v1')).toBe('http://localhost:1234');
    expect(normalizeLocalBaseUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234');
    expect(normalizeLocalBaseUrl('  http://box:8080  ')).toBe('http://box:8080');
  });

  it('strips /v1 from an anthropic proxy root too (@anthropic-ai/sdk appends /v1/messages verbatim)', () => {
    // Both flavors strip: openai-completions gets /v1 re-appended before writing;
    // anthropic-messages leaves the root as-is because pi passes it to the SDK,
    // which appends /v1/messages itself. Keeping /v1 would produce /v1/v1/messages.
    expect(normalizeLocalBaseUrl('http://proxy.example.com/anthropic/v1')).toBe(
      'http://proxy.example.com/anthropic'
    );
    expect(normalizeLocalBaseUrl('http://proxy.example.com/anthropic/v1/')).toBe(
      'http://proxy.example.com/anthropic'
    );
    // Real Anthropic base as pasted works either way (with or without /v1).
    expect(normalizeLocalBaseUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com');
    expect(normalizeLocalBaseUrl('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com');
  });
});

describe('probeLocalProvider', () => {
  it('returns sorted model ids from /v1/models', async () => {
    stubModels(['zeta', 'alpha']);
    const res = await probeLocalProvider('http://localhost:11434', undefined, 'openai-completions');
    expect(res.ok).toBe(true);
    expect(res.models).toEqual(['alpha', 'zeta']);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://localhost:11434/v1/models');
  });

  it('rejects a non-http URL without fetching', async () => {
    const res = await probeLocalProvider('localhost:11434');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/http:\/\/localhost/);
  });

  it('reports an HTTP error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503, statusText: 'Service Unavailable' })));
    const res = await probeLocalProvider('http://localhost:11434', undefined, 'openai-completions');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('503');
  });

  it('reports a network failure as its message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    const res = await probeLocalProvider('http://localhost:11434', undefined, 'openai-completions');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ECONNREFUSED');
  });

  it('drops Ollama models without tool support and counts them', async () => {
    // Ollama-style server: /v1/models lists two, /api/show says only one has tools.
    const caps: Record<string, string[]> = { 'llama3.1:8b': ['completion', 'tools'], 'smollm:135m': ['completion'] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/v1/models')) {
          return new Response(JSON.stringify({ data: Object.keys(caps).map((id) => ({ id })) }), { status: 200 });
        }
        const { model } = JSON.parse(String(init?.body)) as { model: string };
        return new Response(JSON.stringify({ capabilities: caps[model] }), { status: 200 });
      })
    );
    const res = await probeLocalProvider('http://localhost:11434', undefined, 'openai-completions');
    expect(res.ok).toBe(true);
    expect(res.models).toEqual(['llama3.1:8b']);
    expect(res.skippedNoTools).toBe(1);
  });

  it('keeps every model when the server has no /api/show (LM Studio etc.)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/v1/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'some-gguf' }] }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      })
    );
    const res = await probeLocalProvider('http://localhost:1234', undefined, 'openai-completions');
    expect(res.ok).toBe(true);
    expect(res.models).toEqual(['some-gguf']);
    expect(res.skippedNoTools).toBeUndefined();
  });

  it('sends the api key as a bearer token and skips the Ollama capability probe', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'gw-model' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await probeLocalProvider('https://gw.example.com/v1', ' sk-secret ', 'openai-completions');
    expect(res).toEqual({ ok: true, api: 'openai-completions', models: ['gw-model'] });
    // Only the listing call — no /api/show round-trip at a third-party endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers?: Record<string, string> }];
    expect(url).toBe('https://gw.example.com/v1/models');
    expect(init.headers).toEqual({ Authorization: 'Bearer sk-secret' });
  });

  describe('auto-detect (api omitted)', () => {
    it('classifies via OPTIONS and probes openai-completions when /v1/chat/completions exists', async () => {
      // OPTIONS: /v1/chat/completions -> 200 (route present), /v1/messages -> 404.
      // Then GET /v1/models under openai-completions.
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (init?.method === 'OPTIONS') {
          return new Response(null, { status: path.endsWith('/v1/chat/completions') ? 200 : 404 });
        }
        return new Response(JSON.stringify({ data: [{ id: 'gpt-x' }] }), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const res = await probeLocalProvider('http://localhost:8080', 'sk-secret');
      expect(res).toEqual({ ok: true, api: 'openai-completions', models: ['gpt-x'] });
    });

    it('classifies as anthropic-messages when /v1/messages exists and /v1/chat/completions is 404', async () => {
      // Anthropic-only proxy shape: /v1/chat/completions -> 404, /v1/messages -> 405 (route exists, wrong method).
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (init?.method === 'OPTIONS') {
          if (path.endsWith('/v1/chat/completions')) return new Response(null, { status: 404 });
          if (path.endsWith('/v1/messages')) return new Response(null, { status: 405 });
        }
        return new Response(JSON.stringify({ data: [{ id: 'anthropic--claude-4.8-opus' }] }), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const res = await probeLocalProvider('http://proxy.example:9999/anthropic/v1', 'sk-secret');
      expect(res).toEqual({ ok: true, api: 'anthropic-messages', models: ['anthropic--claude-4.8-opus'] });
    });

    it('prefers openai-completions when both chat routes exist (tie-break to pre-existing default)', async () => {
      // Both 200 on OPTIONS — the ambiguous case. Auto-detect must not silently
      // pick anthropic when the more common flavor also works.
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'OPTIONS') return new Response(null, { status: 200 });
        return new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const res = await probeLocalProvider('http://localhost:8080', 'sk-secret');
      expect(res.ok).toBe(true);
      expect(res.api).toBe('openai-completions');
    });

    it('falls back to an openai-completions listing when both OPTIONS return 404', async () => {
      // Some servers refuse OPTIONS entirely (405) or 404 every unknown path;
      // the fallback keeps the pre-existing default so Ollama/LM Studio still
      // probe as before.
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'OPTIONS') return new Response(null, { status: 404 });
        return new Response(JSON.stringify({ data: [{ id: 'llama' }] }), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const res = await probeLocalProvider('http://localhost:11434', 'sk-secret');
      expect(res.ok).toBe(true);
      expect(res.api).toBe('openai-completions');
    });
  });

  it('probes {base}/v1/models for anthropic-messages with Anthropic auth, not a bearer token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'anthropic--claude-4.8-opus' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    // User pastes their proxy URL with /v1; normalization strips it, probe re-adds /v1/models.
    const res = await probeLocalProvider('http://proxy.example:9999/anthropic/v1', ' sk-secret ', 'anthropic-messages');
    expect(res.ok).toBe(true);
    expect(res.models).toEqual(['anthropic--claude-4.8-opus']);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers?: Record<string, string> }];
    expect(url).toBe('http://proxy.example:9999/anthropic/v1/models');
    // Anthropic rejects a request without x-api-key + anthropic-version before it
    // ever looks at the route — a bearer token here would fail an endpoint that
    // serves real turns fine.
    expect(init.headers).toEqual({ 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-secret' });
  });

  it('still sends anthropic-version when the endpoint is keyless', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'a' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await probeLocalProvider('http://proxy.example:9999/anthropic', undefined, 'anthropic-messages');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { headers?: Record<string, string> }];
    expect(init.headers).toEqual({ 'anthropic-version': '2023-06-01' });
  });

  it('carries both flavors of auth on the auto-detect OPTIONS probe', async () => {
    // The classifier does not yet know which flavor answers, so it presents both
    // credentials; a server ignores the header it does not recognize.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'OPTIONS') return new Response(null, { status: 404 });
      return new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await probeLocalProvider('http://localhost:8080', 'sk-secret');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { headers?: Record<string, string> }];
    expect(init.headers).toEqual({
      Authorization: 'Bearer sk-secret',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'sk-secret'
    });
  });

  it('skips the Ollama tool-capability probe for anthropic-messages even without a key', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await probeLocalProvider('https://api.anthropic.com/v1', undefined, 'anthropic-messages');
    expect(res.ok).toBe(true);
    // Only the listing call — no /api/show against an Anthropic-flavored server.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('providerIsSpawnable', () => {
  it('is false for a local provider with no usable block, true once it has models', async () => {
    // Nothing written yet: pi would not know "custom" exists.
    expect(await providerIsSpawnable('custom')).toBe(false);

    writeFileSync(configPath, JSON.stringify({ providers: { custom: { baseUrl: 'https://gw/v1', models: [] } } }));
    expect(await providerIsSpawnable('custom')).toBe(false);

    stubModels(['gw-model']);
    use({ custom: { enabled: true, baseUrl: 'https://gw.example.com' } });
    await syncModelsConfig();
    expect(await providerIsSpawnable('custom')).toBe(true);
  });

  it('answers false for a corrupt config without quarantining it', async () => {
    // pi drops a models.json it can't parse, so the provider is unknown there
    // too — and a read on this path must not leave .corrupt copies behind.
    writeFileSync(configPath, '{not json');
    expect(await providerIsSpawnable('ollama')).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith('.corrupt'))).toEqual([]);
  });

  it('never second-guesses a provider pi ships with', async () => {
    expect(await providerIsSpawnable('anthropic')).toBe(true);
    expect(await providerIsSpawnable('openai-codex')).toBe(true);
  });
});

describe('syncModelsConfig', () => {
  it('writes a provider block for an enabled server and reports change', async () => {
    stubModels(['llama3.1:8b', 'qwen2.5-coder:7b']);
    use({ ollama: { enabled: true, baseUrl: 'http://localhost:11434' } });
    const changed = await syncModelsConfig();
    expect(changed).toBe(true);
    const cfg = readConfig();
    expect(cfg.providers.ollama.baseUrl).toBe('http://localhost:11434/v1');
    expect(cfg.providers.ollama.models).toEqual([{ id: 'llama3.1:8b' }, { id: 'qwen2.5-coder:7b' }]);
    expect(cfg.providers.ollama).toMatchObject({
      api: 'openai-completions',
      apiKey: 'local',
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }
    });
    expect(cfg.providers.lmstudio).toBeUndefined();
  });

  it('is a no-op (unchanged) when nothing is enabled and no file exists', async () => {
    use();
    expect(await syncModelsConfig()).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  it('reports no change when a re-sync finds the same models', async () => {
    stubModels(['llama3.1:8b']);
    use({ ollama: { enabled: true, baseUrl: 'http://localhost:11434' } });
    expect(await syncModelsConfig()).toBe(true);
    expect(await syncModelsConfig()).toBe(false);
  });

  it('keeps last-known models when the probe fails', async () => {
    stubModels(['llama3.1:8b']);
    use({ ollama: { enabled: true, baseUrl: 'http://localhost:11434' } });
    await syncModelsConfig();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    expect(await syncModelsConfig()).toBe(false); // content identical → no restart needed
    expect(readConfig().providers.ollama.models).toEqual([{ id: 'llama3.1:8b' }]);
  });

  // Issue #1: an empty block is not a harmless placeholder. pi derives its
  // provider list from the models it can see, so a block with none leaves the
  // provider *unknown* — and a spawn naming it exits 1 before answering
  // anything, taking every other provider down with it.
  it('writes no provider block at all when a first probe finds nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    use({ ollama: { enabled: true, baseUrl: 'http://localhost:11434' } });
    expect(await syncModelsConfig()).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  it('removes a block whose server now serves no models', async () => {
    stubModels(['llama3.1:8b']);
    use({ ollama: { enabled: true, baseUrl: 'http://localhost:11434' } });
    await syncModelsConfig();
    stubModels([]);
    expect(await syncModelsConfig()).toBe(true);
    expect(readConfig().providers.ollama).toBeUndefined();
  });

  it('drops the provider block when disabled', async () => {
    stubModels(['llama3.1:8b']);
    use({ ollama: { enabled: true, baseUrl: 'http://localhost:11434' } });
    await syncModelsConfig();
    use();
    expect(await syncModelsConfig()).toBe(true);
    expect(readConfig().providers.ollama).toBeUndefined();
  });

  it('preserves hand-added third-party provider blocks', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          'my-vllm': { baseUrl: 'http://box:8000/v1', api: 'openai-completions', models: [{ id: 'custom' }] }
        }
      })
    );
    stubModels(['llama3.1:8b']);
    use({ ollama: { enabled: true, baseUrl: 'http://localhost:11434' } });
    await syncModelsConfig();
    const cfg = readConfig();
    expect(cfg.providers['my-vllm'].models).toEqual([{ id: 'custom' }]);
    expect(cfg.providers.ollama).toBeDefined();
  });

  it('uses hand-entered model ids verbatim and never probes the endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    use({
      custom: { enabled: true, baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-secret', models: ['a', 'b'] }
    });
    const changed = await syncModelsConfig();
    expect(changed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readConfig().providers.custom).toMatchObject({
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sk-secret',
      models: [{ id: 'a' }, { id: 'b' }]
    });
  });

  it('writes full model extras and overlay compat when custom is locked', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          xai: { baseUrl: 'https://leftover.example/v1', models: [{ id: 'grok' }] }
        }
      })
    );
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    use({
      custom: {
        enabled: true,
        baseUrl: 'http://vllm:8000',
        api: 'openai-completions',
        preserveModelsConfig: true,
        models: ['qwen3'],
        modelExtras: [
          {
            id: 'qwen3',
            reasoning: true,
            maxTokens: 32768,
            contextWindow: 131072,
            compat: { thinkingFormat: 'qwen-chat-template' }
          }
        ],
        providerCompat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          thinkingFormat: 'qwen-chat-template'
        },
        providerHeaders: { 'x-extra': 'yes' }
      }
    });
    expect(await syncModelsConfig()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const cfg = readConfig();
    expect(cfg.providers.xai.models).toEqual([{ id: 'grok' }]);
    expect(cfg.providers.custom).toEqual({
      baseUrl: 'http://vllm:8000/v1',
      api: 'openai-completions',
      apiKey: 'local',
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        thinkingFormat: 'qwen-chat-template'
      },
      headers: { 'x-extra': 'yes' },
      models: [
        {
          id: 'qwen3',
          reasoning: true,
          maxTokens: 32768,
          contextWindow: 131072,
          compat: { thinkingFormat: 'qwen-chat-template' }
        }
      ]
    });
  });

  it('still writes id-only custom models when extras are not locked', async () => {
    stubModels(['discovered']);
    use({ custom: { enabled: true, baseUrl: 'http://box:8000' } });
    await syncModelsConfig();
    expect(readConfig().providers.custom).toMatchObject({
      baseUrl: 'http://box:8000/v1',
      apiKey: 'local',
      models: [{ id: 'discovered' }]
    });
  });

  it('writes an anthropic-messages block that strips /v1 from baseUrl (SDK re-appends /v1/messages) and uses hand-typed models', async () => {
    // Anthropic-flavored proxies get:
    //  - api: 'anthropic-messages'
    //  - baseUrl normalized (trailing /v1 stripped): pi's Anthropic client
    //    (@anthropic-ai/sdk) will append /v1/messages verbatim at request time
    //  - empty compat block so pi's Anthropic defaults apply
    use({
      custom: {
        enabled: true,
        baseUrl: 'http://proxy.example:9999/anthropic/v1',
        api: 'anthropic-messages',
        apiKey: 'sk-secret',
        models: ['anthropic--claude-4.8-opus']
      }
    });
    expect(await syncModelsConfig()).toBe(true);
    expect(readConfig().providers.custom).toEqual({
      baseUrl: 'http://proxy.example:9999/anthropic',
      api: 'anthropic-messages',
      apiKey: 'sk-secret',
      compat: {},
      models: [{ id: 'anthropic--claude-4.8-opus' }]
    });
  });

  // The flavor and issue #1's empty-block guard meet on the same line. A merge
  // that keeps the flavor but drops the guard writes `custom` with no models —
  // and every pi spawn dies on "Unknown provider" again, this time for the
  // provider the flavor was added for.
  it('writes no anthropic-messages block either when its probe finds nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    use({
      custom: {
        enabled: true,
        baseUrl: 'http://proxy.example:9999/anthropic',
        api: 'anthropic-messages',
        apiKey: 'sk-secret'
      }
    });
    expect(await syncModelsConfig()).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  it('rejects anthropic-messages on ollama/lmstudio and falls back to openai-completions', async () => {
    // Defense in depth: settings coercion also strips this, so getting here means
    // a hand-edited settings.json tried to bypass. models.json must not honor it.
    stubModels(['llama']);
    // Cast: TS type on LocalProviderSettings allows the field but the runtime
    // path must ignore it for non-`custom` providers.
    use({
      ollama: {
        enabled: true,
        baseUrl: 'http://localhost:11434',
        api: 'anthropic-messages'
      } as unknown as LocalProvidersSettings['ollama']
    });
    await syncModelsConfig();
    expect(readConfig().providers.ollama).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'http://localhost:11434/v1'
    });
  });

  it('quarantines a corrupt models.json instead of parsing it', async () => {
    writeFileSync(configPath, '{not json');
    stubModels(['m']);
    use({ ollama: { enabled: true, baseUrl: 'http://localhost:11434' } });
    await syncModelsConfig();
    const quarantined = readdirSync(dir).find((f) => f.endsWith('.corrupt'));
    expect(quarantined).toBeDefined();
    expect(readFileSync(join(dir, quarantined!), 'utf8')).toBe('{not json');
    expect(readConfig().providers.ollama).toBeDefined();
  });

  // BUG-003. Two syncs used to share one `<path>.tmp` and run an unserialized
  // read-modify-write, so they could corrupt the file, reject with ENOENT, or
  // commit an older settings snapshot on top of a newer one.
  describe('concurrent syncs', () => {
    it('serializes overlapping syncs and leaves valid JSON behind', async () => {
      stubModels(['llama3.1:8b']);
      use({ ollama: { enabled: true, baseUrl: 'http://localhost:11434' } });
      const results = await Promise.allSettled([syncModelsConfig(), syncModelsConfig(), syncModelsConfig()]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(readConfig().providers.ollama.models).toEqual([{ id: 'llama3.1:8b' }]);
      // No temp file survives a completed write.
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('does not resurrect a provider disconnected while an earlier sync was probing', async () => {
      // The refresh below reads settings while `custom` is still enabled, then
      // blocks in its probe. The disconnect lands in the middle. Before the fix
      // the refresh carried its own stale snapshot and could rewrite the block —
      // and its API key — after the disconnect had removed it.
      let release: () => void = () => undefined;
      const probeStarted = new Promise<void>((resolve) => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => {
            resolve();
            await new Promise<void>((r) => {
              release = r;
            });
            return new Response(JSON.stringify({ data: [{ id: 'ghost' }] }), { status: 200 });
          })
        );
      });

      use({ custom: { enabled: true, baseUrl: 'http://box:8000', apiKey: 'sk-should-not-survive' } });
      const refresh = syncModelsConfig();
      await probeStarted;

      // The user disconnects mid-probe: settings are flipped, then a second sync
      // is queued behind the first.
      use();
      const disconnect = syncModelsConfig();
      release();
      await Promise.all([refresh, disconnect]);

      const raw = readFileSync(configPath, 'utf8');
      expect(JSON.parse(raw).providers.custom).toBeUndefined();
      expect(raw).not.toContain('sk-should-not-survive');
    });
  });
});
