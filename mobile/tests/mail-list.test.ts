import { describe, expect, it } from 'vitest';
import type { MailConversation, MailListResult } from '@shared/types';
import { mailPreview, mailSections, mailUnread } from '../src/mail/list';

const NOW = 1_800_000_000_000;
function fixture(overrides: Partial<MailConversation> = {}): MailListResult {
  return {
    conversations: [{ id: 'm', subject: 'Test', participants: ['normal'], sessions: {}, status: 'idle', exchangeCount: 0, sendCounts: {}, updatedAt: NOW, userUpdatedAt: NOW - 100, userSentAt: NOW - 200, createdAt: NOW - 300, ...overrides }],
    items: [{ id: 'q', conversationId: 'm', from: 'user', to: ['normal'], at: NOW - 200, body: 'Question' }, { id: 'a', conversationId: 'm', from: 'normal', to: ['user'], at: NOW - 100, body: 'Answer' }],
    inbox: { baseline: 0, entries: {} }
  };
}

describe('mail folders', () => {
  it('puts replies in Inbox and preserves Sent as all conversations the user sent into', () => {
    const mail = fixture();
    const sections = mailSections(mail, NOW);
    expect(sections.inbox.map((c) => c.id)).toEqual(['m']);
    expect(sections.sent.map((c) => c.id)).toEqual(['m']);
    expect(mailUnread(mail.conversations[0], mail)).toBe(true);
  });
  it('a compose or replied-to conversation waits under Sent; stopped mail surfaces in Inbox', () => {
    const mail = fixture({ userSentAt: NOW, status: 'working' });
    expect(mailSections(mail, NOW).inbox).toEqual([]);
    expect(mailSections(mail, NOW).sent).toHaveLength(1);
    mail.conversations[0].status = 'aborted';
    expect(mailSections(mail, NOW).inbox).toHaveLength(1);
  });
  it('internal messages cannot create unread mail or resurrect archives', () => {
    const mail = fixture({ updatedAt: NOW + 200 });
    mail.inbox.entries.m = { archivedAt: NOW, readAt: NOW };
    mail.items.push({ id: 'internal', conversationId: 'm', from: 'normal', to: ['helper'], at: NOW + 200, body: 'Private work' });
    expect(mailSections(mail, NOW + 200).archived).toHaveLength(1);
    expect(mailUnread(mail.conversations[0], mail)).toBe(false);
    expect(mailPreview(mail, 'm')?.body).toBe('Answer');
  });
  it('snooze expiry and new user-addressed replies return a conversation to Inbox', () => {
    const mail = fixture();
    mail.inbox.entries.m = { snoozedAt: NOW, snoozedUntil: NOW + 1000 };
    expect(mailSections(mail, NOW).snoozed).toHaveLength(1);
    expect(mailSections(mail, NOW + 1000).inbox).toHaveLength(1);
    mail.conversations[0].userUpdatedAt = NOW + 500;
    expect(mailSections(mail, NOW + 500).inbox).toHaveLength(1);
  });
});
