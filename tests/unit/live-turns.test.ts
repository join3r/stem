// The busy signal the scheduler reads (liveTurnCount → busyWithin → isUserActive),
// and the recall background passes yield to.
//
// This used to be two disjoint counters — the desktop's own run-state and the
// phone bridge's set of threads a phone had started — neither of which could see
// the other. It is one server-side set now, folded out of the backend event
// stream, so it answers for every connected device at once.
//
// Driving it from events rather than from a start-turn response is also what
// retires the race the bridge needed SettledTurns for: there is no longer a way
// for a terminal event to arrive before the mark it is meant to clear. The cases
// that guard covered are kept below, stated in the new terms.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLiveTurns,
  foldTurnEvent,
  liveTurnAgeMs,
  liveTurnCount,
  liveTurnSnapshot,
  noteTurnEvent,
  noteTurnStart
} from '../../src/server/live-turns';

beforeEach(() => {
  clearLiveTurns();
});

describe('marking a thread busy', () => {
  it('starts on the turn\'s first event and clears on its terminal one', () => {
    noteTurnEvent('item/started', 'thread-1');
    expect(liveTurnCount()).toBe(1);

    noteTurnEvent('turn/completed', 'thread-1');
    expect(liveTurnCount()).toBe(0);

    // A turn that only ever streams text counts too — the first delta is as
    // good a "this thread is working" as the first item.
    noteTurnEvent('item/agentMessage/delta', 'thread-1');
    expect(liveTurnCount()).toBe(1);
    noteTurnEvent('turn/aborted', 'thread-1');
    expect(liveTurnCount()).toBe(0);
  });

  it('counts each thread once, however many events it produces', () => {
    for (const method of ['item/started', 'item/agentMessage/delta', 'item/agentMessage/delta']) {
      noteTurnEvent(method, 'thread-1');
    }
    noteTurnEvent('item/started', 'thread-2');
    expect(liveTurnCount()).toBe(2);
    noteTurnEvent('turn/failed', 'thread-1');
    expect(liveTurnCount()).toBe(1);
  });

  it('leaves no mark when the turn settles with nothing having streamed', () => {
    // The old race, in its new shape: the mark is made by an EARLIER event of the
    // same turn, so a terminal event that arrives first has nothing to strand.
    // Before the split this had to be guarded, because the mark came from the
    // start-turn response and could land after the terminal event.
    noteTurnEvent('turn/completed', 'thread-1');
    expect(liveTurnCount()).toBe(0);
  });

  it('does not let one turn settling suppress the next turn on the same thread', () => {
    // Thread ids recur across turns. A settled thread must not be remembered as
    // settled, or the next turn on it would never register as busy.
    noteTurnEvent('turn/completed', 'thread-1');
    noteTurnEvent('item/started', 'thread-1');
    expect(liveTurnCount()).toBe(1);
  });
});

describe('the backend going away', () => {
  it('clears every mark on a process-level event', () => {
    noteTurnEvent('item/started', 'thread-1');
    noteTurnEvent('item/started', 'thread-2');
    // An unattributed process/exit (older backend): no turn survived it, so a
    // stuck mark here would defer every scheduled task for the life of the process.
    noteTurnEvent('process/exit', undefined);
    expect(liveTurnCount()).toBe(0);
  });

  it("an attributed exit clears only the dying worker's own thread", () => {
    noteTurnEvent('item/started', 'thread-1');
    noteTurnEvent('item/started', 'thread-2');
    // A pool worker dies carrying thread-2; the turn streaming on thread-1's
    // worker keeps its mark.
    noteTurnEvent('process/exit', 'thread-2');
    expect(liveTurnCount()).toBe(1);
    expect(liveTurnAgeMs('thread-1')).not.toBeNull();
  });

  it('ignores anything that is neither a start nor a settle', () => {
    noteTurnEvent('item/completed', 'thread-1');
    noteTurnEvent('turn/started', 'thread-1');
    expect(liveTurnCount()).toBe(0);
  });
});

// The same fold, read as an answer rather than a count: what a client is told the
// instant its event stream connects, so a turn that kept running while it was
// away shows as active instead of finished.
describe('the snapshot a connecting client gets', () => {
  it('names each live thread and the turn running in it', () => {
    noteTurnEvent('item/started', 'thread-1', 'turn-a');
    noteTurnEvent('item/agentMessage/delta', 'thread-2', 'turn-b');
    expect(liveTurnSnapshot()).toEqual([
      { threadId: 'thread-1', turnId: 'turn-a' },
      { threadId: 'thread-2', turnId: 'turn-b' }
    ]);
  });

  it('carries the newest turn of a thread, not the one that started it', () => {
    // The turn id is what a client's Stop interrupts. An id from the previous
    // turn of the same thread would interrupt nothing.
    noteTurnEvent('item/started', 'thread-1', 'turn-a');
    noteTurnEvent('turn/completed', 'thread-1', 'turn-a');
    noteTurnEvent('item/started', 'thread-1', 'turn-b');
    expect(liveTurnSnapshot()).toEqual([{ threadId: 'thread-1', turnId: 'turn-b' }]);
  });

  it('names a turn that has been dispatched but has not streamed yet', () => {
    // What a phone connecting a second after somebody hit send is told. The
    // backend has the prompt; nothing has come back.
    noteTurnStart('thread-1', 'turn-a');
    expect(liveTurnSnapshot()).toEqual([{ threadId: 'thread-1', turnId: 'turn-a' }]);
  });

  it('is empty once every turn has settled', () => {
    noteTurnEvent('item/started', 'thread-1', 'turn-a');
    noteTurnEvent('turn/aborted', 'thread-1', 'turn-a');
    // Emptiness is an answer, not an absence of one: a client reading this is
    // told its spinner should stop, which is the whole point of being sent it.
    expect(liveTurnSnapshot()).toEqual([]);
  });
});

