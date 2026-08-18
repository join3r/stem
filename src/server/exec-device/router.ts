import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { degrade } from '../degrade';
import { log } from '../log';
import { readDevices } from '../transport/auth';
import { connectedDeviceIds, pushToDevice } from '../startup/transport';
import { execDeviceHostsPath } from '../workspace/paths';
import {
  EXEC_REQUEST_FRAME,
  type DeviceExecAnnouncement,
  type DeviceExecHostEntry,
  type DeviceExecRequest,
  type DeviceExecResult
} from '../../shared/types';

// The server's half of a run_command that runs on a paired computer.
//
// Same rails as mcp-device/router.ts, same security argument: the request goes
// out as an addressed control frame on that device's own streams, the answer
// comes back as an ordinary POST /rpc on `execHost:result`, and the only thing
// standing between a renderer that can call that channel and a request it was
// never handed is the correlation id — 128 CSPRNG bits, single-use, forgotten
// on timeout. Keep the id unguessable and single-use and it holds.
//
// What is deliberately NOT here: policy. The allowlist / judge / approval-card
// tiers run in exec/service.ts before anything reaches this file, against the
// TARGET's platform and the target's own learned allowlist. And the far end
// holds one more gate this file never sees: the client-local opt-in switch,
// which is off until the person at that machine turns it on there — a
// compromised server can put anything it likes on this wire, and get nowhere on
// a machine whose owner never opted in.

/**
 * Grace on top of the command's own timeout. The device enforces the real kill
 * (same executor, same clamp); this bound only covers the case where the device
 * is there and its answer is not coming — a wedged client, a dropped result —
 * and it must never fire before a legitimately slow command has had its full
 * time.
 */
const RESULT_GRACE_MS = 30_000;

/** One command, out on the wire and waiting to be answered or to run out of time. */
interface Pending {
  deviceId: string;
  threadId: string;
  settle(result: DeviceExecResult): void;
  timer: NodeJS.Timeout;
}

/** Where announcements are remembered across restarts. */
export interface ExecHostStore {
  read(): Promise<Record<string, DeviceExecHostEntry>>;
  write(next: Record<string, DeviceExecHostEntry>): Promise<void>;
}

export interface ExecDeviceRouterDeps {
  /** Write an addressed control frame; the count is how many streams it reached. */
  pushTo(deviceId: string, name: string, data: unknown): number;
  /** Which devices have a stream open right now — the availability signal. */
  connectedDevices(): Set<string>;
  store: ExecHostStore;
}

export interface ExecDeviceRouter {
  /** Record a device's account of whether it runs commands — `execHost:announce`. */
  announce(deviceId: string, report: unknown): Promise<void>;
  /** Every device that ever announced, by id. */
  hosts(): Promise<Record<string, DeviceExecHostEntry>>;
  /** The remembered announcement for one device, or null. */
  hostFor(deviceId: string): Promise<DeviceExecHostEntry | null>;
  /** Whether that device could be sent work this instant. */
  isAvailable(deviceId: string): boolean;
  /** Run one command on `deviceId`. The request's timeout is already clamped. */
  run(deviceId: string, request: Omit<DeviceExecRequest, 'requestId'>): Promise<DeviceExecResult>;
  /**
   * Answer one held command — `execHost:result`. Returns whether the id was
   * live: false for an id that never existed, was already spent, or timed out —
   * the same non-event, and none of them an error to the caller.
   */
  settle(deviceId: string, requestId: string, result: unknown): boolean;
  /**
   * Fail this thread's in-flight commands now (turn interrupted). The command
   * itself keeps running on the far machine until its own timeout — there is no
   * cancel frame, deliberately: a kill signal a server can send to a client's
   * process tree is a bigger capability than an interrupted turn justifies.
   */
  abortThread(threadId: string): void;
  /** Drop what an unpaired device announced, and fail its in-flight commands. */
  forget(deviceId: string): Promise<void>;
  /** Fail everything in flight (shutdown, tests). */
  close(): void;
}

/** The wire shape, validated — a device wrote this, so nothing is assumed. */
function asAnnouncement(report: unknown): DeviceExecAnnouncement | null {
  const value = report as Partial<DeviceExecAnnouncement> | null;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.enabled !== 'boolean') return null;
  if (value.platform !== 'darwin' && value.platform !== 'linux' && value.platform !== 'win32') return null;
  return { enabled: value.enabled, platform: value.platform };
}

