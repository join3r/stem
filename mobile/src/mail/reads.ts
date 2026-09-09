import type { MailListResult } from '@shared/types';
import { mailUnread } from './list';

/** Opening a conversation acknowledges existing unread mail. Later refreshes
 * acknowledge new replies only while visible, and respect explicit unread
 * decisions made on any device (the desktop follows the same rule). */
export function createMailReadTracker(markRead: (id: string) => Promise<unknown>) {
  let id: string | null = null;
  let opening = false;
  let preserveUnread = false;
  let generation = 0;
  const pending = new Set<string>();
  return {
    focus(conversationId: string): void {
      id = conversationId;
      opening = true;
      preserveUnread = false;
      generation += 1;
    },
    blur(): void {
      id = null;
      generation += 1;
    },
    preserveUnread(): void {
      // Set before the RPC, so a mail:changed response arriving before navigation
      // finishes cannot turn the user's own Mark unread back into Mark read.
      preserveUnread = true;
      opening = false;
    },
    update(mail: MailListResult, foreground: boolean): void {
      if (!id || !foreground || preserveUnread) return;
      const conversation = mail.conversations.find((c) => c.id === id);
      if (!conversation) return; // The first load may not have arrived yet.
      const wasOpening = opening;
      opening = false;
      if (!mailUnread(conversation, mail)) return;
      if (!wasOpening && mail.inbox.entries[id]?.forcedUnread) return;
      const key = `${generation}:${id}:${conversation.userUpdatedAt}`;
      if (pending.has(key)) return;
      pending.add(key);
      const requestGeneration = generation;
      void markRead(id).catch(() => {
        // A failed initial acknowledgement can be retried by a later refresh
        // or foreground event, including an initially forced-unread row.
        if (generation === requestGeneration && wasOpening) opening = true;
      }).finally(() => pending.delete(key));
    }
  };
}
