import type { ChatMessage, MessageAttachment } from '@shared/types';

const submitted = new Map<string, ChatMessage>();
/** Transfer the accepted new-chat prompt across route replacement. */
export function seedSubmittedThread(threadId: string, text: string, runtimeTurnId?: string, attachments?: MessageAttachment[]): void {
  submitted.set(threadId, {
    id: `user-submitted-${runtimeTurnId ?? Date.now()}`, role: 'user', content: text,
    turnId: runtimeTurnId, runtimeTurnId, pendingHistory: true,
    createdAt: new Date().toISOString(), ...(attachments?.length ? { attachments } : {})
  });
}
export function takeSubmittedThread(threadId: string): ChatMessage | undefined {
  const message = submitted.get(threadId);
  return message;
}

export function retainSubmittedThread(threadId: string, message: ChatMessage): void {
  submitted.set(threadId, message);
}
export function acknowledgeSubmittedThread(threadId: string, messageId?: string): void {
  if (messageId !== undefined && submitted.get(threadId)?.id !== messageId) return;
  submitted.delete(threadId);
}
const rejectedListeners = new Set<(threadId: string, messageId: string) => void>();
export function onSubmittedThreadRejected(listener: (threadId: string, messageId: string) => void): () => void {
  rejectedListeners.add(listener);
  return () => { rejectedListeners.delete(listener); };
}
export function rejectSubmittedThread(threadId: string, messageId: string): void {
  if (submitted.get(threadId)?.id !== messageId) return;
  submitted.delete(threadId);
  rejectedListeners.forEach((listener) => listener(threadId, messageId));
}

/** A client turn identity is bookkeeping, not an authentication secret. */
export function newSubmittedTurnId(): string {
  return globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (letter) => {
    const value = Math.floor(Math.random() * 16);
    return (letter === 'x' ? value : (value & 3) | 8).toString(16);
  });
}

export function clearSubmittedThreads(): void { submitted.clear(); }
