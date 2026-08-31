import type { ChatSummary } from '../../shared/types';

/**
 * The Inbox's pinned "Return to chat" shortcut — an explicit, persisted pointer
 * to the ordinary chat you opened (or created) while the Inbox list was the
 * selected sidebar section, so a trip through your mail always has a way back.
 *
 * Explicit is the contract: the id is written only by that open/create rule,
 * never guessed from recency or activity, and it never expires on its own. It
 * leaves in exactly three ways — replaced by another chat opened the same way,
 * dismissed, or orphaned (its chat deleted or gone from the list). Mail triage,
 * tab switches, reloads and restarts all leave it alone.
 */
export const RETURN_CHAT_KEY = 'stem.inbox.returnChatId';

// Structural, not the DOM's Storage: the unit tests run in Node, where only a
// fake with these three methods exists.
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

// Storage that refuses to answer (locked-down quota, private mode) costs the
// shortcut its memory, never the navigation — the useRememberedTab stance.
export function readReturnChatId(storage: StorageLike = localStorage): string | null {
  try {
    return storage.getItem(RETURN_CHAT_KEY);
  } catch {
    return null;
  }
}

export function persistReturnChatId(id: string | null, storage: StorageLike = localStorage): void {
  try {
    if (id === null) storage.removeItem(RETURN_CHAT_KEY);
    else storage.setItem(RETURN_CHAT_KEY, id);
  } catch {
    // Best-effort: the in-memory value still serves this session.
  }
}

/**
 * Opening or creating a chat with the Inbox selected is the ONLY thing that
 * sets (or replaces) the target. A chat opened from the Chats tab leaves it
 * untouched — the row keeps pointing where the user last left the Inbox from,
 * not wherever they happen to have been most recently.
 */
export function returnChatIdOnOpen(
  current: string | null,
  openedThreadId: string,
  inboxSelected: boolean
): string | null {
  return inboxSelected ? openedThreadId : current;
}

/** A deleted chat can't be returned to; any other delete leaves the target alone. */
export function returnChatIdOnDelete(current: string | null, deletedThreadId: string): string | null {
  return current === deletedThreadId ? null : current;
}

export type ReturnChatRow = {
  threadId: string;
  title: string;
  /** The target IS what the centre pane shows — render as non-actionable "Currently viewing". */
  current: boolean;
};

export type ReturnChatResolution = {
  /** null = nothing to render (no target, list not loaded yet, or orphaned). */
  row: ReturnChatRow | null;
  /** The list has loaded and the target isn't in it — the caller should clear the id. */
  orphaned: boolean;
};

/**
 * Resolve the persisted id against the chat list. Membership is the only test:
 * a listed chat is an openable chat, whatever its inbox placement — archiving
 * never orphans the shortcut. Before the first list arrives nothing is known,
 * so the row stays hidden and the id is NOT judged orphaned (clearing on a
 * still-empty startup list would erase the very persistence being promised).
 */
export function resolveReturnChat(args: {
  returnChatId: string | null;
  chats: readonly ChatSummary[];
  chatsLoaded: boolean;
  activeThreadId: string | null;
  /** Centre pane currently shows mail (open conversation or compose form). */
  mailPaneOpen: boolean;
}): ReturnChatResolution {
  const { returnChatId, chats, chatsLoaded, activeThreadId, mailPaneOpen } = args;
  if (!returnChatId) return { row: null, orphaned: false };
  if (!chatsLoaded) return { row: null, orphaned: false };
  const chat = chats.find((c) => c.threadId === returnChatId);
  if (!chat) return { row: null, orphaned: true };
  return {
    row: {
      threadId: chat.threadId,
      title: returnChatTitle(chat),
      current: activeThreadId === chat.threadId && !mailPaneOpen
    },
    orphaned: false
  };
}

/** The row's title: subject over raw title, with a spoken fallback for a blank one. */
export function returnChatTitle(chat: Pick<ChatSummary, 'title' | 'subject'>): string {
  return chat.subject?.trim() || chat.title.trim() || 'Untitled chat';
}
