import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { degrade } from '../degrade';
import { isUploadHandle } from '../files/staging';
import { log } from '../log';
import { connectedDeviceIds, pushToDevice } from '../startup/transport';
import { browserDeviceHostsPath } from '../workspace/paths';
import {
  BROWSER_END_FRAME,
  BROWSER_REQUEST_FRAME,
  type BrowserAction,
  type BrowserDownloadReceipt,
  type BrowserInfo,
  type DeviceBrowserAnnouncement,
  type DeviceBrowserHostEntry,
  type DeviceBrowserRequest,
  type DeviceBrowserResult
} from '../../shared/types';

// The server's half of the `browser` tool: one browser action out to the Mac
// the turn is pinned to, one answer back.
//
// A sibling of computer-device/router.ts rather than a generalisation of it:
// the rails and the security argument are the same (an addressed control frame
// on that device's own streams, the answer an ordinary POST /rpc on
// `browserHost:result`, a 128-bit single-use correlation id), but three things
// differ and none of them should leak into the screen router:
//
// - There is no "the person touched the mouse" kill switch. The browser works
//   in background tabs beside the user, so their input is not a takeover; the
//   user ends a run with Stop (in the tab's marker or the extension), which
//   arrives as `browserHost:event {kind:'stopped'}` and refuses the rest of
//   the turn here, without a round-trip.
// - A model-chooses chat may drive two Macs' browsers in one turn, so a thread
//   remembers every device it touched and the end frame reaches all of them.
// - The device owns the real deadlines (launching the browser, a page load, a
//   `wait`); the timeout here is only the backstop for a device that vanished.
//
// What is deliberately NOT here, by the user's choice (2026-10-05): any
// per-action policy. No tab grants, no origin gates, no approval before a
// submit. The guards are the pin, the Mac's own switch, the marker and Stop.

/** Backstop for a device that went silent; the Mac answers its own timeouts (≤ 90 s) well before this. */
const ACTION_TIMEOUT_MS = 120_000;

interface Pending {
  deviceId: string;
  threadId: string;
  settle(result: DeviceBrowserResult): void;
  timer: NodeJS.Timeout;
}

export interface BrowserHostStore {
  read(): Promise<Record<string, DeviceBrowserHostEntry>>;
  write(next: Record<string, DeviceBrowserHostEntry>): Promise<void>;
}

export interface BrowserDeviceRouterDeps {
  pushTo(deviceId: string, name: string, data: unknown): number;
  connectedDevices(): Set<string>;
  store: BrowserHostStore;
}

export interface BrowserDeviceRouter {
  /** Record a Mac's account of whether it lets Stem drive its browser — `browserHost:announce`. */
  announce(deviceId: string, report: unknown): Promise<void>;
  hosts(): Promise<Record<string, DeviceBrowserHostEntry>>;
  hostFor(deviceId: string): Promise<DeviceBrowserHostEntry | null>;
  isAvailable(deviceId: string): boolean;
  /** Send one action to `deviceId` for `threadId`; resolves with the device's answer or a refusal. */
  send(threadId: string, deviceId: string, action: BrowserAction): Promise<DeviceBrowserResult>;
  /** Answer one held action — `browserHost:result`. False for an id that is not live. */
  settle(deviceId: string, requestId: string, result: unknown): boolean;
  /**
   * The user pressed Stop for this thread's run — `browserHost:event`. Fails
   * the thread's in-flight actions and refuses every later one this turn.
   */
  stopped(deviceId: string, threadId: string): void;
  /** Whether the user stopped this thread's run (cleared by endThread). */
  isStopped(threadId: string): boolean;
  /** The turn is over: fail anything in flight and tell every Mac the thread used. */
  endThread(threadId: string, reason?: string): void;
  /** Drop what an unpaired device announced, and fail its in-flight actions. */
  forget(deviceId: string): Promise<void>;
  /** Fail everything in flight (shutdown, tests). */
  close(): void;
}

function asBrowsers(raw: unknown): BrowserInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: BrowserInfo[] = [];
  for (const item of raw.slice(0, 16)) {
    const b = item as Partial<BrowserInfo> | null;
    if (!b || typeof b !== 'object') continue;
    if (typeof b.id !== 'string' || !b.id || typeof b.name !== 'string' || !b.name) continue;
    out.push({
      id: b.id.slice(0, 500),
      name: b.name.slice(0, 100),
      connected: b.connected === true,
      ...(typeof b.version === 'string' && b.version ? { version: b.version.slice(0, 40) } : {})
    });
  }
  return out;
}

