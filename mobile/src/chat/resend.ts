import type { ChatMessage } from '@shared/types';

/** Only offer the latest failed/interrupted text turn; never drop attachments. */
export function messageToResend(messages: ChatMessage[]): ChatMessage | null {
  const notice = messages.at(-1);
  if (notice?.role !== 'system' || !notice.turnId) return null;
  for (let i = messages.length - 2; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    return (message.turnId === notice.turnId || message.runtimeTurnId === notice.turnId) && message.content.trim() && !message.attachments?.length
      ? message
      : null;
  }
  return null;
}
