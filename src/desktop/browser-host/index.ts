import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, realpath, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { log } from '../../server/log';
import {
  encodeFrame,
  FrameReader,
  MAX_TO_EXTENSION_BYTES,
  type ExtensionAction,
  type ExtensionResult,
  type FromExtension,
  type HostHello,
  type ToExtension
} from '../../shared/browser-native';
import type {
  BrowserDownloadReceipt,
  BrowserHostLocalState,
  BrowserInfo,
  DeviceBrowserRequest,
  DeviceBrowserResult
} from '../../shared/types';
import {
  browserInstallPaths,
  ensureHostConfig,
  installBrowserControl,
  refreshBrowserControl,
  type BrowserHostConfig,
  type BrowserInstallPaths,
  type InstallSource
} from './install';
import { readBrowserHostSettings, updateBrowserHostSettings, writeBrowserHostEnabled } from './store';

// The client half of the `browser` tool: THIS Mac, handing the browser actions
// its Stem server sends (BROWSER_REQUEST_FRAME) to the Stem extension in the
// user's browser, and answering with what it reports.
//
// The extension reaches us through its native-messaging host, which the
// browser starts and which connects to a unix socket here (0600, in this
// profile's state folder) and opens with the token from the config Set up
// wrote. One connection per browser; several may be up at once (Arc and
// Chrome), and the user picks which one Stem drives.
//
// What this file decides, like computer-host: whether Stem may drive the
// browser at all (the switch, read fresh on every request), and the file
// traffic — an upload's files are fetched from the server's outbox into a
// folder here before the extension attaches them, and finished downloads are
// streamed up to the server, which files them for the chat. What it does NOT
// do is any per-action policy; the user chose none (2026-10-05).

/** How long a launched browser gets to start and have its extension connect. */
const LAUNCH_WAIT_MS = 20_000;

export interface BrowserHostDeps {
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  /** Stream a file up to the server; answers the staging handle (file-transfer.ts uploadFile). */
  uploadFile(path: string): Promise<string>;
  /** Fetch an outbox entry into `dir` under `name`; answers the path (file-transfer.ts downloadFile). */
  downloadOutbox(id: string, dir: string, name: string): Promise<string>;
  /** Where the bundled extension and native host are, and what runs the host. */
  installSource(): InstallSource;
  /** Start an app without bringing it forward. Tests fake it. */
  launch?(appPath: string): Promise<void>;
  /** Open a URL or folder with an app (Set up's last step). Tests fake it. */
  openWith?(appPath: string | null, target: string): Promise<void>;
  paths?: BrowserInstallPaths;
  platform?: NodeJS.Platform;
  /** Tests shorten the launch wait. */
  launchWaitMs?: number;
}

export interface BrowserHost {
  start(): Promise<void>;
  refresh(): Promise<void>;
  /** An action arrived on the event stream. Never throws; answers over RPC. */
  onRequest(request: DeviceBrowserRequest): void;
  /** The server says this thread's run is over. */
  onEnd(end: { threadId: string }): void;
  localState(): Promise<BrowserHostLocalState>;
  setEnabled(enabled: boolean): Promise<BrowserHostLocalState>;
  choose(id: string): Promise<BrowserHostLocalState>;
  setUp(): Promise<BrowserHostLocalState>;
  openExtensionsPage(browserId?: string): Promise<void>;
  close(): void;
}

interface Conn {
  socket: Socket;
  appPath: string;
  appName: string;
  version?: string;
  pending: Map<string, (result: ExtensionResult) => void>;
}

function defaultLaunch(appPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // -g: do not bring it to the front; the user keeps working where they are.
    execFile('/usr/bin/open', ['-g', '-a', appPath], (error) => (error ? reject(error) : resolve()));
  });
}

function defaultOpenWith(appPath: string | null, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', appPath ? ['-a', appPath, target] : [target], (error) =>
      error ? reject(error) : resolve()
    );
  });
}

/** How long one action may take on this side before the extension is presumed stuck. */
export function actionTimeoutMs(action: ExtensionAction): number {
  switch (action.kind) {
    case 'wait':
      return (action.ms ?? 15_000) + 15_000;
    case 'downloads':
      return action.wait ? (action.ms ?? 30_000) + 15_000 : 30_000;
    case 'open':
    case 'navigate':
      return 45_000;
    default:
      return 60_000;
  }
}

