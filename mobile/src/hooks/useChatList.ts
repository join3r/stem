// The chat list, kept current.
//
// One RPC (`chats:list`) and four reasons to run it again. They are worth naming
// because between them they are the whole of "the phone is live", and the shape
// of the answer — refetch, rather than patch what is on screen from the event —
// is deliberate. The desktop's offline cache makes the same choice for the same
// reason (see the SETTLED_TURN_METHODS comment in src/desktop/proxy.ts):
// reassembling a thread's summary from the deltas that went past would be a
// second, worse implementation of something the server already does, and it would
// be wrong in a different way on every screen that tried it.
//
//   pairing        there is a server to ask, and nothing has been asked yet.
//   chats:changed  a background subject write renamed a thread. Its own channel
//                  precisely because "ask for the list again" is the only
//                  sensible response to it.
//   a settled turn a turn finished, so some thread's preview and updatedAt have
//                  moved. Debounced, because several can settle at once.
//   resync         the stream could not be resumed and everything on screen is
//                  now of unknown age. Immediate, not debounced: this one means
//                  what is displayed may be wrong rather than merely old.
//
// A reconnect refetches too, but only from the second one on — the first is the
// stream opening after the load that pairing already triggered. And the app
// coming to the front (onWake) refetches, debounced into the reconnect's own.
//
// Who asked matters (ReadCause in ../chat/reads.ts): `refresh` is the user's
// pull and fails out loud; `revalidate` and every reason above are the phone
// keeping itself current, and one of those failing to reach a server that is
// being reconnected to at that very moment is not worth a banner.

import { useCallback, useEffect, useRef, useState } from 'react';
import { isSettledMethod } from '@shared/settledTurns';
import type { ChatListResult } from '@shared/types';
import {
  IDLE_READ,
  isCurrent,
  readAbandoned,
  readIdle,
  readSettled,
  readStarted,
  shouldAbandon,
  type ReadCause,
  type ReadState
} from '../chat/reads';
import { isUnreachable } from '../transport/connection';
import { useTransport } from '../transport/provider';

/** Long enough to swallow a burst of terminal events, short enough to feel live. */
const REFETCH_DEBOUNCE_MS = 400;

export interface ChatListState {
  list: ChatListResult | null;
  /** A request is in flight. Also true for the very first load. */
  loading: boolean;
  /** The last failure, or null. Kept alongside `list`, not instead of it: a stale
   * list plus "couldn't refresh" beats an empty screen. */
  error: string | null;
  /** The user asked (pull-to-refresh). Fails out loud. */
  refresh: () => void;
  /** The screen came back into view. Fails quietly while the link is reconnecting. */
  revalidate: () => void;
  /**
   * Adopt a list the caller already has. The Inbox mutators (`inbox:setArchived`
   * and friends) answer with the fresh ChatListResult precisely so acting on a
   * row does not cost a second round trip — this is where that answer lands.
   * Counted as a request, so an older in-flight fetch cannot overwrite it and
   * whatever spinner was waiting on that fetch stops here.
   */
  replace: (next: ChatListResult) => void;
}

export function useChatList(): ChatListState {
  const { connection, status } = useTransport();
  const [list, setList] = useState<ChatListResult | null>(null);
  // Answers from superseded requests are dropped rather than raced, and every
  // way this read can end settles the spinner — see ../chat/reads.ts. The ref is
  // the source and the state its mirror, because the callbacks below have to
  // read the current request number, which a setter's argument cannot give them.
  const [read, setRead] = useState<ReadState>(IDLE_READ);
  const readRef = useRef<ReadState>(IDLE_READ);
  const applyRead = useCallback((next: (prev: ReadState) => ReadState) => {
    readRef.current = next(readRef.current);
    setRead(readRef.current);
  }, []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenStream = useRef(false);

  const cancelPending = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const fetchNow = useCallback(
    async (cause: ReadCause) => {
      cancelPending();
      if (!connection.status().paired) {
        applyRead(readIdle);
        return;
      }
      applyRead(readStarted);
      const mine = readRef.current.request;
      try {
        const answer = await connection.rpc('chats:list');
        if (!isCurrent(readRef.current, mine)) return;
        setList(answer);
        applyRead((prev) => readSettled(prev, mine, null));
      } catch (e) {
        if (shouldAbandon(cause, isUnreachable(e), connection.status().reachable)) {
          applyRead((prev) => readAbandoned(prev, mine));
          return;
        }
        applyRead((prev) => readSettled(prev, mine, e));
      }
    },
    [applyRead, cancelPending, connection]
  );

  // Every scheduled read is the phone's own idea.
  const schedule = useCallback(() => {
    cancelPending();
    timer.current = setTimeout(() => {
      timer.current = null;
      void fetchNow('background');
    }, REFETCH_DEBOUNCE_MS);
  }, [cancelPending, fetchNow]);

  useEffect(() => {
    if (!status.paired) {
      // Unpaired: the list belonged to a server this phone no longer has a
      // credential for, and leaving it on screen would be showing somebody
      // else's data.
      cancelPending();
      applyRead(readIdle);
      setList(null);
      return;
    }
    // The first load is the user's: there is nothing on screen yet, so a failure
    // has to be said, or the screen is empty for no stated reason.
    void fetchNow('user');
  }, [status.paired, applyRead, fetchNow, cancelPending]);

  useEffect(() => {
    if (!status.streaming) return;
    if (!seenStream.current) {
      seenStream.current = true;
      return;
    }
    schedule();
  }, [status.streaming, schedule]);

  useEffect(() => {
    const offResync = connection.onResync(() => {
      void fetchNow('background');
    });
    // Debounced rather than immediate: the wake also reopens the stream, whose
    // rising edge schedules a read of its own, and one read is enough.
    const offWake = connection.onWake(schedule);
    const offChanged = connection.onPush('chats:changed', schedule);
    const offBackend = connection.onBackendEvent((event) => {
      if (isSettledMethod(event.method)) schedule();
    });
    return () => {
      offResync();
      offWake();
      offChanged();
      offBackend();
    };
  }, [connection, fetchNow, schedule]);

  useEffect(() => cancelPending, [cancelPending]);

  const replace = useCallback(
    (next: ChatListResult) => {
      cancelPending();
      // This IS the fresh data, so the read the user is waiting on is over — a
      // pull-to-refresh that archived a row underneath it must not be left
      // turning until some unrelated refetch happens along and settles it.
      applyRead(readIdle);
      setList(next);
    },
    [applyRead, cancelPending]
  );

  const refresh = useCallback(() => void fetchNow('user'), [fetchNow]);
  const revalidate = useCallback(() => void fetchNow('background'), [fetchNow]);

  return { list, loading: read.loading, error: read.error, refresh, revalidate, replace };
}
