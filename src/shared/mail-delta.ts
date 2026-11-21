import type { MailListResult } from './types';

// Mail by the conversation, not by the store.
//
// The whole mail store was 1.6 MB by November 2026, and every mail write used
// to send all of it to the desktop: each mutator answers with the full list,
// and each mail:changed made the desktop fetch mail:list again. A working
// persona writes many times a minute, so the user's own Send queued behind
// stacks of whole-store downloads (tens of seconds on the VPS).
//
// Every mail write touches known conversations (workspace/mail.ts tracks
// them), so the answer can carry just those: a DELTA is a MailListResult whose
// `delta.conversationIds` names the conversations it speaks for. For each named
// id, the delta's conversation and items replace what the client holds, and a
// named id the delta does not carry was deleted. Inbox state and `sys` ride
// whole (small). A result with no `delta` is the full list, as always.
//
// Skew-safe both ways: an old server never sends `delta`, so a new client
// replaces as before; an old client never asks for one (the transport slices
// a mutator's answer only for a caller that sends `x-stem-mail: delta`, and
// only mail:conversations, which an old client never calls, answers a delta
// unasked).

/** The request header a client sends to get mail answers as deltas. */
export const MAIL_DELTA_HEADER = 'x-stem-mail';
export const MAIL_DELTA_VALUE = 'delta';

/** True for a mail result that names the conversations it changed. */
export function isMailResult(value: unknown): value is MailListResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<MailListResult>;
  return Array.isArray(v.conversations) && Array.isArray(v.items) && !!v.inbox && typeof v.inbox === 'object';
}

/** The part of a full result that `ids` covers, marked as a delta for them. */
export function sliceMailResult(full: MailListResult, ids: readonly string[]): MailListResult {
  const want = new Set(ids);
  return {
    conversations: full.conversations.filter((c) => want.has(c.id)),
    items: full.items.filter((i) => want.has(i.conversationId)),
    inbox: full.inbox,
    ...(full.sys ? { sys: full.sys } : {}),
    delta: { conversationIds: [...want] }
  };
}

/** Fold a server answer into what the client holds: a delta merges, a full list replaces. */
export function mergeMailResult(prev: MailListResult, next: MailListResult): MailListResult {
  const ids = next.delta?.conversationIds;
  if (!ids) return next;
  const named = new Set(ids);
  // Only what the delta names counts, so an answer that carries more than it
  // names can never duplicate a conversation the client already holds.
  const fresh = new Map(next.conversations.filter((c) => named.has(c.id)).map((c) => [c.id, c]));
  // Keep each conversation where it was (a replaced one stays in place, a new
  // one goes on the end, a deleted one leaves), the store's own order.
  const conversations = prev.conversations.flatMap((c) => {
    if (!named.has(c.id)) return [c];
    const replacement = fresh.get(c.id);
    fresh.delete(c.id);
    return replacement ? [replacement] : [];
  });
  conversations.push(...fresh.values());
  const items = prev.items
    .filter((i) => !named.has(i.conversationId))
    .concat(next.items.filter((i) => named.has(i.conversationId)));
  return { conversations, items, inbox: next.inbox, ...(next.sys ?? prev.sys ? { sys: next.sys ?? prev.sys } : {}) };
}
