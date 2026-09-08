import { degrade } from '../degrade';
import { registerServer } from './guard';
import type { IpcDeps } from './deps';
import { searchChats, searchChatsLexical } from '../chatsearch/search';
import { reindexChatThread, dropChatThread } from '../chatsearch/index-sync';
import { copyThreadScratch, deleteThreadScratch } from '../exec/scratch';
import {
  createFolder,
  deleteFolder,
  getAssignments,
  getPrivateChats,
  getSubjects,
  listFolders,
  moveFolder,
  removeChat,
  renameFolder,
  setChatFolder
} from '../workspace/chats';
import {
  markAllRead,
  noteSilentRun,
  readInbox,
  removeInboxEntry,
  setArchived,
  setRead,
  setSnooze
} from '../workspace/inbox';
import { listedUpdatedAt, toMs } from '../../shared/inbox';
import { mailSessionThreadIds } from '../workspace/mail';
import { memoryRunOf } from '../workspace/settings';
import type { LlmClient } from '../recall/llm';
import type { ChatListResult } from '../../shared/types';

/**
 * Chats + chat folders. Chats come from the backend's thread store;
 * folders/assignments from the Stem store. Merged here so the runtime stays
 * backend-only and the store stays backend-unaware. (`chats:open` stays in
 * index.ts — it has to let the client complete a Quick Chat hand-off before the
 * read, which is a composition-root concern.)
 */
/**
 * Ceiling on the query-expansion completion behind chats:search. The user is
 * waiting on a search box, so a slow (or wedged) memory model must degrade to
 * the same-language results chats:searchFast already painted rather than hold
 * the cross-language superset back indefinitely.
 */
const CHAT_SEARCH_COMPLETION_TIMEOUT_MS = 4_000;

/**
 * How far past the rename's own write its quiet window reaches. pi appends the
 * session_info entry before answering, so the mtime is already final when the
 * thread list is re-read; the grace covers a filesystem that rounds mtimes up.
 */
const RENAME_GRACE_MS = 2_000;

