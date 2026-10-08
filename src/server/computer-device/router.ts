import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { degrade } from '../degrade';
import { log } from '../log';
import { connectedDeviceIds, pushToDevice } from '../startup/transport';
import { computerDeviceHostsPath } from '../workspace/paths';
import {
  COMPUTER_END_FRAME,
  COMPUTER_REQUEST_FRAME,
  type ComputerAction,
  type ComputerAccess,
  type ComputerScreenshot,
  type ComputerTarget,
  type DeviceComputerAnnouncement,
  type DeviceComputerHostEntry,
  type DeviceComputerRequest,
  type DeviceComputerResult
} from '../../shared/types';

// The server's half of the `computer` tool: one screen action out to the Mac
// a persona is pinned to, one screenshot back.
//
// Same rails and the same security argument as exec-device/router.ts: the
// request is an addressed control frame on that device's own streams, the
// answer an ordinary POST /rpc on `computerHost:result`, and the correlation
// id — 128 CSPRNG bits, single-use, forgotten on timeout — is the only thing
// between a caller of that channel and a request it was never handed.
//
// What is deliberately NOT here: any per-action policy. The user chose no
// approval cards for screen actions (they would defeat the point); the guards
// are the persona pin (pi/runtime.ts reads it off the live turn), the
// client-local switch on the Mac, the banner it shows while a run is on, and
// the kill switch: the person's own input ends the run, and this router then
// refuses every further action for that thread until the turn is over.

/** How long one action may take to come back: a screenshot round-trip on a busy Mac is well under this. */
const ACTION_TIMEOUT_MS = 60_000;

interface Pending {
  deviceId: string;
  threadId: string;
  settle(result: DeviceComputerResult): void;
  timer: NodeJS.Timeout;
}

export interface ComputerHostStore {
  read(): Promise<Record<string, DeviceComputerHostEntry>>;
  write(next: Record<string, DeviceComputerHostEntry>): Promise<void>;
}

export interface ComputerDeviceRouterDeps {
  pushTo(deviceId: string, name: string, data: unknown): number;
  connectedDevices(): Set<string>;
  store: ComputerHostStore;
}

export interface ComputerDeviceRouter {
  /** Record a Mac's account of whether it lets Stem drive its screen — `computerHost:announce`. */
  announce(deviceId: string, report: unknown): Promise<void>;
  hosts(): Promise<Record<string, DeviceComputerHostEntry>>;
  hostFor(deviceId: string): Promise<DeviceComputerHostEntry | null>;
  isAvailable(deviceId: string): boolean;
  /**
   * Send one action to `deviceId` for `threadId`; resolves with the device's
   * answer or a refusal. `shot: false` asks for no picture back.
   */
  send(
    threadId: string,
    deviceId: string,
    action: ComputerAction,
    opts?: { shot?: false }
  ): Promise<DeviceComputerResult>;
  /** Answer one held action — `computerHost:result`. False for an id that is not live. */
  settle(deviceId: string, requestId: string, result: unknown): boolean;
  /**
   * The person at the Mac took over — `computerHost:event`. Fails the thread's
   * in-flight action as aborted and marks the thread so every later action
   * this turn is refused without a round-trip.
   */
  /** False when the report came from a device not running that thread (ignored). */
  humanInput(deviceId: string, threadId: string): boolean;
  /** Whether the person took over this thread's run (cleared by endThread). */
  isAborted(threadId: string): boolean;
  /**
   * The turn is over (settled, cancelled, worker died): fail anything in
   * flight and tell the device so it drops its banner and helper.
   */
  endThread(threadId: string, reason?: string): void;
  /** Drop what an unpaired device announced, and fail its in-flight actions. */
  forget(deviceId: string): Promise<void>;
  /** Fail everything in flight (shutdown, tests). */
  close(): void;
}

function asAccess(raw: unknown): ComputerAccess | undefined {
  const v = raw as Partial<ComputerAccess> | null;
  if (!v || typeof v !== 'object') return undefined;
  return {
    screen: v.screen === true,
    accessibility: v.accessibility === true,
    inputMonitoring: v.inputMonitoring === true
  };
}

function asAnnouncement(report: unknown): DeviceComputerAnnouncement | null {
  const value = report as Partial<DeviceComputerAnnouncement> | null;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.enabled !== 'boolean') return null;
  if (value.platform !== 'darwin') return null;
  const access = asAccess(value.access);
  return {
    enabled: value.enabled,
    platform: 'darwin',
    ...(access ? { access } : {})
  };
}

