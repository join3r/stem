// One conversation, live: the transcript on disk plus everything the stream has
// said since, folded by the same reducer the desktop uses.
//
// The fold is @shared/chatState — lifted out of the renderer for this. Nothing
// about turn assembly is re-decided here; what this file owns is the three
// wirings that fold needs and cannot do for itself:
//
//   1. HYDRATE. `chats:open` reads a file, and events keep arriving while it is
//      being read. mergeHydratedThread reconciles the two, and it needs the
//      slice as it stood when the request went out — hence `stateAtRequest`.
//      Identity, not a flag: a whole turn can start and settle during the read,
//      leaving `running` false again at both ends.
//   2. FILTER. Every device gets every frame (the server broadcasts; see
//      src/server/transport/server.ts), so this screen drops everything whose
//      threadId is not its own. That is by design and not a waste: it is the
//      same wire the chat list is reading for other threads.
//   3. SEED. A thread opened while a turn is already running has no events yet
//      to say so, and may not get one for a minute if the model is thinking.
//      The `snapshot` frame is the only thing that knows, so the running flag
//      and the id Stop interrupts both fall back to it.
//
// WHAT IS SIMPLER THAN THE DESKTOP'S, deliberately: there are no drafts (this
// hook only ever opens threads that exist — a chat started on the phone becomes
// a real thread before navigation reaches here, see app/new.tsx), so there is no
// draft→real migration and no generation counter. The pending-send rule that
// survives is the one that matters — Stop must interrupt a turn whose startTurn
// has not returned yet, rather than pretending locally that it stopped while the
// backend keeps going (src/renderer/pendingTurn.ts, interruptibleTurnId). That
// is `pending.turnId` below, a promise rather than a mutated field so the
// microtask ordering it depends on is written down instead of relied upon.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_STATE,
  appendSystemMessage,
  applyBackendEventToThread,
  applyProcessExitToThread,
  backendEventThreadId,
  mergeHydratedThread,
  type ThreadState
} from '@shared/chatState';
import type { ChatMessage } from '@shared/types';
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
import { applyStartTurnResult, interruptTarget, settleAgainstSnapshot } from '../chat/turns';
import { isUnreachable } from '../transport/connection';
import { createEventBatcher } from '../transport/eventBatcher';
import { useTransport } from '../transport/provider';
import { useLiveTurns } from './useLiveTurns';

export interface ThreadView {
  state: ThreadState;
  title: string;
  /**
   * The transcript is being read. False once it has been, even if it failed —
   * and false while there is nothing to read at all, which an unpaired phone
   * waiting on its Keychain is.
   */
  loading: boolean;
  /** Failure to READ the thread. Turn failures arrive as system bubbles instead. */
  error: string | null;
  /** A turn is running: this screen's events say so, or the snapshot does. */
  running: boolean;
  /** A send is in flight but startTurn has not answered yet. */
  sending: boolean;
  /** Why the connection makes sending impossible, or null when it doesn't. */
  blocked: string | null;
  /** `personaId` = send this turn AS that persona (one the user opened to clients). */
  send(text: string, personaId?: string | null): void;
  interrupt(): void;
  reload(): void;
}

/** An in-flight startTurn, kept only so Stop can wait for the id it minted. */
interface PendingSend {
  /** The turn id once the server answers, or null if the send failed. */
  turnId: Promise<string | null>;
}

