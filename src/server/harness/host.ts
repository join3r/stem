import type { HarnessApprovalContent, HarnessApprovalOption } from '../../shared/types';
import type { HarnessEvent } from './format';

// The host-agnostic contract between HarnessService and whatever actually runs
// the coding agent: acpx embedded in this process (local-host.ts) or a paired
// desktop reached over the wire (device-host.ts). The service implements
// policy, sessions, approvals and result formatting ONCE against this
// interface; a host only ensures sessions, runs turns, and streams what
// happened into the sink.

export interface HarnessSessionSpec {
  agent: string;
  cwd: string;
  /**
   * The host's own identifier from a previous ensure, to resume that
   * conversation; absent starts a fresh one. Opaque to the service — the
   * local host uses it as its acpx session key, a device answers whatever
   * its own ensure minted.
   */
  sessionId?: string;
  /**
   * Model pin for the agent (alias or full id, e.g. "claude-fable-5"), from
   * the server's harness settings. Absent = whatever the agent defaults to.
   */
  model?: string;
}

export type HarnessEnsureResult = { ok: true; sessionId: string } | { ok: false; error: string };

/** An escalated permission ask, host-independent (ACP request boiled down). */
export interface HarnessPermissionAsk {
  /** Idempotency key minted by whoever raised it (retried device asks reuse it). */
  permissionId: string;
  title: string;
  toolName?: string;
  /** Exact shell input for a kind-'execute' ask (ACP rawInput.command); the approval tiers key off it. */
  command?: string;
  description?: string;
  options: HarnessApprovalOption[];
  content?: HarnessApprovalContent[];
}

/** `expired` means nobody answered — distinct from a person choosing reject. */
export type HarnessPermissionDecision = { optionId: string } | { expired: true };

export interface HarnessTurnSink {
  onEvent(events: HarnessEvent[]): void;
  onPermission(ask: HarnessPermissionAsk): Promise<HarnessPermissionDecision>;
}

export type HarnessTurnResult =
  | { ok: true; stopReason: 'end_turn' | 'cancelled' | 'max_turn'; text: string }
  | { ok: false; error: string };

export interface HarnessTurnHandle {
  /** Never rejects; every failure settles as `{ok: false}`. */
  result: Promise<HarnessTurnResult>;
  /** Graceful ACP turn cancel, idempotent. The session stays usable. */
  cancel(): void;
}

export interface HarnessRunTurnInput {
  turnId: string;
  agent: string;
  cwd: string;
  sessionId: string;
  prompt: string;
  /** Model pin, carried so a restart's re-ensure keeps it (same as the spec's). */
  model?: string;
  maxTurnMs?: number;
}

export interface HarnessHost {
  /** "this server", or the hosting device's label. */
  label(): string;
  /**
   * Platform the agent's commands run on, when known — the approval judge and
   * classifier reason against that shell. Absent/undefined = generic label.
   */
  platform?(): NodeJS.Platform | undefined;
  available(): boolean;
  ensureSession(spec: HarnessSessionSpec): Promise<HarnessEnsureResult>;
  runTurn(input: HarnessRunTurnInput, sink: HarnessTurnSink): HarnessTurnHandle;
  close(): Promise<void>;
}