/** `target` as the device sent it: a window, null (whole screen), or undefined when it said nothing. */
function asTarget(raw: unknown): ComputerTarget | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as { app?: unknown; title?: unknown; windowId?: unknown };
  if (typeof t.app !== 'string' || typeof t.windowId !== 'number') return undefined;
  return { app: t.app, title: typeof t.title === 'string' ? t.title : '', windowId: t.windowId };
}

function asResult(raw: unknown): DeviceComputerResult {
  const value = raw as Partial<DeviceComputerResult> | null;
  if (value && typeof value === 'object' && value.ok === true) {
    const v = value as {
      screenshot?: Partial<ComputerScreenshot>;
      cursor?: { x?: unknown; y?: unknown };
      text?: unknown;
      target?: unknown;
    };
    const shot = v.screenshot;
    const screenshot: ComputerScreenshot | undefined =
      shot &&
      typeof shot.jpegBase64 === 'string' &&
      shot.jpegBase64 &&
      typeof shot.width === 'number' &&
      typeof shot.height === 'number'
        ? {
            jpegBase64: shot.jpegBase64,
            width: shot.width,
            height: shot.height,
            ...(typeof shot.scale === 'number' ? { scale: shot.scale } : {}),
            ...(shot.zoomed === true ? { zoomed: true } : {})
          }
        : undefined;
    const text = typeof v.text === 'string' && v.text.trim() ? v.text : undefined;
    // A frame or some text: the windows list (and an action asked for no
    // picture) answers with text alone; every other action carries a
    // screenshot, the evidence of what it did.
    if (!screenshot && !text) return { ok: false, error: 'The computer answered without a screenshot.' };
    const target = asTarget(v.target);
    return {
      ok: true,
      ...(screenshot ? { screenshot } : {}),
      ...(screenshot
        ? {
            cursor: {
              x: typeof v.cursor?.x === 'number' ? v.cursor.x : 0,
              y: typeof v.cursor?.y === 'number' ? v.cursor.y : 0
            }
          }
        : {}),
      ...(text ? { text } : {}),
      ...(target !== undefined ? { target } : {})
    };
  }
  const error = (value as { error?: unknown } | null)?.error;
  const aborted = (value as { aborted?: unknown } | null)?.aborted === true;
  return {
    ok: false,
    error: typeof error === 'string' && error.trim() ? error : 'The computer answered with nothing usable.',
    ...(aborted ? { aborted: true } : {})
  };
}

export const HUMAN_TOOK_OVER =
  'The user took over the computer (they touched the mouse or keyboard, or pressed Stop). Do not send ' +
  'more actions this turn: report what you did and what was left, and wait for them.';

