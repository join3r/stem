import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { degrade } from '../degrade';
import { log } from '../log';
import { connectedDeviceIds, pushToDevice } from '../startup/transport';
import { harnessDeviceHostsPath } from '../workspace/paths';
import {
  HARNESS_CANCEL_FRAME,
  HARNESS_REQUEST_FRAME,
  type DeviceHarnessAnnouncement,
  type DeviceHarnessCancel,
  type DeviceHarnessEventAck,
  type DeviceHarnessEventBatch,
  type DeviceHarnessHostEntry,
  type DeviceHarnessPermissionAsk,
  type DeviceHarnessPermissionDecision,
  type DeviceHarnessRequest,
  type DeviceHarnessResult
} from '../../shared/types';
import type { HarnessEvent } from './format';
import type {
  HarnessEnsureResult,
  HarnessHost,
  HarnessRunTurnInput,
  HarnessSessionSpec,
  HarnessTurnHandle,
  HarnessTurnResult,
  HarnessTurnSink
} from './host';

// The server's half of a coding_agent turn that runs on a paired computer.
//
// Ownership split (the whole wire design in two sentences): the CLIENT owns the
// acpx runtime, the session store and the child processes, and enforces the
// only overall turn bound (maxTurnMs); the SERVER owns the session mapping and
// an in-memory pending map per turn, so a server restart mid-turn is a graceful
// kill, not a recovery — the client's next event POST names an unknown turnId
// and is answered {action: 'cancel'}, and the session itself survives.
//
// Streaming rides client->server POSTs (own connections, individually acked)
// so an SSE drop mid-turn loses nothing of the run; the addressed leg carries
// only ensure/run/cancel. There is no client event buffer and no re-poll
// protocol: event gaps are log lines, and `result` is the sole authority.

/** Availability probe: an ensure that got no answer in this long is refused. */
const ENSURE_TIMEOUT_MS = 30_000;
/** After `run` goes out, the first event/heartbeat must arrive within this. */
const FIRST_LIFE_TIMEOUT_MS = 30_000;
/** Rolling idle bound; the client heartbeats every 15s, so 90s means gone. */
const IDLE_TIMEOUT_MS = 90_000;
/** After a cancel frame, how long the client has to confirm before we settle. */
const CANCEL_WINDDOWN_MS = 15_000;
/** How long a decided permission answer stays replayable for RPC retries. */
const DECIDED_TTL_MS = 5 * 60_000;

interface PendingEnsure {
  kind: 'ensure';
  deviceId: string;
  settle(result: HarnessEnsureResult): void;
  timer: NodeJS.Timeout;
}

interface PendingTurn {
  kind: 'turn';
  deviceId: string;
  sink: HarnessTurnSink;
  settle(result: HarnessTurnResult): void;
  /** First-life, then rolling idle; re-armed on every POST that cites the turn. */
  timer: NodeJS.Timeout;
  lastSeq: number;
  cancelWanted: boolean;
  cancelTimer: NodeJS.Timeout | null;
  /** In-flight asks by permissionId, so an RPC retry joins the same card. */
  asks: Map<string, Promise<DeviceHarnessPermissionDecision>>;
  /** Settled asks kept briefly, so a retry after the card closed still answers. */
  decided: Map<string, DeviceHarnessPermissionDecision>;
}

type Pending = PendingEnsure | PendingTurn;

export interface HarnessHostStore {
  read(): Promise<Record<string, DeviceHarnessHostEntry>>;
  write(next: Record<string, DeviceHarnessHostEntry>): Promise<void>;
}

export interface HarnessDeviceRouterDeps {
  pushTo(deviceId: string, name: string, data: unknown): number;
  connectedDevices(): Set<string>;
  store: HarnessHostStore;
}