export function registerChatsIpc(deps: IpcDeps): void {
  const chatList = async (): Promise<ChatListResult> => {
    const [allChats, folders, assignments, subjects, privateChats, inbox, mailThreads] = await Promise.all([
      deps.runtime().listThreads(),
      listFolders(),
      getAssignments(),
      getSubjects(),
      getPrivateChats(),
      readInbox(),
      // The hidden persona sessions behind mail conversations are backend
      // threads like any other — the Inbox shows them as mail, so the chat
      // list must not show them again as chats.
      mailSessionThreadIds()
    ]);
    const chats = allChats.filter((chat) => !mailThreads.has(chat.threadId));
    const valid = new Set(folders.map((f) => f.id));
    for (const chat of chats) {
      const folderId = assignments[chat.threadId];
      chat.folderId = folderId && valid.has(folderId) ? folderId : null;
      const subject = subjects[chat.threadId];
      if (subject) chat.subject = subject;
      if (privateChats.has(chat.threadId)) chat.private = true;
      // A write nobody should notice (a silent scheduled run, a no-op rename)
      // still moved the file's mtime. List the chat as of the last write that
      // meant something, so it stays where the user left it — see shared/inbox.ts.
      chat.updatedAt = listedUpdatedAt(chat, inbox);
    }
    return { chats, folders, inbox };
  };

  registerServer('chats:list', () => chatList());
  // Cross-language chat search: expand the query across Slovak+English (via the same
  // hidden LlmClient seam as recall), then match the dedicated FTS5 chat index. The
  // LLM is used regardless of the memory toggle — this is a foreground, user-initiated
  // search, not background capture — and degrades to same-language search if it fails.
  // Instant same-language results (no LLM) — the renderer shows these first, then swaps
  // in the cross-language superset from chats:search when expansion resolves.
  registerServer('chats:searchFast', (_e, query: string) =>
    searchChatsLexical(query, { llm: null, listChats: () => deps.runtime().listThreads() })
  );
  registerServer('chats:search', (_e, query: string) => {
    // Reuse the hidden one-shot seam (on the memory model) for query expansion.
    const llm: LlmClient = {
      complete: async (prompt) =>
        deps.runtime().complete(prompt, {
          ...(await memoryRunOf((s) => s.memory.model)),
          timeoutMs: CHAT_SEARCH_COMPLETION_TIMEOUT_MS
        })
    };
    return searchChats(query, { llm, listChats: () => deps.runtime().listThreads() });
  });
  registerServer('chats:rollbackToTurn', (_e, threadId: string, turnId: string) =>
    deps.runtime().rollbackToTurn(threadId, turnId)
  );
  registerServer('chats:forkThread', async (_e, threadId: string, turnId: string) => {
    const forked = await deps.runtime().forkThread(threadId, turnId);
    // The fork's history already talks about files the original built, so give it
    // a copy of them — otherwise its first act is to look for something it can
    // see itself creating. Best-effort: a fork whose files didn't copy is still
    // a fork worth having.
    await copyThreadScratch(threadId, forked.threadId).catch((err) =>
      // The fork opens looking exactly like a good one, and the first thing the
      // assistant does in it is fail to find a file its own transcript says it
      // wrote a moment ago.
      degrade('chats', 'forked a chat without a copy of its scratch files', err)
    );
    return forked;
  });
  registerServer('chats:rename', async (_e, threadId: string, name: string) => {
    const before = (await deps.runtime().listThreads()).find((t) => t.threadId === threadId);
    // The sidebar's rename field commits on blur, so opening Rename and clicking
    // away asks for the name the chat already has. Writing it would append a
    // session_info entry all the same, and the bumped mtime would drag the chat
    // to the top of the list, bold — a "new message" nobody wrote.
    if (before && before.title === name.trim()) return;
    await deps.runtime().renameThread(threadId, name);
    // The title is indexed for search too — reflect the new name right away.
    void reindexChatThread(deps.runtime(), threadId);
    // A real rename is the user's own doing, not new activity: keep the chat
    // where it was, with whatever read/archive/snooze standing it had. Same
    // absorber a silent scheduled run gets, for the same reason.
    if (before) {
      const after = (await deps.runtime().listThreads()).find((t) => t.threadId === threadId);
      const at = Math.max(Date.now(), toMs(after?.updatedAt ?? 0)) + RENAME_GRACE_MS;
      await noteSilentRun(threadId, before.updatedAt, at).catch((err) =>
        degrade('chats', 'left a renamed chat looking like it had a new message', err)
      );
    }
  });
  registerServer('chats:delete', async (_e, threadId: string) => {
    // Independent stores (pi session file vs. folder-assignment JSON) — run concurrently.
    // Also drop any scheduled tasks bound to this chat (they'd otherwise run into a
    // missing thread; the scheduler guards against that too, but cleaning up is tidier).
    await Promise.all([
      deps.runtime().deleteThread(threadId),
      removeChat(threadId),
      removeInboxEntry(threadId),
      // The chat's scratch folder goes with it — that is the whole point of
      // keeping scratch per chat (see server/exec/scratch.ts).
      deleteThreadScratch(threadId),
      deps.scheduler()?.removeForThread(threadId) ?? Promise.resolve()
    ]);
    dropChatThread(threadId); // forget it from the search index
  });
  registerServer('chats:setFolder', async (_e, threadId: string, folderId: string | null) => {
    await setChatFolder(threadId, folderId);
    return chatList();
  });
  // "Write a subject" on a row. Threads name themselves on their own schedule;
  // this is the explicit ask, so it runs whatever the mode is, reads the whole
  // thread rather than only what is new, and is allowed to replace a name the
  // user typed. Awaited (unlike the automatic path) because the user pressed a
  // button and is waiting for the row to change.
  registerServer('chats:writeSubject', async (_e, threadId: string) => {
    const subject = await deps.runtime().writeThreadSubject(threadId, true);
    // A rename went through the same path chats:rename uses, so the search
    // index needs the same nudge.
    if (subject) void reindexChatThread(deps.runtime(), threadId);
    return chatList();
  });

  // Inbox state. Each returns the fresh list so the renderer applies one payload
  // rather than re-fetching — the same contract the folder mutators use.
  registerServer('inbox:setArchived', async (_e, threadIds: string[], archived: boolean) => {
    await setArchived(threadIds, archived);
    return chatList();
  });
  registerServer('inbox:snooze', async (_e, threadIds: string[], until: number | null) => {
    await setSnooze(threadIds, until ?? null);
    return chatList();
  });
  registerServer('inbox:setRead', async (_e, threadIds: string[], read: boolean) => {
    // Hand setRead the threads' own mtimes so a stamp lands at least on the mtime
    // (clock skew on a networked home dir) — the markAllRead guard, per-thread.
    const updatedAt = read
      ? new Map((await deps.runtime().listThreads()).map((t) => [t.threadId, t.updatedAt]))
      : undefined;
    await setRead(threadIds, read, updatedAt);
    return chatList();
  });
  registerServer('inbox:markAllRead', async () => {
    // Stamp against the threads the backend actually has, so a chat mid-creation
    // (not yet listed) isn't silently marked read before the user ever sees it.
    await markAllRead(await deps.runtime().listThreads());
    return chatList();
  });

  registerServer('folders:create', async (_e, name: string, parentId: string | null) => {
    await createFolder(name, parentId);
    return chatList();
  });
  registerServer('folders:rename', async (_e, folderId: string, name: string) => {
    await renameFolder(folderId, name);
    return chatList();
  });
  registerServer('folders:delete', async (_e, folderId: string) => {
    await deleteFolder(folderId);
    return chatList();
  });
  registerServer('folders:move', async (_e, folderId: string, parentId: string | null) => {
    await moveFolder(folderId, parentId);
    return chatList();
  });
}
