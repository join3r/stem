// One object for "the phone's link to a Stem server": the RPC call, the event
// stream, who is listening to what, and the connection state the UI renders.
//
// This is the file screens talk to; ./rpc.ts and ./stream.ts are its two halves
// and nothing above this line imports them directly. It holds no React and no
// Expo — the provider in ./provider.tsx supplies the streaming fetch and the
// Keychain, and this stays a plain object so a test can drive a whole session
// through it with two fakes.
//
// TWO QUESTIONS THAT MUST NOT BE CONFUSED, the same pair src/desktop/proxy.ts
// calls out: `paired` is whether this phone has a credential for a server at all
// — a fact about the Keychain, changed only by pairing and unpairing.
// `reachable` is whether that server is answering right now. A phone in a tunnel
// is paired and unreachable; a phone that has never been set up is neither.
//
// Fan-out is by channel name and nothing else. The desktop's proxy routes pushes
// to one of three windows and reveals an overlay for approval cards; a phone has
// one surface, so the routing table collapses to "whoever asked for this channel
// gets it" and the filtering that used to happen in the router (which thread is
// this for?) happens in the screen that knows.
//
// A DROP IS A RECONNECT FIRST AND AN OUTAGE SECOND. One request that nothing
// answered used to flip `reachable` for the whole app on the spot, and on a phone
// that one request is routine: the first fetch after the screen unlocks goes out
// before the radio has re-associated, and every RPC that was in the air when iOS
// suspended us fails the instant we come back. Painting the app red for that is
// lying about the connection in the one moment the user is looking at it. So a
// failure now opens a GRACE (RECONNECT_GRACE_MS) during which the status says
// `reconnecting` and `reachable` is left alone; only a grace that ends with the
// failures still coming and no stream open says offline. A server that answers
// — with anything, including an error — ends the question at once, and a stream
// opening ends it the other way. Nothing here changes what the cache may do:
// "nothing answered" is a fact about one call, and it is answered from the cache
// whether or not the status has given up yet.

import type { BackendEventEnvelope, LiveTurn } from '@shared/types';
import type { OfflineCache } from '../offline/cache';
import type { ChannelArgs, ChannelName, ChannelResult } from './channels';
import { applyLiveTurnEvent, liveTurnList, liveTurnsFromSnapshot } from './live-turns';
import { rpc, rpcRaw, UnreachableError, type Endpoint } from './rpc';
import { createEventStream, type EventStream, type StreamingFetch } from './stream';

export { UnreachableError };

/**
 * Did this call reach nobody? The one question a screen may ask about a
 * failure, and the question that decides whether it is worth a banner: a
 * background refetch that nothing answered while the link is reconnecting is
 * not news, a server error always is. Here rather than imported from ./rpc so
 * the screens keep to this file, as the header says they should.
 */
export function isUnreachable(error: unknown): boolean {
  return error instanceof UnreachableError;
}

/**
 * How long a dropped link is "reconnecting" before it is "offline". Long enough
 * for a radio to come back after an unlock and for the first backoff steps to
 * run (250, 500, 1000, 2000ms), short enough that a server that is really gone
 * is not hidden behind a dim dot for long.
 */
export const RECONNECT_GRACE_MS = 6_000;

/** What the connection indicator renders, and what a composer would gate on. */
export interface ConnectionStatus {
  /** There is a stored pairing, so there is a server to talk to. */
  paired: boolean;
  /** The server answers. Decided by the transport, never by a response body. */
  reachable: boolean;
  /** A stream is open right now — i.e. events would arrive if anything happened. */
  streaming: boolean;
  /**
   * The server has this device's token and does not accept it (a revoked
   * device). Sticky until the next successful connect, because the answer is
   * "pair again", not "wait".
   */
  unauthorized: boolean;
  /**
   * A stream is being (re)opened and the link has not been down long enough to
   * call the server gone. The dim state between Live and Offline — see the
   * header. Always false while streaming.
   */
  reconnecting: boolean;
}

export type Unsubscribe = () => void;

