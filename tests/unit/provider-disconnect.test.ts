// Disconnecting a provider must not leave the app pointing at it. Issue #1: the
// persisted default model outlived the custom endpoint that served it, and pi
// exits 1 when a spawn names a provider it no longer knows — so every later
// spawn died, for every provider. The handler is driven through dispatchLocal
// (the same argument validation the renderer's invoke goes through, minus the
// Electron sender), with only the singletons this channel touches faked.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerAuthIpc } from '../../src/server/ipc/auth';
import { dispatchLocal } from '../../src/server/ipc/guard';
import type { IpcDeps } from '../../src/server/ipc/deps';
import { readSettings, updateDefaultModel, updateLocalProvider } from '../../src/server/workspace/settings';
import { settingsStorePath } from '../../src/server/workspace/paths';

const removed: string[] = [];
const restarts: number[] = [];

const deps = {
  e2e: false,
  runtime: () => ({ restart: async () => void restarts.push(1), status: async () => ({ ok: true }) }),
  providerAuth: () => ({
    removeProvider: async (id: string) => void removed.push(id),
    setApiKey: async () => undefined
  }),
  onAuthenticated: async () => ({ ok: true }),
  scheduler: () => null,
  embedManager: () => null,
  mainWindow: () => null,
  sendToMain: () => undefined,
  scheduleMemoryRebuild: () => undefined,
  scheduleFolderIndexScan: () => undefined,
  scheduleFolderLearn: () => undefined
} as unknown as IpcDeps;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stem-disconnect-'));
  process.env.STEM_PI_MODELS_CONFIG = join(dir, 'models.json');
  mkdirSync(dirname(settingsStorePath()), { recursive: true });
  rmSync(settingsStorePath(), { force: true });
  removed.length = 0;
  restarts.length = 0;
  registerAuthIpc(deps);
});

afterEach(() => {
  delete process.env.STEM_PI_MODELS_CONFIG;
  rmSync(settingsStorePath(), { force: true });
  rmSync(dir, { recursive: true, force: true });
});

describe('providers:disconnect', () => {
  it('clears a default model served by the provider being disconnected', async () => {
    await updateLocalProvider('custom', {
      enabled: true,
      baseUrl: 'https://gw.example.com',
      apiKey: 'sk-secret',
      models: ['anthropic--claude-4.8-opus']
    });
    await updateDefaultModel('custom/anthropic--claude-4.8-opus');

    await expect(dispatchLocal('providers:disconnect', ['custom'])).resolves.toMatchObject({ ok: true });

    expect(removed).toEqual(['custom']);
    const settings = await readSettings();
    expect(settings.defaults.model).toBeNull();
    expect(settings.localProviders.custom).toMatchObject({ enabled: false });
    expect(settings.localProviders.custom.apiKey).toBeUndefined();
  });

  it('disconnects one named custom endpoint without changing another', async () => {
    await updateLocalProvider('custom-one', {
      enabled: true,
      name: 'One',
      baseUrl: 'https://one.example',
      apiKey: 'one-key',
      models: ['one-model'],
      modelOverrides: { 'one-model': { reasoning: true } }
    });
    await updateLocalProvider('custom-two', {
      enabled: true,
      name: 'Two',
      baseUrl: 'https://two.example',
      apiKey: 'two-key',
      models: ['two-model']
    });
    await updateDefaultModel('custom-one/one-model');

    await expect(dispatchLocal('providers:disconnect', ['custom-one'])).resolves.toMatchObject({ ok: true });

    const settings = await readSettings();
    expect(removed).toEqual(['custom-one']);
    expect(settings.defaults.model).toBeNull();
    expect(settings.localProviders['custom-one']).toMatchObject({
      enabled: false,
      name: 'One',
      modelOverrides: { 'one-model': { reasoning: true } }
    });
    expect(settings.localProviders['custom-one'].apiKey).toBeUndefined();
    expect(settings.localProviders['custom-two']).toMatchObject({
      enabled: true,
      name: 'Two',
      apiKey: 'two-key',
      models: ['two-model']
    });
  });

  it('leaves a default served by a provider that is still connected', async () => {
    await updateDefaultModel('anthropic/claude-sonnet-4.5');
    await expect(dispatchLocal('providers:disconnect', ['openai-codex'])).resolves.toMatchObject({ ok: true });
    expect((await readSettings()).defaults.model).toBe('anthropic/claude-sonnet-4.5');
  });

  // "custom/…" must not be read as a prefix of "custom-gateway/…".
  it('matches the provider exactly, not by name prefix', async () => {
    await updateDefaultModel('custom-gateway/some-model');
    await expect(dispatchLocal('providers:disconnect', ['custom'])).resolves.toMatchObject({ ok: true });
    expect((await readSettings()).defaults.model).toBe('custom-gateway/some-model');
  });
});
