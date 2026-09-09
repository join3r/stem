import type { MailItem, MailWorkGroup } from '@shared/types';

/** Prefer the initiating message; scheduled runs are anchored to their delivered
 * notification. Never infer a request from timing when its source is missing. */
export function partitionMailWork(groups: MailWorkGroup[], items: MailItem[]) {
  const itemIds = new Set(items.map((item) => item.id));
  const byItem = new Map<string, MailWorkGroup[]>();
  const unanchored: MailWorkGroup[] = [];
  for (const group of groups) {
    const anchor = [group.sourceItemId, group.notificationItemId].find(
      (id): id is string => !!id && itemIds.has(id)
    );
    if (anchor) byItem.set(anchor, [...(byItem.get(anchor) ?? []), group]);
    else unanchored.push(group);
  }
  return { byItem, unanchored };
}

function validWorkTime(at: number | undefined): at is number {
  return at !== undefined && Number.isFinite(at) && at > 0 && Number.isFinite(new Date(at).getTime());
}

export function workTimestamp(at: number | undefined, timeOnly = false): string {
  if (!validWorkTime(at)) return 'Time unavailable';
  return timeOnly ? new Date(at).toLocaleTimeString() : new Date(at).toLocaleString();
}

export function workDuration(startedAt: number | undefined, endedAt: number | undefined): string {
  if (!validWorkTime(startedAt) || !validWorkTime(endedAt)) return 'Duration unavailable';
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
