import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { shell } from 'electron';

// MCP OAuth 2.1 browser flow for remote (Streamable HTTP) servers that require
// OAuth rather than a static bearer header — e.g. Fastmail. Implements the MCP
// authorization spec end-to-end with no third-party deps:
//   RFC 9728 protected-resource discovery (via the 401 WWW-Authenticate hint,
//     falling back to the .well-known path),
//   RFC 8414 authorization-server metadata,
//   RFC 7591 dynamic client registration (public client),
//   PKCE (S256), a loopback redirect, and the authorization-code exchange.
// The resulting token (incl. refresh token) is persisted by the caller; the
// bridge extension injects it as `Authorization: Bearer …` and refreshes it.

// Fixed loopback port for the static-client (confidential) path. Providers like
// Slack only allow pre-registered redirect URLs, so a random port can never
// match — the user registers exactly this URL in their provider app. The DCR
// path keeps a random port (the server registers whatever we send).
export const STEM_OAUTH_REDIRECT_PORT = 41759;

/** The exact redirect URL to register with a static-client OAuth provider. */
export function stemOAuthRedirectUri(): string {
  return `http://127.0.0.1:${STEM_OAUTH_REDIRECT_PORT}/callback`;
}

export interface OAuthToken {
  /** The MCP resource URL these credentials are scoped to (RFC 8707). */
  resource: string;
  /** Token endpoint, for the bridge's refresh. */
  tokenEndpoint: string;
  /** The OAuth client id — dynamically registered, or a static pre-registered one. */
  clientId: string;
  /**
   * The static client secret, for confidential clients (e.g. Slack). Present only
   * when the server was configured with one; the bridge sends it on refresh.
   */
  clientSecret?: string;
  scope: string;
  accessToken: string;
  refreshToken?: string;
  /** ms epoch the access token expires; 0 when the server didn't say. */
  expiresAt: number;
}

interface AsMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
}

interface ProtectedResource {
  resource: string;
  authServer: string;
  scopes?: string[];
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Resolve the authorization server + resource for an MCP URL. Prefers the exact
 * `resource_metadata` URL the server advertises in its 401 WWW-Authenticate
 * header; falls back to the RFC 9728 well-known path, then to the URL's origin.
 */
async function discoverProtectedResource(mcpUrl: string): Promise<ProtectedResource> {
  const u = new URL(mcpUrl);
  let resourceMetaUrl: string | undefined;
  try {
    const probe = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stem', version: '1.0' } }
      })
    });
    const wwwAuth = probe.headers.get('www-authenticate');
    const m = wwwAuth?.match(/resource_metadata="([^"]+)"/);
    if (m) resourceMetaUrl = m[1];
  } catch {
    // fall through to the well-known path
  }
  if (!resourceMetaUrl) resourceMetaUrl = `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;

  let resource = mcpUrl;
  let authServer = u.origin;
  let scopes: string[] | undefined;
  try {
    const prm = await fetchJson(resourceMetaUrl);
    if (typeof prm.resource === 'string') resource = prm.resource;
    const servers = prm.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === 'string') authServer = servers[0];
    if (Array.isArray(prm.scopes_supported)) scopes = prm.scopes_supported as string[];
  } catch {
    // some servers skip RFC 9728 — assume the AS lives at the resource origin
  }
  return { resource, authServer, scopes };
}

async function discoverAuthServer(issuer: string): Promise<AsMetadata> {
  const candidates = [
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuer}/.well-known/openid-configuration`
  ];
  for (const url of candidates) {
    try {
      return (await fetchJson(url)) as AsMetadata;
    } catch {
      // try the next well-known location
    }
  }
  throw new Error('Could not discover the OAuth authorization server for this MCP server.');
}

/** Request offline_access (for a refresh token) when the server advertises it. */
function chooseScope(prmScopes: string[] | undefined, asScopes: string[] | undefined): string {
  const base = prmScopes && prmScopes.length ? prmScopes : (asScopes ?? []);
  const set = new Set(base.filter((s) => s !== 'offline_access'));
  const supportsOffline =
    (asScopes ?? prmScopes ?? []).includes('offline_access') || !asScopes; // assume yes if AS didn't enumerate
  const scopes = [...set];
  if (supportsOffline) scopes.push('offline_access');
  return scopes.join(' ');
}

