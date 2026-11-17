// Built-in provider models Stem writes into models.json until pi lists them.
import { describe, expect, it } from 'vitest';
import { applyCatalogBackfill, CATALOG_BACKFILL } from '../../src/server/pi/catalog-backfill';

const astra = { id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra' };

describe('applyCatalogBackfill', () => {
  it('lists GPT-6.2 Astra and Sol on the ChatGPT (Codex) provider', () => {
    const providers: Record<string, any> = {};
    applyCatalogBackfill(providers);
    const ids = providers['openai-codex'].models.map((m: { id: string }) => m.id);
    expect(ids).toEqual(['gpt-6.2-astra', 'gpt-6.2-sol']);
    for (const m of providers['openai-codex'].models) {
      expect(m.api).toBe('openai-codex-responses');
      // Both reject reasoning effort "none": no Off in the picker.
      expect(m.thinkingLevelMap.off).toBeNull();
    }
    expect(providers['openai-codex'].models[1].contextWindow).toBe(500000);
  });

  it('is stable: a second pass changes nothing', () => {
    const providers: Record<string, any> = {};
    applyCatalogBackfill(providers);
    const once = JSON.stringify(providers);
    applyCatalogBackfill(providers);
    expect(JSON.stringify(providers)).toBe(once);
  });

  it('keeps hand-added models and other provider fields', () => {
    const providers: Record<string, any> = {
      'openai-codex': { baseUrl: 'https://proxy.example', models: [{ id: 'my-model' }] },
      ollama: { baseUrl: 'http://x', api: 'openai-completions', models: [{ id: 'q' }] }
    };
    applyCatalogBackfill(providers);
    expect(providers['openai-codex'].baseUrl).toBe('https://proxy.example');
    expect(providers['openai-codex'].models.map((m: { id: string }) => m.id)).toEqual([
      'my-model',
      ...CATALOG_BACKFILL['openai-codex'].map((m) => m.id)
    ]);
    expect(providers.ollama.models).toEqual([{ id: 'q' }]);
  });

  it('removes retired entries and the block it alone created', () => {
    const providers: Record<string, any> = {};
    applyCatalogBackfill(providers, { 'openai-codex': [astra] }, {});
    expect(providers['openai-codex'].models).toEqual([astra]);
    applyCatalogBackfill(providers, {}, { 'openai-codex': ['gpt-6.2-astra'] });
    expect(providers).toEqual({});
  });

  it('removes retired entries but leaves the user’s own', () => {
    const providers: Record<string, any> = {
      'openai-codex': { models: [{ id: 'mine' }, astra] }
    };
    applyCatalogBackfill(providers, {}, { 'openai-codex': ['gpt-6.2-astra'] });
    expect(providers['openai-codex']).toEqual({ models: [{ id: 'mine' }] });
  });
});
