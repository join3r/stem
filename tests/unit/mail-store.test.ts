// The mail store — exercises the REAL file at the throwaway path the unit-test
// STEM_STATE_DIR provides. Covers conversation/item append semantics (the
// activity clocks), triage keyed by conversation, deletion, corrupt-file
// degradation, and that the shared inbox derivations apply unchanged.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  appendMailItem,
  createConversation,
  deleteConversation,
  mailSessionThreadIds,
  readMail,
  setConversationSession,
  setConversationStatus,
  setMailArchived,
  setMailRead,
  setMailSnooze
} from '../../src/server/workspace/mail';
import { mailStorePath } from '../../src/server/workspace/paths';
import { isUnread, placement } from '../../src/shared/inbox';

const path = mailStorePath();

beforeEach(() => {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
});
afterEach(() => {
  rmSync(path, { force: true });
});

describe('conversations and items', () => {
  it('appends items and stamps the activity clocks by addressee', async () => {
    const conversation = await createConversation('Build the thing', ['code-stem']);
    await appendMailItem({ conversationId: conversation.id, from: 'user', to: ['code-stem'], body: 'go' });
    let { conversations } = await readMail();
    // A user→persona mail moves updatedAt but NOT userUpdatedAt: nothing new
    // for the user to read, so the row must not go bold over their own send.
    expect(conversations[0].updatedAt).toBeGreaterThan(0);
    expect(conversations[0].userUpdatedAt).toBe(0);
    expect(conversations[0].exchangeCount).toBe(0);

    await appendMailItem({ conversationId: conversation.id, from: 'code-stem', to: ['user'], body: 'done' });
    ({ conversations } = await readMail());
    expect(conversations[0].userUpdatedAt).toBe(conversations[0].updatedAt);

    // Persona→persona traffic counts against the exchange cap; user-addressed
    // mail never does.
    await appendMailItem({ conversationId: conversation.id, from: 'code-stem', to: ['verifier'], body: 'check' });
    ({ conversations } = await readMail());
    expect(conversations[0].exchangeCount).toBe(1);
    expect((await readMail()).items).toHaveLength(3);
  });

  it('records sessions and lists their thread ids for the chat-list filter', async () => {
    const c = await createConversation('s', ['normal']);
    await setConversationSession(c.id, 'normal', 'thread-9');
    expect(await mailSessionThreadIds()).toEqual(new Set(['thread-9']));
  });

  it('never persists a working status across a reload', async () => {
    const c = await createConversation('s', ['normal']);
    await setConversationStatus(c.id, 'working');
    const { conversations } = await readMail();
    expect(conversations[0].status).toBe('idle');
  });

  it('deletes a conversation with its items and triage state, returning its threads', async () => {
    const c = await createConversation('s', ['normal']);
    await setConversationSession(c.id, 'normal', 'thread-1');
    await appendMailItem({ conversationId: c.id, from: 'user', to: ['normal'], body: 'x' });
    await setMailArchived([c.id], true);
    const { result, threadIds } = await deleteConversation(c.id);
    expect(threadIds).toEqual(['thread-1']);
    expect(result.conversations).toHaveLength(0);
    expect(result.items).toHaveLength(0);
    expect(result.inbox.entries[c.id]).toBeUndefined();
  });
});

describe('triage (shared inbox semantics over userUpdatedAt)', () => {
  async function conversationRow() {
    const { conversations, inbox } = await readMail();
    const c = conversations[0];
    return { subject: { threadId: c.id, updatedAt: c.userUpdatedAt }, inbox };
  }

  it('a reply to the user resurrects an archived conversation', async () => {
    const c = await createConversation('s', ['normal']);
    await appendMailItem({ conversationId: c.id, from: 'normal', to: ['user'], body: 'first' });
    await setMailArchived([c.id], true);
    let row = await conversationRow();
    expect(placement(row.subject, row.inbox, Date.now())).toBe('archived');

    await appendMailItem({ conversationId: c.id, from: 'normal', to: ['user'], body: 'more' });
    row = await conversationRow();
    expect(placement(row.subject, row.inbox, Date.now())).toBe('inbox');
  });

  it('persona-internal traffic does NOT resurrect or unbold', async () => {
    const c = await createConversation('s', ['normal', 'verifier']);
    await appendMailItem({ conversationId: c.id, from: 'normal', to: ['user'], body: 'reply' });
    await setMailRead([c.id], true);
    await setMailArchived([c.id], true);
    await appendMailItem({ conversationId: c.id, from: 'normal', to: ['verifier'], body: 'psst' });
    const row = await conversationRow();
    expect(placement(row.subject, row.inbox, Date.now())).toBe('archived');
    expect(isUnread(row.subject, row.inbox)).toBe(false);
  });

  it('unread follows user-addressed mail, and read/snooze mirror the chat inbox', async () => {
    const c = await createConversation('s', ['normal']);
    await appendMailItem({ conversationId: c.id, from: 'normal', to: ['user'], body: 'reply' });
    let row = await conversationRow();
    expect(isUnread(row.subject, row.inbox)).toBe(true);
    await setMailRead([c.id], true);
    row = await conversationRow();
    expect(isUnread(row.subject, row.inbox)).toBe(false);

    const wake = Date.now() + 60_000;
    await setMailSnooze([c.id], wake);
    row = await conversationRow();
    expect(placement(row.subject, row.inbox, Date.now())).toBe('snoozed');
    expect(placement(row.subject, row.inbox, wake + 1)).toBe('inbox');
  });
});

describe('degradation', () => {
  it('serves an empty store from a corrupt file without rewriting it', async () => {
    writeFileSync(path, '{ not json', 'utf8');
    const { conversations } = await readMail();
    expect(conversations).toHaveLength(0);
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
    // …and refuses to write over it.
    await expect(createConversation('s', ['normal'])).rejects.toThrow();
  });

  it('drops items whose conversation is gone', async () => {
    const c = await createConversation('s', ['normal']);
    await appendMailItem({ conversationId: c.id, from: 'user', to: ['normal'], body: 'x' });
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.conversations = [];
    writeFileSync(path, JSON.stringify(raw), 'utf8');
    expect((await readMail()).items).toHaveLength(0);
  });
});
