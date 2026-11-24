// Mail by the conversation (shared/mail-delta.ts): every store write names the
// conversations it touched, mail:changed carries them, and a client folds a
// delta into what it holds. Against the REAL store file at the unit-test
// STEM_STATE_DIR, like mail-store.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  appendMailItem,
  createConversation,
  deleteConversation,
  mailResultTouched,
  onMailChanged,
  readMail,
  readMailConversations,
  setConversationStatus,
  setMailRead,
  settleMailApproval
} from '../../src/server/workspace/mail';
import { mailStorePath } from '../../src/server/workspace/paths';
import { mergeMailResult, sliceMailResult } from '../../src/shared/mail-delta';
import type { MailListResult } from '../../src/shared/types';

const path = mailStorePath();

beforeEach(() => {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
});
afterEach(() => {
  rmSync(path, { force: true });
});

/** What mail:changed announced during `run`. */
async function announced(run: () => Promise<unknown>): Promise<(string[] | null)[]> {
  const heard: (string[] | null)[] = [];
  const off = onMailChanged((ids) => heard.push(ids));
  try {
    await run();
  } finally {
    off();
  }
  return heard;
}

describe('a write names what it touched', () => {
  it('an append, a status flip and a read mark each name their one conversation', async () => {
    const a = await createConversation('a', ['normal']);
    const b = await createConversation('b', ['normal']);
    expect(await announced(() => appendMailItem({ conversationId: a.id, from: 'user', to: ['normal'], body: 'hi' }))).toEqual([[a.id]]);
    expect(await announced(() => setConversationStatus(b.id, 'working'))).toEqual([[b.id]]);
    expect(await announced(() => setMailRead([a.id, b.id], true))).toEqual([[a.id, b.id]]);
    const result = await appendMailItem({ conversationId: b.id, from: 'normal', to: ['user'], body: 'done' });
    expect(mailResultTouched(result)).toEqual([b.id]);
  });

  it('a delete names the conversation it removed', async () => {
    const a = await createConversation('a', ['normal']);
    const heard = await announced(() => deleteConversation(a.id));
    expect(heard).toEqual([[a.id]]);
  });

  it('a write that changes nothing announces nothing and its answer covers no conversation', async () => {
    const a = await createConversation('a', ['normal']);
    const list = await appendMailItem({ conversationId: a.id, from: 'normal', to: ['user'], body: 'x' });
    const itemId = list.items.at(-1)!.id;
    let settled: unknown;
    const heard = await announced(async () => {
      settled = await settleMailApproval(itemId, 'allowed');
    });
    expect(settled).toBeNull();
    expect(heard).toEqual([]);
  });
});

describe('reading some conversations', () => {
  it('answers just the named ones as a delta, and a vanished id comes back absent', async () => {
    const a = await createConversation('a', ['normal']);
    const b = await createConversation('b', ['normal']);
    await appendMailItem({ conversationId: a.id, from: 'user', to: ['normal'], body: 'for a' });
    await appendMailItem({ conversationId: b.id, from: 'user', to: ['normal'], body: 'for b' });
    const delta = await readMailConversations([a.id, 'gone']);
    expect(delta.delta).toEqual({ conversationIds: [a.id, 'gone'] });
    expect(delta.conversations.map((c) => c.id)).toEqual([a.id]);
    expect(delta.items.map((i) => i.body)).toEqual(['for a']);
  });
});

describe('a client folding deltas in', () => {
  it('ends up with exactly what a full read shows, through appends, a new conversation and a delete', async () => {
    const a = await createConversation('a', ['normal']);
    const b = await createConversation('b', ['normal']);
    let held: MailListResult = await readMail();
    const apply = (answer: MailListResult) => {
      const touched = mailResultTouched(answer);
      held = mergeMailResult(held, touched ? sliceMailResult(answer, touched) : answer);
    };
    apply(await appendMailItem({ conversationId: a.id, from: 'user', to: ['normal'], body: 'one' }));
    apply(await appendMailItem({ conversationId: a.id, from: 'normal', to: ['user'], body: 'two' }));
    const c = await createConversation('c', ['normal']);
    apply(await appendMailItem({ conversationId: c.id, from: 'user', to: ['normal'], body: 'three' }));
    apply((await deleteConversation(b.id)).result);
    apply(await setMailRead([a.id], true));

    const full = await readMail();
    const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((x, y) => x.id.localeCompare(y.id));
    expect(byId(held.conversations)).toEqual(byId(full.conversations));
    expect(byId(held.items)).toEqual(byId(full.items));
    expect(held.inbox).toEqual(full.inbox);
    expect(held.delta).toBeUndefined();
  });

  it('a full list replaces, and a delta never duplicates what it did not name', () => {
    const conv = (id: string) => ({ id, subject: id }) as unknown as MailListResult['conversations'][number];
    const item = (id: string, conversationId: string) => ({ id, conversationId }) as unknown as MailListResult['items'][number];
    const inbox = { baseline: 0, entries: {} };
    const prev: MailListResult = { conversations: [conv('a'), conv('b')], items: [item('1', 'a'), item('2', 'b')], inbox };
    // Carries b too, but names only a: b stays as held, once.
    const merged = mergeMailResult(prev, {
      conversations: [conv('a'), conv('b')],
      items: [item('3', 'a'), item('2', 'b')],
      inbox,
      delta: { conversationIds: ['a'] }
    });
    expect(merged.conversations.map((c) => c.id)).toEqual(['a', 'b']);
    expect(merged.items.map((i) => i.id).sort()).toEqual(['2', '3']);
    const full: MailListResult = { conversations: [conv('z')], items: [], inbox };
    expect(mergeMailResult(prev, full)).toBe(full);
  });
});
