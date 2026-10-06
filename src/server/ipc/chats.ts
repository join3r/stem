import { removeThreadDrafts } from '../skills/record-drafts';
import { degrade } from '../degrade';
import { registerServer } from './guard';
import type { IpcDeps } from './deps';
import { searchChats, searchChatsLexical } from '../chatsearch/search';
import { reindexChatThread, dropChatThread } from '../chatsearch/index-sync';
import { copyThreadScratch, deleteThreadScratch } from '../exec/scratch';
import { copyPinsToFork, dropThreadPins, listPins } from '../pins/store';
import { forkAnchors } from './pins';
import {
  createFolder,
  deleteFolder,
  getAssignments,
  getChatFormat,
  copyChatPrivacyToFork,
  getPlainChats,
  getPrivateChats,
  getSubjects,
  listFolders,
  getFilingState,
  moveFolder,
  queueRefile,
  removeChat,
  renameFolder,
  setChatFolder,
  setChatFormat,
  updateFolder
} from '../workspace/chats';
import { IDLE_MS } from '../chats/autofile';
import { faviconFor } from '../chats/favicon';
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
import type { ChatListResult, FolderSettings } from '../../shared/types';

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

/**
 * The sidebar payload: every chat the list shows, merged with its folder,
 * subject, privacy and format, plus the folder tree and Inbox state. Exported for the
 * idle-chat filer, which has to see exactly the chats the user sees.
 */
export async function chatListOf(deps: Pick<IpcDeps, 'runtime' | 'scheduler'>): Promise<ChatListResult> {
  const [allChats, folders, assignments, subjects, privateChats, plainChats, inbox, mailThreads] = await Promise.all([
    deps.runtime().listThreads(),
    listFolders(),
    getAssignments(),
    getSubjects(),
    getPrivateChats(),
    getPlainChats(),
    readInbox(),
    // The hidden persona sessions behind mail conversations, and the threads
    // scheduled runs left behind on their mail, are backend threads like any
    // other — the Inbox shows them as mail, so the chat list must not show
    // them again as chats.
    mailSessionThreadIds()
  ]);
  // A scheduled run in flight is on no mail yet; its thread is hidden all the same.
  const running = deps.scheduler()?.activeRunThreadId() ?? null;
  const chats = allChats.filter((chat) => !mailThreads.has(chat.threadId) && chat.threadId !== running);
  const valid = new Set(folders.map((f) => f.id));
  for (const chat of chats) {
    const folderId = assignments[chat.threadId];
    chat.folderId = folderId && valid.has(folderId) ? folderId : null;
    const subject = subjects[chat.threadId];
    if (subject) chat.subject = subject;
    if (privateChats.has(chat.threadId)) chat.private = true;
    if (plainChats.has(chat.threadId)) chat.format = 'md';
    // A write nobody should notice (a no-op rename; historically a silent
    // scheduled run) still moved the file's mtime. List the chat as of the last
    // write that meant something, so it stays where the user left it — see
    // shared/inbox.ts.
    chat.updatedAt = listedUpdatedAt(chat, inbox);
  }
  // The runtime sorted by real mtime; the listed stamps above can move a chat
  // back weeks (quiet windows from before runs had their own threads). Sort by what is shown,
  // or the client's date headers ("Previous 7 Days", "Yesterday", "Previous
  // 7 Days" again) follow the mtime order while the labels follow the stamp.
  chats.sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt));
  return { chats, folders, inbox };
}