// How long a turn ran — the number the phone push weighs against MIN_TURN_PUSH_MS.
//
// The clock is started by whichever comes first: the dispatch (noteTurnStart, called
// where a turn is handed to the backend) or the turn's first streamed event. Both
// exist because neither is enough alone — an event cannot describe a turn that never
// produced one, and a dispatch cannot see a turn a re-connected client is watching.
describe('the clock on a running turn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('measures a turn that hung without ever streaming anything', () => {
    // The regression this exists for. A turn that produces no item and no token
    // has no first event, so before the dispatch was recorded it had no start
    // time — and a turn ending with an unknown age is one nobody is told about.
    // Which made the silent hour-long turns the only kind that never pushed.
    noteTurnStart('thread-1', 'turn-a');
    vi.advanceTimersByTime(45 * 60_000);

    expect(foldTurnEvent('turn/failed', 'thread-1', 'turn-a').ranForMs).toBe(45 * 60_000);
  });

  it('keeps the earlier clock when the turn streams before the dispatch is noted', () => {
    // startTurn resolves after the prompt is written, so a fast backend can have
    // streamed its first token by then. First of the two wins, or the measurement
    // would restart at whatever the later call happened to be.
    noteTurnEvent('item/started', 'thread-1', 'turn-a');
    vi.advanceTimersByTime(10_000);
    noteTurnStart('thread-1', 'turn-a');
    vi.advanceTimersByTime(20_000);

    expect(foldTurnEvent('turn/completed', 'thread-1', 'turn-a').ranForMs).toBe(30_000);
  });

  it('adopts the id of a turn already seen without one', () => {
    noteTurnEvent('item/agentMessage/delta', 'thread-1');
    vi.advanceTimersByTime(5_000);
    noteTurnStart('thread-1', 'turn-a');

    // The id is what a client's Stop interrupts, so it is taken; the clock is not.
    expect(liveTurnSnapshot()).toEqual([{ threadId: 'thread-1', turnId: 'turn-a' }]);
    expect(liveTurnAgeMs('thread-1')).toBe(5_000);
  });

  it('restarts the clock for a genuinely new turn on the same thread', () => {
    noteTurnStart('thread-1', 'turn-a');
    vi.advanceTimersByTime(60_000);
    noteTurnStart('thread-1', 'turn-b');

    expect(liveTurnAgeMs('thread-1')).toBe(0);
    expect(liveTurnSnapshot()).toEqual([{ threadId: 'thread-1', turnId: 'turn-b' }]);
  });

  it('knows nothing about a thread with no turn in it', () => {
    expect(liveTurnAgeMs('thread-1')).toBeNull();
  });
});

// The measure-then-forget pair, which is the whole reason foldTurnEvent exists as
// one call: done in the other order it returns null every time, and null reads
// downstream as "too short to be worth a notification" rather than as a fault.
describe('folding the event that ends a turn', () => {
  it('measures the turn before forgetting it', () => {
    noteTurnStart('thread-1', 'turn-a');

    expect(foldTurnEvent('turn/completed', 'thread-1', 'turn-a').ranForMs).not.toBeNull();
    // And the fold really did happen: nothing is left to measure, which is what
    // the same read done a line too late would have returned.
    expect(liveTurnAgeMs('thread-1')).toBeNull();
    expect(liveTurnCount()).toBe(0);
  });

  it('measures nothing for a turn that was stopped by hand', () => {
    noteTurnStart('thread-1', 'turn-a');

    // turn/aborted is somebody's own Stop, pressed on a device in their hand.
    expect(foldTurnEvent('turn/aborted', 'thread-1', 'turn-a').ranForMs).toBeNull();
    expect(liveTurnCount()).toBe(0);
  });

  it('measures nothing mid-turn, and still folds', () => {
    expect(foldTurnEvent('item/started', 'thread-1', 'turn-a').ranForMs).toBeNull();
    expect(liveTurnSnapshot()).toEqual([{ threadId: 'thread-1', turnId: 'turn-a' }]);
  });

  it('measures nothing for a turn that ended in a thread it never began in', () => {
    // A terminal event for a turn this process never saw start (a restart, a
    // client reconnecting into somebody else's turn): unknown, not zero.
    expect(foldTurnEvent('turn/completed', 'thread-1', 'turn-a').ranForMs).toBeNull();
  });
});