export interface ConnectionDeps {
  /** The streaming fetch used for GET /events; see ./expo-fetch.ts. */
  streamingFetch: StreamingFetch;
  /** The ordinary fetch used for POST /rpc. Defaults to the platform's. */
  fetch?: typeof globalThis.fetch;
  /**
   * The read-only chat cache, or nothing. Wired HERE rather than in a screen for
   * the reason the desktop wires it into proxy.ts: this is the only layer that
   * knows the difference between "the server said no" and "nothing answered",
   * and that distinction is the cache's whole safety argument. See
   * ../offline/cache.ts.
   */
  cache?: OfflineCache;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface Connection {
  status(): ConnectionStatus;
  onStatus(listener: (status: ConnectionStatus) => void): Unsubscribe;
  /** Every push on one channel. The names are the server's (`backend:event`, …). */
  onPush(channel: string, listener: (payload: unknown) => void): Unsubscribe;
  /** The backend's own event stream, typed. Sugar over onPush('backend:event'). */
  onBackendEvent(listener: (event: BackendEventEnvelope) => void): Unsubscribe;
  /**
   * The stream could not be resumed and whatever is on screen is now of unknown
   * age. Every screen holding server data must refetch — that is the entire
   * contract, and it is why the server sends this instead of a partial replay.
   */
  onResync(listener: () => void): Unsubscribe;
  /** Authoritative snapshots received when the stream opens; used to reconcile transcripts. */
  onLiveTurns(listener: (liveTurns: LiveTurn[]) => void): Unsubscribe;
  /** Current running turns, delivered immediately and whenever snapshots/events change them. */
  subscribeLiveTurns(listener: (liveTurns: LiveTurn[]) => void): Unsubscribe;
  /**
   * The app is in front again and whatever is on screen is of unknown age.
   * Screens holding server data refetch it QUIETLY — spinner if they like, no
   * banner if nothing answers, because the stream is being reopened at the same
   * moment and the link may not be back yet. Not onResync: that one is the
   * server saying frames were lost, and this one is the phone saying it was not
   * watching.
   */
  onWake(listener: () => void): Unsubscribe;
  rpc<C extends ChannelName>(channel: C, ...args: ChannelArgs<C>): Promise<ChannelResult<C>>;
  /**
   * Point this connection at a server, or at nothing. Persisting the pairing is
   * the caller's job (./credentials.ts) — this only decides where the next
   * connect goes, and restarts the stream so it goes there immediately.
   */
  setEndpoint(endpoint: Endpoint | null): void;
  /**
   * The app is in front. Drop whatever stream there was, open a fresh one from
   * the bookmark, and tell the screens (onWake). Unconditional on purpose — see
   * the RESUME paragraph in ./stream.ts for why "only if it is down" is not
   * answerable after a suspension.
   */
  wake(): void;
  /**
   * The app is in the background. Close the stream and stop retrying until
   * wake(); the bookmark and the pairing stay. Nothing about reachability is
   * concluded from a socket we closed ourselves.
   */
  sleep(): void;
  start(): void;
  stop(): void;
}

/** The smallest listener set that supports unsubscribing during a dispatch. */
function emitter<T>(): {
  add: (listener: (value: T) => void) => Unsubscribe;
  emit: (value: T) => void;
} {
  const listeners = new Set<(value: T) => void>();
  return {
    add(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(value) {
      for (const listener of [...listeners]) listener(value);
    }
  };
}

export function createConnection(deps: ConnectionDeps): Connection {
  let endpoint: Endpoint | null = null;
  let status: ConnectionStatus = {
    paired: false,
    reachable: false,
    streaming: false,
    unauthorized: false,
    reconnecting: false
  };

  const statusListeners = emitter<ConnectionStatus>();
  const resyncListeners = emitter<void>();
  const liveTurnListeners = emitter<LiveTurn[]>();
  const liveStateListeners = emitter<LiveTurn[]>();
  // Screens can mount long after the connection's snapshot arrived. Keep its
  // current answer here, including the events since that snapshot, so opening
  // a running chat can offer Stop before the model produces another token.
  let liveTurns = new Map<string, string>();
  const wakeListeners = emitter<void>();
  const pushListeners = new Map<string, ReturnType<typeof emitter<unknown>>>();

  const patchStatus = (patch: Partial<ConnectionStatus>): void => {
    const next = { ...status, ...patch };
    if (
      next.paired === status.paired &&
      next.reachable === status.reachable &&
      next.streaming === status.streaming &&
      next.unauthorized === status.unauthorized &&
      next.reconnecting === status.reconnecting
    ) {
      return;
    }
    status = next;
    statusListeners.emit(status);
  };

  // The grace — see the header. One timer; `failedInGrace` is whether anything
  // came back "nothing answered" since it was armed, which is what the timer
  // looks at when it fires.
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let failedInGrace = false;

  const endGrace = (): void => {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    failedInGrace = false;
    patchStatus({ reconnecting: false });
  };

  const beginGrace = (): void => {
    if (graceTimer !== null) return;
    failedInGrace = false;
    patchStatus({ reconnecting: true });
    const arm = (): void => {
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (status.streaming) {
          // Cannot happen — onStreaming(true) ends the grace — but the honest
          // fallback is the same answer.
          endGrace();
          return;
        }
        if (failedInGrace) {
          // The link has been down for the whole grace and something tried and
          // failed in it. That is what offline means.
          failedInGrace = false;
          patchStatus({ reachable: false, reconnecting: false });
          return;
        }
        // Nothing failed, nothing opened: a handshake still in the air. Waiting
        // is the only honest thing, and the connect timeout in ./stream.ts
        // guarantees this does not wait forever.
        arm();
      }, RECONNECT_GRACE_MS);
    };
    arm();
  };