async function registerClient(endpoint: string, redirectUri: string, scope: string): Promise<string> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Stem',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope
    })
  });
  if (!res.ok) {
    throw new Error(`Dynamic client registration failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  const data = (await res.json()) as { client_id?: string };
  if (!data.client_id) throw new Error('Client registration returned no client_id.');
  return data.client_id;
}

interface Loopback {
  redirectUri: string;
  codePromise: Promise<{ code: string | null; state: string | null }>;
  close: () => void;
}

/**
 * A one-shot loopback HTTP server that catches the OAuth redirect. `port` 0 (the
 * default) picks a random free port — used for the DCR path, where the server
 * registers whatever redirect we send. The static-client path passes a fixed
 * port so the redirect URL matches the one pre-registered with the provider.
 */
function startLoopback(port = 0): Promise<Loopback> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject); // e.g. EADDRINUSE when the fixed port is taken
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
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        redirectUri: `http://127.0.0.1:${port}/callback`,
        codePromise,
        close: () => server.close()
      });
    });
  });
}

async function exchangeCode(tokenEndpoint: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString()
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Normalize a token-endpoint response. Standard OAuth servers return the token
 * fields at the top level; Slack's `oauth.v2.user.access` may instead nest them
 * under `authed_user`. Prefer a top-level access_token, else fall back to the
 * wrapper so the static-client path works either way.
 */
function normalizeTokenResponse(tok: Record<string, unknown>): Record<string, unknown> {
  if (typeof tok.access_token === 'string') return tok;
  const wrapped = tok.authed_user;
  if (wrapped && typeof wrapped === 'object') return wrapped as Record<string, unknown>;
  return tok;
}

export interface AuthorizeOptions {
  /** Called with the authorization URL so the UI can show a click/copy fallback. */
  onAuthUrl?: (url: string) => void;
  /** Overall timeout for the browser round-trip (default 5 min). */
  timeoutMs?: number;
  /**
   * A pre-registered client id. When set, the flow skips dynamic client
   * registration (for providers like Slack that don't support it) and uses a
   * fixed loopback redirect so the URL matches the provider's registration.
   */
  clientId?: string;
  /** The client secret for a confidential static client (`client_secret_post`). */
  clientSecret?: string;
  /** Verbatim scope string for the static-client path (overrides discovery). */
  scope?: string;
}

/**
 * Drive the full MCP OAuth flow for `mcpUrl` and return the resulting token.
 * Opens the system browser for the user to consent; resolves once the loopback
 * redirect delivers the code and the exchange succeeds.
 */
export async function authorizeMcp(mcpUrl: string, opts: AuthorizeOptions = {}): Promise<OAuthToken> {
  const pr = await discoverProtectedResource(mcpUrl);
  const asMeta = await discoverAuthServer(pr.authServer);
  if (!asMeta.authorization_endpoint || !asMeta.token_endpoint) {
    throw new Error('The authorization server is missing its authorize/token endpoints.');
  }
  // A pre-registered (static) client sidesteps dynamic client registration, which
  // servers like Slack don't offer.
  const staticClient = !!opts.clientId;
  if (!staticClient && !asMeta.registration_endpoint) {
    throw new Error(
      "This server has no dynamic client registration endpoint. Register an app with the provider and add its OAuth Client ID (and secret) to this server's settings, then sign in again."
    );
  }

  // A static client may carry its own scope (matching what's enabled on the
  // provider app); otherwise fall back to discovery-derived scopes.
  const scope = opts.scope?.trim() || chooseScope(pr.scopes, asMeta.scopes_supported);
  // Static (confidential) clients must use the fixed, pre-registered redirect URL.
  const loop = await startLoopback(staticClient ? STEM_OAUTH_REDIRECT_PORT : 0);
  const timeout = setTimeout(() => loop.close(), opts.timeoutMs ?? 300_000);
  try {
    const clientId = staticClient
      ? opts.clientId!
      : await registerClient(asMeta.registration_endpoint!, loop.redirectUri, scope);

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));

    const authUrl = new URL(asMeta.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', loop.redirectUri);
    authUrl.searchParams.set('scope', scope);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('resource', pr.resource);

    opts.onAuthUrl?.(authUrl.toString());
    await shell.openExternal(authUrl.toString());

    const { code, state: returnedState } = await loop.codePromise;
    if (!code) throw new Error('No authorization code was returned.');
    if (returnedState !== state) throw new Error('OAuth state mismatch — aborting for safety.');

    const tok = normalizeTokenResponse(
      await exchangeCode(asMeta.token_endpoint, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: loop.redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: pr.resource,
        ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {})
      })
    );
    if (typeof tok.access_token !== 'string') throw new Error('The token response had no access_token.');

    return {
      resource: pr.resource,
      tokenEndpoint: asMeta.token_endpoint,
      clientId,
      ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
      scope,
      accessToken: tok.access_token,
      refreshToken: typeof tok.refresh_token === 'string' ? tok.refresh_token : undefined,
      expiresAt: typeof tok.expires_in === 'number' ? Date.now() + tok.expires_in * 1000 : 0
    };
  } finally {
    clearTimeout(timeout);
    loop.close();
  }
}
