// The Inbox's pinned Return-to-chat shortcut: the explicit-pointer state machine
// (set only by open/create with the Inbox selected, cleared only by dismiss /
// delete / orphan), its localStorage persistence, and the resolver that turns
// the persisted id into a row (or an orphan verdict) against the live chat list.
import { describe, expect, it } from 'vitest';
import {
  RETURN_CHAT_KEY,
  persistReturnChatId,
  readReturnChatId,
  resolveReturnChat,
  returnChatIdOnDelete,
  returnChatIdOnOpen,
  returnChatTitle,
  type StorageLike
} from '../../src/renderer/chats/return-chat';
import type { ChatSummary } from '../../src/shared/types';

function fakeStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k)
  };
}

const brokenStorage: StorageLike = {
  getItem: () => {
    throw new Error('quota');
  },
  setItem: () => {
    throw new Error('quota');
  },
  removeItem: () => {
    throw new Error('quota');
  }
};

function chat(threadId: string, title = 'A chat', subject?: string): ChatSummary {
  return { threadId, title, subject, folderId: null, createdAt: 1, updatedAt: 1 };
}

describe('return-chat state transitions', () => {
  it('opening a chat with the Inbox selected sets and replaces the target', () => {
    expect(returnChatIdOnOpen(null, 't1', true)).toBe('t1');
    expect(returnChatIdOnOpen('t1', 't2', true)).toBe('t2');
  });

  it('opening a chat from the Chats tab leaves the target untouched', () => {
    expect(returnChatIdOnOpen(null, 't1', false)).toBeNull();
    expect(returnChatIdOnOpen('t1', 't2', false)).toBe('t1');
  });

  it('deleting the target clears it; deleting any other chat does not', () => {
    expect(returnChatIdOnDelete('t1', 't1')).toBeNull();
    expect(returnChatIdOnDelete('t1', 't2')).toBe('t1');
    expect(returnChatIdOnDelete(null, 't1')).toBeNull();
  });
});

describe('return-chat persistence', () => {
  it('round-trips the id and removes the key on null', () => {
    const storage = fakeStorage();
    persistReturnChatId('t1', storage);
    expect(storage.map.get(RETURN_CHAT_KEY)).toBe('t1');
    expect(readReturnChatId(storage)).toBe('t1');
    persistReturnChatId(null, storage);
    expect(storage.map.has(RETURN_CHAT_KEY)).toBe(false);
    expect(readReturnChatId(storage)).toBeNull();
  });

  it('storage that refuses to answer costs the memory, never a throw', () => {
    expect(readReturnChatId(brokenStorage)).toBeNull();
    expect(() => persistReturnChatId('t1', brokenStorage)).not.toThrow();
    expect(() => persistReturnChatId(null, brokenStorage)).not.toThrow();
  });
});

describe('resolveReturnChat', () => {
  const base = { chatsLoaded: true, activeThreadId: null, mailPaneOpen: false };

  it('no target → no row, not orphaned', () => {
    expect(resolveReturnChat({ ...base, returnChatId: null, chats: [chat('t1')] })).toEqual({
      row: null,
      orphaned: false
    });
  });

  it('before the first list arrives the row hides but the id is NOT orphaned', () => {
    expect(
      resolveReturnChat({ ...base, returnChatId: 't1', chats: [], chatsLoaded: false })
    ).toEqual({ row: null, orphaned: false });
  });

  it('a listed target resolves to a row', () => {
    const res = resolveReturnChat({ ...base, returnChatId: 't1', chats: [chat('t1', 'Trip plan')] });
    expect(res.orphaned).toBe(false);
    expect(res.row).toEqual({ threadId: 't1', title: 'Trip plan', current: false });
  });

  it('a target missing from the loaded list is orphaned', () => {
    expect(resolveReturnChat({ ...base, returnChatId: 'gone', chats: [chat('t1')] })).toEqual({
      row: null,
      orphaned: true
    });
  });

  it('membership is the only test — an archived-but-listed chat still resolves', () => {
    // Archiving lives in the inbox state, not in chats:list membership, so the
    // resolver never sees it; a listed chat is an openable chat.
    const res = resolveReturnChat({ ...base, returnChatId: 't1', chats: [chat('t1')] });
    expect(res.row?.threadId).toBe('t1');
  });

  it('is current only while the target IS the centre pane (active chat, no mail over it)', () => {
    const chats = [chat('t1')];
    const at = (activeThreadId: string | null, mailPaneOpen: boolean) =>
      resolveReturnChat({ ...base, returnChatId: 't1', chats, activeThreadId, mailPaneOpen }).row
        ?.current;
    expect(at('t1', false)).toBe(true);
    expect(at('t1', true)).toBe(false); // a mail view covers the chat
    expect(at('t2', false)).toBe(false);
    expect(at(null, false)).toBe(false);
  });

  it('titles the row subject-first with an untitled fallback', () => {
    expect(returnChatTitle({ title: 'raw', subject: 'Neat subject' })).toBe('Neat subject');
    expect(returnChatTitle({ title: 'raw' })).toBe('raw');
    expect(returnChatTitle({ title: '  ', subject: '  ' })).toBe('Untitled chat');
    const res = resolveReturnChat({ ...base, returnChatId: 't1', chats: [chat('t1', '  ')] });
    expect(res.row?.title).toBe('Untitled chat');
  });
});
