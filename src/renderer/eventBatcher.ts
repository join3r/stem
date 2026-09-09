import type { AgentMessageDeltaParams, BackendEventEnvelope } from '../shared/types';

// Coalesces streamed `item/agentMessage/delta` events so the renderer applies one
// state update per animation frame instead of one per token. Every other event is
// applied immediately — after synchronously flushing any buffered delta for its
// thread, so ordering (delta → item/completed → turn/*) is preserved exactly.

interface DeltaBuffer {
  turnId: string;
  itemId: string;
  delta: string;
  offset?: number;
  receivedAt: string;
}

export interface EventBatcher {
  push(event: BackendEventEnvelope): void;
  /** Synchronously apply every buffered delta — used before reading a state
   * snapshot that must include everything already delivered (e.g. the Quick
   * Chat handoff), since a delta can sit buffered for up to one frame. */
  flush(): void;
}

export function createEventBatcher(apply: (event: BackendEventEnvelope) => void): EventBatcher {
  const buffers = new Map<string, DeltaBuffer>();
  let handle: number | null = null;
  let handleIsRaf = false;

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
    if (handle !== null) {
      if (handleIsRaf) cancelAnimationFrame(handle);
      else window.clearTimeout(handle);
      handle = null;
    }
    for (const threadId of [...buffers.keys()]) flushThread(threadId);
  }

  function schedule(): void {
    if (handle !== null) return;
    // rAF stalls while the window is hidden/occluded — fall back to a timer there
    // so background threads keep streaming into state.
    if (document.hidden) {
      handleIsRaf = false;
      handle = window.setTimeout(() => {
        handle = null;
        flushAll();
      }, 40);
    } else {
      handleIsRaf = true;
      handle = requestAnimationFrame(() => {
        handle = null;
        flushAll();
      });
    }
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
          // A different turn started streaming on this thread mid-frame: flush the
          // old buffer first so its tokens land before the new turn's.
          if (buf) flushThread(p.threadId);
          buffers.set(p.threadId, {
            turnId: p.turnId,
            itemId: p.itemId,
            delta: p.delta,
            offset: p.offset,
            receivedAt: event.receivedAt
          });
        }
        schedule();
        return;
      }
      const threadId = (event.params as { threadId?: string } | undefined)?.threadId;
      // Thread-scoped events flush that thread's buffer; global events (process/exit)
      // flush everything so downstream state is fully caught up before they apply.
      if (threadId) flushThread(threadId);
      else flushAll();
      apply(event);
    },
    flush(): void {
      flushAll();
    }
  };
}
