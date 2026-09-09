// One state update per frame instead of one per token — the phone's copy of
// src/renderer/eventBatcher.ts.
//
// The problem is the same on both clients: a streaming turn produces
// `item/agentMessage/delta` events faster than any UI wants to re-render, and
// applying each one is a React commit per token. So deltas for a thread are
// concatenated into a buffer and applied once per tick; every OTHER event is
// applied immediately, after synchronously flushing that thread's buffer, so
// the order a screen sees (delta → item/completed → turn/*) is exactly the order
// the wire had. Getting that backwards would let a turn settle before its last
// tokens land, and the missing tail would never be re-sent.
//
// WHAT DIFFERS FROM THE DESKTOP'S, and why: the desktop schedules on
// requestAnimationFrame and falls back to a timer when `document.hidden`,
// because rAF stops firing on an occluded window. React Native has rAF too and
// it has the same property — it is driven by the frame loop, so it stalls when
// the app is not drawing — but there is no `document.hidden` to ask, and the
// state it stalls in (backgrounded on iOS) is one where the JS thread may be
// suspended entirely and then resumed. A frame callback queued before the
// suspension is not a thing to reason about. A timer is: it fires on the next
// tick the runtime gives us, whenever that is, and one tick's worth of tokens is
// not a rendering problem when nobody is looking at the screen.
//
// The scheduler is injected so the tests here need neither.

import type { AgentMessageDeltaParams, BackendEventEnvelope } from '@shared/types';

interface DeltaBuffer {
  turnId: string;
  itemId: string;
  delta: string;
  offset?: number;
  receivedAt: string;
}

export interface EventBatcher {
  push(event: BackendEventEnvelope): void;
  /** Apply every buffered delta right now. Used when tearing down a screen, so
   * tokens already delivered are not lost with the subscription. */
  flush(): void;
}

/** Queue `run` for the next tick and answer with the way to cancel it. */
export type Scheduler = (run: () => void) => () => void;

/** ~60fps. Close enough to a frame that the stream reads as continuous. */
const FRAME_MS = 16;

const timerScheduler: Scheduler = (run) => {
  const handle = setTimeout(run, FRAME_MS);
  return () => clearTimeout(handle);
};

export function createEventBatcher(
  apply: (event: BackendEventEnvelope) => void,
  schedule: Scheduler = timerScheduler
): EventBatcher {
  const buffers = new Map<string, DeltaBuffer>();
  let cancel: (() => void) | null = null;

  function flushThread(threadId: string): void {
    const buf = buffers.get(threadId);
    if (!buf) return;
    buffers.delete(threadId);
    const params: AgentMessageDeltaParams = {
      threadId,
      turnId: buf.turnId,
      itemId: buf.itemId,
      delta: buf.delta,
      ...(buf.offset === undefined ? {} : { offset: buf.offset })
    };
    apply({ method: 'item/agentMessage/delta', params, receivedAt: buf.receivedAt });
  }

  function flushAll(): void {
    if (cancel) {
      cancel();
      cancel = null;
    }
    for (const threadId of [...buffers.keys()]) flushThread(threadId);
  }

  return {
    push(event: BackendEventEnvelope): void {
      if (event.method === 'item/agentMessage/delta') {
        const p = event.params as AgentMessageDeltaParams;
        const buf = buffers.get(p.threadId);
        if (buf && buf.turnId === p.turnId && (buf.offset === undefined && p.offset === undefined || buf.offset !== undefined && p.offset === buf.offset + buf.delta.length)) {
          buf.delta += p.delta;
          buf.receivedAt = event.receivedAt;
        } else {
          // A different turn started streaming into this thread mid-tick: the old
          // buffer's tokens belong to the older bubble and must land first.
          if (buf) flushThread(p.threadId);
          buffers.set(p.threadId, {
            turnId: p.turnId,
            itemId: p.itemId,
            delta: p.delta,
            offset: p.offset,
            receivedAt: event.receivedAt
          });
        }
        if (!cancel) {
          cancel = schedule(() => {
            cancel = null;
            flushAll();
          });
        }
        return;
      }
      const threadId = (event.params as { threadId?: string } | undefined)?.threadId;
      // A thread-scoped event flushes its own thread; a thread-less one
      // (process/exit) flushes everything, because it says something about state
      // that every buffer is behind on.
      if (threadId) flushThread(threadId);
      else flushAll();
      apply(event);
    },
    flush: flushAll
  };
}
