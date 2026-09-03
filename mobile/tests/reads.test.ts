// The read bookkeeping both screens hold, and the two ways it used to strand a
// spinner: a request that was never made, and an answer that arrived by another
// road while one was still in flight.

import { describe, expect, it } from 'vitest';
import { IDLE_READ, isCurrent, readIdle, readSettled, readStarted } from '../src/chat/reads';

describe('a read that answers', () => {
  it('loads, settles, and clears the failure it started with', () => {
    const started = readStarted({ request: 4, loading: false, error: 'nothing answered' });
    expect(started.loading).toBe(true);
    // The banner stays up for the length of the refetch: blanking it would
    // claim the problem is fixed before anything has said so.
    expect(started.error).toBe('nothing answered');

    const done = readSettled(started, started.request, null);
    expect(done.loading).toBe(false);
    expect(done.error).toBeNull();
  });

  it('keeps the failure and stops loading when it does not', () => {
    const started = readStarted(IDLE_READ);
    const failed = readSettled(started, started.request, new Error('could not reach the server'));
    expect(failed.loading).toBe(false);
    expect(failed.error).toBe('could not reach the server');
  });

  it('ignores an answer to a request the screen has moved on from', () => {
    const first = readStarted(IDLE_READ);
    const second = readStarted(first);
    expect(isCurrent(second, first.request)).toBe(false);

    const late = readSettled(second, first.request, new Error('a stale failure'));
    expect(late).toBe(second);
    expect(late.loading).toBe(true);
  });
});

describe('a read that never happens', () => {
  it('stops loading when there is nothing to ask', () => {
    // A cold launch straight into a thread: the Keychain has not answered yet,
    // so the screen is not paired and no request goes out. Leaving `loading`
    // set here is a spinner with no error, no data and nothing to retry.
    const idle = readIdle(readStarted(IDLE_READ));
    expect(idle.loading).toBe(false);
    expect(idle.error).toBeNull();
  });

  it('reads for real once the pairing lands', () => {
    const waiting = readIdle(IDLE_READ);
    const started = readStarted(waiting);
    expect(started.loading).toBe(true);

    const done = readSettled(started, started.request, null);
    expect(done.loading).toBe(false);
    expect(done.error).toBeNull();
  });

  it('settles the request in flight when fresh data arrives by another road', () => {
    // Pull-to-refresh, and mid-refetch the user archives a row; the mutator
    // answers with the whole new list. That IS the fresh data, so the spinner
    // has nothing left to wait for — and the answer still on its way belongs to
    // the older request and must not overwrite it.
    const refetching = readStarted(IDLE_READ);
    const replaced = readIdle(refetching);
    expect(replaced.loading).toBe(false);

    expect(isCurrent(replaced, refetching.request)).toBe(false);
    expect(readSettled(replaced, refetching.request, null)).toBe(replaced);
  });
});

// The third way a read can end: nothing answered, and nobody asked.
import { readAbandoned, shouldAbandon } from '../src/chat/reads';

describe('a read the phone gives up on quietly', () => {
  it('stops loading and leaves whatever banner was already up alone', () => {
    const started = readStarted({ request: 2, loading: false, error: 'the chat is gone' });
    const abandoned = readAbandoned(started, started.request);
    expect(abandoned.loading).toBe(false);
    expect(abandoned.error).toBe('the chat is gone');
  });

  it('ignores a request the screen has moved on from', () => {
    const first = readStarted(IDLE_READ);
    const second = readStarted(first);
    expect(readAbandoned(second, first.request)).toBe(second);
  });

  it('is only for a background read that reached nobody while the link is still reconnecting', () => {
    expect(shouldAbandon('background', true, true)).toBe(true);
    // The user pulled: they are owed an answer, even a bad one.
    expect(shouldAbandon('user', true, true)).toBe(false);
    // The server answered — with an error. That is always news.
    expect(shouldAbandon('background', false, true)).toBe(false);
    // The transport has given up: the screen is stale and should say so.
    expect(shouldAbandon('background', true, false)).toBe(false);
  });
});
