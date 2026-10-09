import type { MailItem, MailWorkGroup } from '../../shared/types';
import { groupMailTimeline } from './grouping';

// How a mail conversation reads: newest on top, like the Inbox. Each mail the
// user sent or received is one entry; the persona↔persona mails that led to a
// reply fold onto it ("Consulted Verifier · 2 mails"), and the finished work
// behind it hangs off it too. Work still running belongs to the live card, and
// work no mail can claim folds into one "Earlier work" line. Pure, so the
// view's grouping is unit-tested apart from React.

export interface ThreadEntry {
  item: MailItem;
  /** The persona↔persona mails exchanged before this one, oldest first. */
  exchange: MailItem[];
  /** Finished work this mail made (or, with no reply yet, that it started). */
  work: MailWorkGroup[];
}

export interface ThreadLayout {
  /** Newest first. */
  entries: ThreadEntry[];
  /** Persona↔persona mails after the newest entry: consulting still under way. */
  trailingExchange: MailItem[];
  /** Work with a run still going — shown on the live card. */
  liveWork: MailWorkGroup[];
  /** Work no mail in this conversation can claim. */
  unlinkedWork: MailWorkGroup[];
  /** Entries shown open by default; the rest fold to one line. */
  defaultOpen: Set<string>;
}

export function layoutThread(mails: MailItem[], work: MailWorkGroup[]): ThreadLayout {
  const sorted = [...mails].sort((a, b) => a.at - b.at);
  const entries: ThreadEntry[] = [];
  let pending: MailItem[] = [];
  for (const group of groupMailTimeline(sorted)) {
    if (group.kind === 'exchange') {
      pending.push(...group.items);
      continue;
    }
    entries.push({ item: group.item, exchange: pending, work: [] });
    pending = [];
  }

  // Any item id → the entry it belongs to (exchange mails belong to the reply they led to).
  const entryOf = new Map<string, number>();
  entries.forEach((entry, i) => {
    entryOf.set(entry.item.id, i);
    for (const x of entry.exchange) entryOf.set(x.id, i);
  });

  const liveWork: MailWorkGroup[] = [];
  const unlinkedWork: MailWorkGroup[] = [];
  for (const group of work) {
    if (group.runs.some((run) => run.status === 'running')) {
      liveWork.push(group);
      continue;
    }
    const anchor = group.notificationItemId ?? group.sourceItemId;
    const at = anchor === undefined ? undefined : entryOf.get(anchor);
    if (at === undefined) {
      unlinkedWork.push(group);
      continue;
    }
    entries[replyTo(entries, at)].work.push(group);
  }

  const defaultOpen = new Set<string>();
  const newest = entries[entries.length - 1];
  if (newest) defaultOpen.add(newest.item.id);
  for (let i = entries.length - 1; i >= 0; i--) {
    const item = entries[i].item;
    if (item.from !== 'user' && item.to.includes('user')) {
      defaultOpen.add(item.id);
      break;
    }
  }
  for (const entry of entries) if (entry.item.approval?.status === 'pending') defaultOpen.add(entry.item.id);

  return { entries: entries.reverse(), trailingExchange: pending, liveWork, unlinkedWork, defaultOpen };
}

/**
 * Work started by the user's mail at `at` is shown on the reply it produced:
 * the first persona mail after it, before the user wrote again. No reply yet
 * (or a run that failed silently) keeps it on the user's own mail.
 */
function replyTo(entries: ThreadEntry[], at: number): number {
  if (entries[at].item.from !== 'user') return at;
  for (let j = at + 1; j < entries.length; j++) {
    if (entries[j].item.from === 'user') break;
    return j;
  }
  return at;
}

/** "Consulted Verifier · 2 mails": who the reply's author talked to, and how much. */
export function exchangeLabel(exchange: MailItem[], author: string, name: (id: string) => string): string {
  const others = new Set<string>();
  for (const m of exchange) {
    for (const id of [m.from, ...m.to]) if (id !== author && id !== 'user') others.add(id);
  }
  const who = others.size ? [...others] : [...new Set(exchange.map((m) => m.from))];
  const n = exchange.length;
  return `Consulted ${who.map(name).join(', ')} · ${n} ${n === 1 ? 'mail' : 'mails'}`;
}