export function registerChatsIpc(deps: IpcDeps): void {
  const chatList = (): Promise<ChatListResult> => chatListOf(deps);

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
    // Which of the board's pins the fork keeps depends on the turns it keeps —
    // read off the original before forking, while it is still the active
    // session (the fork's own file only appears on its first append).
    // An unreadable pins database must not stop the fork itself.
    let hasPins = false;
    try {
      hasPins = listPins(threadId).length > 0;
    } catch (err) {
      degrade('chats', 'forked a chat without its pinboard', err);
    }
    const anchors = hasPins
      ? await deps.runtime().readThread(threadId).then(
          (t) => forkAnchors(t.messages, turnId),
          (err) => {
            degrade('chats', 'forked a chat keeping only its notes, not its pinned messages', err);
            return new Set<string>();
          }
        )
      : null;
    const forked = await deps.runtime().forkThread(threadId, turnId);
    // Privacy first, and fail closed: an unmarked fork of a private chat would
    // capture its next turn. The fork has no file until its first append, so a
    // fork refused here is simply never seen.
    await copyChatPrivacyToFork(threadId, forked.threadId).catch((err) => {
      degrade('chats', 'refused a fork whose privacy marks could not be copied', err);
      throw new Error(`Could not fork this chat: ${err instanceof Error ? err.message : String(err)}`);
    });
    // A fork carries on the conversation it copied, in the format it was in;
    // left unmarked, a Markdown chat's fork would quietly become MDX.
    if ((await getChatFormat(threadId)) === 'md') {
      await setChatFormat(forked.threadId, 'md').catch((err) =>
        degrade('chats', 'forked a Markdown chat as MDX', err)
      );
    }
    if (anchors) {
      try {
        if (copyPinsToFork(threadId, forked.threadId, anchors) > 0) deps.emit('pins:changed', { threadId: forked.threadId });
      } catch (err) {
        // The fork is real either way; it just opens with an empty board.
        degrade('chats', 'forked a chat without its pinboard', err);
      }
    }
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
    // where it was, with whatever read/archive/snooze standing it had.
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
    // Scheduled tasks created here survive: they only remember this chat as
    // where they were scheduled from, and run in threads of their own.
    await Promise.all([
      deps.runtime().deleteThread(threadId),
      removeChat(threadId),
      // A recording's draft cards are the chat's too.
      removeThreadDrafts(threadId),
      // The board goes with its chat. Synchronous and local; wrapped so a
      // failure surfaces like the rest rather than skipping the others.
      Promise.resolve().then(() => dropThreadPins(threadId)),
      removeInboxEntry(threadId),
      // The chat's scratch folder goes with it — that is the whole point of
      // keeping scratch per chat (see server/exec/scratch.ts).
      deleteThreadScratch(threadId)
    ]);
    dropChatThread(threadId); // forget it from the search index
  });
  // Switch an existing chat between MDX and plain Markdown. The format picks the
  // system prompt the chat's worker is spawned with, so the next turn runs on a
  // worker of the other kind (see acquireWorker in pi/runtime.ts); messages
  // already written keep rendering as they are.
  registerServer('chats:setFormat', async (_e, threadId: string, format: 'md' | 'mdx') => {
    await setChatFormat(threadId, format === 'md' ? 'md' : 'mdx');
    return chatList();
  });
  // The Sources panel's site icons, fetched here because neither the renderer's
  // CSP nor the phone should reach arbitrary sites (see chats/favicon.ts).
  registerServer('sources:favicon', (_e, host: string) => faviconFor(host));
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
    // Other windows and devices hold their own copy of the list: the Quick Chat
    // overlay stamps its thread read while the main window's sidebar still shows
    // it bold, and the phone does the same for chats read on the Mac.
    deps.emit('chats:changed', undefined);
    return chatList();
  });
  registerServer('inbox:markAllRead', async () => {
    // Stamp against the threads the backend actually has, so a chat mid-creation
    // (not yet listed) isn't silently marked read before the user ever sees it.
    await markAllRead(await deps.runtime().listThreads());
    return chatList();
  });

  registerServer(
    'folders:create',
    async (_e, name: string, parentId: string | null, settings?: Omit<FolderSettings, 'name'> | null) => {
      await createFolder(name, parentId, settings ? folderSettingsOf({ name, ...settings }) : undefined);
      return chatList();
    }
  );
  registerServer('folders:update', async (_e, folderId: string, settings: FolderSettings) => {
    await updateFolder(folderId, folderSettingsOf(settings));
    return chatList();
  });
  // "Move older chats too": every chat at root that has sat idle for a day gets
  // one more look, whatever an earlier sweep decided — except chats the user
  // placed, which queueRefile skips under the lock.
  registerServer('folders:includeOldChats', async (_e, folderId: string) => {
    const [list, state] = await Promise.all([chatList(), getFilingState()]);
    const idleBefore = Date.now() - IDLE_MS;
    const idle = list.chats
      .filter((c) => c.folderId === null && !c.private && toMs(c.updatedAt) <= idleBefore && state.filing[c.threadId] !== 'user')
      .map((c) => c.threadId);
    await queueRefile(folderId, idle);
    deps.scheduleAutoFile();
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

/** The dialog's answer as a typed shape: the guard checked it is an object, not what is in it. */
function folderSettingsOf(raw: FolderSettings): FolderSettings {
  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    description: typeof raw.description === 'string' ? raw.description.slice(0, 2_000) : '',
    autoFile: raw.autoFile === true
  };
}