export interface HarnessDeviceRouter {
  /** Record a device's account of whether it runs coding agents. */
  announce(deviceId: string, report: unknown): Promise<void>;
  hostFor(deviceId: string): Promise<DeviceHarnessHostEntry | null>;
  isAvailable(deviceId: string): boolean;
  ensure(deviceId: string, label: string, spec: HarnessSessionSpec): Promise<HarnessEnsureResult>;
  runTurn(deviceId: string, label: string, input: HarnessRunTurnInput, sink: HarnessTurnSink): HarnessTurnHandle;
  /** `harnessHost:result` — answer one held ensure/run. */
  settle(deviceId: string, requestId: string, result: unknown): boolean;
  /** `harnessHost:event` — fold a batch in; the ack can carry the cancel. */
  onEvent(deviceId: string, batch: unknown): DeviceHarnessEventAck;
  /** `harnessHost:permission` — blocking; answered when the card settles. */
  onPermission(deviceId: string, ask: unknown): Promise<DeviceHarnessPermissionDecision>;
  /** Drop what an unpaired device announced, and fail its in-flight work. */
  forget(deviceId: string): Promise<void>;
  close(): void;
}

function asAnnouncement(report: unknown): DeviceHarnessAnnouncement | null {
  const value = report as Partial<DeviceHarnessAnnouncement> | null;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.enabled !== 'boolean') return null;
  if (value.platform !== 'darwin' && value.platform !== 'linux' && value.platform !== 'win32') return null;
  return { enabled: value.enabled, platform: value.platform };
}

function errorText(raw: unknown, fallback: string): string {
  const error = (raw as { error?: unknown } | null)?.error;
  return typeof error === 'string' && error.trim() ? error : fallback;
}