function asResult(raw: unknown): DeviceExecResult {
  const value = raw as Partial<DeviceExecResult> | null;
  if (value && typeof value === 'object' && value.ok === true && typeof value.text === 'string') {
    return { ok: true, text: value.text };
  }
  const error = (value as { error?: unknown } | null)?.error;
  return {
    ok: false,
    error:
      typeof error === 'string' && error.trim()
        ? error
        : 'The computer answered with nothing usable.'
  };
}

export function createExecDeviceRouter(deps: ExecDeviceRouterDeps): ExecDeviceRouter {
  /** In-flight commands by correlation id. Single-use: settling deletes the entry. */
  const pending = new Map<string, Pending>();

  const mintRequestId = (): string => randomBytes(16).toString('hex');

  return {
    async announce(deviceId, report) {
      const announcement = asAnnouncement(report);
      if (!announcement) return;
      const hosts = await deps.store.read();
      hosts[deviceId] = { deviceId, announcedAt: new Date().toISOString(), ...announcement };
      await deps.store.write(hosts);
      log('exec-device', 'a device announced whether it runs commands', {
        deviceId,
        enabled: announcement.enabled,
        platform: announcement.platform
      });
    },

    hosts: () => deps.store.read(),

    async hostFor(deviceId) {
      return (await deps.store.read())[deviceId] ?? null;
    },

    isAvailable: (deviceId) => deps.connectedDevices().has(deviceId),

    async run(deviceId, request) {
      const requestId = mintRequestId();
      const frame: DeviceExecRequest = { requestId, ...request };
      const reached = deps.pushTo(deviceId, EXEC_REQUEST_FRAME, frame);
      // The caller checked availability before classifying, but the stream can
      // close in the window since. Act on the write that actually tried:
      // nothing was written, so nobody is going to answer.
      if (reached === 0) {
        return { ok: false, error: 'That computer disconnected from Stem before the command could be sent.' };
      }
      log('exec-device', 'sent a command to a device', { deviceId, streams: reached });
      const timeoutMs = request.timeoutMs + RESULT_GRACE_MS;
      return new Promise<DeviceExecResult>((resolve) => {
        const timer = setTimeout(() => {
          // Forget it first: a late answer must find nothing, or it would settle
          // a promise that has already been settled.
          pending.delete(requestId);
          log('exec-device', 'a device command went unanswered', { deviceId });
          resolve({
            ok: false,
            error: `The computer did not answer within ${Math.round(timeoutMs / 1000)}s. The command may still be running there.`
          });
        }, timeoutMs);
        timer.unref?.();
        pending.set(requestId, { deviceId, threadId: request.threadId, settle: resolve, timer });
      });
    },

    settle(deviceId, requestId, result) {
      const held = pending.get(requestId);
      if (!held) return false;
      // Same belt-and-braces as the MCP router: it buys nothing against the
      // machine the request was sent to, but it stops a second paired device
      // from answering for the first.
      if (held.deviceId !== deviceId) {
        log('exec-device', 'refused a command result from the wrong device', {
          expected: held.deviceId,
          got: deviceId
        });
        return false;
      }
      pending.delete(requestId);
      clearTimeout(held.timer);
      held.settle(asResult(result));
      return true;
    },

    abortThread(threadId) {
      for (const [requestId, held] of pending) {
        if (held.threadId !== threadId) continue;
        pending.delete(requestId);
        clearTimeout(held.timer);
        held.settle({ ok: false, error: 'The command was cancelled.' });
      }
    },

    async forget(deviceId) {
      for (const [requestId, held] of pending) {
        if (held.deviceId !== deviceId) continue;
        pending.delete(requestId);
        clearTimeout(held.timer);
        held.settle({
          ok: false,
          error: 'The computer was unpaired from this Stem while the command was running.'
        });
      }
      const hosts = await deps.store.read();
      if (!hosts[deviceId]) return;
      delete hosts[deviceId];
      await deps.store.write(hosts);
      log('exec-device', 'forgot that an unpaired device ran commands', { deviceId });
    },

    close() {
      for (const [, held] of pending) {
        clearTimeout(held.timer);
        held.settle({ ok: false, error: 'Stem stopped while the command was running.' });
      }
      pending.clear();
    }
  };
}

