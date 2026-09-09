import { isUnread, placement } from '@shared/inbox';
import type { MailConversation, MailItem, MailListResult, Persona } from '@shared/types';

export type MailFolder = 'inbox' | 'sent' | 'snoozed' | 'archived';
export const MAIL_FOLDERS: MailFolder[] = ['inbox', 'sent', 'snoozed', 'archived'];
export const mailSubject = (c: MailConversation) => ({
  threadId: c.id,
  updatedAt: c.userUpdatedAt
});
export const mailUnread = (c: MailConversation, mail: MailListResult): boolean =>
  isUnread(mailSubject(c), mail.inbox);
export const mailName = (personas: Persona[], id: string): string =>
  id === 'user'
    ? 'You'
    : id.startsWith('task:')
      ? 'Scheduled task'
      : (personas.find((p) => p.id === id)?.name ?? id);
export const statusLabel = (c: MailConversation): string =>
  ({
    idle: '',
    working: 'Working',
    'awaiting-user': 'Waiting for you',
    failed: 'Failed',
    aborted: 'Stopped'
  })[c.status];

/** Same placement and Sent semantics as desktop MailList. Internal traffic
 * may update sort order, but cannot create unread mail or resurrect a row. */
export function mailSections(
  mail: MailListResult,
  now: number
): Record<MailFolder, MailConversation[]> {
  const sections: Record<MailFolder, MailConversation[]> = {
    inbox: [],
    sent: [],
    snoozed: [],
    archived: []
  };
  const lastSent = new Map<string, number>();
  for (const item of mail.items)
    if (item.from === 'user')
      lastSent.set(item.conversationId, Math.max(lastSent.get(item.conversationId) ?? 0, item.at));
  for (const c of mail.conversations) {
    const where = placement(mailSubject(c), mail.inbox, now);
    if (where !== 'inbox') sections[where].push(c);
    else if (c.userUpdatedAt > (c.userSentAt ?? 0) || c.status === 'aborted')
      sections.inbox.push(c);
    if (lastSent.has(c.id)) sections.sent.push(c);
  }
  sections.inbox.sort((a, b) => b.updatedAt - a.updatedAt);
  sections.archived.sort((a, b) => b.updatedAt - a.updatedAt);
  sections.snoozed.sort(
    (a, b) =>
      (mail.inbox.entries[a.id]?.snoozedUntil ?? 0) - (mail.inbox.entries[b.id]?.snoozedUntil ?? 0)
  );
  sections.sent.sort((a, b) => lastSent.get(b.id)! - lastSent.get(a.id)!);
  return sections;
}

export function mailPreview(mail: MailListResult, id: string): MailItem | undefined {
  return mail.items
    .filter((i) => i.conversationId === id && (i.to.includes('user') || i.from === 'user'))
    .sort((a, b) => b.at - a.at)[0];
}
