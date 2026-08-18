import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { host } from '../host';
import { expectCallback } from './oauth-courier';
import type { AuthProviderId, ApiKeyProviderId, AuthUiEvent, LocalProviderId } from '../../shared/types';

// In-app provider sign-in. pi's TUI is NOT required for login: since pi 0.80.8
// the package exports ModelRuntime, the credential/auth facade that owns the
// file-locked auth.json store and the provider login flows (the old AuthStorage
// orchestration API was removed). runtime.login(provider, 'oauth', interaction)
// runs the provider's OAuth flow and persists the credential: PKCE against a
// localhost callback (anthropic → 127.0.0.1:53692/callback, openai-codex →
// localhost:1455/auth/callback), or an RFC 8628 device code (xai, i.e. a
// SuperGrok/X Premium subscription — no callback server, just a user code
// confirmed in the browser);
// 'api_key' login answers the provider's single "Enter API key" prompt with the
// stored key. This class bridges the interaction callbacks to the renderer's
// wizard: events go out as AuthUiEvent pushes; text answers (manual code paste)
// come back via respond(). One login at a time — a new attempt supersedes.
//
// A ModelRuntime is created fresh per operation: it composes providers from
// builtins + models.json at create time, and models.json changes between
// operations (local-provider enable/disable) must be visible. Creation is
// offline (no allowModelNetwork); login/logout run pi's own trailing catalog
// refresh, throttled upstream to once per four hours.
//
// The pi package is pure ESM and rollup-external; import it lazily so app
// startup never pays for it.

type PiModule = typeof import('@earendil-works/pi-coding-agent');
type PiModelRuntime = Awaited<ReturnType<PiModule['ModelRuntime']['create']>>;

interface ActiveLogin {
  controller: AbortController;
  pending: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>;
}

// undici wraps connection-level failures as a terse `TypeError: fetch failed`
// whose real reason (ENOTFOUND, EHOSTUNREACH, a TLS error, a socket address) lives
// on `.cause`. Surface that so a failed OAuth token exchange is diagnosable instead
// of an opaque "fetch failed".
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    const detail = code && !cause.message.includes(code) ? `${code}: ${cause.message}` : cause.message;
    return `${e.message} (${detail})`;
  }
  return e.message;
}

export class ProviderAuth {
  private active: ActiveLogin | null = null;
  private piModule: Promise<PiModule> | null = null;

  constructor(
    private readonly authPath: string,
    private readonly emit: (event: AuthUiEvent) => void
  ) {}

  get busy(): boolean {
    return this.active !== null;
  }