  /**
   * Every transport verdict — a fetch that answered or one that reached nobody
   * — lands here rather than on `reachable` directly. This is the one place
   * that knows whether a failure is news.
   */
  const noteTransport = (ok: boolean): void => {
    if (ok) {
      failedInGrace = false;
      patchStatus({ reachable: true });
      return;
    }
    // An RPC failing under an open stream is that RPC's problem, not the link's:
    // the stream is the authority while it is up, and a single POST timing out
    // through a proxy must not paint the app offline.
    if (status.streaming) return;
    // Already offline: more failures are more of the same, and opening a grace
    // for each retry would blink the dot between Connecting and Offline forever.
    if (!status.reachable && graceTimer === null) return;
    failedInGrace = true;
    beginGrace();
  };

  /**
   * How a catch-up run reaches the server. Untyped on purpose — it walks channels
   * (`chats:history`) by name, and it writes through the cache itself so the
   * watermarks are in place by the time the run diffs against them.
   *
   * No `onReachable`: while a run is happening the stream is open and it is the
   * authority on reachability. A background fetch failing would otherwise flip
   * the whole UI to "offline" without a user having asked for anything.
   */
  const prefetchCall = async (channel: string, args: unknown[], signal: AbortSignal): Promise<unknown> => {
    if (!endpoint) throw new Error('This phone is not paired with a Stem server yet.');
    const result = await rpcRaw(endpoint, channel, args, { fetch: deps.fetch, signal });
    deps.cache?.record(channel, args, result);
    return result;
  };

  const stream: EventStream = createEventStream({
    endpoint: () => endpoint,
    fetch: deps.streamingFetch,
    log: deps.log,
    onPush: (channel, payload) => {
      const previous = liveTurns;
      if (channel === 'backend:event') {
        liveTurns = applyLiveTurnEvent(liveTurns, payload as BackendEventEnvelope);
      }
      // Deliver the event to transcripts before publishing its running-state
      // change; a failure's explanation belongs to the event itself.
      pushListeners.get(channel)?.emit(payload);
      if (liveTurns !== previous) liveStateListeners.emit(liveTurnList(liveTurns));
    },
    onResync: () => resyncListeners.emit(undefined),
    onSnapshot: (snapshot) => {
      liveTurns = liveTurnsFromSnapshot(snapshot);
      liveStateListeners.emit(liveTurnList(liveTurns));
      liveTurnListeners.emit(liveTurnList(liveTurns));
    },
    onReachable: noteTransport,
    // A connect that got as far as a stream is a connect the credential passed,
    // so this is also where a stale `unauthorized` is cleared — and the moment
    // worth topping the offline cache up in, since the phone is demonstrably on
    // a network right now and may not be in a minute. A stream CLOSING opens the
    // grace: the reader is about to reconnect, and whether that is a blip or an
    // outage is not known yet.
    onStreaming: (streaming) => {
      if (streaming) {
        patchStatus({ streaming, unauthorized: false, reachable: true });
        endGrace();
        deps.cache?.schedulePrefetch(prefetchCall);
      } else {
        patchStatus({ streaming });
        if (status.paired) beginGrace();
        deps.cache?.cancel();
      }
    },
    onRefused: (httpStatus) => patchStatus({ unauthorized: httpStatus === 401 })
  });

