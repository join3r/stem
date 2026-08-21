import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type {
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpRuntime,
  AcpRuntimeHandle
} from 'acpx/runtime';
import { degrade } from '../degrade';
import { log } from '../log';
import { harnessSessionsDir } from '../workspace/paths';
import type { HarnessEvent } from './format';
import type {
  HarnessEnsureResult,
  HarnessHost,
  HarnessPermissionAsk,
  HarnessRunTurnInput,
  HarnessSessionSpec,
  HarnessTurnHandle,
  HarnessTurnResult,
  HarnessTurnSink
} from './host';

// acpx embedded in the server process: the HarnessHost that runs coding agents
// on the machine Stem itself runs on. Plain node throughout — acpx is loaded
// lazily via dynamic import (it is external in the build, like
// pi-coding-agent, because it spawns adapter CLIs and resolves
// package-relative paths), and nothing here may touch electron.

/** A turn with no self-bound: the client-side ceiling, not a per-call knob. */
export const DEFAULT_MAX_TURN_MS = 2 * 60 * 60_000;

/** ACP option kinds a card decision can translate to an acpx outcome. */
const DECISION_KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always']);

interface LiveTurn {
  sink: HarnessTurnSink;
  /** Session identifiers acpx may cite on a permission request for this turn. */
  sessionIds: Set<string>;
  cancel: (() => void) | null;
  cancelWanted: boolean;
}

export interface HarnessRuntimeConfig {
  stateDir: string;
  /** Registry overrides from settings: agent name -> command line. */
  agentCommands?: Record<string, string>;
  onPermissionRequest: (
    req: AcpPermissionRequest
  ) => Promise<AcpPermissionDecision | undefined> | undefined;
}

export interface LocalHarnessHostOptions {
  stateDir?: string;
  /** Registry overrides from settings: agent name -> command line. */
  agentCommands?: Record<string, string>;
  /** Test seam: a scripted stand-in for the real acpx runtime. */
  runtimeFactory?: (config: HarnessRuntimeConfig) => Promise<AcpRuntime>;
}

export class LocalHarnessHost implements HarnessHost {
  private readonly options: LocalHarnessHostOptions;
  private runtimePromise: Promise<AcpRuntime> | null = null;
  /** sessionId (our acpx sessionKey) -> the live acpx handle. */
  private readonly handles = new Map<string, AcpRuntimeHandle>();
  private readonly liveTurns = new Map<string, LiveTurn>();

  constructor(options: LocalHarnessHostOptions = {}) {
    this.options = options;
  }

  label(): string {
    return 'this server';
  }

  available(): boolean {
    return true;
  }

  private runtime(): Promise<AcpRuntime> {
    if (!this.runtimePromise) {
      const config: HarnessRuntimeConfig = {
        stateDir: this.options.stateDir ?? harnessSessionsDir(),
        ...(this.options.agentCommands ? { agentCommands: this.options.agentCommands } : {}),
        onPermissionRequest: (req) => this.routePermission(req)
      };
      const created = (this.options.runtimeFactory ?? createRealRuntime)(config);
      // A runtime that failed to construct must not poison every later call.
      this.runtimePromise = created.catch((e) => {
        this.runtimePromise = null;
        throw e;
      });
    }
    return this.runtimePromise;
  }

  /** Route an acpx permission request to the sink of the turn that owns it. */
  private routePermission(
    req: AcpPermissionRequest
  ): Promise<AcpPermissionDecision | undefined> | undefined {
    const turn =
      [...this.liveTurns.values()].find((t) => t.sessionIds.has(req.sessionId)) ??
      (this.liveTurns.size === 1 ? [...this.liveTurns.values()][0] : undefined);
    if (!turn) {
      // No live turn claims it: let acpx's mode-based resolver answer, which
      // for approve-reads denies anything that writes or executes.
      log('harness', 'permission request with no live turn, left to the mode resolver', {
        sessionId: req.sessionId
      });
      return undefined;
    }
    const ask = askFromRequest(req);
    return turn.sink.onPermission(ask).then((decision) => {
      if ('expired' in decision) return { outcome: 'cancel' } as const;
      const kind = ask.options.find((o) => o.optionId === decision.optionId)?.kind;
      return kind && DECISION_KINDS.has(kind)
        ? ({ outcome: kind } as AcpPermissionDecision)
        : ({ outcome: 'cancel' } as const);
    });
  }