export function createHarnessDeviceRouter(deps: HarnessDeviceRouterDeps): HarnessDeviceRouter {
  const pending = new Map<string, Pending>();

  const mintRequestId = (): string => randomBytes(16).toString('hex');

  function dropTurn(requestId: string, turn: PendingTurn, result: HarnessTurnResult): void {
    // Forget it first: a late result or event must find nothing.
    pending.delete(requestId);
    clearTimeout(turn.timer);
    if (turn.cancelTimer) clearTimeout(turn.cancelTimer);
    turn.settle(result);
  }

  function armIdle(requestId: string, turn: PendingTurn, ms: number, what: string): void {
    clearTimeout(turn.timer);
    turn.timer = setTimeout(() => {
      const held = pending.get(requestId);
      if (held !== turn) return;
      log('harness-device', 'a device turn went silent', { deviceId: turn.deviceId, what });
      dropTurn(requestId, turn, {
        ok: false,
        error:
          'The computer running the coding agent went silent, so the turn was abandoned here. ' +
          'The session survives — calling coding_agent again continues the conversation once that computer is back.'
      });
    }, ms);
    turn.timer.unref?.();
  }

  return {
    async announce(deviceId, report) {
      const announcement = asAnnouncement(report);
      if (!announcement) return;
      const hosts = await deps.store.read();
      hosts[deviceId] = { deviceId, announcedAt: new Date().toISOString(), ...announcement };
      await deps.store.write(hosts);
      log('harness-device', 'a device announced whether it runs coding agents', {
        deviceId,
        enabled: announcement.enabled
      });
    },

    async hostFor(deviceId) {
      return (await deps.store.read())[deviceId] ?? null;
    },

    isAvailable: (deviceId) => deps.connectedDevices().has(deviceId),

    ensure(deviceId, label, spec) {
      const requestId = mintRequestId();
      const frame: DeviceHarnessRequest = {
        requestId,
        op: 'ensure',
        agent: spec.agent,
        cwd: spec.cwd,
        ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
        ...(spec.model ? { model: spec.model } : {})
      };
      const reached = deps.pushTo(deviceId, HARNESS_REQUEST_FRAME, frame);
      if (reached === 0) {
        return Promise.resolve({
          ok: false as const,
          error: `“${label}” disconnected from Stem before the coding agent could be reached.`
        });
      }
      return new Promise<HarnessEnsureResult>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          resolve({
            ok: false,
            error: `“${label}” did not answer within ${Math.round(ENSURE_TIMEOUT_MS / 1000)}s — it may be asleep or Stem there may be busy starting the agent.`
          });
        }, ENSURE_TIMEOUT_MS);
        timer.unref?.();
        pending.set(requestId, { kind: 'ensure', deviceId, settle: resolve, timer });
      });
    },

    runTurn(deviceId, label, input, sink) {
      // The turnId is server-minted (it is the runId), so a cancel can only
      // ever name a turn this server started.
      const requestId = input.turnId;
      const frame: DeviceHarnessRequest = {
        requestId,
        op: 'run',
        agent: input.agent,
        cwd: input.cwd,
        sessionId: input.sessionId,
        prompt: input.prompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.maxTurnMs ? { maxTurnMs: input.maxTurnMs } : {})
      };
      const reached = deps.pushTo(deviceId, HARNESS_REQUEST_FRAME, frame);
      if (reached === 0) {
        return {
          result: Promise.resolve({
            ok: false as const,
            error: `“${label}” disconnected from Stem before the coding agent could be reached.`
          }),
          cancel: () => {}
        };
      }
      let turn: PendingTurn;
      const result = new Promise<HarnessTurnResult>((resolve) => {
        turn = {
          kind: 'turn',
          deviceId,
          sink,
          settle: resolve,
          timer: setTimeout(() => {}, 0),
          lastSeq: 0,
          cancelWanted: false,
          cancelTimer: null,
          asks: new Map(),
          decided: new Map()
        };
        clearTimeout(turn.timer);
        pending.set(requestId, turn);
        armIdle(requestId, turn, FIRST_LIFE_TIMEOUT_MS, 'no first sign of life');
      });
      return {
        result,
        cancel: () => {
          const held = pending.get(requestId);
          if (held?.kind !== 'turn') return;
          held.cancelWanted = true;
          // Best effort; a lost frame is covered by the next event POST's ack.
          deps.pushTo(deviceId, HARNESS_CANCEL_FRAME, { turnId: requestId } satisfies DeviceHarnessCancel);
          if (!held.cancelTimer) {
            held.cancelTimer = setTimeout(() => {
              const still = pending.get(requestId);
              if (still !== held) return;
              dropTurn(requestId, held, { ok: true, stopReason: 'cancelled', text: '' });
            }, CANCEL_WINDDOWN_MS);
            held.cancelTimer.unref?.();
          }
        }
      };
    },

    settle(deviceId, requestId, result) {
      const held = pending.get(requestId);
      if (!held) return false;
      // Same rule as exec-device's router: a second paired device must not be
      // able to answer for the first.
      if (held.deviceId !== deviceId) {
        log('harness-device', 'refused a result from the wrong device', {
          expected: held.deviceId,
          got: deviceId
        });
        return false;
      }
      const value = result as Partial<DeviceHarnessResult> | null;
      if (held.kind === 'ensure') {
        pending.delete(requestId);
        clearTimeout(held.timer);
        if (value && value.ok === true && typeof (value as { sessionId?: unknown }).sessionId === 'string') {
          held.settle({ ok: true, sessionId: (value as { sessionId: string }).sessionId });
        } else {
          held.settle({ ok: false, error: errorText(value, 'The computer answered with nothing usable.') });
        }
        return true;
      }
      const run = value as { ok?: unknown; stopReason?: unknown; text?: unknown } | null;
      if (
        run &&
        run.ok === true &&
        (run.stopReason === 'end_turn' || run.stopReason === 'cancelled' || run.stopReason === 'max_turn') &&
        typeof run.text === 'string'
      ) {
        dropTurn(requestId, held, { ok: true, stopReason: run.stopReason, text: run.text });
      } else {
        dropTurn(requestId, held, {
          ok: false,
          error: errorText(value, 'The computer answered with nothing usable.')
        });
      }
      return true;
    },

    onEvent(deviceId, batch) {
      const value = batch as Partial<DeviceHarnessEventBatch> | null;
      if (!value || typeof value !== 'object' || typeof value.turnId !== 'string') {
        return { action: 'cancel' };
      }
      const held = pending.get(value.turnId);
      if (held?.kind !== 'turn' || held.deviceId !== deviceId) {
        // An unknown turn is the restart story: the server that minted it is
        // gone, and this ack is how the client learns to stand down.
        return { action: 'cancel' };
      }
      armIdle(value.turnId, held, IDLE_TIMEOUT_MS, 'idle timeout');
      const firstSeq = typeof value.firstSeq === 'number' ? value.firstSeq : 0;
      const events = Array.isArray(value.events) ? value.events : [];
      if (events.length) {
        if (firstSeq <= held.lastSeq) {
          // A duplicate flush from a retried POST; dropping it beats double-counting.
          log('harness-device', 'dropped a stale event batch', { turnId: value.turnId, firstSeq });
        } else {
          if (firstSeq > held.lastSeq + 1) {
            log('harness-device', 'an event gap (harmless; the result is authoritative)', {
              turnId: value.turnId,
              expected: held.lastSeq + 1,
              got: firstSeq
            });
          }
          held.lastSeq = firstSeq + events.length - 1;
          held.sink.onEvent(events as HarnessEvent[]);
        }
      }
      return { action: held.cancelWanted ? 'cancel' : 'continue' };
    },

    onPermission(deviceId, ask) {
      const value = ask as Partial<DeviceHarnessPermissionAsk> | null;
      if (
        !value ||
        typeof value !== 'object' ||
        typeof value.turnId !== 'string' ||
        typeof value.permissionId !== 'string' ||
        typeof value.title !== 'string' ||
        !Array.isArray(value.options)
      ) {
        return Promise.resolve({ expired: true });
      }
      const held = pending.get(value.turnId);
      if (held?.kind !== 'turn' || held.deviceId !== deviceId) {
        // Server restarted with a card up (or the turn is gone): the retry gets
        // expired, the client maps it to a cancel outcome, the turn continues.
        return Promise.resolve({ expired: true });
      }
      const decided = held.decided.get(value.permissionId);
      if (decided) return Promise.resolve(decided);
      const inFlight = held.asks.get(value.permissionId);
      if (inFlight) return inFlight;
      const asked = held.sink
        .onPermission({
          permissionId: value.permissionId,
          title: value.title,
          ...(typeof value.toolName === 'string' ? { toolName: value.toolName } : {}),
          ...(typeof value.description === 'string' ? { description: value.description } : {}),
          options: value.options.filter(
            (o): o is { optionId: string; kind?: string; name?: string } =>
              !!o && typeof o === 'object' && typeof (o as { optionId?: unknown }).optionId === 'string'
          ),
          ...(Array.isArray(value.content) ? { content: value.content as never } : {})
        })
        .then((decision) => {
          held.asks.delete(value.permissionId!);
          held.decided.set(value.permissionId!, decision);
          const expire = setTimeout(() => held.decided.delete(value.permissionId!), DECIDED_TTL_MS);
          expire.unref?.();
          return decision;
        });
      held.asks.set(value.permissionId, asked);
      return asked;
    },

    async forget(deviceId) {
      for (const [requestId, held] of pending) {
        if (held.deviceId !== deviceId) continue;
        if (held.kind === 'ensure') {
          pending.delete(requestId);
          clearTimeout(held.timer);
          held.settle({ ok: false, error: 'The computer was unpaired from this Stem.' });
        } else {
          dropTurn(requestId, held, {
            ok: false,
            error: 'The computer was unpaired from this Stem while the coding agent was working.'
          });
        }
      }
      const hosts = await deps.store.read();
      if (!hosts[deviceId]) return;
      delete hosts[deviceId];
      await deps.store.write(hosts);
      log('harness-device', 'forgot that an unpaired device ran coding agents', { deviceId });
    },

    close() {
      for (const [requestId, held] of pending) {
        if (held.kind === 'ensure') {
          clearTimeout(held.timer);
          held.settle({ ok: false, error: 'Stem stopped while the coding agent was starting.' });
        } else {
          clearTimeout(held.timer);
          if (held.cancelTimer) clearTimeout(held.cancelTimer);
          held.settle({ ok: false, error: 'Stem stopped while the coding agent was working.' });
        }
        pending.delete(requestId);
      }
    }
  };
}

