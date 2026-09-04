import { useSyncExternalStore } from 'react';
import type { ExecApprovalRequest, ExecDecision, HarnessApprovalRequest } from '../../shared/types';
import { approvalKey, type PendingApproval } from './approvalQueue';

// One subscription to the exec and harness approval channels for the whole
// window, read by every surface that shows a card: the chat that owns the ask
// (inline), the notice in any other chat, the sidebar dot, Quick Chat. Before
// this each card component kept its own copy of the queue and could only ever
// be a modal — there was nowhere else for it to be.

interface ApprovalState {
  /** Every ask still waiting, in the order it arrived. */
  pending: PendingApproval[];
  /** The ask whose answer is in flight (its buttons are disabled meanwhile). */
  busyKey: string | null;
  /**
   * An answer that arrived after the card had already expired. Held apart from
   * the queue: the card is gone, and the one thing the user must not be left
   * believing is that their click ran or allowed something.
   */
  missed: string | null;
}

let state: ApprovalState = { pending: [], busyKey: null, missed: null };
const listeners = new Set<() => void>();
let wired = false;

function set(patch: Partial<ApprovalState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function add(a: PendingApproval): void {
  const key = approvalKey(a);
  // Append once, preserving arrival order for parallel tool approvals.
  if (state.pending.some((p) => approvalKey(p) === key)) return;
  set({ pending: [...state.pending, a] });
}

function remove(kind: PendingApproval['kind'], id: string): void {
  const key = `${kind}:${id}`;
  const next = state.pending.filter((p) => approvalKey(p) !== key);
  if (next.length === state.pending.length) return;
  set({ pending: next, busyKey: state.busyKey === key ? null : state.busyKey });
}

function arm(kind: PendingApproval['kind'], id: string, expiresAt: number): void {
  set({
    pending: state.pending.map((a) =>
      a.kind === kind && a.request.id === id ? ({ ...a, request: { ...a.request, expiresAt } } as PendingApproval) : a
    )
  });
}

// Lazily, on the first subscriber: tests render these components without a
// preload bridge, and a module that touched window.stem at import time would
// not load there at all.
function wire(): void {
  if (wired || typeof window === 'undefined' || !window.stem) return;
  wired = true;
  window.stem.onExecApproval((r: ExecApprovalRequest) => add({ kind: 'exec', request: r }));
  window.stem.onExecApprovalResolved(({ id }) => remove('exec', id));
  window.stem.onExecApprovalArmed(({ id, expiresAt }) => arm('exec', id, expiresAt));
  window.stem.onHarnessApproval((r: HarnessApprovalRequest) => add({ kind: 'harness', request: r }));
  window.stem.onHarnessApprovalResolved(({ id }) => remove('harness', id));
  window.stem.onHarnessApprovalArmed(({ id, expiresAt }) => arm('harness', id, expiresAt));
}

function subscribe(l: () => void): () => void {
  wire();
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useApprovals(): ApprovalState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/**
 * Answer an ask. Resolves to the error to show on the card, or null. A false
 * from the backend means the card had already expired (or another surface
 * answered it) and the turn moved on without this click — the user is told so
 * through `missed` rather than left believing their click landed.
 */
export async function decideApproval(
  a: PendingApproval,
  choice: ExecDecision | { optionId: string }
): Promise<string | null> {
  const key = approvalKey(a);
  if (state.busyKey) return null;
  set({ busyKey: key });
  try {
    const answered =
      a.kind === 'exec'
        ? await window.stem.respondExecApproval(a.request.id, choice as ExecDecision)
        : await window.stem.respondHarnessApproval(a.request.id, (choice as { optionId: string }).optionId);
    remove(a.kind, a.request.id);
    if (!answered) set({ missed: a.kind === 'exec' ? a.request.command : a.request.title });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    if (state.busyKey === key) set({ busyKey: null });
  }
}

export function dismissMissedApproval(): void {
  set({ missed: null });
}

/** Test seam: drop everything, as if the window had just opened. */
export function resetApprovalStoreForTests(): void {
  state = { pending: [], busyKey: null, missed: null };
  for (const l of listeners) l();
}
