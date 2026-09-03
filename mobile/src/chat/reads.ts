// One read from the server, as a screen holds it.
//
// Every screen on this phone shows the same three things about the data it is
// displaying — whether a request is outstanding, what the last failure was, and
// which request the answer on screen belongs to — and every one of them had its
// own copy of the bookkeeping. Two of those copies had the same bug: a path that
// ended a request without ending the SPINNER. An unpaired thread screen returned
// early and span forever; the chat list adopted a mutator's fresh answer and
// left pull-to-refresh turning until an unrelated refetch happened by.
//
// That is why this is one module rather than a fix in each hook. There are four
// ways a read can end and all four are here, so "the request is over" and "the
// spinner stops" cannot come apart again.
//
// The counter is what makes a late answer harmless. It is not a cancellation —
// an RPC already in the air arrives regardless — it is the record of which
// request the screen is still interested in, so an older one's answer can be
// recognized and dropped instead of overwriting a newer one's.

export interface ReadState {
  /** The request the screen is waiting for. Answers to older ones are dropped. */
  request: number;
  /** A request is outstanding. Also true for a first load. */
  loading: boolean;
  /**
   * The last failure, kept alongside whatever is already displayed rather than
   * instead of it: stale data plus "couldn't refresh" beats an empty screen.
   */
  error: string | null;
}

export const IDLE_READ: ReadState = { request: 0, loading: false, error: null };

/**
 * A request is going out. The error stays until this one answers — clearing it
 * here would blank the banner for the length of a refetch that may fail the same
 * way.
 */
export function readStarted(prev: ReadState): ReadState {
  return { request: prev.request + 1, loading: true, error: prev.error };
}

/**
 * A request answered. `request` is the number readStarted handed out; an older
 * one is a superseded answer and changes nothing, which is the same test the
 * caller must make before it writes the data itself (see isCurrent).
 */
export function readSettled(prev: ReadState, request: number, error: unknown | null): ReadState {
  if (!isCurrent(prev, request)) return prev;
  return {
    request: prev.request,
    loading: false,
    error: error === null ? null : String((error as Error)?.message ?? error)
  };
}

/**
 * The read is over without an answer being waited for: there was nothing to ask
 * (this phone is not paired yet), or the current data arrived by another road —
 * the Inbox mutators return the fresh list precisely so acting on a row costs no
 * second round trip.
 *
 * Both invalidate anything in flight, because its answer is now the older of
 * the two, and both leave nothing loading. Neither is a failure.
 */
export function readIdle(prev: ReadState): ReadState {
  return { request: prev.request + 1, loading: false, error: null };
}

/**
 * The read ended without an answer worth showing: nothing answered, and the
 * screen did not ask — the phone did, on its way back to the foreground or on a
 * stream edge, while the link was still being reopened. The spinner stops, the
 * data on screen stays, and whatever banner was already up stays too (it was
 * about something else). Neither a success nor a failure; see shouldAbandon.
 */
export function readAbandoned(prev: ReadState, request: number): ReadState {
  if (!isCurrent(prev, request)) return prev;
  return { request: prev.request, loading: false, error: prev.error };
}

/**
 * Who asked for this read. `user` is a finger: a pull, a tap, an open screen.
 * `background` is the phone keeping itself current: a focus, a wake, a resync,
 * a settled turn. Only the second may be abandoned quietly.
 */
export type ReadCause = 'user' | 'background';

/**
 * Whether a failed read is one to say nothing about. Three conditions, all
 * required: nobody asked (`background`), nothing answered (`unreachable` — a
 * server error is always news), and the link has not given up yet (`reachable`
 * still true, i.e. the transport is inside its reconnect grace). Once the
 * transport does say offline, a background read failing is worth the banner:
 * the user should know their screen is stale and why.
 */
export function shouldAbandon(cause: ReadCause, unreachable: boolean, reachable: boolean): boolean {
  return cause === 'background' && unreachable && reachable;
}

/** Is this the request the screen is still waiting for? */
export function isCurrent(state: ReadState, request: number): boolean {
  return state.request === request;
}
