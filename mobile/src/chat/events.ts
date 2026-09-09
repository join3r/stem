import {
  applyBackendEventToThread,
  applyProcessExitToThread,
  backendEventThreadId,
  type ThreadState
} from '@shared/chatState';
import type { BackendEventEnvelope } from '@shared/types';
import { createEventBatcher, type Scheduler } from '../transport/eventBatcher';

/** The mounted thread's event pipeline, also usable without React in tests. */
export function createThreadEvents(options: {
  threadId: string;
  read: () => ThreadState;
  apply: (update: (state: ThreadState) => ThreadState) => void;
  sending: () => boolean;
  refresh: () => void;
  schedule?: Scheduler;
}): { deliver(event: BackendEventEnvelope): void; flush(): void } {
  const batcher = createEventBatcher((event) => {
    const settled = ['turn/completed', 'turn/failed', 'turn/aborted'].includes(event.method);
    const turnId = (event.params as { turn?: { id?: string } } | undefined)?.turn?.id;
    // User-message echoes are not broadcast. A turn started elsewhere needs a
    // history read, including when it ends without a single assistant token.
    const foreign = settled && !options.sending() && !options.read().messages.some(
      (message) => message.role === 'user' && (message.runtimeTurnId ?? message.turnId) === turnId
    );
    options.apply((state) => applyBackendEventToThread(state, event) ?? state);
    if (foreign || (settled && !options.sending() && options.read().messages.some((message) => message.pendingHistory))) options.refresh();
  }, options.schedule);

  return {
    deliver(event) {
      const threadId = backendEventThreadId(event);
      if (event.method === 'process/exit') {
        const params = event.params as { threadId?: string | null } | undefined;
        // A pool worker can exit while idle, or while serving another chat.
        if (params && 'threadId' in params && params.threadId !== options.threadId) return;
        batcher.flush();
        options.apply(applyProcessExitToThread);
        return;
      }
      // Diagnostics such as process/stderr must not silently end a reply.
      if (threadId !== options.threadId) return;
      batcher.push(event);
    },
    flush: batcher.flush
  };
}
