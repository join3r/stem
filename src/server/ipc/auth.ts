import { registerServer } from './guard';
import type { IpcDeps } from './deps';
import { markOnboardingCompleted, readSettings, updateDefaultModel, updateLocalProvider } from '../workspace/settings';
import { probeLocalProvider, syncModelsConfig } from '../pi/models-config';
import { CLEARED_CUSTOM_OVERLAY, overlayPatchFromSource, previewPiModelsSource } from '../pi/models-copy';
import { relayCallback } from '../pi/oauth-courier';
import { isLocalProviderId } from '../../shared/providers';
import type {
  ApiKeyProviderId,
  AuthProviderId,
  LocalProviderApi,
  LocalProviderId,
  LocalProviderSettings
} from '../../shared/types';

/** The user code the E2E fake shows for the device-code flow (asserted by the wizard spec). */
const E2E_DEVICE_CODE = 'STEM-E2E1';
/** How long that fake keeps the device-code step on screen before completing. */
const E2E_DEVICE_CODE_HOLD_MS = 750;

/** Provider sign-in (onboarding wizard) + local providers (Ollama / LM Studio / custom). */
export function registerAuthIpc(deps: IpcDeps): void {
  registerServer('auth:providerLogin', async (_e, provider: AuthProviderId) => {
    if (deps.e2e) {
      // Scripted fake: surface the URL step, then complete, so the wizard's
      // whole state machine is exercised without a browser or network. The
      // fake backend flips to authenticated via its login(). xai stands in for
      // the device-code flow — the only one that shows a user code — so that
      // branch is reachable hermetically too.
      if (provider === 'xai') {
        deps.emit('auth:event', {
          kind: 'device-code',
          userCode: E2E_DEVICE_CODE,
          verificationUri: 'https://oauth.example.test/device'
        });
        // A real device flow only completes once the user confirms the code in
        // the browser, i.e. the code stays on screen. Without a hold the fake
        // would emit `done` in the same tick and the step would flash past
        // unobservably — including to the test that guards it renders at all.
        await new Promise((resolve) => setTimeout(resolve, E2E_DEVICE_CODE_HOLD_MS));
      } else {
        deps.emit('auth:event', { kind: 'auth-url', url: 'https://oauth.example.test/authorize' });
      }
      const status = await deps.runtime().login();
      deps.emit('auth:event', { kind: 'done', ok: true, provider });
      void deps.scheduler()?.start(); // mirror onAuthenticated()
      return { ok: true, status };
    }
    const res = await deps.providerAuth()!.login(provider);
    if (!res.ok) return res;
    return { ok: true, status: await deps.onAuthenticated() };
  });
  registerServer('auth:setApiKey', async (_e, provider: ApiKeyProviderId, key: string) => {
    if (deps.e2e) {
      const status = await deps.runtime().login();
      void deps.scheduler()?.start(); // mirror onAuthenticated()
      return { ok: true, status };
    }
    try {
      await deps.providerAuth()!.setApiKey(provider, key);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, status: await deps.onAuthenticated() };
  });
  registerServer('auth:respond', (_e, requestId: string, value: string) => {
    deps.providerAuth()?.respond(requestId, value);
  });
  // A client caught an OAuth callback that was addressed to this server's own
  // loopback listener, because the browser was on the client's machine and
  // 127.0.0.1 there is not 127.0.0.1 here. Replayed to the waiting flow, which
  // is the only thing this channel can do with it — see pi/oauth-courier.ts for
  // why a delivery has to match a sign-in that is actually outstanding.
  registerServer('auth:deliverCallback', async (_e, redirectUri: string, params: Record<string, unknown>) => {
    try {
      await relayCallback(redirectUri, params);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  // Authoritative liveness probe for a stored credential — used reactively to
  // classify a failed turn (expired/revoked OAuth token vs. a transient error).
  registerServer('auth:check', async (_e, provider: string) => {
    if (deps.e2e) return { alive: true };
    return { alive: await deps.providerAuth()!.isAlive(provider) };
  });
  registerServer('providers:testLocal', async (_e, _id: LocalProviderId, baseUrl: string, apiKey?: string, api?: LocalProviderApi) => {
    if (deps.e2e) return { ok: true, models: ['stem-e2e-model'] };
    return probeLocalProvider(baseUrl, apiKey, api);
  });
  registerServer('providers:previewPiModels', async (_e, source: { json?: string; path?: string }) => {
    if (deps.e2e) return { ok: true, providers: [{ id: 'vllm', modelIds: ['stem-e2e-model'] }] };
    return previewPiModelsSource(source);
  });
  registerServer('providers:copyPiModels', async (_e, source: { json?: string; path?: string }, providerId: string, hints?: Partial<{ baseUrl: string; apiKey: string; api: LocalProviderApi }>) => {
    if (deps.e2e) return { ok: true, status: await deps.runtime().login() };
    try {
      const stored = (await readSettings()).localProviders.custom;
      const current = {
        ...stored,
        ...(hints?.baseUrl?.trim() ? { baseUrl: hints.baseUrl.trim() } : {}),
        ...(hints?.apiKey !== undefined ? { apiKey: hints.apiKey } : {}),
        ...(hints?.api ? { api: hints.api } : {})
      };
      const overlay = await overlayPatchFromSource(source, providerId, current);
      if (!overlay.ok) return { ok: false, error: overlay.error };
      const settings = await updateLocalProvider('custom', overlay.patch);
      const cfg = settings.localProviders.custom;
      await syncModelsConfig();
      if (cfg.enabled) await deps.providerAuth()!.setApiKey('custom', cfg.apiKey?.trim() || 'local');
      await deps.runtime().restart();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, status: await deps.onAuthenticated() };
  });
  registerServer('providers:updateLocal', async (_e, id: LocalProviderId, patch: Partial<LocalProviderSettings>) => {
    if (deps.e2e) return { ok: true, status: await deps.runtime().login() };
    try {
      const settings = await updateLocalProvider(id, patch);
      const cfg = settings.localProviders[id];
      // models.json first: the credential write goes through pi's provider
      // login, which only knows providers already present in models.json.
      // syncModelsConfig re-reads settings under its own lock — the patch above
      // is already persisted, so it sees this change or a newer one, never older.
      await syncModelsConfig();
      // The endpoint's own key, or the placeholder for keyless local servers
      // (see ProviderAuth.setApiKey).
      if (cfg.enabled) await deps.providerAuth()!.setApiKey(id, cfg.apiKey?.trim() || 'local');
      else await deps.providerAuth()!.removeProvider(id);
      // pi reads models.json and auth.json only at spawn — restart before
      // onAuthenticated() lists models so the new registry is visible to it.
      await deps.runtime().restart();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, status: await deps.onAuthenticated() };
  });
  registerServer('providers:disconnect', async (_e, providerId: string) => {
    if (deps.e2e) return { ok: true, status: await deps.runtime().status() };
    try {
      await deps.providerAuth()!.removeProvider(providerId);
      if (isLocalProviderId(providerId)) {
        // Drop the endpoint's secret with it — re-adding asks for the key again.
        await updateLocalProvider(providerId, { enabled: false, apiKey: '', models: [], ...CLEARED_CUSTOM_OVERLAY });
        await syncModelsConfig();
      }
      // The default model must not outlive the provider that served it: pi refuses
      // to start when a spawn names a provider it no longer knows, which would
      // brick the backend for every remaining provider. Cleared here rather than
      // left to onAuthenticated()'s re-pick, which needs a live model list — and
      // therefore the very backend the stale default keeps from starting.
      const { defaults } = await readSettings();
      if (defaults.model?.startsWith(`${providerId}/`)) await updateDefaultModel(null);
      await deps.runtime().restart();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, status: await deps.onAuthenticated() };
  });
  registerServer('auth:cancel', () => {
    deps.providerAuth()?.cancel();
  });
  registerServer('auth:completeOnboarding', () => markOnboardingCompleted());
}
