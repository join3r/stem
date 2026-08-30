import { ForegroundSessionGate } from './session-gate';
import type { PiProcess } from './rpc';
import type { TurnContext } from './normalize';

// One slot of the pi runtime pool: a single `pi --mode rpc` child plus every
// piece of state that is true of THAT process and no other — its active
// session, the model/thinking mirrors of that session, the turn it is
// streaming, and the gate that serializes its foreground-session mutations.
//
// pi RPC holds one mutable active session per process, which is why Stem used
// to hold one process and serialize every thread through it. The pool keeps
// that invariant per WORKER instead: a thread's turns still run one at a time
// (on the worker it is bound to), but two threads on two workers stream
// genuinely in parallel, sharing no mutable session, model, tool-gate, or turn
// state. The pool logic itself — acquisition, affinity, the bound — lives in
// PiRuntime (runtime.ts); this class is deliberately just the per-process
// state so that everything mutable is visibly scoped to one child.

export class PiWorker {
  /** The live child, or null when (re)spawning is needed. */
  proc: PiProcess | null = null;
  /** Coalesces concurrent ensureWorkerStarted() calls. */
  starting: Promise<void> | null = null;
  /** Serializes THIS process's foreground-session mutations (see session-gate.ts). */
  readonly gate = new ForegroundSessionGate();
  /** The pi session this process is on, or null right after spawn/park. */
  activeThreadId: string | null = null;
  /**
   * Model/thinking mirrors of the CURRENTLY active pi session, kept so a turn
   * can skip redundant set_model/set_thinking_level RPCs. Same invalidation
   * discipline as always: null on EVERY session change (new/switch/fork/rollback),
   * or the next turn silently runs on the wrong model.
   */
  currentModel: string | null = null;
  currentThinking: string | null = null;
  /** The turn currently streaming on this process (one at a time per process). */
  currentTurn: TurnContext | null = null;
  /**
   * The last turn that settled on this process, so post-run auto-compaction
   * (which pi runs AFTER agent_end) can still be surfaced on its bubble.
   */
  lastSettledTurn: { threadId: string; turnId: string } | null = null;
  /** The skills revision marker captured at turn start (in-turn write detection). */
  skillsRevAtTurnStart = '';
  /** Gated operations queued or running — the pool's "is this worker free" input. */
  leases = 0;
  /** When the last gated operation finished, for idle reaping. */
  lastUsedAt = Date.now();
  /** Set by the pool when the worker is being retired; a disposed worker is never reused. */
  disposed = false;

  constructor(
    /** Stable per-pool id; names the worker's gate directory and log lines. */
    readonly id: number,
    /**
     * This worker's private directory for the per-turn gate files the bridge
     * extension polls (native-search.json / service-tier.json). Handed to the
     * child as STEM_GATE_DIR: with more than one process alive, a shared gate
     * would let one thread's turn run on another thread's web-search/tier
     * setting — the exact mutable-state sharing the pool exists to end.
     */
    readonly gateDir: string
  ) {}

  /** Free for the pool to hand to another thread: nothing queued, nothing streaming. */
  get idle(): boolean {
    return this.leases === 0 && !this.currentTurn && !this.gate.turnActive;
  }
}
