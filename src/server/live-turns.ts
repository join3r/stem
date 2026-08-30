// Which threads have a turn in flight, on any surface of any client.
//
// This is the server-side replacement for two things that used to be counted
// separately and could disagree: the desktop asking itself "is one of my windows
// streaming", and the phone bridge keeping its own set of threads a phone had
// started. Neither could see the other, which is why the scheduler needed both.
// The server sees every backend event, so it can answer for every device at once
// — and that is the only answer that stays right when there is more than one.
//
// Driven purely from the event stream, never from a start-turn response. That is
// what retires the settled-turn race the bridge needed a guard for: a terminal
// event can no longer arrive before the mark it is supposed to clear, because the
// mark is made by an earlier event of the same turn.

import { isSettledMethod } from '../shared/settledTurns';

/** What is known about one running turn: its id (empty when unknown) and its clock. */
interface LiveTurn {
  turnId: string;
  /** When this turn was first heard of, in epoch ms — see noteTurnStart. */
  startedAt: number;
}

/** Thread id → the turn currently running in it. */
const live = new Map<string, LiveTurn>();

/**
 * Fold one backend event into the set. A `threadId` of undefined means a
 * process-level event (process/exit): the backend is gone and no turn survived
 * it, so everything clears.
 */
export function noteTurnEvent(method: string, threadId: string | undefined, turnId?: string): void {
  if (!threadId) {
    live.clear();
    return;
  }
  // The same two methods the desktop's follow-me pill has always treated as "this
  // thread is working": the first item of a turn, or its first token.
  if (method === 'item/started' || method === 'item/agentMessage/delta') {
    // Later events of the same turn re-assert the same id; a NEW turn in the same
    // thread overwrites it, which is what a client resuming needs — the turn id is
    // what its Stop button interrupts, and an id from the previous turn would
    // interrupt nothing.
    const current = live.get(threadId);
    const id = turnId ?? current?.turnId ?? '';
    // The clock belongs to the TURN, not the thread: a later event of the turn
    // already being tracked keeps the original start (including the case where
    // the first event arrived without an id and this one names it), and only a
    // genuinely different turn restarts it. Anything else would measure "time
    // since the last delta", which is nearly zero for every turn there is.
    const startedAt = current && (!current.turnId || !id || current.turnId === id) ? current.startedAt : Date.now();
    live.set(threadId, { turnId: id, startedAt });
  } else if (isSettledMethod(method)) live.delete(threadId);
}

/**
 * A turn has just been handed to the backend — the prompt is written and the turn
 * id exists. Called by whoever starts one (the `backend:startTurn` handler, the
 * scheduler's runTask), which is the ONLY moment known to every turn.
 *
 * The fold above learns of a turn from its first item or token, and for a turn
 * that produces neither — one that hangs and is eventually failed by a timeout —
 * that moment never comes. Such a turn had no start time, so it measured as
 * "unknown" and its ending pushed nothing: the long silent turns most worth
 * telling somebody about were exactly the ones nothing was ever said about.
 *
 * First-of-the-two wins. A turn whose events arrive before this call keeps the
 * earlier clock (and this only fills in an id it may have been missing), because
 * an event of a turn cannot precede the turn; a different turn id means a genuinely
 * new turn and restarts it. Only the CLOCK is taken on trust here — everything
 * else about which thread is live still comes out of the event stream, and this
 * cannot strand a mark the stream would not have cleared anyway: one THREAD's
 * turns serialize on its pool worker's gate (different threads run in parallel
 * on different workers, but each entry here is per thread), so the previous
 * turn's terminal event has been folded in by the time the next one is
 * dispatched.
 */
export function noteTurnStart(threadId: string, turnId: string): void {
  const current = live.get(threadId);
  if (current && (!current.turnId || current.turnId === turnId)) {
    live.set(threadId, { turnId: current.turnId || turnId, startedAt: current.startedAt });
    return;
  }
  live.set(threadId, { turnId, startedAt: Date.now() });
}

/** Threads still streaming — the scheduler's defer/preempt signal. */
export function liveTurnCount(): number {
  return live.size;
}

/**
 * What is running right now, for a client that has just (re)connected.
 *
 * A client that was away cannot tell "this turn is still going" from "this turn
 * finished and I missed the event": both look like a thread that stopped
 * producing deltas. Answering it from here means the answer comes from the same
 * fold that every other consumer reads, rather than from a second count that
 * could disagree — and it is the whole of the answer, so a thread absent from it
 * is settled, not merely unmentioned.
 */
export function liveTurnSnapshot(): { threadId: string; turnId: string | null }[] {
  return [...live].map(([threadId, turn]) => ({ threadId, turnId: turn.turnId || null }));
}

/**
 * How long the turn in `threadId` has been running, or null when none is. Read
 * by the push triggers just BEFORE the terminal event is folded in — this fold
 * is what forgets the turn, so afterwards there is nothing left to measure.
 *
 * It answers from the same map every other consumer reads rather than from a
 * second set of timestamps kept alongside it, which is the only way the answer
 * cannot disagree with "is this thread live".
 */
export function liveTurnAgeMs(threadId: string): number | null {
  const turn = live.get(threadId);
  return turn ? Date.now() - turn.startedAt : null;
}

/**
 * Fold one event AND, when it is the event that ends a turn, say how long that
 * turn ran.
 *
 * One call rather than two because the two only work in one order, and the wrong
 * order fails silently: the fold is what forgets the turn, so an age read after
 * it is always null, and "always null" reads downstream as "not worth a
 * notification" rather than as a bug. Keeping the pair here means the ordering is
 * tested once, in tests/unit/live-turns.test.ts, instead of re-argued at each
 * call site in a comment.
 *
 * Only the two endings somebody might want to hear about are measured. A turn
 * that was ABORTED is somebody's own Stop, pressed on a device they were holding
 * — never news.
 */
export function foldTurnEvent(
  method: string,
  threadId: string | undefined,
  turnId?: string
): { ranForMs: number | null } {
  const ranForMs =
    threadId && (method === 'turn/completed' || method === 'turn/failed') ? liveTurnAgeMs(threadId) : null;
  noteTurnEvent(method, threadId, turnId);
  return { ranForMs };
}

/** Drop every mark (tests; a fresh server). */
export function clearLiveTurns(): void {
  live.clear();
}