  async ensureSession(spec: HarnessSessionSpec): Promise<HarnessEnsureResult> {
    try {
      const runtime = await this.runtime();
      // The sessionId doubles as the acpx session key: resuming is reusing the
      // key (acpx's FileSessionStore holds the conversation, warm or cold), and
      // a fresh conversation is simply a fresh key.
      const sessionId = spec.sessionId ?? `${spec.agent}-${randomUUID()}`;
      const handle = await runtime.ensureSession({
        sessionKey: sessionId,
        agent: spec.agent,
        mode: 'persistent',
        cwd: spec.cwd
      });
      if (spec.agent === 'claude') {
        // Verified 2026-08-21 against claude-agent-acp@0.60: the adapter's
        // default `auto` mode self-approves everything it classifies as fine —
        // including rm -rf outside the project — and never raises
        // session/request_permission, so no card would ever appear. `default`
        // surfaces every non-preapproved command; `acceptEdits` additionally
        // keeps file edits silent, which matches the intended split (routine
        // edits run, risky commands raise a card). Fail closed: a claude
        // session that cannot be switched must not run in auto behind the
        // cards' back.
        if (!runtime.setMode) {
          // quiet: best-effort cleanup of a session we are refusing anyway —
          // the refusal on the next line is the signal.
          await runtime.close({ handle, reason: 'setMode unavailable' }).catch(() => undefined);
          return { ok: false, error: 'This acpx runtime cannot set the claude permission mode.' };
        }
        await runtime.setMode({ handle, mode: 'acceptEdits' });
      }
      this.handles.set(sessionId, handle);
      return { ok: true, sessionId };
    } catch (e) {
      // quiet: the returned error IS the answer — the service turns it into
      // the tool result the assistant reads.
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  runTurn(input: HarnessRunTurnInput, sink: HarnessTurnSink): HarnessTurnHandle {
    const live: LiveTurn = {
      sink,
      sessionIds: new Set([input.sessionId]),
      cancel: null,
      cancelWanted: false
    };
    this.liveTurns.set(input.turnId, live);

    const result = (async (): Promise<HarnessTurnResult> => {
      const runtime = await this.runtime();
      let handle = this.handles.get(input.sessionId);
      if (!handle) {
        // A restart dropped the in-memory handle; the FileSessionStore still
        // has the conversation under this key.
        const ensured = await this.ensureSession({
          agent: input.agent,
          cwd: input.cwd,
          sessionId: input.sessionId
        });
        if (!ensured.ok) return { ok: false, error: ensured.error };
        handle = this.handles.get(input.sessionId)!;
      }
      for (const id of [handle.backendSessionId, handle.agentSessionId, handle.acpxRecordId]) {
        if (id) live.sessionIds.add(id);
      }
      const turn = runtime.startTurn({
        handle,
        text: input.prompt,
        mode: 'prompt',
        requestId: input.turnId,
        timeoutMs: input.maxTurnMs ?? DEFAULT_MAX_TURN_MS
      });
      // quiet: a cancel that raced the turn's own end has nothing to cancel;
      // the result below reports whichever won.
      live.cancel = () => void turn.cancel({ reason: 'stopped from Stem' }).catch(() => undefined);
      if (live.cancelWanted) live.cancel();

      let text = '';
      const pump = (async () => {
        for await (const event of turn.events) {
          if (event.type === 'text_delta' && event.stream !== 'thought') text += event.text;
          sink.onEvent([event as HarnessEvent]);
        }
      })();
      const outcome = await turn.result;
      // quiet: closing an already-torn-down stream changes nothing — the
      // result above is the sole authority (spike-proven contract).
      await turn.closeStream({ reason: 'turn settled' }).catch(() => undefined);
      // quiet: same authority argument for a stream that errored mid-pump.
      await pump.catch(() => undefined);

      if (outcome.status === 'completed') return { ok: true, stopReason: 'end_turn', text };
      if (outcome.status === 'cancelled') return { ok: true, stopReason: 'cancelled', text };
      return { ok: false, error: outcome.error.message };
    })()
      // quiet: the contract says result never rejects — a throw anywhere above
      // becomes the {ok: false} the service formats for the assistant.
      .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        this.liveTurns.delete(input.turnId);
      });

    return {
      result,
      cancel: () => {
        const turn = this.liveTurns.get(input.turnId);
        if (!turn) return;
        turn.cancelWanted = true;
        turn.cancel?.();
      }
    };
  }

