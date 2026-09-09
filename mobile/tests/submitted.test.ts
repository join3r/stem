import { afterEach, expect, it } from 'vitest';
import type { ChatMessage } from '@shared/types';
import { acknowledgeSubmittedThread, clearSubmittedThreads, onSubmittedThreadRejected, rejectSubmittedThread, retainSubmittedThread, takeSubmittedThread } from '../src/chat/submitted';
afterEach(clearSubmittedThreads);
const message = (id: string): ChatMessage => ({ id, role: 'user', content: 'Pending question', runtimeTurnId: id, pendingHistory: true });
it('keeps the exact optimistic identity available across navigation and repeated mounts', () => {
  const sent = message('first');
  retainSubmittedThread('thread', sent);
  expect(takeSubmittedThread('thread')).toBe(sent);
  expect(takeSubmittedThread('thread')).toBe(sent);
  acknowledgeSubmittedThread('thread', sent.id);
  expect(takeSubmittedThread('thread')).toBeUndefined();
});
it('cannot remove a newer pending record from an old rejection or acknowledgement', () => {
  retainSubmittedThread('thread', message('old'));
  const newer = message('new');
  retainSubmittedThread('thread', newer);
  rejectSubmittedThread('thread', 'old');
  acknowledgeSubmittedThread('thread', 'old');
  expect(takeSubmittedThread('thread')).toBe(newer);
});
it('notifies a remounted view when its pending send fails', () => {
  const rejected: string[] = [];
  const off = onSubmittedThreadRejected((threadId, id) => rejected.push(`${threadId}:${id}`));
  retainSubmittedThread('thread', message('sent'));
  rejectSubmittedThread('thread', 'sent');
  expect(takeSubmittedThread('thread')).toBeUndefined();
  expect(rejected).toEqual(['thread:sent']);
  off();
});