  const onPush = (channel: string, listener: (payload: unknown) => void): Unsubscribe => {
    let channelListeners = pushListeners.get(channel);
    if (!channelListeners) {
      channelListeners = emitter<unknown>();
      pushListeners.set(channel, channelListeners);
    }
    return channelListeners.add(listener);
  };

  return {
    status: () => status,
    onStatus: (listener) => statusListeners.add(listener),
    onPush,
    onBackendEvent: (listener) =>
      onPush('backend:event', (payload) => listener(payload as BackendEventEnvelope)),
    onResync: (listener) => resyncListeners.add(listener),
    onLiveTurns: (listener) => liveTurnListeners.add(listener),
    subscribeLiveTurns: (listener) => {
      const off = liveStateListeners.add(listener);
      listener(liveTurnList(liveTurns));
      return off;
    },
    onWake: (listener) => wakeListeners.add(listener),
    async rpc<C extends ChannelName>(channel: C, ...args: ChannelArgs<C>): Promise<ChannelResult<C>> {
      if (!endpoint) throw new Error('This phone is not paired with a Stem server yet.');
      let result: ChannelResult<C>;
      try {
        result = await rpc(endpoint, channel, args, {
          fetch: deps.fetch,
          onReachable: noteTransport
        });
      } catch (e) {
        // The ONLY place the cache is ever read, and the reason the throw is
        // narrowed to UnreachableError: an `{ok:false}` or an HTTP 500 is a
        // server that is up and saying something, and answering it from a copy
        // would be the cache overruling a server it can reach. Nothing answered
        // is a different fact, and the only one a cached answer improves on.
        if (e instanceof UnreachableError) {
          const cached = deps.cache?.replay(channel, args);
          if (cached !== undefined) return cached as ChannelResult<C>;
        }
        throw e;
      }
      deps.cache?.record(channel, args, result);
      // The server answered, so it is up. That does not make the stream healthy
      // — a dead stream means missed events — so re-open it now rather than
      // waiting out the backoff.
      stream.retryNow();
      return result;
    },
    setEndpoint(next) {
      endpoint = next;
      liveTurns = new Map();
      liveStateListeners.emit([]);
      endGrace();
      patchStatus({
        paired: next !== null,
        // Nothing is known about a server we have not spoken to yet, and the
        // last one's verdict is not evidence about this one.
        reachable: false,
        unauthorized: false
      });
      // A catch-up run in flight is aimed at the server we just stopped talking
      // to; its answers must not land in the cache under the new one's name.
      deps.cache?.cancel();
      stream.stop();
      if (next) {
        // "Connecting", not "Offline", for the first moments after launch: the
        // grace is what the dot reads while the handshake is out.
        beginGrace();
        stream.start();
      }
    },
    wake() {
      if (!endpoint) return;
      // The grace opens here explicitly because the reader may not have been
      // streaming (a socket the OS already tore down reports nothing), in which
      // case reconnect() has no streaming edge to fall to false on.
      beginGrace();
      stream.reconnect();
      wakeListeners.emit(undefined);
    },
    sleep() {
      deps.cache?.cancel();
      stream.sleep();
      // AFTER the stream closes: closing it reports a streaming edge, which
      // opens a grace, and a socket we are closing on purpose says nothing
      // about the server — so that grace is dropped here, not concluded.
      endGrace();
    },
    start() {
      stream.start();
    },
    stop() {
      deps.cache?.cancel();
      stream.stop();
      endGrace();
    }
  };
}