export function useThread(threadId: string): ThreadView {
  const { connection, status } = useTransport();
  const live = useLiveTurns();

  const [state, setState] = useState<ThreadState>(EMPTY_STATE);
  const [title, setTitle] = useState('');
  const [sending, setSending] = useState(false);

  // The reducer is applied from callbacks that also need to READ the current
  // slice (hydration's stateAtRequest, Stop's activeTurnId), and a setter's
  // argument is not readable outside it — so the ref is the source and the state
  // is its mirror. One writer (`apply`) keeps them from parting company.
  const stateRef = useRef<ThreadState>(EMPTY_STATE);
  const apply = useCallback((next: (prev: ThreadState) => ThreadState) => {
    stateRef.current = next(stateRef.current);
    setState(stateRef.current);
  }, []);

  // The transcript read, same shape and same rules as the chat list's — and read
  // back from a ref for the same reason the slice above is (../chat/reads.ts).
  //
  // Paired at mount means the effect below is about to make a request, and
  // starting out already loading is the difference between opening a thread on a
  // spinner and opening it on one frame of “Nothing in this chat yet”.
  const [read, setRead] = useState<ReadState>(() => (status.paired ? readStarted(IDLE_READ) : IDLE_READ));
  const readRef = useRef<ReadState>(read);
  const applyRead = useCallback((next: (prev: ReadState) => ReadState) => {
    readRef.current = next(readRef.current);
    setRead(readRef.current);
  }, []);

  const pending = useRef<PendingSend | null>(null);
  const nonce = useRef(0);

  const liveTurnId = live.get(threadId) ?? null;
  const liveTurnRef = useRef<string | null>(liveTurnId);
  liveTurnRef.current = liveTurnId;

  // A background read that could not reach the server, or that the cache
  // answered for it, leaves the transcript of unknown age. Rather than retry on
  // a timer, the next stream opening (the link is demonstrably back) reads once
  // more — see the effect on `status.streaming` below.
  const needsFreshRead = useRef(false);

  const load = useCallback(
    async (cause: ReadCause) => {
      if (!status.paired) {
        // There is nothing to ask yet, and that is not a failure — but it is not a
        // read in progress either. Leaving `loading` set here is what made a cold
        // launch straight into a thread (a notification tap, a deep link) spin
        // forever: the Keychain had not answered when this first ran, and nothing
        // ever ran it again. Pairing is this callback's dependency now, so the
        // effect below re-runs and turns this into a real read the moment a
        // credential exists.
        applyRead(readIdle);
        return;
      }
      applyRead(readStarted);
      const mine = readRef.current.request;
      const stateAtRequest = stateRef.current;
      try {
        const history = await connection.rpc('chats:open', threadId);
        if (!isCurrent(readRef.current, mine)) return;
        setTitle(history.title);
        if (history.offline && stateRef.current.hydrated) {
          // The cache spoke for the server, and there is already a transcript
          // on screen — one that may hold a bubble the cache has never seen (a
          // message sent seconds before the phone went to sleep). A copy that
          // is stale by definition does not replace it; the next stream opening
          // reads the real thing.
          needsFreshRead.current = true;
          applyRead((prev) => readSettled(prev, mine, null));
          return;
        }
        apply((liveState) => mergeHydratedThread(history.messages, liveState, stateAtRequest));
        applyRead((prev) => readSettled(prev, mine, null));
        // The cache spoke for an empty screen. Fine to show, not fine to stop at.
        needsFreshRead.current = history.offline === true;
      } catch (e) {
        if (shouldAbandon(cause, isUnreachable(e), connection.status().reachable)) {
          needsFreshRead.current = true;
          applyRead((prev) => readAbandoned(prev, mine));
          return;
        }
        applyRead((prev) => readSettled(prev, mine, e));
      }
    },
    [apply, applyRead, connection, status.paired, threadId]
  );

  // Opening a different thread is a different conversation, not a refresh: drop
  // the old slice before the new transcript arrives so no bubble from the
  // previous thread is ever on screen under this one's title.
  useEffect(() => {
    applyRead(readIdle);
    stateRef.current = EMPTY_STATE;
    setState(EMPTY_STATE);
    setTitle('');
    needsFreshRead.current = false;
    void load('user');
  }, [applyRead, load]);

  useEffect(() => {
    if (!status.streaming || !needsFreshRead.current) return;
    needsFreshRead.current = false;
    void load('background');
  }, [status.streaming, load]);

  useEffect(() => {
    const batcher = createEventBatcher((event) =>
      apply((prev) => applyBackendEventToThread(prev, event) ?? prev)
    );
    const offEvent = connection.onBackendEvent((event) => {
      const eventThread = backendEventThreadId(event);
      // A thread-less event is the backend itself going away, and it ends every
      // turn there is — including this one, whether or not it was named.
      if (eventThread === undefined) {
        batcher.flush();
        apply(applyProcessExitToThread);
        return;
      }
      if (eventThread !== threadId) return;
      batcher.push(event);
    });
    // Resync means the stream could not be resumed, so the deltas that would
    // have completed this transcript are gone. Re-reading it is the only honest
    // answer, and the same one every other screen gives. Wake is the phone
    // saying the same thing about itself — it was not watching — and gets the
    // same read.
    const offResync = connection.onResync(() => void load('background'));
    const offWake = connection.onWake(() => void load('background'));
    // The snapshot is the only thing that can tell a turn still running from one
    // that finished while the phone was asleep; see settleAgainstSnapshot. Any
    // frames the batcher holds are older than the snapshot and go first.
    const offSnapshot = connection.onLiveTurns((snapshot) => {
      batcher.flush();
      apply((prev) => settleAgainstSnapshot(prev, snapshot, threadId, pending.current !== null));
    });
    return () => {
      offEvent();
      offResync();
      offWake();
      offSnapshot();
      batcher.flush();
    };
  }, [apply, connection, load, threadId]);

  const send = useCallback(
    (text: string, personaId?: string | null) => {
      const input = text.trim();
      if (!input || pending.current) return;
      // A turn already running on this thread — ours or one started at the desk.
      // The backend refuses a second one, so accepting the text here would only
      // produce a bubble that fails a round trip later.
      if (stateRef.current.running || liveTurnRef.current !== null) return;

      // The optimistic bubble carries no turnId yet; the answer stamps one on so
      // a later failure can be traced to the message that caused it.
      const id = `user-${Date.now()}-${++nonce.current}`;
      const optimistic: ChatMessage = {
        id,
        role: 'user',
        content: input,
        createdAt: new Date().toISOString()
      };
      apply((prev) => ({
        ...prev,
        messages: [...prev.messages, optimistic],
        running: true,
        status: 'running'
      }));

      setSending(true);
      // Declared before the chain that closes over it: the `finally` must only
      // clear `pending` if it is still the send that set it.
      let entry: PendingSend | null = null;
      const started = connection
        // No `format`: StartTurnInput defaults to 'mdx', which is what the desk
        // asks for and what src/mdx/ now renders. Step 5 pinned this to 'md'
        // while the component map did not exist yet.
        .rpc('backend:startTurn', { input, threadId, ...(personaId ? { personaId } : {}) })
        .then(
          (result) => {
            // One fold for both answers a send can get: a turn to wait for, or a
            // reply the server has already handled and no turn at all — the
            // second of which has to end the optimistic `running` set above,
            // because no event ever will. See ../chat/turns.ts.
            const outcome = applyStartTurnResult(stateRef.current, result, id);
            apply(() => outcome.state);
            return outcome.turnId;
          },
          (e: unknown) => {
            // The send never became a turn (offline, or the agent is already
            // busy). Mark the bubble so it does not look sent, and say why —
            // the same split the desktop makes with `sendFailed`.
            apply((prev) =>
              appendSystemMessage(
                {
                  ...prev,
                  messages: prev.messages.map((m) => (m.id === id ? { ...m, sendFailed: true } : m))
                },
                e
              )
            );
            return null;
          }
        )
        .finally(() => {
          if (pending.current === entry) pending.current = null;
          setSending(false);
        });
      entry = { turnId: started };
      pending.current = entry;
    },
    [apply, connection, threadId]
  );

  const interrupt = useCallback(async () => {
    // Prefer what the stream has already told us; fall back to the snapshot for a
    // turn that started before this screen was listening; and if a send is still
    // in the air, wait for the id it is about to mint rather than giving up.
    let turnId = stateRef.current.activeTurnId ?? liveTurnRef.current ?? null;
    if (!turnId && pending.current) turnId = await pending.current.turnId;
    // Read AFTER the await: the send that was in the air has landed by now, and
    // whether this thread is still running is the question that decides whether
    // there is an older turn worth aiming at (interruptTarget in ../chat/turns.ts).
    if (!turnId) turnId = interruptTarget(stateRef.current);
    if (!turnId) return;
    try {
      await connection.rpc('backend:interruptTurn', turnId);
    } catch (e) {
      apply((prev) => appendSystemMessage(prev, e));
    }
  }, [apply, connection]);

  const running = state.running || liveTurnId !== null;
  // Offline composing is blocked rather than queued: there is no sync layer on
  // this phone by design, so a message accepted here would be a message that
  // exists nowhere else and might never be sent.
  const blocked = useMemo(() => {
    if (!status.paired) return 'This phone is not paired with a server.';
    if (status.unauthorized) return 'This phone’s pairing was rejected. Pair it again.';
    if (!status.reachable) return 'Offline — messages can’t be sent from here.';
    return null;
  }, [status.paired, status.reachable, status.unauthorized]);

  return {
    state,
    title,
    loading: read.loading,
    error: read.error,
    running,
    sending,
    blocked,
    send,
    interrupt: () => void interrupt(),
    reload: () => void load('user')
  };
}
