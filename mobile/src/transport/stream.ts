// GET /events — the phone's event stream, ported from src/desktop/proxy.ts.
//
// This is the only channel the server has for telling a client that anything
// happened, and the phone is a broadcast listener on it exactly like the desktop
// is: every frame the server sends reaches every paired device, and filtering by
// thread is the client's job. That is by design (see the fan-out comment in
// proxy.ts) — the server does not model which screen anybody is looking at.
//
// What was ported, and why each piece is here rather than left out:
//
//   Last-Event-ID   the frame ids are `epoch.seq`, the server keeps a bounded
//                   replay buffer, and echoing the last id back is what turns a
//                   reconnect into a resumption. Kept in memory only, like the
//                   desktop's: a relaunched app refetches everything anyway, and
//                   a bookmark that outlived its process would ask for a replay
//                   nobody is watching.
//   backoff         250ms doubling to 10s. The server suggests 3s via `retry:`;
//                   ours starts far under it because a phone's first reconnect
//                   usually follows a screen unlock, where the network is fine
//                   and three seconds of "connecting…" is three seconds of
//                   staring at a spinner.
//   resync          the gap was longer than the buffer. The bookmark moves to
//                   the head the server reports BEFORE the refetch, so a second
//                   drop does not ask to replay across a gap already closed.
//   snapshot        `liveTurns` — what is running right now. A returning client
//                   cannot otherwise tell "still streaming" from "finished while
//                   I was away": both look like a thread that stopped producing.
//   stall timer     NEW on mobile, and the one thing the desktop does not need.
//                   A backgrounded phone's socket can be severed by the OS or by
//                   a carrier NAT without either end being told, leaving a reader
//                   that will wait forever on a connection that is already dead.
//                   The server's 25s keepalive is the liveness proof; not seeing
//                   one for STALL_MS means the stream is a corpse, so we drop it
//                   ourselves and reconnect.
//
// Reachability is decided here and in ./rpc.ts, never from a payload. A stream
// that ENDS is routine — a proxy recycling a connection, a handover between
// wifi and cellular — so it does not by itself mean the server is gone; the
// honest test is whether the next connect can be made at all, which is why
// `reachable:false` is set on a failed connect and nowhere else.

import type { LiveTurn } from '@shared/types';
import { createSseParser } from './sse';
import type { Endpoint } from './rpc';

/** Reconnect backoff, same as the desktop's. */
export const RECONNECT_BASE_MS = 250;
export const RECONNECT_MAX_MS = 10_000;

/**
 * How long a silent stream may stay open. The server writes `: keepalive` every
 * 25s (SSE_KEEPALIVE_MS in src/server/transport/server.ts), so anything past two
 * missed heartbeats plus slack is a connection that is not coming back.
 */
export const STALL_MS = 60_000;

/** The delay before attempt N (1-based), capped. Exported for its test. */
export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/**
 * The slice of a streaming fetch this reader uses. Structural rather than
 * imported from `expo/fetch` so the module stays importable — and testable —
 * outside React Native; the wiring in ./connection.ts is what supplies the real
 * one.
 */
export interface StreamingResponse {
  status: number;
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
      cancel(reason?: unknown): unknown;
    };
  } | null;
}

export type StreamingFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal }
) => Promise<StreamingResponse>;

