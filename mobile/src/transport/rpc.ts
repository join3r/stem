// POST /rpc, the phone's half.
//
// The envelope is the transport's: `{channel, args}` in, `{ok:true, result}` or
// `{ok:false, error}` out, bearer token in a header. Nothing here is
// phone-specific — it is the same call src/desktop/proxy.ts makes, minus the
// wrapped-channel table, because none of the client-side behaviors that table
// describes (native pickers, the Quick Chat overlay, an OAuth browser) exist on
// a phone.
//
// THE ONE RULE THIS FILE EXISTS TO KEEP: whether the server is reachable is
// decided by the TRANSPORT, never by what came back in the body. A 500 with a
// stack trace in it is a server that is up and having a bad time; an
// `{ok:false}` is a server that is up and saying no. Only a fetch that throws —
// nothing answered at all — means unreachable. Get that backwards and the phone
// shows "offline" whenever a call fails for an ordinary reason, which is exactly
// the moment a user needs to be told the truth about their connection.

import type { ChannelArgs, ChannelName, ChannelResult } from './channels';

export interface Endpoint {
  /** Origin, no trailing slash — see normalizeServerUrl in ./pairing.ts. */
  serverUrl: string;
  token: string;
}

/**
 * Deliberately generous, and the same number as the desktop's. An RPC is not a
 * request to a web service: the handler may be waiting on pi to accept a prompt
 * or on a model download. The timeout is here so a wedged server cannot wedge
 * the UI forever, not to bound normal work.
 */
export const RPC_TIMEOUT_MS = 10 * 60_000;

/** Nothing answered. Distinct from a refusal so the UI can say which happened. */
export class UnreachableError extends Error {
  /** What the platform said, for the log. Not for the screen: it is a Swift stack location. */
  readonly detail: string;
  constructor(serverUrl: string, cause: unknown) {
    // The message is what a banner shows, so it is a sentence about the server
    // and not the platform's exception text ("UnexpectedException … at
    // ExpoModulesCore/Promise.swift:56" was the banner before this).
    super(`Could not reach ${serverUrl.replace(/^https?:\/\//, '')}.`);
    this.name = 'UnreachableError';
    this.detail = String((cause as Error)?.message ?? cause);
  }
}

export interface RpcOptions {
  /** Injected so tests need no network; defaults to the platform fetch. */
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /** Called with the transport's verdict, before the answer is inspected. */
  onReachable?: (reachable: boolean) => void;
}

/** One call, untyped. `rpc()` below is what callers should reach for. */
export async function rpcRaw(
  endpoint: Endpoint,
  channel: string,
  args: unknown[],
  options: RpcOptions = {}
): Promise<unknown> {
  const doFetch = options.fetch ?? globalThis.fetch;
  // AbortSignal.timeout() is not everywhere in React Native yet, and combining
  // it with a caller's own signal needs AbortSignal.any(), which is less
  // available still. A timer and one controller work on every runtime.
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort);
  const timer = setTimeout(abort, RPC_TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(`${endpoint.serverUrl}/rpc`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ channel, args }),
      signal: controller.signal
    });
  } catch (e) {
    options.onReachable?.(false);
    throw new UnreachableError(endpoint.serverUrl, e);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
  options.onReachable?.(true);
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; result?: unknown; error?: string }
    | null;
  if (res.ok && body?.ok) return body.result;
  // The server's own message, verbatim: the channel guard's wording ("Rejected
  // local call to X: …") is meant to reach a person unchanged, and rewriting it
  // here would leave whoever reads it guessing which side of the wire spoke.
  throw new Error(body?.error ?? `${channel} failed (HTTP ${res.status})`);
}

/** One call, typed against StemApi through the table in ./channels.ts. */
export function rpc<C extends ChannelName>(
  endpoint: Endpoint,
  channel: C,
  args: ChannelArgs<C>,
  options?: RpcOptions
): Promise<ChannelResult<C>> {
  return rpcRaw(endpoint, channel, args as unknown[], options) as Promise<ChannelResult<C>>;
}
