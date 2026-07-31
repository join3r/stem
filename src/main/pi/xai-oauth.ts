import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { shell } from 'electron';
import { piHome } from '../workspace/paths';
import { decryptSecretValue, encryptSecretValue, secretKeyAvailable } from './secrets';
import { SECRET_ENVELOPE_KEY } from './protocol';
import { readModelsConfig } from './models-config';
import { piModelsConfigPath } from '../workspace/paths';

// xAI OAuth 2.0 (Grok Build / subscription) — PKCE authorization-code flow
// against auth.x.ai, using the public Grok CLI client. Produces a bearer token
// for the OpenAI-compatible proxy at cli-chat-proxy.grok.com/v1.

const XAI_AUTH_SERVER = 'https://auth.x.ai';
const XAI_AUTHORIZE_ENDPOINT = `${XAI_AUTH_SERVER}/oauth2/authorize`;
const XAI_TOKEN_ENDPOINT = `${XAI_AUTH_SERVER}/oauth2/token`;
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_SCOPES = 'openid profile email offline_access grok-cli:access api:access';
const XAI_REDIRECT_PORT = 56121;
const XAI_REDIRECT_URI = `http://127.0.0.1:${XAI_REDIRECT_PORT}/callback`;
export const XAI_API_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const XAI_TOKEN_FILE = 'xai-oauth.json';

// The subscription proxy requires a Grok CLI version header; without it
// requests are rejected with HTTP 426. This must meet the minimum version
// the server advertises in its error message.
const XAI_CLIENT_VERSION = '0.1.202';

// Known Grok models available through the subscription proxy.
export const XAI_DEFAULT_MODELS = [
  { id: 'grok-4' },
  { id: 'grok-3' },
  { id: 'grok-3-mini' }
];

export interface XaiOAuthToken {
  accessToken: string;
  refreshToken?: string;
  /** ms epoch when the access token expires; 0 if the server didn't say. */
  expiresAt: number;
  /** User's email from the ID token, for display. */
  email?: string;
}

// ---- Credential persistence (encrypted, like MCP OAuth tokens) ----

function xaiTokenPath(): string {
  return process.env.STEM_XAI_OAUTH ?? join(piHome(), XAI_TOKEN_FILE);
}

export async function readXaiToken(): Promise<XaiOAuthToken | null> {
  try {
    const parsed = JSON.parse(await readFile(xaiTokenPath(), 'utf8')) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      const envelope = parsed[SECRET_ENVELOPE_KEY];
      if (typeof envelope === 'string') {
        const plain = decryptSecretValue(envelope);
        if (plain === null) return null;
        return JSON.parse(plain) as XaiOAuthToken;
      }
      if (typeof parsed.accessToken === 'string') return parsed as unknown as XaiOAuthToken;
    }
  } catch {
    // missing/corrupt
  }
  return null;
}

async function writeXaiToken(token: XaiOAuthToken): Promise<void> {
  const path = xaiTokenPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const data = secretKeyAvailable()
    ? JSON.stringify({ [SECRET_ENVELOPE_KEY]: encryptSecretValue(JSON.stringify(token)) }, null, 2)
    : JSON.stringify(token, null, 2);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

export async function deleteXaiToken(): Promise<void> {
  await rm(xaiTokenPath(), { force: true }).catch(() => undefined);
}

// ---- PKCE helpers ----

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---- Loopback callback server ----

interface Loopback {
  codePromise: Promise<{ code: string | null; state: string | null }>;
  close: () => void;
}

function startLoopback(): Promise<Loopback> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    let settle: (v: { code: string | null; state: string | null }) => void;
    let fail: (e: Error) => void;
    const codePromise = new Promise<{ code: string | null; state: string | null }>((res, rej) => {
      settle = res;
      fail = rej;
    });
    server.on('request', (req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const error = reqUrl.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body style="font-family:system-ui,sans-serif;text-align:center;padding-top:3rem">' +
          `<h2>${error ? 'Sign-in failed' : 'Sign-in complete'}</h2>` +
          '<p>You can close this tab and return to Stem.</p></body></html>'
      );
      if (error) fail(new Error(`Authorization was denied (${error}).`));
      else settle({ code: reqUrl.searchParams.get('code'), state: reqUrl.searchParams.get('state') });
    });
    server.listen(XAI_REDIRECT_PORT, '127.0.0.1', () => {
      resolve({ codePromise, close: () => server.close() });
    });
  });
}

// ---- Token exchange ----

