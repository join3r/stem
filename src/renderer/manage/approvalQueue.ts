export interface ApprovalWithId {
  id: number | string;
}

/** Append once, preserving arrival order for parallel tool approvals. */
export function enqueueApproval<T extends ApprovalWithId>(queue: T[], proposal: T): T[] {
  const id = String(proposal.id);
  return queue.some((p) => String(p.id) === id) ? queue : [...queue, proposal];
}

/** Idempotently remove an answered/expired proposal from any queue position. */
export function removeApproval<T extends ApprovalWithId>(queue: T[], id: number | string): T[] {
  const key = String(id);
  const next = queue.filter((p) => String(p.id) !== key);
  return next.length === queue.length ? queue : next;
}

// ---- The two permission cards, seen as one queue ----
//
// A run_command ask and a coding-agent ask are answered by the same person in
// the same place: the chat whose turn is waiting on them. Both kinds live in
// one arrival-ordered list so a thread's card is "the oldest ask in this chat",
// whichever service raised it.

import type { ExecApprovalRequest, HarnessApprovalRequest } from '../../shared/types';

export type PendingApproval =
  | { kind: 'exec'; request: ExecApprovalRequest }
  | { kind: 'harness'; request: HarnessApprovalRequest };

export function approvalKey(a: PendingApproval): string {
  return `${a.kind}:${a.request.id}`;
}

/** The asks raised by this chat's turn, oldest first. */
export function approvalsForThread(all: PendingApproval[], threadId: string | null): PendingApproval[] {
  if (!threadId) return [];
  return all.filter((a) => a.request.threadId === threadId);
}

/** The asks waiting in chats other than the one on screen, oldest first. */
export function approvalsElsewhere(all: PendingApproval[], threadId: string | null): PendingApproval[] {
  return all.filter((a) => a.request.threadId !== threadId);
}