export interface EventStreamDeps {
  /** Where to connect, re-read on every attempt; null = not paired, stay closed. */
  endpoint: () => Endpoint | null;
  fetch: StreamingFetch;
  /** One `{channel, payload}` push, already parsed. */
  onPush: (channel: string, payload: unknown) => void;
  /** The gap was too big to replay: everything on screen must be refetched. */
  onResync: () => void;
  /** The whole truth about what is running, as of the moment the stream opened. */
  onSnapshot: (liveTurns: LiveTurn[]) => void;
  /** Whether the server answers at all. Transport verdict; see the header. */
  onReachable: (reachable: boolean) => void;
  /** Whether a stream is open right now — the connection dot in the UI. */
  onStreaming: (streaming: boolean) => void;
  /**
   * The server answered the stream request with something other than 200. Almost
   * always 401: this device's row is gone from the registry (revoked, or the
   * server's state was rebuilt), which is a thing only the user can fix and
   * therefore a thing the UI has to say out loud. Reported, never acted on here
   * — nothing in this file deletes a credential.
   */
  onRefused?: (status: number) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface EventStream {
  /** Open, and keep reopening until stop(). Safe to call when already running. */
  start(): void;
  /** Close and stay closed. */
  stop(): void;
  /**
   * Reconnect now instead of waiting out the backoff, if nothing is open. This
   * is what an app coming back to the foreground calls, and what a successful
   * RPC calls: the server answered, so a stream that is still down is down for
   * a reason that will not fix itself by waiting.
   *
   * "Nothing is open" includes a connect that has been made but not yet
   * answered. An RPC finishing while the /events request is still in the air is
   * the ORDINARY case on a slow link — every screen makes one — and treating it
   * as a reason to start over would abort the handshake it was waiting for and
   * do it again, forever. See the `connecting` guard below.
   */
  retryNow(): void;
  streaming(): boolean;
}

export function createEventStream(deps: EventStreamDeps): EventStream {
  const log = deps.log ?? ((): void => undefined);
  let closed = true;
  let streaming = false;
  /**
   * A connect has been made and has not yet come back — the window between the
   * /events request going out and its response headers landing. `streaming` only
   * covers the half after that, so this is the flag that makes "there is already
   * an attempt in flight" answerable while the attempt is the slow part.
   */
  let connecting = false;
  let attempt = 0;
  let generation = 0;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last frame id actually delivered — see the header. In memory only. */
  let lastEventId: string | null = null;

  const setStreaming = (next: boolean): void => {
    if (streaming === next) return;
    streaming = next;
    deps.onStreaming(next);
  };

  const clearRetry = (): void => {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const clearStall = (): void => {
    if (stallTimer === null) return;
    clearTimeout(stallTimer);
    stallTimer = null;
  };

  const armStall = (): void => {
    clearStall();
    const mine = generation;
    stallTimer = setTimeout(() => {
      if (mine !== generation) return;
      log('event stream went quiet; dropping it', { stallMs: STALL_MS });
      // Aborting makes the pending read() reject, which lands in the same
      // teardown path a real drop takes — one way out, not two.
      controller?.abort();
    }, STALL_MS);
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    clearRetry();
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, reconnectDelay(attempt));
  };

  const deliver = (raw: string): void => {
    let frame: { channel?: unknown; payload?: unknown };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return; // a truncated frame is not worth taking the app down for
    }
    if (typeof frame.channel !== 'string') return;
    deps.onPush(frame.channel, frame.payload);
  };