async function tokenRequest(params: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const res = await fetch(XAI_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    signal
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`xAI token exchange failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

function parseTokenResponse(tok: Record<string, unknown>): XaiOAuthToken {
  if (typeof tok.access_token !== 'string') throw new Error('xAI token response missing access_token.');
  return {
    accessToken: tok.access_token,
    refreshToken: typeof tok.refresh_token === 'string' ? tok.refresh_token : undefined,
    expiresAt: typeof tok.expires_in === 'number' ? Date.now() + tok.expires_in * 1000 : 0
  };
}

// ---- Public API ----

export interface XaiLoginOptions {
  signal: AbortSignal;
  /** Called when the authorize URL is ready (for UI fallback display). */
  onAuthUrl?: (url: string) => void;
  /** Overall timeout for the browser round-trip (default 5 min). */
  timeoutMs?: number;
}

/**
 * Run the full xAI OAuth login flow: open the browser, wait for the callback,
 * exchange the code, and persist the token. Returns the stored credential.
 */
export async function xaiLogin(opts: XaiLoginOptions): Promise<XaiOAuthToken> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const controller = new AbortController();
  const combinedSignal = AbortSignal.any([opts.signal, controller.signal]);
  const timeout = setTimeout(
    () => controller.abort(new Error(`xAI sign-in timed out after ${Math.round(timeoutMs / 1000)}s.`)),
    timeoutMs
  );
  (timeout as NodeJS.Timeout).unref?.();
  let loop: Loopback | null = null;

  try {
    loop = await startLoopback();
    if (combinedSignal.aborted) throw combinedSignal.reason;

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));

    const authUrl = new URL(XAI_AUTHORIZE_ENDPOINT);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', XAI_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', XAI_REDIRECT_URI);
    authUrl.searchParams.set('scope', XAI_SCOPES);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    opts.onAuthUrl?.(authUrl.toString());
    await shell.openExternal(authUrl.toString());

    const { code, state: returnedState } = await raceAbort(loop.codePromise, combinedSignal);
    if (!code) throw new Error('No authorization code was returned.');
    if (returnedState !== state) throw new Error('OAuth state mismatch — aborting for safety.');

    // xAI may require code_challenge + code_challenge_method in the token POST
    const tok = await tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: XAI_REDIRECT_URI,
        client_id: XAI_CLIENT_ID,
        code_verifier: verifier,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      },
      combinedSignal
    );

    const token = parseTokenResponse(tok);
    await writeXaiToken(token);
    return token;
  } finally {
    clearTimeout(timeout);
    loop?.close();
  }
}

/**
 * Refresh the stored xAI token if it's expired (or within `marginMs` of expiry).
 * Returns the current valid token, or null if no token is stored / refresh fails.
 */
export async function refreshXaiTokenIfNeeded(marginMs = 5 * 60_000): Promise<XaiOAuthToken | null> {
  const token = await readXaiToken();
  if (!token) return null;
  if (token.expiresAt && Date.now() < token.expiresAt - marginMs) return token;
  if (!token.refreshToken) return null;

  try {
    const tok = await tokenRequest(
      {
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
        client_id: XAI_CLIENT_ID
      },
      AbortSignal.timeout(15_000)
    );
    const refreshed = parseTokenResponse(tok);
    // Carry forward the refresh token if the server didn't issue a new one.
    if (!refreshed.refreshToken) refreshed.refreshToken = token.refreshToken;
    await writeXaiToken(refreshed);
    return refreshed;
  } catch {
    return null;
  }
}

/**
 * Write (or update) the xAI provider block in models.json with the current access
 * token so pi can use it as a bearer token. Returns true if the file changed.
 */
export async function syncXaiModelsConfig(accessToken: string): Promise<boolean> {
  const config = await readModelsConfig();
  const existing = config.providers.xai;
  const block = {
    baseUrl: XAI_API_BASE_URL,
    api: 'openai-completions',
    apiKey: accessToken,
    headers: {
      'x-grok-client-version': XAI_CLIENT_VERSION,
      'x-grok-client-mode': 'cli'
    },
    models: XAI_DEFAULT_MODELS
  };
  if (existing && existing.apiKey === accessToken) return false;
  config.providers.xai = block;
  const path = piModelsConfigPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
  return true;
}

/** Remove the xAI provider block from models.json. */
export async function removeXaiModelsConfig(): Promise<boolean> {
  const config = await readModelsConfig();
  if (!config.providers.xai) return false;
  delete config.providers.xai;
  const path = piModelsConfigPath();
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
  return true;
}

// ---- Abort-race utility ----

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error('xAI sign-in was cancelled.'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { cleanup(); resolve(v); },
      (e) => { cleanup(); reject(e); }
    );
  });
}