// ---- the store ----

interface StoredHosts {
  version: 1;
  hosts?: Record<string, DeviceExecHostEntry>;
}

async function readHostsFile(): Promise<Record<string, DeviceExecHostEntry>> {
  try {
    const parsed = JSON.parse(await readFile(execDeviceHostsPath(), 'utf8')) as StoredHosts;
    if (parsed && typeof parsed === 'object' && parsed.hosts && typeof parsed.hosts === 'object') {
      const hosts: Record<string, DeviceExecHostEntry> = {};
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
    // A Stem that has never paired a command host has no file to read, and that
    // is not a failure. A file that exists and will not parse is one: a computer
    // that announced itself is silently no longer targetable, and the next write
    // replaces the catalog with whatever announces after it.
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('exec-device.hosts', 'forgot which devices run commands', e);
    }
  }
  return {};
}

async function writeHostsFile(hosts: Record<string, DeviceExecHostEntry>): Promise<void> {
  const path = execDeviceHostsPath();
  // Temp + rename, like the MCP device catalog: a torn write must not read back
  // as corrupt on the next boot.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  } finally {
    // quiet: on the happy path the rename already moved it, and a temp file left
    // behind by a torn write is inert — nothing reads this directory by pattern,
    // only the one catalog path.
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** The real store; reads and writes serialized so two announcements can't race. */
export function fileExecHostStore(): ExecHostStore {
  let tail: Promise<unknown> = Promise.resolve();
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    // quiet: the rejection is delivered to the caller through `next`, which is
    // what this function returns. This copy exists only so one failed read does
    // not poison every announcement queued behind it.
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    read: () => queue(readHostsFile),
    write: (next) => queue(() => writeHostsFile(next))
  };
}

/** An in-memory store, for tests. */
export function memoryExecHostStore(
  initial: Record<string, DeviceExecHostEntry> = {}
): ExecHostStore {
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

let router: ExecDeviceRouter | null = null;

/** The router this server uses, created on first use — same shape as deviceMcpRouter(). */
export function execDeviceRouter(): ExecDeviceRouter {
  router ??= createExecDeviceRouter({
    pushTo: pushToDevice,
    connectedDevices: connectedDeviceIds,
    store: fileExecHostStore()
  });
  return router;
}

/** Drop the wired router (app quit; tests that want a clean singleton). */
export function closeExecDeviceRouter(): void {
  router?.close();
  router = null;
}

/**
 * Resolve what the assistant called the target — a device label or id — to a
 * paired desktop, along with why it cannot be used when it cannot. Matching is
 * case-insensitive on the label; an ambiguous label is refused rather than
 * guessed, because the difference between two machines is the whole point of
 * naming one.
 */
export async function resolveExecTarget(
  nameOrId: string
): Promise<{ ok: true; deviceId: string; label: string } | { ok: false; error: string }> {
  const wanted = nameOrId.trim();
  if (!wanted) return { ok: false, error: 'Name the computer the command should run on.' };
  // The empty list is indistinguishable from "nothing is paired", and that is
  // what the assistant is told — and repeats to the user — about a machine that
  // is sitting there paired.
  const devices = await readDevices().catch((e) => {
    degrade('exec-device.hosts', 'told the assistant no computers are paired', e);
    return [];
  });
  const matches = devices.filter(
    (d) => d.id === wanted || d.label.toLowerCase() === wanted.toLowerCase()
  );
  if (matches.length === 0) {
    const known = devices
      .filter((d) => (d.kind ?? 'desktop') === 'desktop')
      .map((d) => `“${d.label}”`)
      .join(', ');
    return {
      ok: false,
      error:
        `No paired computer is called “${wanted}”.` +
        (known ? ` The paired computers are: ${known}.` : ' No computers are paired with this Stem.')
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `More than one paired device is called “${wanted}” — ask the user which one they mean (Settings → Server → Devices shows them).`
    };
  }
  const device = matches[0]!;
  if ((device.kind ?? 'desktop') !== 'desktop') {
    return { ok: false, error: `“${device.label}” is a phone, and commands only run on computers.` };
  }
  return { ok: true, deviceId: device.id, label: device.label };
}
