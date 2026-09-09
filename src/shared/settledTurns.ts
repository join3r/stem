// The settled-turn race guard for the renderer's session orchestration.
//
// A turn can finish before the call that started it has returned, and the
// renderer would then resurrect `activeTurnId` from the late response. The main
// process had the same problem while its busy marks came from start-turn
// responses; server/live-turns.ts folds them out of the event stream instead, so
// the ordering cannot arise there any more and only this side needs the guard.
//
// Always keyed by TURN id, never thread id: thread ids recur across turns, so a
// settled thread would suppress the *next* turn's bookkeeping.

/** Bound on the defensive settled-turn race set. Entries normally disappear when
 * their matching start response arrives a moment later. */
export const SETTLED_TURN_CAP = 256;

export type TurnSettledMethod = 'turn/completed' | 'turn/failed' | 'turn/aborted';

export function isSettledMethod(method: string): method is TurnSettledMethod {
  return method === 'turn/completed' || method === 'turn/failed' || method === 'turn/aborted';
}

/** Item events use turnId; canonical terminal events use turn.id. */
export function eventTurnId(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const p = params as { turnId?: unknown; turn?: { id?: unknown } };
  return typeof p.turnId === 'string' ? p.turnId : typeof p.turn?.id === 'string' ? p.turn.id : undefined;
}

/** Terminal events can beat the start-turn IPC response on very fast turns.
 * Remember them briefly so the late response cannot resurrect activeTurnId. */
export class SettledTurns {
  private ids = new Set<string>();

  note(turnId: string): void {
    this.ids.add(turnId);
    if (this.ids.size > SETTLED_TURN_CAP) {
      const oldest = this.ids.values().next().value as string | undefined;
      if (oldest) this.ids.delete(oldest);
    }
  }

  /** True (and forgets the id) when this turn already settled — i.e. its terminal
   * event beat the start IPC response. */
  consume(turnId: string | null | undefined): boolean {
    return turnId ? this.ids.delete(turnId) : false;
  }
}