export function createComputerDeviceRouter(deps: ComputerDeviceRouterDeps): ComputerDeviceRouter {
  const pending = new Map<string, Pending>();
  /** Threads whose run the person ended; the device they ran on, for the end frame. */
  const aborted = new Map<string, string>();
  /** Which device each live thread is driving, so endThread knows whom to tell. */
  const runs = new Map<string, string>();

  const mintRequestId = (): string => randomBytes(16).toString('hex');

  function failThread(threadId: string, result: DeviceComputerResult): void {
    for (const [requestId, held] of pending) {
      if (held.threadId !== threadId) continue;
      pending.delete(requestId);
      clearTimeout(held.timer);
      held.settle(result);
    }
  }

  return {
    async announce(deviceId, report) {
      const announcement = asAnnouncement(report);
      if (!announcement) return;
      const hosts = await deps.store.read();
      hosts[deviceId] = {
        deviceId,
        announcedAt: new Date().toISOString(),
        ...announcement
      };
      await deps.store.write(hosts);
      log('computer-device', 'a device announced whether it lets Stem drive its screen', {
        deviceId,
        enabled: announcement.enabled,
        access: announcement.access
      });
    },

    hosts: () => deps.store.read(),

    async hostFor(deviceId) {
      return (await deps.store.read())[deviceId] ?? null;
    },

    isAvailable: (deviceId) => deps.connectedDevices().has(deviceId),

    async send(threadId, deviceId, action, opts) {
      if (aborted.has(threadId)) return { ok: false, error: HUMAN_TOOK_OVER, aborted: true };
      const requestId = mintRequestId();
      const frame: DeviceComputerRequest = {
        requestId,
        threadId,
        action,
        ...(opts?.shot === false ? { shot: false } : {})
      };
      const reached = deps.pushTo(deviceId, COMPUTER_REQUEST_FRAME, frame);
      if (reached === 0) {
        return {
          ok: false,
          error:
            'That computer is not connected to Stem right now (asleep, or Stem is not running there). ' +
            'Tell the user which machine needs waking rather than saying the task cannot be done.'
        };
      }
      runs.set(threadId, deviceId);
      return new Promise<DeviceComputerResult>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          log('computer-device', 'a screen action went unanswered', {
            deviceId,
            kind: action.kind
          });
          resolve({
            ok: false,
            error: `The computer did not answer within ${Math.round(ACTION_TIMEOUT_MS / 1000)}s.`
          });
        }, ACTION_TIMEOUT_MS);
        timer.unref?.();
        pending.set(requestId, { deviceId, threadId, settle: resolve, timer });
      });
    },

    settle(deviceId, requestId, result) {
      const held = pending.get(requestId);
      if (!held) return false;
      if (held.deviceId !== deviceId) {
        log('computer-device', 'refused a screen result from the wrong device', {
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

    humanInput(deviceId, threadId) {
      // Only the device that is running this thread may end it: a second
      // paired Mac cannot cancel a run it never had.
      const running = runs.get(threadId);
      if (running && running !== deviceId) {
        log('computer-device', 'ignored a take-over report from the wrong device', {
          threadId,
          got: deviceId
        });
        return false;
      }
      aborted.set(threadId, deviceId);
      failThread(threadId, {
        ok: false,
        error: HUMAN_TOOK_OVER,
        aborted: true
      });
      log('computer-device', 'the user took over a computer-control run', {
        threadId,
        deviceId
      });
      return true;
    },

    isAborted: (threadId) => aborted.has(threadId),

    endThread(threadId, reason) {
      failThread(threadId, {
        ok: false,
        error: reason ?? 'The run was interrupted.'
      });
      const deviceId = runs.get(threadId) ?? aborted.get(threadId);
      runs.delete(threadId);
      aborted.delete(threadId);
      if (deviceId) deps.pushTo(deviceId, COMPUTER_END_FRAME, { threadId });
    },

    async forget(deviceId) {
      for (const [requestId, held] of pending) {
        if (held.deviceId !== deviceId) continue;
        pending.delete(requestId);
        clearTimeout(held.timer);
        held.settle({
          ok: false,
          error: 'The computer was unpaired from this Stem during the run.'
        });
      }
      for (const [threadId, id] of [...runs]) if (id === deviceId) runs.delete(threadId);
      for (const [threadId, id] of [...aborted]) if (id === deviceId) aborted.delete(threadId);
      const hosts = await deps.store.read();
      if (!hosts[deviceId]) return;
      delete hosts[deviceId];
      await deps.store.write(hosts);
      log('computer-device', 'forgot that an unpaired device hosted computer control', { deviceId });
    },

    close() {
      for (const [, held] of pending) {
        clearTimeout(held.timer);
        held.settle({ ok: false, error: 'Stem stopped during the run.' });
      }
      pending.clear();
      runs.clear();
      aborted.clear();
    }
  };
}

// ---- the store ----

interface StoredHosts {
  version: 1;
  hosts?: Record<string, DeviceComputerHostEntry>;
}

async function readHostsFile(): Promise<Record<string, DeviceComputerHostEntry>> {
  try {
    const parsed = JSON.parse(await readFile(computerDeviceHostsPath(), 'utf8')) as StoredHosts;
    if (parsed && typeof parsed === 'object' && parsed.hosts && typeof parsed.hosts === 'object') {
      const hosts: Record<string, DeviceComputerHostEntry> = {};
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
    // Never announced → no file → not a failure. A file that will not parse
    // is one: a Mac that said yes is silently no longer targetable.
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('computer-device.hosts', 'forgot which Macs host computer control', e);
    }
  }
  return {};
}

async function writeHostsFile(hosts: Record<string, DeviceComputerHostEntry>): Promise<void> {
  const path = computerDeviceHostsPath();
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  } finally {
    // quiet: on the happy path the rename already moved it; a temp file left
    // behind by a torn write is inert.
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function fileComputerHostStore(): ComputerHostStore {
  let tail: Promise<unknown> = Promise.resolve();
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    // quiet: the rejection reaches the caller through `next`; this copy only
    // keeps one failed read from poisoning the announcements queued behind it.
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    read: () => queue(readHostsFile),
    write: (next) => queue(() => writeHostsFile(next))
  };
}

export function memoryComputerHostStore(
  initial: Record<string, DeviceComputerHostEntry> = {}
): ComputerHostStore {
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

let router: ComputerDeviceRouter | null = null;

export function computerDeviceRouter(): ComputerDeviceRouter {
  router ??= createComputerDeviceRouter({
    pushTo: pushToDevice,
    connectedDevices: connectedDeviceIds,
    store: fileComputerHostStore()
  });
  return router;
}

export function closeComputerDeviceRouter(): void {
  router?.close();
  router = null;
}