function asAnnouncement(report: unknown): DeviceBrowserAnnouncement | null {
  const value = report as Partial<DeviceBrowserAnnouncement> | null;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.enabled !== 'boolean') return null;
  if (value.platform !== 'darwin') return null;
  return {
    enabled: value.enabled,
    platform: 'darwin',
    browsers: asBrowsers(value.browsers),
    ...(typeof value.chosen === 'string' && value.chosen ? { chosen: value.chosen.slice(0, 500) } : {})
  };
}

function asDownloads(raw: unknown): BrowserDownloadReceipt[] {
  if (!Array.isArray(raw)) return [];
  const out: BrowserDownloadReceipt[] = [];
  for (const item of raw) {
    const d = item as Partial<BrowserDownloadReceipt> | null;
    // Only staging handles: the device streamed the bytes up first. A path
    // here would name a file on the SERVER, which is no business of the Mac's.
    if (!d || typeof d.handle !== 'string' || !isUploadHandle(d.handle)) continue;
    if (typeof d.name !== 'string' || !d.name) continue;
    out.push({
      handle: d.handle,
      name: d.name.slice(0, 255),
      size: typeof d.size === 'number' && d.size >= 0 ? d.size : 0,
      ...(typeof d.mime === 'string' && d.mime ? { mime: d.mime.slice(0, 100) } : {})
    });
  }
  return out;
}

function asResult(raw: unknown): DeviceBrowserResult {
  const value = raw as Partial<DeviceBrowserResult> | null;
  if (value && typeof value === 'object' && value.ok === true) {
    const v = value as {
      text?: unknown;
      screenshot?: { jpegBase64?: unknown; width?: unknown; height?: unknown };
      tab?: unknown;
      downloads?: unknown;
    };
    const shot = v.screenshot;
    const screenshot =
      shot &&
      typeof shot.jpegBase64 === 'string' &&
      shot.jpegBase64 &&
      typeof shot.width === 'number' &&
      typeof shot.height === 'number'
        ? { jpegBase64: shot.jpegBase64, width: shot.width, height: shot.height }
        : undefined;
    const text = typeof v.text === 'string' && v.text ? v.text : undefined;
    const downloads = asDownloads(v.downloads);
    if (!screenshot && !text && downloads.length === 0) {
      return { ok: false, error: 'The browser answered with nothing usable.' };
    }
    return {
      ok: true,
      ...(text ? { text } : {}),
      ...(screenshot ? { screenshot } : {}),
      ...(typeof v.tab === 'number' && Number.isInteger(v.tab) ? { tab: v.tab } : {}),
      ...(downloads.length ? { downloads } : {})
    };
  }
  const error = (value as { error?: unknown } | null)?.error;
  const stopped = (value as { stopped?: unknown } | null)?.stopped === true;
  return {
    ok: false,
    error: typeof error === 'string' && error.trim() ? error : 'The browser answered with nothing usable.',
    ...(stopped ? { stopped: true } : {})
  };
}

export const USER_STOPPED_BROWSER =
  'The user pressed Stop on your browser run. Do not send more browser actions this turn: report what you ' +
  'did and what was left, and wait for them.';

