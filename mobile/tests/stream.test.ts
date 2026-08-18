import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveTurn } from '@shared/types';
import {
  createEventStream,
  reconnectDelay,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  STALL_MS,
  type StreamingFetch
} from '../src/transport/stream';

// The reader, driven over a fake socket. Everything a phone's event stream does
// badly happens here on purpose: the server closes it, the connect fails
// outright, the credential is refused, and — the mobile-only one — the socket
// stays open while the network under it is quietly gone.

interface FakeSocket {
  url: string;
  headers: Record<string, string>;
  send(text: string): void;
  end(): void;
  reset(): void;
}

function harness(): {
  fetch: StreamingFetch;
  sockets: FakeSocket[];
  /** How many connects have been ATTEMPTED — sockets counts the ones answered. */
  callCount(): number;
  refuseNext(status: number): void;
  failNext(error: Error): void;
  /** Leave the next connect hanging in the handshake until release() is called. */
  holdNext(): void;
  release(): void;
} {
  const sockets: FakeSocket[] = [];
  let status = 200;
  let thrown: Error | null = null;
  let calls = 0;
  let held: Promise<void> | null = null;
  let releaseHeld: (() => void) | null = null;
  const fetch: StreamingFetch = async (url, init) => {
    calls += 1;
    if (held) {
      const wait = held;
      held = null;
      await wait;
    }
    if (thrown) {
      const error = thrown;
      thrown = null;
      throw error;
    }
    if (status !== 200) {
      const refusal = status;
      status = 200;
      return { status: refusal, body: null };
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      }
    });
    const die = (reason: unknown): void => {
      try {
        controller.error(reason);
      } catch {
        // already closed
      }
    };
    init.signal.addEventListener('abort', () => die(new Error('aborted')));
    sockets.push({
      url,
      headers: init.headers,
      send: (text) => controller.enqueue(new TextEncoder().encode(text)),
      end: () => controller.close(),
      reset: () => die(new Error('connection reset'))
    });
    return { status: 200, body };
  };
  return {
    fetch,
    sockets,
    callCount: () => calls,
    refuseNext: (next) => {
      status = next;
    },
    failNext: (error) => {
      thrown = error;
    },
    holdNext: () => {
      held = new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
    },
    release: () => {
      releaseHeld?.();
      releaseHeld = null;
    }
  };
}

function listeners(): {
  pushes: { channel: string; payload: unknown }[];
  snapshots: LiveTurn[][];
  resyncs: number;
  reachable: boolean[];
  streaming: boolean[];
  refused: number[];
} {
  return { pushes: [], snapshots: [], resyncs: 0, reachable: [], streaming: [], refused: [] };
}

function start(net: ReturnType<typeof harness>, seen = listeners()): { seen: typeof seen; stream: ReturnType<typeof createEventStream> } {
  const stream = createEventStream({
    endpoint: () => ({ serverUrl: 'https://stem.example', token: 'tok' }),
    fetch: net.fetch,
    onPush: (channel, payload) => seen.pushes.push({ channel, payload }),
    onResync: () => {
      seen.resyncs += 1;
    },
    onSnapshot: (liveTurns) => seen.snapshots.push(liveTurns),
    onReachable: (reachable) => seen.reachable.push(reachable),
    onStreaming: (streaming) => seen.streaming.push(streaming),
    onRefused: (status) => seen.refused.push(status)
  });
  stream.start();
  return { seen, stream };
}

