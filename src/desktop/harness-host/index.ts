import { join } from 'node:path';
import { log } from '../../server/log';
import { host } from '../../server/host';
import { LocalHarnessHost } from '../../server/harness/local-host';
import type { HarnessEvent } from '../../server/harness/format';
import type { HarnessPermissionDecision, HarnessTurnHandle } from '../../server/harness/host';
import type {
  DeviceHarnessCancel,
  DeviceHarnessEventAck,
  DeviceHarnessEventBatch,
  DeviceHarnessPermissionAsk,
  DeviceHarnessRequest,
  HarnessHostLocalState
} from '../../shared/types';
import { readHarnessHostEnabled, writeHarnessHostEnabled } from './store';

// The client half of coding_agent's `device` target: THIS machine, running a
// harness turn its Stem server sent over the addressed frame. The acpx
// embedding is the same LocalHarnessHost the server uses (exec-host's reuse
// argument: same adapters, same session store shape, same behavior wherever a
// turn runs) — its state root is just this machine's, and the plan's separate
// runtime.ts collapsed into that reuse.
//
// What this file trusts and what it does not: the frames arrived over this
// client's own authenticated stream, and the policy (settings gate, protected
// roots, approval routing) ran on the server. What it never delegates is the
// consent: the switch is read fresh from this disk on EVERY request (store.ts)
// and never goes on the wire. Cancel is the one thing honored with the switch
// off — cancelling reduces activity.

/** Flush cadence for live events; an empty flush every 15s is the heartbeat. */
const FLUSH_MS = 250;
const FLUSH_MAX_EVENTS = 64;
const HEARTBEAT_MS = 15_000;
/** The client-enforced overall turn bound (the server deliberately has none). */
const DEVICE_MAX_TURN_MS = 2 * 60 * 60_000;
/** Retry cadence for the blocking permission RPC after transport errors. */
const PERMISSION_RETRY_DELAY_MS = 2_000;
const PERMISSION_RETRIES = 6;
/** Seen requestIds kept for dedupe across reconnect stream overlap. */
const SEEN_CAP = 512;

export interface HarnessHostDeps {
  /** Call a server channel through the proxy (late-bound, like the exec host's). */
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  /** Test seam: a LocalHarnessHost built over a scripted acpx runtime. */
  acpxFactory?(): LocalHarnessHost;
}

export interface DesktopHarnessHost {
  /** Announce on launch. */
  start(): Promise<void>;
  /** Re-announce — the stream reconnected, and the server may have restarted. */
  refresh(): Promise<void>;
  /** An ensure/run arrived on the event stream. Never throws; answers over RPC. */
  onRequest(request: DeviceHarnessRequest): void;
  /** A cancel frame arrived. Honored even with the consent switch off. */
  onCancel(cancel: DeviceHarnessCancel): void;
  localState(): Promise<HarnessHostLocalState>;
  /** The switch. Persists locally, then tells the server. */
  setEnabled(enabled: boolean): Promise<HarnessHostLocalState>;
  /** Cancel live turns and close the adapters (app quit). */
  close(): Promise<void>;
}

interface LiveTurn {
  handle: HarnessTurnHandle;
  flush: () => Promise<void>;
  stopTimers: () => void;
}

