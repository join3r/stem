// Mail drafts: one reply draft per conversation (never shared between them),
// one New mail draft, persisted without pasted bytes.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAIL_DRAFTS_KEY,
  EMPTY_COMPOSE,
  freshCompose,
  pruneReplyDrafts,
  rememberRecipients,
  readComposeDraft,
  readReplyDraft,
  resetMailDrafts,
  subscribeMailDrafts,
  writeComposeDraft,
  writeReplyDraft
} from '../../src/renderer/mail/mail-drafts';

function fakeStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k)
  };
}

let storage = fakeStorage();
beforeEach(() => {
  storage = fakeStorage();
  resetMailDrafts(storage);
});

describe('mail drafts', () => {
  it('keeps each conversation’s reply draft to itself', () => {
    writeReplyDraft('a', { text: 'for a', attachments: [] });
    expect(readReplyDraft('a').text).toBe('for a');
    expect(readReplyDraft('b').text).toBe('');
  });

  it('an emptied reply draft is forgotten', () => {
    writeReplyDraft('a', { text: 'x', attachments: [] });
    writeReplyDraft('a', { text: '  ', attachments: [] });
    expect(JSON.parse(storage.data.get(MAIL_DRAFTS_KEY)!).replies).toEqual({});
  });

  it('survives a restart, minus pasted bytes', () => {
    writeReplyDraft('a', {
      text: 'see files',
      attachments: [
        { name: 'shot.png', dataBase64: 'AAAA', mime: 'image/png' },
        { name: 'plan.pdf', path: '/tmp/plan.pdf' }
      ]
    });
    resetMailDrafts(storage);
    expect(readReplyDraft('a')).toEqual({ text: 'see files', attachments: [{ name: 'plan.pdf', path: '/tmp/plan.pdf' }] });
  });

  it('To and Private alone do not make a New mail draft', () => {
    writeComposeDraft({ ...EMPTY_COMPOSE, to: ['normal', 'verifier'], private: true });
    expect(readComposeDraft()).toBeNull();
    writeComposeDraft({ ...EMPTY_COMPOSE, body: 'Find me a desk' });
    expect(readComposeDraft()?.body).toBe('Find me a desk');
    writeComposeDraft(null);
    expect(readComposeDraft()).toBeNull();
  });

  it('notifies subscribers and prunes drafts of deleted conversations', () => {
    let calls = 0;
    subscribeMailDrafts(() => (calls += 1));
    writeReplyDraft('a', { text: 'x', attachments: [] });
    writeReplyDraft('gone', { text: 'y', attachments: [] });
    pruneReplyDrafts(new Set(['a']));
    expect(readReplyDraft('gone').text).toBe('');
    expect(readReplyDraft('a').text).toBe('x');
    expect(calls).toBe(3);
  });

  it('a fresh New mail goes to whoever the last one went to, across a restart', () => {
    expect(freshCompose().to).toEqual(['normal']);
    rememberRecipients(['verifier', 'normal']);
    resetMailDrafts(storage);
    expect(freshCompose().to).toEqual(['verifier', 'normal']);
    // A deleted persona drops out; nobody left falls back to the default.
    expect(freshCompose(new Set(['normal'])).to).toEqual(['normal']);
    expect(freshCompose(new Set(['other'])).to).toEqual(['normal']);
  });
});