export function createBrowserDeviceRouter(deps: BrowserDeviceRouterDeps): BrowserDeviceRouter {
  const pending = new Map<string, Pending>();
  /** Threads the user stopped. */
  const stoppedThreads = new Set<string>();
  /** Every device each live thread has sent an action to, so endThread reaches them all. */
  const runs = new Map<string, Set<string>>();

  const mintRequestId = (): string => randomBytes(16).toString('hex');

  function failThread(threadId: string, result: DeviceBrowserResult): void {
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
      log('browser-device', 'a device announced whether it lets Stem drive its browser', {
        deviceId,
        enabled: announcement.enabled,
        browsers: announcement.browsers.map((b) => `${b.name}${b.connected ? '' : ' (closed)'}`),
        chosen: announcement.chosen
      });
    },

    hosts: () => deps.store.read(),

    async hostFor(deviceId) {
      return (await deps.store.read())[deviceId] ?? null;
    },

    isAvailable: (deviceId) => deps.connectedDevices().has(deviceId),

    async send(threadId, deviceId, action) {
      if (stoppedThreads.has(threadId)) return { ok: false, error: USER_STOPPED_BROWSER, stopped: true };
      const requestId = mintRequestId();
      const frame: DeviceBrowserRequest = { requestId, threadId, action };
      const reached = deps.pushTo(deviceId, BROWSER_REQUEST_FRAME, frame);
      if (reached === 0) {
        return {
          ok: false,
          error:
            'That computer is not connected to Stem right now (asleep, or Stem is not running there). ' +
            'Tell the user which machine needs waking rather than saying the task cannot be done.'
        };
      }
      const devices = runs.get(threadId) ?? new Set<string>();
      devices.add(deviceId);
      runs.set(threadId, devices);
      return new Promise<DeviceBrowserResult>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          log('browser-device', 'a browser action went unanswered', { deviceId, kind: action.kind });
          resolve({
            ok: false,
            error:
              `The browser did not answer within ${Math.round(ACTION_TIMEOUT_MS / 1000)}s. The action may or ` +
              'may not have happened: check the page (snapshot) before repeating it.'
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
        log('browser-device', 'refused a browser result from the wrong device', {
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

    stopped(deviceId, threadId) {
      // Only a device this thread is running on may stop it: another paired
      // Mac cannot end a run it never had.
      if (!runs.get(threadId)?.has(deviceId)) {
        log('browser-device', 'ignored a Stop from a device the thread is not using', { threadId, got: deviceId });
        return;
      }
      stoppedThreads.add(threadId);
      failThread(threadId, { ok: false, error: USER_STOPPED_BROWSER, stopped: true });
      log('browser-device', 'the user stopped a browser run', { threadId, deviceId });
    },

    isStopped: (threadId) => stoppedThreads.has(threadId),

    endThread(threadId, reason) {
      failThread(threadId, { ok: false, error: reason ?? 'The run was interrupted.' });
      const devices = runs.get(threadId);
      runs.delete(threadId);
      stoppedThreads.delete(threadId);
      for (const deviceId of devices ?? []) deps.pushTo(deviceId, BROWSER_END_FRAME, { threadId });
    },

    async forget(deviceId) {
      for (const [requestId, held] of pending) {
        if (held.deviceId !== deviceId) continue;
        pending.delete(requestId);
        clearTimeout(held.timer);
        held.settle({ ok: false, error: 'The computer was unpaired from this Stem during the run.' });
      }
      for (const [threadId, devices] of [...runs]) {
        devices.delete(deviceId);
        if (devices.size === 0) runs.delete(threadId);
      }
      const hosts = await deps.store.read();
      if (!hosts[deviceId]) return;
      delete hosts[deviceId];
      await deps.store.write(hosts);
      log('browser-device', 'forgot that an unpaired device hosted browser control', { deviceId });
    },

    close() {
      for (const [, held] of pending) {
        clearTimeout(held.timer);
        held.settle({ ok: false, error: 'Stem stopped during the run.' });
      }
      pending.clear();
      runs.clear();
      stoppedThreads.clear();
    }
  };
}

// ---- the store ----

interface StoredHosts {
  version: 1;
  hosts?: Record<string, DeviceBrowserHostEntry>;
}

async function readHostsFile(): Promise<Record<string, DeviceBrowserHostEntry>> {
  try {
    const parsed = JSON.parse(await readFile(browserDeviceHostsPath(), 'utf8')) as StoredHosts;
    if (parsed && typeof parsed === 'object' && parsed.hosts && typeof parsed.hosts === 'object') {
      const hosts: Record<string, DeviceBrowserHostEntry> = {};
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
      degrade('browser-device.hosts', 'forgot which Macs host browser control', e);
    }
  }
  return {};
}

async function writeHostsFile(hosts: Record<string, DeviceBrowserHostEntry>): Promise<void> {
  const path = browserDeviceHostsPath();
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

export function fileBrowserHostStore(): BrowserHostStore {
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

export function memoryBrowserHostStore(initial: Record<string, DeviceBrowserHostEntry> = {}): BrowserHostStore {
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

let router: BrowserDeviceRouter | null = null;

export function browserDeviceRouter(): BrowserDeviceRouter {
  router ??= createBrowserDeviceRouter({
    pushTo: pushToDevice,
    connectedDevices: connectedDeviceIds,
    store: fileBrowserHostStore()
  });
  return router;
}

export function closeBrowserDeviceRouter(): void {
  router?.close();
  router = null;
}
