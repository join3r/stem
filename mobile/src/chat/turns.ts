// What a startTurn answer means, and which turn Stop is for.
//
// Two decisions lifted out of ../hooks/useThread.ts because they are the two the
// screen gets wrong when nobody is watching — a send that never became a turn,
// and a Stop with nothing to aim at — and neither needs React to be decided.
//
// THE SHORTCUT. `backend:startTurn` does not always start a turn. The memory
// capture path answers "I'll remember that." and is done (StartTurnResult in
// @shared/types: `handled`, `assistantMessage`, and NO turnId), and the same
// shape covers anything else the server can settle by itself. A client that
// reads only `turnId` therefore sits on an optimistic `running:true` that no
// event will ever clear: the composer stays a Stop button, and the thread looks
// like it is thinking about a reply it has already given.
//
// The desktop settles it in src/renderer/session/turns.ts — append the message
// if there is one, then idle — and this is the same fold, so the two clients
// cannot answer the shortcut differently.

import { applyProcessExitToThread, type ThreadState } from '@shared/chatState';
import type { LiveTurn, StartTurnResult } from '@shared/types';

/**
 * Reconcile this thread's slice with what the server says is running NOW.
 *
 * The snapshot frame arrives on every fresh stream, and a fresh stream is what
 * the app opens every time it comes back to the front. A turn that finished
 * while the phone was asleep never got its `turn/completed` delivered — the
 * frame aged out of the server's replay ring — so the slice still says running,
 * the composer still shows Stop, and the last bubble still says it is being
 * written. Re-reading the transcript does not fix that: mergeHydratedThread
 * spreads the live slice over the disk one precisely so an in-flight turn
 * survives a hydration, and it cannot tell an in-flight turn from a stranded
 * one. The snapshot can. This thread absent from it means nothing of ours is
 * running, and the slice is settled the way a backend exit settles it: the
 * streaming bubble closed, the activity cleared, the turn ended.
 *
 * `pendingSend`: a startTurn we have sent and not yet had answered is a turn the
 * snapshot may predate by milliseconds. Its optimistic `running` is left alone;
 * the answer to the send settles it (applyStartTurnResult).
 *
 * Same object back when there is nothing to do, so a caller can `apply` it
 * unconditionally without re-rendering an idle thread on every reconnect.
 */
export function settleAgainstSnapshot(
  state: ThreadState,
  snapshot: LiveTurn[],
  threadId: string,
  pendingSend: boolean
): ThreadState {
  if (!state.running || pendingSend) return state;
  if (snapshot.some((turn) => turn.threadId === threadId)) return state;
  return applyProcessExitToThread(state);
}

export interface StartTurnOutcome {
  state: ThreadState;
  /** The turn this send became, or null when it never became one. */
  turnId: string | null;
}

/**
 * Fold the answer to a send into the thread.
 *
 * With a turnId the only change is bookkeeping: the id goes onto the bubble that
 * caused it, so a Stop pressed before the first event still knows what to
 * interrupt (see interruptTarget) and a later failure can be traced back.
 *
 * Without one there is nothing to wait for, so the turn that was optimistically
 * started here has to be ended here too.
 */
export function applyStartTurnResult(
  prev: ThreadState,
  result: StartTurnResult,
  userMessageId: string
): StartTurnOutcome {
  const turnId = result.turnId ?? null;
  if (turnId) {
    return {
      state: {
        ...prev,
        messages: prev.messages.map((m) => (m.id === userMessageId ? { ...m, turnId } : m))
      },
      turnId
    };
  }
  return {
    state: {
      ...prev,
      messages: result.assistantMessage
        ? [
            ...prev.messages,
            { id: `assistant-${Date.now()}`, role: 'assistant', content: result.assistantMessage }
          ]
        : prev.messages,
      running: false,
      activeTurnId: null,
      status: 'idle'
    },
    turnId: null
  };
}

/**
 * The turn Stop should interrupt, going only on what this screen holds.
 *
 * The fallback exists for the gap between "startTurn answered" and the model's
 * first event, when there is no activeTurnId yet but the id is already stamped
 * on the message that started the turn — on a slow provider that gap is exactly
 * when Stop gets pressed.
 *
 * It is gated on `running` and that gate is the whole point: with the thread
 * idle, the newest stamped id belongs to a turn that has already finished, and
 * interrupting it would be a request that quietly does nothing while the user
 * watches for something to stop.
 */
export function interruptTarget(state: ThreadState): string | null {
  if (state.activeTurnId) return state.activeTurnId;
  if (!state.running) return null;
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i];
    if (message.role === 'user' && message.turnId) return message.turnId;
  }
  return null;
}
