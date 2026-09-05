// Which threads have a turn running, kept on the phone.
//
// The server already knows this (src/server/live-turns.ts) and says so once, in
// the `snapshot` control frame, at the moment a stream opens. What it does not do
// is send an update every time the answer changes — it does not need to, because
// the events that change it are already on the wire. So this is the same fold as
// the server's, applied to the same events, seeded by the server's answer:
// snapshot for where we came in, events for everything after.
//
// The two questions it exists to separate are the ones a phone cannot answer for
// itself after being away: "this thread is still working" and "this thread
// finished while the screen was off" look identical — both are a thread that
// stopped producing deltas — and only the snapshot tells them apart.
//
// Pure, and keyed by thread id with the TURN id as the value, exactly as the
// server keeps it: the turn id is what a Stop button interrupts, and a thread
// marked as running without one would show a button that cannot do anything.

import type { BackendEventEnvelope, LiveTurn } from '@shared/types';
import { isSettledMethod } from '@shared/settledTurns';

/** Thread id → the turn running in it (empty string when the event carried none). */
export type LiveTurnMap = ReadonlyMap<string, string>;

/** The server's answer, as a map. Replaces whatever the client believed. */
export function liveTurnsFromSnapshot(snapshot: LiveTurn[]): Map<string, string> {
  return new Map(snapshot.map((turn) => [turn.threadId, turn.turnId ?? '']));
}

/** The map as the shared LiveTurn shape, for anything typed against the server's. */
export function liveTurnList(live: LiveTurnMap): LiveTurn[] {
  return [...live].map(([threadId, turnId]) => ({ threadId, turnId: turnId || null }));
}

/**
 * Fold one backend event in. Returns the new map when it changed and the same
 * one when it did not, so a React state setter can compare by identity and not
 * re-render on every streamed token — which is most of the events there are.
 */
export function applyLiveTurnEvent(live: Map<string, string>, event: BackendEventEnvelope): Map<string, string> {
  const params = event.params as { threadId?: string | null; turnId?: string } | undefined;
  const threadId = params?.threadId;
  if (event.method === 'process/exit') {
    // Pool workers report their own thread, or null when they were idle. Only
    // an older, unattributed backend exit means all running turns are gone.
    if (params && 'threadId' in params && threadId == null) return live;
    if (!threadId) return live.size === 0 ? live : new Map();
    if (!live.has(threadId)) return live;
    const next = new Map(live);
    next.delete(threadId);
    return next;
  }
  // Diagnostics such as process/stderr say nothing about whether a turn ended.
  if (!threadId) return live;
  // The same two methods the desktop's follow-me pill treats as "this thread is
  // working": the first item of a turn, or its first token.
  if (event.method === 'item/started' || event.method === 'item/agentMessage/delta') {
    const turnId = params?.turnId ?? live.get(threadId) ?? '';
    if (live.get(threadId) === turnId) return live;
    const next = new Map(live);
    next.set(threadId, turnId);
    return next;
  }
  if (isSettledMethod(event.method)) {
    if (!live.has(threadId)) return live;
    const next = new Map(live);
    next.delete(threadId);
    return next;
  }
  return live;
}
