import type { LiveTurnInfo, StartTurnInput, TurnOrigin } from '../../shared/types';
import { eventTurnId, isSettledMethod, SETTLED_TURN_CAP } from '../../shared/settledTurns';

export interface PillEventParams {
  threadId?: string | null;
  turnId?: string;
  turn?: { id?: string };
  origin?: TurnOrigin;
  mail?: boolean;
  scheduled?: unknown;
}

/** Tracks turns, never conversation ownership. Only a local submission or an
 * authenticated origin can qualify; a reconnect snapshot replaces active state. */
export class PillTurns {
  private deviceId: string | null = null;
  private verified = false;
  private active = new Map<string, LiveTurnInfo>();
  private pending = new Set<string>();
  private submitted = new Set<string>();
  private settled = new Set<string>();

  get connected(): boolean { return this.verified; }
  get turns(): LiveTurnInfo[] { return this.verified ? [...this.active.values()] : []; }

  submit(input: StartTurnInput): void {
    if (input.turnId && !input.mail && !input.scheduled) {
      this.pending.add(input.turnId);
      this.submitted.add(input.turnId);
    }
  }

  accepted(turnId: string): void {
    // A start response proves acceptance, not that the turn is STILL running.
    this.pending.delete(turnId);
  }

  abandon(turnId: string): void {
    this.pending.delete(turnId);
    this.submitted.delete(turnId);
    this.active.delete(turnId);
    this.retire(turnId);
  }

  disconnect(): void { this.verified = false; }

  reconcile(deviceId: string, turns: LiveTurnInfo[]): void {
    this.deviceId = deviceId;
    const next = new Map<string, LiveTurnInfo>();
    for (const turn of turns) {
      if (turn.turnId && this.isLocal(turn) && !this.settled.has(turn.turnId)) next.set(turn.turnId, turn);
    }
    for (const id of new Set([...this.active.keys(), ...this.submitted])) {
      if (!next.has(id) && !this.pending.has(id)) this.retire(id);
    }
    this.active = next;
    this.verified = true;
  }

  private isLocal(p: { turnId?: string | null; origin?: TurnOrigin; mail?: boolean; scheduled?: unknown }): boolean {
    if (p.mail || p.scheduled || (p.origin && p.origin.kind !== 'interactive')) return false;
    if (p.origin?.deviceId) return p.origin.deviceId === this.deviceId;
    return !!p.turnId && this.submitted.has(p.turnId);
  }

  /** True when an event belongs to a tracked local turn. Terminal events remove
   * that exact turn; another turn in the same conversation is unaffected. */
  event(method: string, p: PillEventParams): boolean {
    if (!this.verified) {
      const id = eventTurnId(p);
      if (id && isSettledMethod(method)) this.abandon(id);
      return false; // Replay may retire old IDs, but never shows or chimes.
    }
    if (method === 'process/exit') {
      if ('threadId' in p && !p.threadId) return false; // idle worker retirement
      const affected = [...this.active.values()].filter(t => !p.threadId ||
        (t.threadId === p.threadId && (!p.turnId || t.turnId === p.turnId)));
      for (const t of affected) this.abandon(t.turnId!);
      return affected.length > 0;
    }
    const id = eventTurnId(p);
    if (!id || !p.threadId || this.settled.has(id)) return false;
    if (p.mail || p.scheduled || (p.origin && p.origin.kind !== 'interactive')) return false;
    const tracked = this.active.has(id);
    if (isSettledMethod(method)) {
      // Remember even a very fast completion that preceded its first item.
      const submitted = this.submitted.has(id);
      if (tracked || this.isLocal({ ...p, turnId: id })) this.abandon(id);
      return tracked || submitted;
    }
    if (!tracked && !this.isLocal(p)) return false;
    if (method === 'item/started' || method === 'item/agentMessage/delta') {
      this.active.set(id, { threadId: p.threadId, turnId: id, origin: p.origin });
      return true;
    }
    return tracked;
  }

  private retire(id: string): void {
    this.submitted.delete(id);
    this.settled.add(id);
    if (this.settled.size > SETTLED_TURN_CAP) this.settled.delete(this.settled.values().next().value!);
  }
}
