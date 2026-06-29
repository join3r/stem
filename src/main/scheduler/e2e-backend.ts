import { EventEmitter } from 'node:events';
import type { ChatBackend } from '../backend/types';
import type { ChatSummary, StartTurnInput, StartTurnResult } from '../../shared/types';
import { readTasks } from '../workspace/tasks';

// Hermetic backend for the scheduler under STEM_E2E. The real pi backend can't
// dispatch a turn without a live pi process, so E2E specs normally seed only
// non-due tasks. This shim lets an e2e seed a DUE task and watch it fire through
// the real store → scheduler → IPC → renderer path: startTurn immediately emits a
// `turn/completed` so waitForSettle resolves, and listThreads reports every seeded
// task's thread as existing (so the thread-deleted guard doesn't trip).
//
// The scheduler only ever touches startTurn / listThreads / on / off, so the rest
// of the ChatBackend surface is left unimplemented (cast below).
class E2ESchedulerBackend extends EventEmitter {
  private seq = 0;

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const turnId = `e2e-turn-${++this.seq}`;
    // Settle on the next tick so the scheduler has returned from startTurn and
    // attached its waitForSettle listener before the completion lands.
    setImmediate(() =>
      this.emit('event', {
        method: 'turn/completed',
        params: { threadId: input.threadId, turn: { id: turnId } },
        receivedAt: 0
      })
    );
    return { threadId: input.threadId, turnId };
  }

  async listThreads(): Promise<ChatSummary[]> {
    const tasks = await readTasks();
    return tasks.map((t) => ({
      threadId: t.threadId,
      title: t.title ?? '',
      folderId: null,
      createdAt: 0,
      updatedAt: 0
    }));
  }
}

export function createE2ESchedulerBackend(): ChatBackend {
  return new E2ESchedulerBackend() as unknown as ChatBackend;
}