  /**
   * A frame about the stream rather than about anything that happened. Told
   * apart by SSE's own `event:` field, which a push never carries — so neither
   * can ever be mistaken for the other, however odd the payload.
   */
  const control = (name: string, raw: string): void => {
    let data: { head?: unknown; liveTurns?: unknown; execApprovals?: unknown } = {};
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      return;
    }
    if (name === 'snapshot') {
      // Absent (a server with nothing to say) leaves the client's own view
      // alone; present — even empty — is the whole truth about what is running.
      if (Array.isArray(data.liveTurns)) deps.onSnapshot(data.liveTurns as LiveTurn[]);
      // Approval cards still waiting, replayed down the SAME channel their
      // pushes use: a card raised while this phone was asleep is not a different
      // question, and the queue drops the duplicates when it was already awake.
      // This is what makes a card answerable at all on a phone that was not
      // attached when it was raised — the tool call behind it is blocked either
      // way, and until now the only surface that could release it was the desk.
      if (Array.isArray(data.execApprovals)) {
        for (const request of data.execApprovals) {
          if (request && typeof (request as { id?: unknown }).id === 'string') {
            deps.onPush('exec:approvalRequest', request);
          }
        }
      }
      return;
    }
    if (name === 'resync') {
      // Move the bookmark to where the server says we now stand BEFORE
      // refetching: the refetch is what closes the gap, and asking to replay
      // across it again on the next drop would only repeat work already done.
      if (typeof data.head === 'string') lastEventId = data.head;
      log('the server asked for a resync');
      deps.onResync();
    }
  };

  const parser = createSseParser((block) => {
    // Every block counts as a sign of life, including the keepalive comment —
    // that is the only thing an idle stream sends.
    armStall();
    if (!block.data) return;
    if (block.event) {
      control(block.event, block.data);
      return;
    }
    deliver(block.data);
    // Bookmark AFTER delivering, never before: a frame recorded as seen and then
    // lost on its way to the UI is a frame the server will never send again.
    if (block.id) lastEventId = block.id;
  });

  async function connect(): Promise<void> {
    if (closed) return;
    clearRetry();
    const endpoint = deps.endpoint();
    if (!endpoint) return; // unpaired: nothing to connect to, and no error either
    controller?.abort();
    const mine = ++generation;
    const mineController = new AbortController();
    controller = mineController;
    setStreaming(false);
    connecting = true;
    parser.reset();

    let res: StreamingResponse;
    try {
      res = await deps.fetch(`${endpoint.serverUrl}/events`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          accept: 'text/event-stream',
          // The one header that turns a reconnect into a resumption. Omitted on
          // a first connect, which is how the server knows there is no gap.
          ...(lastEventId ? { 'last-event-id': lastEventId } : {})
        },
        signal: mineController.signal
      });
    } catch (e) {
      // A superseded attempt leaves `connecting` alone: it belongs to the newer
      // connect that replaced this one, and clearing it here would open the door
      // this flag exists to hold shut.
      if (mine !== generation) return;
      connecting = false;
      // A connect that could not be made at all. This — not a stream ending —
      // is what "offline" means.
      deps.onReachable(false);
      log('could not open the event stream', { error: String((e as Error)?.message ?? e) });
      scheduleReconnect();
      return;
    }
    if (mine !== generation) return;
    // The handshake is over either way: the server answered this request, so
    // whatever happens next is no longer "an attempt in flight".
    connecting = false;

    if (res.status !== 200 || !res.body) {
      // Refused, but refused BY something: the server is up and saying no, which
      // is not the offline case. 401 means this device's token is not in the
      // registry any more — the UI notices through ./connection.ts, which is
      // where the "you have been unpaired" decision belongs.
      deps.onReachable(true);
      log('event stream refused', { status: res.status });
      deps.onRefused?.(res.status);
      scheduleReconnect();
      return;
    }

    attempt = 0;
    setStreaming(true);
    deps.onReachable(true);
    armStall();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (mine !== generation) return;
        if (done) break;
        if (value) parser.push(decoder.decode(value, { stream: true }));
      }
    } catch (e) {
      if (mine !== generation) return;
      log('event stream dropped', { error: String((e as Error)?.message ?? e) });
    } finally {
      // cancel() on a stream that has already errored answers with a REJECTED
      // promise carrying that same error. Nothing is waiting on it, so left
      // alone it surfaces as an unhandled rejection — a red box in a dev build,
      // for a stream we were closing anyway.
      try {
        void Promise.resolve(reader.cancel()).catch(() => undefined);
      } catch {
        // Already gone; there is nothing to release.
      }
    }
    if (mine !== generation) return;
    clearStall();
    setStreaming(false);
    scheduleReconnect();
  }

  return {
    start(): void {
      if (!closed) return;
      closed = false;
      attempt = 0;
      void connect();
    },
    stop(): void {
      closed = true;
      generation += 1;
      connecting = false;
      clearRetry();
      clearStall();
      controller?.abort();
      controller = null;
      // The bookmark goes with the stream it belonged to. stop() means unpairing
      // or teardown, and a position in one server's stream means nothing to the
      // next one — the server would answer with a resync anyway (the epoch in
      // the id would not match), so keeping it would only buy a wasted round
      // trip on the way to the refetch that has to happen regardless.
      lastEventId = null;
      setStreaming(false);
    },
    retryNow(): void {
      // Open, or on its way to being open: either way there is nothing here to
      // improve on, and interrupting an attempt that is merely slow is how a
      // phone on a bad link ends up connecting forever without ever finishing.
      if (closed || streaming || connecting) return;
      // Nothing is in flight, so this is a genuine fresh start: the caller has
      // evidence the server is answering (an RPC just did, or the app came
      // back), which is exactly the situation the accumulated backoff was a
      // guess about and is now wrong about.
      attempt = 0;
      void connect();
    },
    streaming: () => streaming
  };
}