/** A HarnessHost that fronts one paired device through the router. */
export class DeviceHarnessHost implements HarnessHost {
  constructor(
    private readonly router: HarnessDeviceRouter,
    private readonly deviceId: string,
    private readonly deviceLabel: string
  ) {}

  label(): string {
    return this.deviceLabel;
  }

  available(): boolean {
    return this.router.isAvailable(this.deviceId);
  }

  ensureSession(spec: HarnessSessionSpec): Promise<HarnessEnsureResult> {
    return this.router.ensure(this.deviceId, this.deviceLabel, spec);
  }

  runTurn(input: HarnessRunTurnInput, sink: HarnessTurnSink): HarnessTurnHandle {
    return this.router.runTurn(this.deviceId, this.deviceLabel, input, sink);
  }

  async close(): Promise<void> {
    // The device owns the processes; there is nothing here to release.
  }
}

// ---- the store (same discipline as exec-device's) ----

interface StoredHosts {
  version: 1;
  hosts?: Record<string, DeviceHarnessHostEntry>;
}

async function readHostsFile(): Promise<Record<string, DeviceHarnessHostEntry>> {
  try {
    const parsed = JSON.parse(await readFile(harnessDeviceHostsPath(), 'utf8')) as StoredHosts;
    if (parsed && typeof parsed === 'object' && parsed.hosts && typeof parsed.hosts === 'object') {
      const hosts: Record<string, DeviceHarnessHostEntry> = {};
      for (const [deviceId, entry] of Object.entries(parsed.hosts)) {
        const announcement = asAnnouncement(entry);
        if (!announcement) continue;
        hosts[deviceId] = {
          deviceId,
          announcedAt: typeof entry?.announcedAt === 'string' ? entry.announcedAt : new Date(0).toISOString(),
          ...announcement
        };
      }
      return hosts;
    }
  } catch (e) {
    // Absent is a Stem where no computer ever announced; unreadable silently
    // untargets a computer that did.
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('harness-device', 'forgot which devices run coding agents', e);
    }
  }
  return {};
}