export function createBrowserHost(deps: BrowserHostDeps): BrowserHost {
  const supported = (deps.platform ?? process.platform) === 'darwin';
  const paths = deps.paths ?? browserInstallPaths();
  const launch = deps.launch ?? defaultLaunch;
  const launchWaitMs = deps.launchWaitMs ?? LAUNCH_WAIT_MS;
  const openWith = deps.openWith ?? defaultOpenWith;
  const conns = new Map<string, Conn>();
  const connectWaiters = new Set<() => void>();
  /** Upload folders per thread, removed when the run ends. */
  const uploadDirs = new Map<string, Set<string>>();
  let server: Server | null = null;
  let config: BrowserHostConfig | null = null;
  /** The extension files changed since a browser connected: tell it to reload on its next hello. */
  let reloadPending = false;

  const send = (conn: Conn, message: ToExtension): boolean => {
    const frame = encodeFrame(message);
    if (frame.length - 4 > MAX_TO_EXTENSION_BYTES) return false;
    conn.socket.write(frame);
    return true;
  };

  async function browsersNow(): Promise<{ browsers: BrowserInfo[]; chosen: string | null; enabled: boolean }> {
    const settings = await readBrowserHostSettings();
    // Known ones first, in the order they first connected, then any connection
    // whose remembering is still being written.
    const known = [...settings.known];
    for (const c of conns.values()) if (!known.some((b) => b.id === c.appPath)) known.push({ id: c.appPath, name: c.appName });
    const browsers: BrowserInfo[] = known.map((b) => {
      const c = conns.get(b.id);
      return { id: b.id, name: b.name, connected: !!c, ...(c?.version ? { version: c.version } : {}) };
    });
    return { browsers, chosen: settings.chosen ?? browsers[0]?.id ?? null, enabled: settings.enabled };
  }

  async function announce(): Promise<void> {
    if (!supported) return;
    const { browsers, chosen, enabled } = await browsersNow();
    await deps
      .invoke('browserHost:announce', [
        { enabled, platform: 'darwin', browsers, ...(chosen ? { chosen } : {}) }
      ])
      .catch((e) => {
        log('browser-host', 'could not announce', { error: e instanceof Error ? e.message : String(e) });
      });
  }

  function onFrame(conn: Conn, message: FromExtension): void {
    if (message.type === 'hello') {
      conn.version = typeof message.extensionVersion === 'string' ? message.extensionVersion : undefined;
      log('browser-host', 'the extension said hello', { browser: conn.appName, version: conn.version });
      if (reloadPending) send(conn, { type: 'reload' });
      void announce();
      return;
    }
    if (message.type === 'result') {
      const settle = conn.pending.get(message.id);
      if (settle) {
        conn.pending.delete(message.id);
        settle(message.result);
      }
      return;
    }
    if (message.type === 'stopped' && typeof message.threadId === 'string' && message.threadId) {
      void deps
        .invoke('browserHost:event', [{ threadId: message.threadId, kind: 'stopped' }])
        .catch(() => undefined);
    }
  }

  function accept(socket: Socket): void {
    const reader = new FrameReader();
    let conn: Conn | null = null;
    const hello = setTimeout(() => socket.destroy(), 5000);
    hello.unref?.();
    socket.on('data', (chunk: Buffer) => {
      let bodies: Buffer[];
      try {
        bodies = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const body of bodies) {
        let message: unknown;
        try {
          message = JSON.parse(body.toString('utf8'));
        } catch {
          continue;
        }
        if (!conn) {
          const h = message as Partial<HostHello>;
          if (h?.type !== 'host-hello' || !config || h.token !== config.token || typeof h.appPath !== 'string') {
            log('browser-host', 'refused a native host without the right token');
            socket.destroy();
            return;
          }
          clearTimeout(hello);
          const appPath = h.appPath;
          const appName = typeof h.appName === 'string' && h.appName ? h.appName : 'Browser';
          // A browser that restarted connects again before the old socket is
          // noticed gone: the new connection wins.
          conns.get(appPath)?.socket.destroy();
          conn = { socket, appPath, appName, pending: new Map() };
          conns.set(appPath, conn);
          void updateBrowserHostSettings((cur) =>
            cur.known.some((b) => b.id === appPath)
              ? cur
              : { ...cur, known: [...cur.known, { id: appPath, name: appName }] }
          ).then(() => {
            for (const wake of [...connectWaiters]) wake();
          });
          continue;
        }
        onFrame(conn, message as FromExtension);
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(hello);
      if (!conn) return;
      for (const settle of conn.pending.values()) {
        settle({
          ok: false,
          error:
            `${conn.appName} disconnected from Stem during the action (it quit, or the extension reloaded). ` +
            'The action may or may not have happened: check the page before repeating it.'
        });
      }
      conn.pending.clear();
      if (conns.get(conn.appPath) === conn) {
        conns.delete(conn.appPath);
        void announce();
      }
    });
  }

  async function listen(): Promise<void> {
    if (!supported || server) return;
    config = await ensureHostConfig(paths);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    // A socket file left by a previous run (or a crash) would make listen fail.
    await rm(config.socketPath, { force: true });
    const s = createServer(accept);
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(config!.socketPath, () => resolve());
    });
    await chmod(config.socketPath, 0o600).catch(() => undefined);
    s.on('error', (e) => log('browser-host', 'socket error', { error: String(e) }));
    server = s;
  }

  /** The connection for the chosen browser, launching it when it is not running. */
  async function connectionFor(): Promise<{ ok: true; conn: Conn } | { ok: false; error: string }> {
    const settings = await readBrowserHostSettings();
    const chosen = settings.chosen ?? settings.known[0]?.id ?? [...conns.keys()][0];
    if (!chosen) {
      return {
        ok: false,
        error:
          'No browser with the Stem extension has connected on this Mac yet. Tell the user to set it up in ' +
          'Settings → Features → Browser control → Set up, on that Mac.'
      };
    }
    const live = conns.get(chosen);
    if (live) return { ok: true, conn: live };
    const name = settings.known.find((b) => b.id === chosen)?.name ?? chosen;
    try {
      await launch(chosen);
    } catch (e) {
      return { ok: false, error: `${name} could not be started on this Mac: ${e instanceof Error ? e.message : String(e)}` };
    }
    const conn = await new Promise<Conn | null>((resolve) => {
      const wake = (): void => {
        const c = conns.get(chosen);
        if (!c) return;
        cleanup();
        resolve(c);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, launchWaitMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        connectWaiters.delete(wake);
      };
      connectWaiters.add(wake);
      wake();
    });
    if (conn) {
      log('browser-host', 'started the browser for a run', { browser: name });
      return { ok: true, conn };
    }
    return {
      ok: false,
      error:
        `${name} was started, but the Stem extension did not connect within ${Math.round(launchWaitMs / 1000)}s. It may be ` +
        'disabled or removed there; tell the user to check Settings → Features → Browser control on that Mac.'
    };
  }

  /** The device's action, as the extension takes it: an upload's files fetched to this Mac first. */
  async function localAction(request: DeviceBrowserRequest): Promise<ExtensionAction> {
    const action = request.action;
    if (action.kind !== 'upload') return action;
    // A folder name of our own, never one built from what came over the wire.
    const dir = join(paths.uploadsDir, randomBytes(8).toString('hex'));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const dirs = uploadDirs.get(request.threadId) ?? new Set<string>();
    dirs.add(dir);
    uploadDirs.set(request.threadId, dirs);
    const local: string[] = [];
    for (const f of action.files) {
      if (typeof f.id !== 'string' || !/^[0-9a-f]{32}$/.test(f.id)) throw new Error('an upload named a file the server never queued');
      local.push(await deps.downloadOutbox(f.id, dir, f.name));
    }
    return { kind: 'upload', ref: action.ref, paths: local, ...(action.tab !== undefined ? { tab: action.tab } : {}) };
  }

  /** Stream finished downloads up; a failure is a line in the text, not a failed action. */
  async function remoteResult(result: ExtensionResult): Promise<DeviceBrowserResult> {
    if (!result.ok) return result;
    const { downloads, ...rest } = result;
    if (!downloads?.length) return rest;
    const receipts: BrowserDownloadReceipt[] = [];
    const notes: string[] = [];
    const spool = await realpath(paths.spoolDir).catch(() => null);
    for (const d of downloads) {
      // Only the native host's own copies, one folder deep in the spool: a
      // path anywhere else — the original in ~/Downloads when the copy failed,
      // or anything a peer on the socket made up — is never sent to the server.
      const real = spool ? await realpath(d.path).catch(() => null) : null;
      const folder = real ? dirname(real) : null;
      if (!spool || !real || !folder || dirname(folder) !== spool) {
        notes.push(`Download “${d.name}” finished on the Mac but could not be copied for Stem; ask the user for the file.`);
        continue;
      }
      try {
        const handle = await deps.uploadFile(real);
        receipts.push({ handle, name: d.name, size: d.size, ...(d.mime ? { mime: d.mime } : {}) });
      } catch (e) {
        notes.push(`Download “${d.name}” finished on the Mac but could not be sent to Stem: ${e instanceof Error ? e.message : String(e)}`);
      }
      // The spool copy has done its job either way.
      void rm(folder, { recursive: true, force: true });
    }
    const text = [rest.text, ...notes].filter(Boolean).join('\n');
    return { ...rest, ...(text ? { text } : {}), ...(receipts.length ? { downloads: receipts } : {}) };
  }

  async function execute(request: DeviceBrowserRequest): Promise<DeviceBrowserResult> {
    if (!supported) return { ok: false, error: 'Browser control is only available on macOS for now.' };
    if (!(await readBrowserHostSettings()).enabled) {
      return {
        ok: false,
        error:
          'This Mac does not let Stem drive its browser. The switch is in Settings → Features → Browser control, ' +
          'on that computer.'
      };
    }
    const target = await connectionFor();
    if (!target.ok) return { ok: false, error: target.error };
    const conn = target.conn;
    let action: ExtensionAction;
    try {
      action = await localAction(request);
    } catch (e) {
      return { ok: false, error: `The files could not be brought to the Mac for the upload: ${e instanceof Error ? e.message : String(e)}` };
    }
    const result = await new Promise<ExtensionResult>((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(request.requestId);
        resolve({
          ok: false,
          error:
            `${conn.appName} did not finish the action in time. It may or may not have happened: check the page ` +
            '(snapshot) before repeating it.'
        });
      }, actionTimeoutMs(action));
      conn.pending.set(request.requestId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      const sent = send(conn, { type: 'request', id: request.requestId, threadId: request.threadId, action });
      if (!sent) {
        clearTimeout(timer);
        conn.pending.delete(request.requestId);
        resolve({ ok: false, error: 'The action is too large to hand to the browser (over 1 MB); shorten it.' });
      }
    });
    return remoteResult(result);
  }

  async function refreshInstall(): Promise<void> {
    try {
      const refreshed = await refreshBrowserControl(deps.installSource(), paths);
      if (refreshed?.extensionChanged) {
        reloadPending = true;
        for (const c of conns.values()) send(c, { type: 'reload' });
      }
    } catch (e) {
      log('browser-host', 'could not refresh the installed extension', { error: String(e) });
    }
  }

  async function state(): Promise<BrowserHostLocalState> {
    const { browsers, chosen, enabled } = await browsersNow();
    return { supported, enabled, browsers, chosen, extensionPath: existsSync(paths.extensionDir) ? paths.extensionDir : null };
  }

  return {
    async start() {
      if (!supported) return;
      try {
        await listen();
      } catch (e) {
        log('browser-host', 'could not listen for the extension', { error: String(e) });
      }
      await refreshInstall();
      await announce();
    },

    refresh: () => announce(),

    onRequest(request) {
      void (async () => {
        let result: DeviceBrowserResult;
        try {
          result = await execute(request);
        } catch (e) {
          result = { ok: false, error: `The action failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        await deps.invoke('browserHost:result', [request.requestId, result]).catch((e) => {
          log('browser-host', 'could not deliver a browser result', {
            error: e instanceof Error ? e.message : String(e)
          });
        });
      })();
    },

    onEnd({ threadId }) {
      for (const c of conns.values()) send(c, { type: 'end', threadId });
      for (const dir of uploadDirs.get(threadId) ?? []) void rm(dir, { recursive: true, force: true });
      uploadDirs.delete(threadId);
    },

    localState: state,

    async setEnabled(enabled) {
      if (!supported) return state();
      await writeBrowserHostEnabled(enabled);
      await announce();
      return state();
    },

    async choose(id) {
      await updateBrowserHostSettings((cur) => (cur.known.some((b) => b.id === id) ? { ...cur, chosen: id } : cur));
      await announce();
      return state();
    },

    async setUp() {
      if (!supported) return state();
      await listen().catch((e) => log('browser-host', 'could not listen for the extension', { error: String(e) }));
      const result = await installBrowserControl(deps.installSource(), paths);
      log('browser-host', 'set up browser control', { registered: result.registered });
      if (result.extensionChanged) {
        reloadPending = true;
        for (const c of conns.values()) send(c, { type: 'reload' });
      }
      return state();
    },

    async openExtensionsPage(browserId) {
      const settings = await readBrowserHostSettings();
      const app = browserId ?? settings.chosen ?? settings.known[0]?.id ?? null;
      // Browsers refuse chrome:// URLs from outside, so the reliable half is
      // the folder: Finder shows it, ready for Load unpacked.
      await openWith(null, paths.extensionDir).catch(() => undefined);
      if (app) await openWith(app, 'chrome://extensions').catch(() => undefined);
    },

    close() {
      for (const c of conns.values()) c.socket.destroy();
      conns.clear();
      server?.close();
      server = null;
      if (config) void rm(config.socketPath, { force: true });
    }
  };
}
