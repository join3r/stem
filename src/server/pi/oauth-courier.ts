import { log } from '../log';
import { loopbackFlow, loopbackRedirectUri, redirectKey } from '../../shared/oauth-redirect';

// The server's half of the OAuth callback courier.
//
// Every loopback OAuth flow on this server — pi's provider logins, the MCP
// authorization in ./oauth.ts — binds 127.0.0.1 *here* and waits for the browser
// to arrive. That is correct on a desktop, where the browser is on this machine,
// and quietly impossible once the server lives on a VPS: the user's browser
// resolves 127.0.0.1 to the laptop it is running on, the callback lands on a
// port nothing on that machine is listening to, and the sign-in hangs until it
// times out with no error to show for it.
//
// So the client catches the callback instead (src/desktop/oauth-courier.ts) and
// hands it back over the transport, and this file replays it to the loopback
// listener the flow already has open. pi completes believing it caught the
// browser itself, which is the point: nothing in a provider flow has to know
// that the browser was on another continent.
//
// The registry below is what keeps that from being a request-forgery primitive.
// A delivery is only replayed to an address that a flow ON THIS SERVER announced
// in the last ten minutes, with the `state` that flow expects — so an
// authenticated client cannot use this channel to make the server fetch loopback
// addresses of its choosing, and a callback that belongs to no live sign-in is
// refused rather than forwarded to whatever happens to be listening.

/** Long enough for a slow consent screen; short enough that a stale address dies. */
const EXPECTATION_TTL_MS = 10 * 60_000;

/**
 * How many flows may be waiting at once. Two is already unusual (a provider
 * login and an MCP sign-in overlapping); the cap is here so a client that
 * repeatedly starts and abandons sign-ins cannot grow this list without bound.
 */
const MAX_EXPECTATIONS = 8;

/** The replay is to a socket on this machine — a slow one is a broken one. */
const RELAY_TIMEOUT_MS = 10_000;

/** Sanity bounds on what a provider may hand back. Real callbacks are tiny. */
const MAX_PARAMS = 32;
const MAX_PARAM_CHARS = 4096;

interface Expectation {
  /** host:port/path — see redirectKey. */
  key: string;
  /** Bracketed for IPv6, i.e. ready to be pasted into a URL. */
  authority: string;
  path: string;
  /** What the provider must echo back, or null when the flow uses no state. */
  state: string | null;
  expiresAt: number;
}

let expectations: Expectation[] = [];

function prune(): void {
  const now = Date.now();
  expectations = expectations.filter((e) => e.expiresAt > now);
}

/**
 * Note that a flow on this server is waiting for a browser at the loopback
 * address inside `authUrl`. Called wherever an authorization URL is handed to
 * the clients, so the record and the announcement can never disagree; a URL with
 * no loopback redirect (a device-code flow, a provider-hosted redirect) records
 * nothing and needs nothing.
 */
export function expectCallback(authUrl: string): void {
  const flow = loopbackFlow(authUrl);
  if (!flow) return;
  prune();
  const key = redirectKey(flow);
  // One expectation per address: a second attempt on the same port supersedes
  // the first, exactly as the flow itself did when it rebound the port.
  expectations = expectations.filter((e) => e.key !== key);
  expectations.push({
    key,
    authority: `${flow.host.includes(':') ? `[${flow.host}]` : flow.host}:${flow.port}`,
    path: flow.path,
    state: flow.state,
    expiresAt: Date.now() + EXPECTATION_TTL_MS
  });
  if (expectations.length > MAX_EXPECTATIONS) expectations = expectations.slice(-MAX_EXPECTATIONS);
  // The address, never the state: this line exists to explain a courier that
  // went to the wrong port, and the state is the one secret in the record.
  log('oauth', 'a sign-in is waiting for a callback', { port: flow.port, path: flow.path });
}

/**
 * Replay a callback a client caught to the flow that is waiting for it. Throws a
 * sentence for every refusal — the client logs it, and there is nothing it can
 * do about any of them but say so.
 *
 * The parameters are forwarded verbatim (minus anything absurd): a provider may
 * return more than `code` and `state`, and the listener on the other end is
 * pi's, not ours, so trimming the query to the fields we happen to know about
 * would be guessing at somebody else's protocol.
 */
export async function relayCallback(redirectUri: string, params: Record<string, unknown>): Promise<void> {
  const target = loopbackRedirectUri(redirectUri);
  if (!target) throw new Error(`${redirectUri} is not a loopback callback address.`);
  prune();
  const expectation = expectations.find((e) => e.key === redirectKey(target));
  if (!expectation) throw new Error('no sign-in on this server is waiting for that callback.');

  const entries = Object.entries(params);
  if (entries.length > MAX_PARAMS) throw new Error('that callback carried too many parameters.');
  const query = new URLSearchParams();
  for (const [name, value] of entries) {
    if (typeof value !== 'string') continue;
    if (name.length > 128 || value.length > MAX_PARAM_CHARS) {
      throw new Error(`the "${name.slice(0, 32)}" parameter of that callback is too long.`);
    }
    query.set(name, value);
  }
  // The client checks this too, at the listener. It is repeated here because the
  // two checks answer different questions: the client's stops a page on the
  // user's machine from feeding it a code, and this one stops a delivery from
  // completing a sign-in it does not belong to.
  if (expectation.state && query.get('state') !== expectation.state) {
    throw new Error('that callback does not match the sign-in that is waiting.');
  }

  // Spent, whatever happens next: a callback is single use, and an expectation
  // that survived a failed replay is one a second delivery could race for.
  expectations = expectations.filter((e) => e !== expectation);

  const url = `http://${expectation.authority}${expectation.path}?${query.toString()}`;
  try {
    // The response is the sign-in page pi serves to the browser, and nobody is
    // looking at it here — what matters is that the request reached the
    // listener, which is what resolves the flow's wait. `manual` so a redirect
    // in that page cannot send this fetch anywhere else.
    await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`the sign-in listener did not answer: ${String((e as Error)?.message ?? e)}`, { cause: e });
  }
  log('oauth', 'replayed a couriered callback', { at: expectation.authority, path: expectation.path });
}

/** Drop every outstanding expectation (tests). */
export function forgetExpectedCallbacks(): void {
  expectations = [];
}

/**
 * The page the browser is left on. Served by whichever end caught the callback —
 * this server's own listener when the browser is on this machine, the client's
 * courier when it is not — so the user sees the same thing either way.
 *
 * Nothing from the request is interpolated into it, deliberately: this page is
 * rendered on a loopback origin from a URL an attacker may have chosen, and the
 * only safe amount of that URL to echo back is none of it.
 */
export function callbackPageHtml(failed: boolean): string {
  return (
    '<html><body style="font-family:system-ui,sans-serif;text-align:center;padding-top:3rem">' +
    `<h2>${failed ? 'Sign-in failed' : 'Sign-in complete'}</h2>` +
    '<p>You can close this tab and return to Stem.</p></body></html>'
  );
}