/**
 * Let the reader's promises settle without letting its timers fire. Several
 * turns of the microtask queue, because one read of the body is a chain of them
 * and the loop queues the next only once the last has resolved.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(0);
}

describe('createEventStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens /events with the bearer token and no Last-Event-ID on a first connect', async () => {
    const net = harness();
    const { stream } = start(net);
    await settle();
    expect(net.sockets).toHaveLength(1);
    expect(net.sockets[0].url).toBe('https://stem.example/events');
    expect(net.sockets[0].headers.authorization).toBe('Bearer tok');
    expect(net.sockets[0].headers.accept).toBe('text/event-stream');
    expect(net.sockets[0].headers['last-event-id']).toBeUndefined();
    stream.stop();
  });

  it('delivers pushes and resumes from the last id it actually delivered', async () => {
    const net = harness();
    const { seen, stream } = start(net);
    await settle();
    net.sockets[0].send('retry: 3000\n\n');
    net.sockets[0].send('id: e1.4\ndata: {"channel":"chats:changed","payload":null}\n\n');
    net.sockets[0].send('id: e1.5\ndata: {"channel":"backend:event","payload":{"method":"turn/completed"}}\n\n');
    await settle();
    expect(seen.pushes).toEqual([
      { channel: 'chats:changed', payload: null },
      { channel: 'backend:event', payload: { method: 'turn/completed' } }
    ]);

    net.sockets[0].end();
    await vi.advanceTimersByTimeAsync(reconnectDelay(1) + 5);
    expect(net.sockets).toHaveLength(2);
    expect(net.sockets[1].headers['last-event-id']).toBe('e1.5');
    stream.stop();
  });

  it('ignores a frame that is not JSON rather than falling over', async () => {
    const net = harness();
    const { seen, stream } = start(net);
    await settle();
    net.sockets[0].send('id: e1.1\ndata: {"channel":"a"\n\n');
    net.sockets[0].send('id: e1.2\ndata: {"channel":"b","payload":1}\n\n');
    await settle();
    expect(seen.pushes).toEqual([{ channel: 'b', payload: 1 }]);
    stream.stop();
  });

  it('reports the connect snapshot, which is the whole truth about live turns', async () => {
    const net = harness();
    const { seen, stream } = start(net);
    await settle();
    net.sockets[0].send('event: snapshot\ndata: {"liveTurns":[{"threadId":"t1","turnId":"u1"}]}\n\n');
    net.sockets[0].send('event: snapshot\ndata: {"liveTurns":[]}\n\n');
    await settle();
    expect(seen.snapshots).toEqual([[{ threadId: 't1', turnId: 'u1' }], []]);
    stream.stop();
  });

  it('replays the approval cards still waiting, as the pushes they were', async () => {
    const net = harness();
    const { seen, stream } = start(net);
    await settle();
    net.sockets[0].send(
      'event: snapshot\ndata: {"liveTurns":[],"execApprovals":[{"id":"a1","command":"ls -la"},{"id":"a2"},{"command":"no id"}]}\n\n'
    );
    await settle();
    // A card raised while this phone was asleep is answerable now; the one with
    // no id is not a card at all and is dropped rather than queued.
    expect(seen.pushes.map((p) => p.channel)).toEqual([
      'exec:approvalRequest',
      'exec:approvalRequest'
    ]);
    expect((seen.pushes[0].payload as { id: string }).id).toBe('a1');
    stream.stop();
  });

  it('leaves live turns alone when a snapshot carries none', async () => {
    const net = harness();
    const { seen, stream } = start(net);
    await settle();
    net.sockets[0].send('event: snapshot\ndata: {}\n\n');
    await settle();
    expect(seen.snapshots).toHaveLength(0);
    stream.stop();
  });

  it('takes the head from a resync so the next connect does not ask again', async () => {
    const net = harness();
    const { seen, stream } = start(net);
    await settle();
    net.sockets[0].send('id: e1.2\ndata: {"channel":"a","payload":null}\n\n');
    net.sockets[0].send('event: resync\ndata: {"head":"e1.90"}\n\n');
    await settle();
    expect(seen.resyncs).toBe(1);

    net.sockets[0].reset();
    await vi.advanceTimersByTimeAsync(reconnectDelay(1) + 5);
    expect(net.sockets[1].headers['last-event-id']).toBe('e1.90');
    stream.stop();
  });

  it('calls a failed connect — and only that — unreachable', async () => {
    const net = harness();
    net.failNext(new Error('network down'));
    const { seen, stream } = start(net);
    await settle();
    expect(seen.reachable).toEqual([false]);

    await vi.advanceTimersByTimeAsync(reconnectDelay(1) + 5);
    expect(seen.reachable).toEqual([false, true]);
    expect(seen.streaming).toEqual([true]);

    // A stream that ENDS is routine and says nothing about the server being gone.
    net.sockets[0].end();
    await settle();
    expect(seen.reachable).toEqual([false, true]);
    stream.stop();
  });

  it('treats a refusal as the server being up, and says which refusal it was', async () => {
    const net = harness();
    net.refuseNext(401);
    const { seen, stream } = start(net);
    await settle();
    expect(seen.reachable).toEqual([true]);
    expect(seen.refused).toEqual([401]);
    expect(seen.streaming).toEqual([]);
    stream.stop();
  });

  it('backs off between attempts and caps the wait', async () => {
    const net = harness();
    net.failNext(new Error('down'));
    const { stream } = start(net);
    await settle();
    // 250ms is the first wait: nothing before it, a connect right after.
    await vi.advanceTimersByTimeAsync(reconnectDelay(1) - 10);
    expect(net.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(net.sockets).toHaveLength(1);
    stream.stop();

    expect(reconnectDelay(1)).toBe(250);
    expect(reconnectDelay(3)).toBe(1000);
    expect(reconnectDelay(20)).toBe(RECONNECT_MAX_MS);
  });

  it('drops a stream that has gone quiet, and keepalives keep it alive', async () => {
    const net = harness();
    const { seen, stream } = start(net);
    await settle();
    expect(seen.streaming).toEqual([true]);

    // Just under the stall bound, then a keepalive: the timer starts again.
    await vi.advanceTimersByTimeAsync(STALL_MS - 1_000);
    net.sockets[0].send(': keepalive\n\n');
    await settle();
    await vi.advanceTimersByTimeAsync(STALL_MS - 1_000);
    expect(seen.streaming).toEqual([true]);
    expect(net.sockets).toHaveLength(1);

    // Now let it go quiet for good: the reader drops the socket itself and
    // reconnects, which is the only way back from a connection the OS severed
    // without telling either end.
    await vi.advanceTimersByTimeAsync(STALL_MS + reconnectDelay(1) + 50);
    expect(seen.streaming).toEqual([true, false, true]);
    expect(net.sockets).toHaveLength(2);
    stream.stop();
  });

  it('reconnects immediately on wake instead of waiting out the backoff', async () => {
    const net = harness();
    net.failNext(new Error('down'));
    const { stream } = start(net);
    await settle();
    expect(net.sockets).toHaveLength(0);

    stream.retryNow();
    await settle();
    expect(net.sockets).toHaveLength(1);
    stream.stop();
  });

  it('starts the backoff over when an idle wait is cut short', async () => {
    const net = harness();
    net.failNext(new Error('down'));
    const { stream } = start(net);
    await settle();
    expect(net.callCount()).toBe(1);

    // An RPC came back, so the server is answering and the 250ms this was about
    // to spend waiting is a guess we now know to be wrong.
    net.failNext(new Error('still down'));
    stream.retryNow();
    await settle();
    expect(net.callCount()).toBe(2);
    expect(net.sockets).toHaveLength(0);

    // And the count went back to zero with it: the next wait is the base one,
    // not the doubled one two failures would otherwise have earned.
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS + 5);
    expect(net.sockets).toHaveLength(1);
    stream.stop();
  });

  it('leaves a handshake that is merely slow alone, however many RPCs succeed', async () => {
    const net = harness();
    // The /events request goes out and its headers do not come back yet — a
    // phone on a slow link, which is precisely when every screen's RPC is also
    // in flight and about to succeed.
    net.holdNext();
    const { seen, stream } = start(net);
    await settle();
    expect(net.callCount()).toBe(1);
    expect(net.sockets).toHaveLength(0);

    // Each of these used to abort the connect in flight and start another,
    // leaving the badge on "Connecting" for as long as screens kept talking.
    stream.retryNow();
    stream.retryNow();
    await settle();
    expect(net.callCount()).toBe(1);

    net.release();
    await settle();
    expect(net.sockets).toHaveLength(1);
    expect(seen.streaming).toEqual([true]);
    stream.stop();
  });

  it('stops meaning stopped: no reconnect, and the bookmark goes with it', async () => {
    const net = harness();
    const { stream } = start(net);
    await settle();
    net.sockets[0].send('id: e1.9\ndata: {"channel":"a","payload":null}\n\n');
    await settle();

    stream.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(net.sockets).toHaveLength(1);

    stream.start();
    await settle();
    expect(net.sockets).toHaveLength(2);
    expect(net.sockets[1].headers['last-event-id']).toBeUndefined();
    stream.stop();
  });
});