  async close(): Promise<void> {
    if (!this.runtimePromise) return;
    // quiet: closing a runtime that never came up has nothing to release.
    const runtime = await this.runtimePromise.catch(() => null);
    if (!runtime) return;
    for (const [sessionId, handle] of this.handles) {
      await runtime.close({ handle, reason: 'shutdown' }).catch((e) =>
        // Shutdown must not hang on one stuck adapter; the process exit is the
        // backstop that reaps whatever this leaves.
        degrade('harness', `left the ${sessionId} coding-agent session to the process reaper`, e)
      );
    }
    this.handles.clear();
    this.runtimePromise = null;
  }
}

/** Boil the ACP wire request down to what a card can render. */
function askFromRequest(req: AcpPermissionRequest): HarnessPermissionAsk {
  const raw = req.raw as {
    toolCall?: {
      title?: string;
      kind?: string;
      content?: Array<Record<string, unknown>>;
    };
    options?: Array<{ optionId?: string; kind?: string; name?: string }>;
  };
  const content: HarnessPermissionAsk['content'] = [];
  for (const piece of raw.toolCall?.content ?? []) {
    if (piece.type === 'diff' && typeof piece.path === 'string') {
      content.push({
        type: 'diff',
        path: piece.path,
        ...(typeof piece.oldText === 'string' ? { oldText: piece.oldText } : {}),
        ...(typeof piece.newText === 'string' ? { newText: piece.newText } : {})
      });
    } else if (piece.type === 'content') {
      const inner = piece.content as { type?: string; text?: string } | undefined;
      if (inner?.type === 'text' && typeof inner.text === 'string') {
        content.push({ type: 'text', text: inner.text });
      }
    }
  }
  return {
    permissionId: randomUUID(),
    title: raw.toolCall?.title || 'The coding agent asked for permission',
    ...(raw.toolCall?.kind ? { toolName: raw.toolCall.kind } : {}),
    options: (raw.options ?? [])
      .filter((o): o is { optionId: string; kind?: string; name?: string } => typeof o.optionId === 'string')
      .map((o) => ({ optionId: o.optionId, ...(o.kind ? { kind: o.kind } : {}), ...(o.name ? { name: o.name } : {}) })),
    ...(content.length ? { content } : {})
  };
}

async function createRealRuntime(config: HarnessRuntimeConfig): Promise<AcpRuntime> {
  // Lazy and dynamic on purpose: acpx is external in the build (it spawns
  // adapter CLIs and resolves package-relative paths), and nothing on the
  // server boot path may load it — the boot tripwire runs on a machine where
  // externals resolve only if node_modules is present.
  const { createAcpRuntime, createAgentRegistry, createFileSessionStore } = await import('acpx/runtime');
  await mkdir(config.stateDir, { recursive: true });
  return createAcpRuntime({
    cwd: config.stateDir,
    sessionStore: createFileSessionStore({ stateDir: config.stateDir }),
    agentRegistry: createAgentRegistry(
      config.agentCommands ? { overrides: config.agentCommands } : undefined
    ),
    // For agents without their own mode story (anything but claude): reads
    // auto-approve, writes and commands land on onPermissionRequest (the card),
    // and this resolver is only the fallback when no live turn claims the ask.
    permissionMode: 'approve-reads',
    onPermissionRequest: (req) => Promise.resolve(config.onPermissionRequest(req))
  });
}
