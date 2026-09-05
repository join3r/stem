import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@shared/types';
import { applyBackendEventToThread, EMPTY_STATE } from '@shared/chatState';
import { messageToResend } from '../src/chat/resend';
import { applyStartTurnResult } from '../src/chat/turns';

const user: ChatMessage = { id: 'u1', role: 'user', content: 'My question', turnId: 'turn1' };
const notice: ChatMessage = { id: 's1', role: 'system', content: 'Interrupted', turnId: 'turn1' };

describe('restoring an interrupted prompt', () => {
  it('offers recovery even when interruption arrives before the send acknowledgement', () => {
    const pending = { ...EMPTY_STATE, running: true, messages: [{ ...user, turnId: undefined }] };
    const stopped = applyBackendEventToThread(pending, {
      method: 'turn/aborted',
      params: { threadId: 'thread1', turn: { id: 'turn1' } },
      receivedAt: '2026-09-05T05:31:52.007Z'
    })!;
    expect(messageToResend(stopped.messages)).toBeNull();
    const acknowledged = applyStartTurnResult(stopped, { turnId: 'turn1' }, user.id).state;
    expect(acknowledged.running).toBe(false);
    expect(messageToResend(acknowledged.messages)?.content).toBe(user.content);
  });

  it('finds the prompt after a partial answer as well as an empty one', () => {
    expect(messageToResend([user, notice])).toBe(user);
    expect(messageToResend([user, { id: 'a1', role: 'assistant', content: 'Partial' }, notice])).toBe(user);
  });

  it('never restores an older prompt over a newer conversation', () => {
    expect(messageToResend([user, notice, { ...user, id: 'u2', turnId: 'turn2' }])).toBeNull();
    expect(messageToResend([user, { ...user, id: 'u2', turnId: 'turn2' }, notice])).toBeNull();
    expect(messageToResend([user, { ...notice, turnId: undefined }])).toBeNull();
  });

  it('does not silently resend text without its attachment', () => {
    expect(messageToResend([{ ...user, attachments: [{ kind: 'image', name: 'photo.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' }] }, notice])).toBeNull();
  });
});
