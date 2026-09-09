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
  onMailChanged,
  onMailReceived,
  createConversation,
  deleteConversation,
  mailSessionThreadIds,
  readMail,
  setConversationSession,
  setConversationStatus,
  setConversationSubject,
  setMailArchived,
  setMailItemResult,
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
  it('a conversation composed private keeps the flag through the file; an ordinary one carries none', async () => {
    const secret = await createConversation('hush', ['verifier'], '', { private: true });
    const open = await createConversation('open', ['verifier']);
    expect(secret.private).toBe(true);
    expect('private' in open).toBe(false);
    const { conversations } = await readMail();
    expect(conversations.find((c) => c.id === secret.id)?.private).toBe(true);
    expect(conversations.find((c) => c.id === open.id)?.private).toBeUndefined();
    // A stored value other than exactly `true` (a hand edit) does not make a conversation private.
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.conversations.find((c: { id: string }) => c.id === open.id).private = 'yes';
    writeFileSync(path, JSON.stringify(raw));
    expect((await readMail()).conversations.find((c) => c.id === open.id)?.private).toBeUndefined();
  });

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

  it('stamps every appended item and the list with the system version; a mangled stamp is dropped on read', async () => {
    const c = await createConversation('ver', ['normal']);
    await appendMailItem({ conversationId: c.id, from: 'user', to: ['normal'], body: 'x' });
    await appendMailItem({ conversationId: c.id, from: 'normal', to: ['user'], body: 'y' });
    const list = await readMail();
    // Under vitest nothing inlines a build-time value, so every hash reads 'unbuilt' —
    // the shape is what matters: three hashes, no build, on both items and the list.
    const unbuilt = { persona: 'unbuilt', skills: 'unbuilt', memory: 'unbuilt' };
    expect(list.sys).toEqual(unbuilt);
    expect(list.items.map((i) => i.sys)).toEqual([unbuilt, unbuilt]);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.items[0].sys = { persona: 'only' };
    delete raw.items[1].sys;
    writeFileSync(path, JSON.stringify(raw), 'utf8');
    const { items } = await readMail();
    expect(items.map((i) => 'sys' in i)).toEqual([false, false]);
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

  it('a read queued before a status write sees the status on file, not the one coming', async () => {
    const c = await createConversation('s', ['normal']);
    await setConversationStatus(c.id, 'working');
    // The read is queued first, so it must serve the file as it stands:
    // 'working'. The bug was the live flag dropping at call time, ahead of the
    // write, so this read coerced the stored 'working' to idle — the mail
    // router's failure reply sat on file under an idle row for one poll.
    const read = readMail();
    const write = setConversationStatus(c.id, 'failed');
    expect((await read).conversations[0].status).toBe('working');
    expect((await write).conversations[0].status).toBe('failed');
    expect((await readMail()).conversations[0].status).toBe('failed');
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

describe('subject hygiene', () => {
  it('createConversation cleans a markup-laden subject and keeps a clean one verbatim', async () => {
    await createConversation('Weekly digest <!--stem:mail from=user-->scaffolding<!--/stem:mail-->', ['normal']);
    await createConversation('Check **the** `feed`', ['normal']);
    await createConversation('Plain subject', ['normal']);
    const { conversations } = await readMail();
    expect(conversations.map((c) => c.subject)).toEqual(['Weekly digest', 'Check the feed', 'Plain subject']);
  });

  it('a blank subject derives one from the first mail body', async () => {
    const c = await createConversation('', ['normal'], 'Book the June flights\nand a hotel');
    expect(c.subject).toBe('Book the June flights');
    // Nothing to derive from either (attachments-only mail): the explicit shrug.
    const empty = await createConversation('', ['normal']);
    expect(empty.subject).toBe('(no subject)');
  });

  it('heals a dirty stored subject on read: markup-only re-derives from the first user mail', async () => {
    const c = await createConversation('placeholder', ['normal']);
    await appendMailItem({ conversationId: c.id, from: 'normal', to: ['user'], body: 'internal note' });
    await appendMailItem({ conversationId: c.id, from: 'user', to: ['normal'], body: 'Investigate the failing deploy' });
    // An older server (or the leak itself) wrote the raw envelope into the store.
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.conversations[0].subject = '<!--stem:mail from=user-->\nThis is a mail delivery in the conversation';
    writeFileSync(path, JSON.stringify(raw), 'utf8');
    // The interior is scaffolding, so the clean is empty — the subject comes
    // from the first USER mail, not the personas' internal traffic.
    expect((await readMail()).conversations[0].subject).toBe('Investigate the failing deploy');
  });

  it('heals a dirty stored subject on read: leaked markdown is stripped in place', async () => {
    await createConversation('placeholder', ['normal']);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.conversations[0].subject = '## **Deploy** update <!--stem:scheduled at="2026-08-';
    writeFileSync(path, JSON.stringify(raw), 'utf8');
    expect((await readMail()).conversations[0].subject).toBe('Deploy update');
    // Healing is idempotent: the healed subject survives a second read (and
    // the write-back every mutator's round-trip performs) unchanged.
    await setMailRead([(await readMail()).conversations[0].id], true);
    expect((await readMail()).conversations[0].subject).toBe('Deploy update');
  });

  it('healing skips mails whose body derives to nothing (attachments-only)', async () => {
    const c = await createConversation('placeholder', ['normal']);
    await appendMailItem({
      conversationId: c.id,
      from: 'user',
      to: ['normal'],
      body: '',
      attachments: [{ kind: 'image', name: 'photo.png' }]
    });
    await appendMailItem({ conversationId: c.id, from: 'user', to: ['normal'], body: 'Frame the photo' });
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.conversations[0].subject = '<!--stem:mail from=user-->';
    writeFileSync(path, JSON.stringify(raw), 'utf8');
    expect((await readMail()).conversations[0].subject).toBe('Frame the photo');
  });

  it('leaves a stored literal (no subject) alone rather than re-deriving it', async () => {
    const c = await createConversation('', ['normal']);
    await appendMailItem({ conversationId: c.id, from: 'user', to: ['normal'], body: 'late body' });
    expect((await readMail()).conversations[0].subject).toBe('(no subject)');
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


describe('mail observers', () => {
  it('a scheduled result joins its notification and re-bolds the conversation, without a second arrival', async () => {
    const received: string[] = [];
    const offReceived = onMailReceived((item) => received.push(item.body));
    try {
      const c = await createConversation('First headline', ['normal']);
      await appendMailItem({ conversationId: c.id, from: 'task:t1', to: ['user'], body: 'One draft is ready in this chat.', taskId: 't1', subject: 'First headline', at: 1_000 });
      let { conversations, items } = await readMail();
      expect(items[0].subject).toBe('First headline');
      // The user read the one-line notice before the drafts landed.
      await setMailRead([c.id], true);
      expect(isUnread({ threadId: c.id, updatedAt: conversations[0].userUpdatedAt }, (await readMail()).inbox)).toBe(false);
      // Strictly after the read stamp: on a warm runner the read and the
      // result otherwise share a millisecond and the re-bold never shows.
      await new Promise((resolve) => setTimeout(resolve, 2));
      await setMailItemResult(items[0].id, '## Draft\n\nHi Josefine…');
      await setConversationSubject(c.id, 'Second headline');
      ({ conversations, items } = await readMail());
      expect(items[0].result).toBe('## Draft\n\nHi Josefine…');
      expect(conversations[0].subject).toBe('Second headline');
      expect(conversations[0].userUpdatedAt).toBeGreaterThan(1_000);
      expect(isUnread({ threadId: c.id, updatedAt: conversations[0].userUpdatedAt }, (await readMail()).inbox)).toBe(true);
      expect(received).toEqual(['One draft is ready in this chat.']);
      await expect(setMailItemResult('missing', 'x')).rejects.toThrow(/no longer exists/);
    } finally { offReceived(); }
  });

  it('announces durable triage writes and only newly appended user-addressed mail', async () => {
    let changes = 0;
    const received: string[] = [];
    const off = onMailChanged(() => { changes += 1; });
    const offReceived = onMailReceived((item) => received.push(item.body));
    try {
      const c = await createConversation('A test', ['normal']);
      await appendMailItem({ conversationId: c.id, from: 'user', to: ['normal'], body: 'question' });
      await appendMailItem({ conversationId: c.id, from: 'normal', to: ['helper'], body: 'internal' });
      await appendMailItem({ conversationId: c.id, from: 'normal', to: ['user'], body: 'answer' });
      await setMailRead([c.id], true);
      await setMailArchived([c.id], true);
      expect(changes).toBe(6);
      expect(received).toEqual(['answer']);
      await readMail();
      expect(received).toEqual(['answer']);
      await expect(appendMailItem({ conversationId: 'missing', from: 'normal', to: ['user'], body: 'failed' })).rejects.toThrow();
      expect(received).toEqual(['answer']);
      expect(changes).toBe(6);
    } finally { off(); offReceived(); }
  });
});
