/**
 * The chat to open once the open one is archived, so archiving walks the list
 * like a mail client: the row below it, or the row above when it was the last.
 * `order` is the list as the Chats tab shows it, top to bottom; `removed` are
 * the chats leaving it (the whole selection when several go at once). Null when
 * nothing is left to open, or the open chat isn't on screen to have neighbours.
 */
export function chatAfterArchive(order: readonly string[], activeId: string, removed: readonly string[]): string | null {
  const at = order.indexOf(activeId);
  if (at === -1) return null;
  const gone = new Set(removed);
  for (let i = at + 1; i < order.length; i++) if (!gone.has(order[i])) return order[i];
  for (let i = at - 1; i >= 0; i--) if (!gone.has(order[i])) return order[i];
  return null;
}