export function createDesktopHarnessHost(deps: HarnessHostDeps): DesktopHarnessHost {
  const platform = (
    process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux'
  ) as 'darwin' | 'linux' | 'win32';

  // Lazy for the same reason the server's is: acpx loads on first use only.
  let acpx: LocalHarnessHost | null = null;
  const acpxHost = (): LocalHarnessHost => {
    acpx ??=
      deps.acpxFactory?.() ?? new LocalHarnessHost({ stateDir: join(host().stateRoot(), 'harness-sessions') });
    return acpx;
  };

  const liveTurns = new Map<string, LiveTurn>();
  /** Reconnect overlap can deliver one frame on two streams; first one wins. */
  const seen = new Set<string>();
  const dedupe = (requestId: string): boolean => {
    if (seen.has(requestId)) return true;
    seen.add(requestId);
    while (seen.size > SEEN_CAP) {
      const oldest = seen.values().next().value as string | undefined;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    return false;
  };

  async function announce(): Promise<void> {
    const enabled = await readHarnessHostEnabled();
    await deps.invoke('harnessHost:announce', [{ enabled, platform }]).catch((e) => {
      // An older server has no such channel; this machine simply cannot be a
      // target there, which is also what the server will say if asked.
      log('harness-host', 'could not announce', { error: e instanceof Error ? e.message : String(e) });
    });
  }

  function deliverResult(requestId: string, result: unknown): void {
    void deps.invoke('harnessHost:result', [requestId, result]).catch((e) => {
      // The server's own timeouts cover a result that never lands.
      log('harness-host', 'could not deliver a result', {
        error: e instanceof Error ? e.message : String(e)
      });
    });
  }

  /** The blocking card round-trip, retried with the SAME permissionId. */
  async function askPermission(ask: DeviceHarnessPermissionAsk): Promise<HarnessPermissionDecision> {
    for (let attempt = 0; ; attempt++) {
      try {
        const raw = (await deps.invoke('harnessHost:permission', [ask])) as
          | { optionId?: unknown; expired?: unknown }
          | null;
        if (raw && typeof raw.optionId === 'string') return { optionId: raw.optionId };
        return { expired: true };
      } catch (e) {
        // A transport drop mid-card: the server's decided map makes this retry
        // idempotent, and joining the same in-flight ask never doubles a card.
        if (attempt >= PERMISSION_RETRIES) {
          log('harness-host', 'gave up asking for permission', {
            error: e instanceof Error ? e.message : String(e)
          });
          return { expired: true };
        }
        await new Promise((resolve) => setTimeout(resolve, PERMISSION_RETRY_DELAY_MS));
      }
    }
  }

  function runTurn(request: Extract<DeviceHarnessRequest, { op: 'run' }>): void {
    let queue: HarnessEvent[] = [];
    let seq = 0;
    let awaitingPermission = false;
    let stopped = false;
    let flushTimer: NodeJS.Timeout | null = null;

    const post = async (events: HarnessEvent[], firstSeq: number): Promise<void> => {
      try {
        const ack = (await deps.invoke('harnessHost:event', [
          {
            turnId: request.requestId,
            firstSeq,
            events,
            state: awaitingPermission ? 'awaiting-permission' : 'running'
          } satisfies DeviceHarnessEventBatch
        ])) as DeviceHarnessEventAck | null;
        // The ack is the lost-cancel fallback — and how this client learns its
        // server restarted and no longer knows the turn.
        if (ack?.action === 'cancel') live?.handle.cancel();
      } catch (e) {
        // Events are best-effort by design; the result POST is what matters.
        log('harness-host', 'an event batch did not land', {
          error: e instanceof Error ? e.message : String(e)
        });
      }
    };

    const flush = async (): Promise<void> => {
      if (!queue.length) return post([], seq);
      const events = queue;
      const firstSeq = seq + 1;
      seq += events.length;
      queue = [];
      await post(events, firstSeq);
    };

    const heartbeat = setInterval(() => {
      if (!stopped) void flush();
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const scheduleFlush = (): void => {
      if (queue.length >= FLUSH_MAX_EVENTS) {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        void flush();
        return;
      }
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush();
      }, FLUSH_MS);
      flushTimer.unref?.();
    };

    const handle = acpxHost().runTurn(
      {
        turnId: request.requestId,
        agent: request.agent,
        cwd: request.cwd,
        sessionId: request.sessionId,
        prompt: request.prompt,
        ...(request.model ? { model: request.model } : {}),
        maxTurnMs: request.maxTurnMs ?? DEVICE_MAX_TURN_MS
      },
      {
        onEvent: (events) => {
          if (stopped) return;
          queue.push(...events);
          scheduleFlush();
        },
        onPermission: async (ask) => {
          awaitingPermission = true;
          try {
            return await askPermission({
              turnId: request.requestId,
              permissionId: ask.permissionId,
              title: ask.title,
              ...(ask.toolName ? { toolName: ask.toolName } : {}),
              ...(ask.command ? { command: ask.command } : {}),
              ...(ask.description ? { description: ask.description } : {}),
              options: ask.options,
              ...(ask.content ? { content: ask.content } : {})
            });
          } finally {
            awaitingPermission = false;
          }
        }
      }
    );

    const live: LiveTurn = {
      handle,
      flush,
      stopTimers: () => {
        stopped = true;
        clearInterval(heartbeat);
        if (flushTimer) clearTimeout(flushTimer);
      }
    };
    liveTurns.set(request.requestId, live);

    void handle.result.then(async (result) => {
      liveTurns.delete(request.requestId);
      // Drain what is left before the terminal answer, so finalSeq is honest.
      await flush().catch(() => undefined);
      live.stopTimers();
      if (result.ok) {
        deliverResult(request.requestId, {
          ok: true,
          stopReason: result.stopReason,
          text: result.text,
          finalSeq: seq
        });
      } else {
        deliverResult(request.requestId, { ok: false, error: result.error });
      }
    });
  }

  return {
    async start() {
      await announce();
    },

    refresh: () => announce(),

    onRequest(request) {
      if (!request || typeof request.requestId !== 'string' || dedupe(request.requestId)) return;
      void (async () => {
        // The gate, read fresh from this disk on every request. The server
        // refuses these before sending under normal operation; this copy is
        // the authoritative one, held by the machine the agent would run on.
        if (!(await readHarnessHostEnabled())) {
          deliverResult(request.requestId, {
            ok: false,
            error:
              'This computer does not run coding agents for Stem. The switch is in Settings → Chat → ' +
              'Coding agents, on this computer.'
          });
          return;
        }
        if (request.op === 'ensure') {
          const ensured = await acpxHost().ensureSession({
            agent: request.agent,
            cwd: request.cwd,
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
            ...(request.model ? { model: request.model } : {})
          });
          deliverResult(
            request.requestId,
            ensured.ok ? { ok: true, sessionId: ensured.sessionId } : { ok: false, error: ensured.error }
          );
          return;
        }
        runTurn(request);
      })();
    },

    onCancel(cancel) {
      const live = liveTurns.get(cancel?.turnId ?? '');
      // Cancel maps to ACP's graceful turn cancel, never a process signal, and
      // is honored even with the switch off: cancelling reduces activity.
      live?.handle.cancel();
    },

    localState: async () => ({ enabled: await readHarnessHostEnabled() }),

    async setEnabled(enabled) {
      await writeHarnessHostEnabled(enabled);
      await announce();
      return { enabled };
    },

    async close() {
      for (const live of liveTurns.values()) {
        live.stopTimers();
        live.handle.cancel();
      }
      liveTurns.clear();
      await acpx?.close();
    }
  };
}