async function writeHostsFile(hosts: Record<string, DeviceHarnessHostEntry>): Promise<void> {
  const path = harnessDeviceHostsPath();
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  } finally {
    // quiet: on the happy path the rename already moved it; a leftover temp
    // file is inert — nothing reads this directory by pattern.
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function fileHarnessHostStore(): HarnessHostStore {
  let tail: Promise<unknown> = Promise.resolve();
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    // quiet: the rejection is delivered through `next`; this copy only stops
    // one failed read from poisoning the announcements queued behind it.
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    read: () => queue(readHostsFile),
    write: (next) => queue(() => writeHostsFile(next))
  };
}

export function memoryHarnessHostStore(
  initial: Record<string, DeviceHarnessHostEntry> = {}
): HarnessHostStore {
  let hosts = { ...initial };
  return {
    read: () => Promise.resolve({ ...hosts }),
    write: (next) => {
      hosts = { ...next };
      return Promise.resolve();
    }
  };
}

// ---- the wired one ----

let router: HarnessDeviceRouter | null = null;

export function harnessDeviceRouter(): HarnessDeviceRouter {
  router ??= createHarnessDeviceRouter({
    pushTo: pushToDevice,
    connectedDevices: connectedDeviceIds,
    store: fileHarnessHostStore()
  });
  return router;
}

export function closeHarnessDeviceRouter(): void {
  router?.close();
  router = null;
}
