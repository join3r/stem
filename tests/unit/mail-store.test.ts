// The mail store — exercises the REAL file at the throwaway path the unit-test
// STEM_STATE_DIR provides. Covers conversation/item append semantics (the
// activity clocks), triage keyed by conversation, deletion, corrupt-file
// degradation, and that the shared inbox derivations apply unchanged.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  addParticipant,
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

  it('the exchange window: user mail resets the count, and a CC to the user still spends budget', async () => {
    const c = await createConversation('window', ['a', 'b']);
    await appendMailItem({ conversationId: c.id, from: 'a', to: ['b'], body: 'hop' });
    // A persona mail that CCs the user still counts its persona recipients —
    // otherwise CCing the user would launder hops past the runaway guard.
    await appendMailItem({ conversationId: c.id, from: 'b', to: ['a', 'user'], body: 'hop with cc' });
    expect((await readMail()).conversations[0].exchangeCount).toBe(2);
    // The user sending into the conversation buys a fresh window.
    await appendMailItem({ conversationId: c.id, from: 'user', to: ['a', 'b'], body: 'continue' });
    expect((await readMail()).conversations[0].exchangeCount).toBe(0);
  });

  it('stamps userSentAt on user sends — a replied-to conversation is dealt with', async () => {
    const c = await createConversation('s', ['normal']);
    await appendMailItem({ conversationId: c.id, from: 'normal', to: ['user'], body: 'question' });
    let row = (await readMail()).conversations[0];
    // Mail for the user is the latest event: Inbox.
    expect(row.userUpdatedAt).toBeGreaterThan(row.userSentAt);

    await appendMailItem({ conversationId: c.id, from: 'user', to: ['normal'], body: 'answer', at: Date.now() + 10 });
    row = (await readMail()).conversations[0];
    // The user's reply is the latest event: the turn is on the personas.
    expect(row.userSentAt).toBeGreaterThan(row.userUpdatedAt);

    // Persona-internal traffic while working does not hand the turn back…
    await appendMailItem({ conversationId: c.id, from: 'normal', to: ['verifier'], body: 'psst', at: Date.now() + 20 });
    row = (await readMail()).conversations[0];
    expect(row.userSentAt).toBeGreaterThan(row.userUpdatedAt);

    // …but new mail for the user does.
    await appendMailItem({ conversationId: c.id, from: 'normal', to: ['user'], body: 'done', at: Date.now() + 30 });
    row = (await readMail()).conversations[0];
    expect(row.userUpdatedAt).toBeGreaterThan(row.userSentAt);
  });

  it('backfills userSentAt from the items for stores written before the field', async () => {
    const c = await createConversation('s', ['normal']);
    await appendMailItem({ conversationId: c.id, from: 'user', to: ['normal'], body: 'x' });
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    for (const conversation of raw.conversations) delete conversation.userSentAt;
    writeFileSync(path, JSON.stringify(raw), 'utf8');
    const { conversations, items } = await readMail();
    expect(conversations[0].userSentAt).toBe(items[0].at);
  });

  it('addParticipant grows the To: set idempotently', async () => {
    const c = await createConversation('grow', ['secretary']);
    await addParticipant(c.id, 'verifier');
    await addParticipant(c.id, 'verifier');
    expect((await readMail()).conversations[0].participants).toEqual(['secretary', 'verifier']);
  });

  it('display attachments survive the reload coerce; junk entries are dropped', async () => {
    const c = await createConversation('att', ['normal']);
    await appendMailItem({
      conversationId: c.id,
      from: 'user',
      to: ['normal'],
      body: 'see attached',
      attachments: [
        { kind: 'image', name: 'a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,xxxx' },
        { kind: 'file', name: 'b.txt' }
      ]
    });
    expect((await readMail()).items[0].attachments).toEqual([
      { kind: 'image', name: 'a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,xxxx' },
      { kind: 'file', name: 'b.txt' }
    ]);

    // Hand-edited junk in the store must not survive the read.
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.items[0].attachments = [{ kind: 'nope' }, 'garbage', { kind: 'file', name: 'ok.md' }];
    writeFileSync(path, JSON.stringify(raw), 'utf8');
    expect((await readMail()).items[0].attachments).toEqual([{ kind: 'file', name: 'ok.md' }]);
  });

  it('records sessions and lists their thread ids for the chat-list filter', async () => {
    const c = await createConversation('s', ['normal']);
    await setConversationSession(c.id, 'normal', 'thread-9');
    expect(await mailSessionThreadIds()).toEqual(new Set(['thread-9']));
  });

  it('a live working status survives reads and unrelated writes; a stale one reads idle', async () => {
    const c = await createConversation('s', ['normal']);
    await setConversationStatus(c.id, 'working');
    // Reads and unrelated writes re-serialize every conversation — neither may
    // erase a working flag this process still holds (the runaway-thread bug:
    // the store said idle while deliveries ran).
    expect((await readMail()).conversations[0].status).toBe('working');
    await setMailRead([c.id], true);
    expect((await readMail()).conversations[0].status).toBe('working');
    await setConversationStatus(c.id, 'idle');
    expect((await readMail()).conversations[0].status).toBe('idle');

    // A working flag NOT set by this process (a crashed predecessor's leftover)
    // must not spin the row forever: it reads idle.
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.conversations[0].status = 'working';
    writeFileSync(path, JSON.stringify(raw), 'utf8');
    expect((await readMail()).conversations[0].status).toBe('idle');
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

    // An explicit `at` strictly after the archive stamp: on a warm runner the
    // archive and the reply otherwise land in the same millisecond and the
    // resurrect reads as still-archived.
    await appendMailItem({ conversationId: c.id, from: 'normal', to: ['user'], body: 'more', at: Date.now() + 10 });
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