  /**
   * Run the OAuth flow for a provider. Resolves once the credential is written
   * to auth.json (ok:true) or the flow failed/was cancelled (ok:false). Emits
   * progress AuthUiEvents throughout, including the final `done`.
   */
  async login(providerId: AuthProviderId): Promise<{ ok: boolean; error?: string }> {
    if (this.active) this.cancel(); // supersede a stale attempt
    const controller = new AbortController();
    const active: ActiveLogin = { controller, pending: new Map() };
    this.active = active;
    try {
      const { readStoredCredential } = await this.loadPi();
      const before = JSON.stringify(readStoredCredential(providerId, this.authPath) ?? null);
      const runtime = await this.createRuntime();
      try {
        await runtime.login(providerId, 'oauth', {
          signal: controller.signal,
          prompt: async (prompt) => {
            // openai-codex offers browser vs device-code; the wizard always
            // drives the browser flow (device-code is a possible follow-up).
            if (prompt.type === 'select') {
              return prompt.options.find((o) => o.id === 'browser')?.id ?? prompt.options[0]?.id ?? '';
            }
            if (prompt.type === 'manual_code') return this.awaitInput(active, 'Paste the code from your browser');
            return this.awaitInput(active, prompt.message, prompt.placeholder);
          },
          notify: (event) => {
            if (event.type === 'auth_url') {
              // pi has already bound its loopback callback port by the time it
              // says this, so recording the address here can never race the
              // listener it names. On a remote server the browser is on a
              // client, and this record is what lets that client's courier hand
              // the callback back (pi/oauth-courier.ts).
              expectCallback(event.url);
              host().openExternal(event.url);
              this.emit({ kind: 'auth-url', url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) });
            } else if (event.type === 'device_code') {
              // Same treatment as auth_url: the user should land on the page, not
              // retype a URL. pi passes verification_uri_complete when the provider
              // offers it (xAI does — the code comes prefilled) and rejects any
              // non-https URI before it reaches us, so opening it is no more
              // trusting than the redirect flow. The code still goes to the UI:
              // the page asks the user to confirm it matches.
              host().openExternal(event.verificationUri);
              this.emit({ kind: 'device-code', userCode: event.userCode, verificationUri: event.verificationUri });
            } else {
              this.emit({ kind: 'progress', message: event.message });
            }
          }
        });
      } catch (e) {
        // The credential is persisted BEFORE login's trailing catalog refresh;
        // a refresh failure (offline, pi.dev hiccup) must not read as a failed
        // sign-in when the token actually landed.
        const after = readStoredCredential(providerId, this.authPath);
        if (!(after?.type === 'oauth' && JSON.stringify(after) !== before)) throw e;
      }
      this.emit({ kind: 'done', ok: true, provider: providerId });
      return { ok: true };
    } catch (e) {
      const error = describeError(e);
      this.emit({ kind: 'done', ok: false, provider: providerId, error });
      return { ok: false, error };
    } finally {
      if (this.active === active) this.active = null;
    }
  }

  /** Answer an `input-request` event (manual code paste, etc.). */
  respond(requestId: string, value: string): void {
    const req = this.active?.pending.get(requestId);
    if (!req) return;
    this.active!.pending.delete(requestId);
    req.resolve(value);
  }

  /** Abort the in-flight login (tears down pi's localhost callback server). */
  cancel(): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    for (const req of active.pending.values()) req.reject(new Error('Login cancelled.'));
    active.pending.clear();
    active.controller.abort();
  }

  /**
   * Save a plain API key; written through the runtime's api_key login (a single
   * "Enter API key" prompt answered with the key) so the store's file lock is
   * honored. Local providers (Ollama, LM Studio) get a placeholder key — their
   * servers are keyless, but the entry makes pi's availability check, Stem's
   * provider filter, and the authenticated gate all treat them as signed in.
   * NOTE: the provider must already exist in models.json (builtin or synced
   * local provider) — sync models.json before calling this for a new one.
   */
  async setApiKey(provider: ApiKeyProviderId | LocalProviderId, key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) throw new Error('API key is empty.');
    const { readStoredCredential } = await this.loadPi();
    const runtime = await this.createRuntime();
    try {
      await runtime.login(provider, 'api_key', {
        prompt: async () => trimmed,
        notify: () => undefined
      });
    } catch (e) {
      const after = readStoredCredential(provider, this.authPath);
      if (!(after?.type === 'api_key' && after.key === trimmed)) throw e;
    }
  }

  /** Remove a provider's stored credential (Disconnect). Missing entries are a no-op. */
  async removeProvider(provider: string): Promise<void> {
    const { readStoredCredential } = await this.loadPi();
    const runtime = await this.createRuntime();
    try {
      await runtime.logout(provider);
    } catch (e) {
      if (readStoredCredential(provider, this.authPath) !== undefined) throw e;
    }
  }

  /** Provider ids with stored credentials. */
  async listProviders(): Promise<string[]> {
    const runtime = await this.createRuntime();
    const credentials = await runtime.listCredentials();
    return credentials.map((c) => c.providerId);
  }

  /**
   * Authoritative liveness check for a stored credential. A stored API key is
   * alive when non-empty; a stored OAuth credential is alive when getAuth can
   * resolve it — that refreshes an expired access token (with file locking, the
   * same path pi uses) and throws when the *refresh itself* fails, i.e. the
   * refresh token is expired/revoked and the user is truly signed out. Checking
   * the stored credential first keeps an env var from masking a dead or missing
   * stored credential (the old includeFallback:false). Caveat: a transient
   * network error during refresh also yields false (false negative), which is
   * acceptable because this only runs after a turn already failed and the
   * re-auth screen has a "Back to chat" escape.
   */
  async isAlive(provider: string): Promise<boolean> {
    const { readStoredCredential } = await this.loadPi();
    const stored = readStoredCredential(provider, this.authPath);
    if (!stored) return false;
    if (stored.type === 'api_key') return typeof stored.key === 'string' && stored.key.length > 0;
    const runtime = await this.createRuntime();
    try {
      return (await runtime.getAuth(provider)) !== undefined;
    } catch {
      // quiet: a refresh that throws IS the signed-out answer this was asked for,
      // and false puts the user on the re-auth screen — which is where the
      // false negative from a flaky network lands too, with a way back out.
      return false;
    }
  }

  private awaitInput(active: ActiveLogin, message: string, placeholder?: string): Promise<string> {
    const requestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      active.pending.set(requestId, { resolve, reject });
      this.emit({ kind: 'input-request', requestId, message, ...(placeholder ? { placeholder } : {}) });
    });
  }

  /** Fresh runtime per operation so models.json edits are always visible. */
  private async createRuntime(): Promise<PiModelRuntime> {
    const { ModelRuntime } = await this.loadPi();
    return ModelRuntime.create({
      authPath: this.authPath,
      modelsPath: join(dirname(this.authPath), 'models.json')
    });
  }

  private loadPi(): Promise<PiModule> {
    // Cached: the module is stateless for our use, and re-importing on every
    // call is wasted work (pi's index pulls a sizable dependency tree).
    this.piModule ??= import('@earendil-works/pi-coding-agent');
    return this.piModule;
  }
}
