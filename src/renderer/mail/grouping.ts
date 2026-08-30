import type { MailItem } from '../../shared/types';

/** One rendered stretch of the conversation: a user-visible mail, or a folded exchange. */
export type MailTimelineGroup =
  | { kind: 'mail'; item: MailItem }
  | { kind: 'exchange'; items: MailItem[] };

/**
 * Fold the conversation for reading: mails the user sent or received stand
 * alone; each run of persona↔persona items between them becomes one 'exchange'
 * group (collapsed by default in the view). Pure — unit-tested apart from the
 * component.
 */
export function groupMailTimeline(mails: MailItem[]): MailTimelineGroup[] {
  const groups: MailTimelineGroup[] = [];
  for (const item of mails) {
    const visible = item.from === 'user' || item.to.includes('user');
    if (visible) {
      groups.push({ kind: 'mail', item });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last?.kind === 'exchange') last.items.push(item);
    else groups.push({ kind: 'exchange', items: [item] });
  }
  return groups;
}
