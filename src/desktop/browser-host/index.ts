import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, realpath, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { log } from '../../server/log';
import {
  encodeFrame,
  FrameReader,
  MAX_TO_EXTENSION_BYTES,
  type ExtensionAction,
  type ExtensionDownload,
  type ExtensionResult,
  type FromExtension,
  type HostHello,
  type ToExtension,
  launchableBrowser,
  sandboxOf
} from '../../shared/browser-native';
import type {
  BrowserDownloadReceipt,
  BrowserHostLocalState,
  BrowserInfo,
  DeviceBrowserRequest,
  DeviceBrowserResult
} from '../../shared/types';
import {
  browserDirs,
  browserInstallPaths,
  ensureHostConfig,
  extensionsPageUrl,
  hasSandboxedBrowsers,
  installBrowserControl,
  newRelayPort,
  refreshBrowserControl,
  relaysHere,
  setupBrowsers,
  writeHostConfig,
  type BrowserHostConfig,
  type BrowserInstallPaths,
  type InstallSource
} from './install';
import { handshakeProof, isNonce, newNonce, proofMatches } from './handshake';
import { launchableAppImage } from './appimage';
import { inSandboxDir, openDownload, removeInSandbox, parseRelayHello, relayKey, sandboxCommand, sandboxRoot, sandboxRunning } from './relay';
import { arcSidebarText, readArcSidebar, type ArcSidebarTab } from './arc-tabs';
import {
  appOf,
  readBrowserHostSettings,
  updateBrowserHostSettings,
  writeBrowserHostEnabled,
  type BrowserHostSettings,
  type KnownBrowser
} from './store';

// The client half of the `browser` tool: THIS Mac, Windows or Linux computer, handing the browser actions
// its Stem server sends (BROWSER_REQUEST_FRAME) to the Stem extension in the
// user's browser, and answering with what it reports.
//
// The extension reaches us through its native-messaging host, which the
// browser starts and which connects to a unix socket here (0600, in this
// profile's state folder; a named pipe on Windows) and proves it holds the
// token from the config Set up wrote (handshake.ts). A Snap or Flatpak
// browser's host is a relay inside its sandbox instead, which reaches a
// loopback TCP port here with the same proof in text lines (relay.ts). One connection per
// browser profile — the extension sends an id it keeps in that profile's
// storage — and several may be up at once (Arc's work and personal profiles,
// Chrome beside them). The user picks the default and can name each one; the
// model may name another profile per call, and the one it named stays the
// thread's until it names a different one.
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
  /** Put text on the clipboard (the extension folder, for Load unpacked's picker). */
  copyText?(text: string): void;
  paths?: BrowserInstallPaths;
  platform?: NodeJS.Platform;
  /** The home whose browsers Set up registers. Tests point it at a temp folder. */
  home?: string;
  /** Arc's sidebar tabs (arc-tabs.ts). Tests fake it. */
  readArcSidebar?(): Promise<{ tabs: ArcSidebarTab[] } | { error: string }>;
  /** Tests shorten the launch wait. */
  launchWaitMs?: number;
  /** Tests shorten every action's deadline, the liveness check after one runs out, and the wait for a restarted extension. */
  actionTimeoutMs?: number;
  aliveProbeMs?: number;
  restartWaitMs?: number;
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
  rename(id: string, name: string): Promise<BrowserHostLocalState>;
  forget(id: string): Promise<BrowserHostLocalState>;
  setUp(): Promise<BrowserHostLocalState>;
  openExtensionsPage(browserId?: string): Promise<void>;
  /**
   * "Ask about this window" over a browser window: whether that browser has
   * the extension connected, and the page in front when it can say. `app` and
   * `title` are the window's, to tell which browser (and profile) it is.
   */
  peekWindow(app: string, title: string): Promise<{ ready: boolean; page: { url: string; title: string } | null }>;
  close(): void;
}

/** How long a peek may hold "Ask about this window" up. */
const PEEK_TIMEOUT_MS = 1_500;
/** After an action ran out of time: how long the extension has to answer a cheap check that it still listens at all. */
const ALIVE_PROBE_MS = 5_000;
/** How long an extension Stem restarted has to connect again. */
const RESTART_WAIT_MS = 15_000;

/** A tab's title and its window's, one cut short or added to by the browser. */
export function sameTitle(page: string, window: string): boolean {
  const a = page.trim().toLowerCase();
  const b = window.trim().toLowerCase();
  return a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a));
}

/** "Google Chrome" ~ "Chrome", "Brave Browser" ~ "Brave": the window's app and the host's name for it. */
export function sameBrowser(windowApp: string, hostName: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\.app$|\.exe$/, '').replace(/[^a-z0-9]+/g, ' ').replace(/\b(google|microsoft|browser)\b/g, '').trim();
  const a = norm(windowApp);
  const b = norm(hostName);
  return !!a && !!b && (a === b || a.split(' ')[0] === b.split(' ')[0]);
}

interface Conn {
  socket: Socket;
  /** KnownBrowser.id, once the extension said hello; until then the connection is not usable. */
  key: string | null;
  appPath: string;
  appName: string;
  version?: string;
  /** HostHello.startedAt: which of two hosts claiming one profile is the newer. 0 when the host did not say. */
  startedAt: number;
  /** Another connection of the same profile took this one's place. */
  replaced?: boolean;
  pending: Map<string, (result: ExtensionResult) => void>;
  /**
   * A sandboxed browser's relay (relay.ts), by its id: an upload's files go to
   * its own folder for the browser to read them, and its downloads are copied
   * here, since the relay cannot.
   */
  sandbox?: string;
}

/** Longest name a profile may be given. */
const MAX_PROFILE_NAME = 40;

/**
 * What each known browser is called: the user's name for it, else — when an
 * app has several profiles — "Arc 2" by the order they first connected. An
 * app's only, unnamed profile has none and goes by the app's name.
 */
export function profileNames(known: readonly KnownBrowser[]): Map<string, string | undefined> {
  const names = new Map<string, string | undefined>();
  const seen = new Map<string, number>();
  for (const b of known) {
    const app = appOf(b.id);
    const n = (seen.get(app) ?? 0) + 1;
    seen.set(app, n);
    const siblings = known.filter((o) => appOf(o.id) === app).length;
    names.set(b.id, b.label ?? (siblings > 1 ? `${b.name} ${n}` : undefined));
  }
  return names;
}

/** How the model and the popup name a known browser. */
function nameOf(b: KnownBrowser, names: Map<string, string | undefined>): string {
  return names.get(b.id) ?? b.name;
}

/** The known browser a name from the model means: a profile's name, or an app with one profile. */
export function findProfile(
  known: readonly KnownBrowser[],
  wanted: string,
  names: Map<string, string | undefined> = profileNames(known)
): KnownBrowser | null {
  const w = wanted.trim().toLowerCase();
  if (!w) return null;
  const byName = known.find((b) => nameOf(b, names).toLowerCase() === w);
  if (byName) return byName;
  const byApp = known.filter((b) => b.name.toLowerCase() === w);
  return byApp.length === 1 ? byApp[0]! : null;
}

/** "“Work” (Arc), “Personal” (Arc)" — the names the model may pass. */
function profileList(
  known: readonly KnownBrowser[],
  names: Map<string, string | undefined> = profileNames(known)
): string {
  return known
    .map((b) => {
      const name = nameOf(b, names);
      return name === b.name ? `“${name}”` : `“${name}” (${b.name})`;
    })
    .join(', ');
}

/** The browser Stem uses on this Mac when nothing else says which. */
function defaultId(settings: BrowserHostSettings): string | undefined {
  const chosen = settings.chosen && settings.known.some((b) => b.id === settings.chosen) ? settings.chosen : undefined;
  return chosen ?? settings.known[0]?.id;
}

/**
 * What one request may reach: every known profile, or only those the turn's
 * grant allows. Names stay those of the whole list, so "Arc 2" means the same
 * profile to every persona.
 */
interface Scope {
  /** The settings with `known` cut down to the allowed profiles (the default falls inside them). */
  settings: BrowserHostSettings;
  names: Map<string, string | undefined>;
  /** The grant limits the profiles. */
  limited: boolean;
}

export function scopeOf(settings: BrowserHostSettings, allowed: readonly string[] | undefined): Scope {
  const names = profileNames(settings.known);
  if (!allowed) return { settings, names, limited: false };
  const known = settings.known.filter((b) => allowed.includes(b.id));
  return { settings: { ...settings, known }, names, limited: true };
}

/** "mail.google.com, github.com" — the sites a hello says are most open there; anything else is dropped. */
function asHint(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const hosts = raw
    .split(',')
    .map((h) => h.trim())
    .filter((h) => /^[a-z0-9.-]{1,100}$/i.test(h))
    .slice(0, 3);
  return hosts.length ? hosts.join(', ') : undefined;
}

/** Is a process running this executable? Linux only: it reads /proc. */
function runningExe(exe: string): boolean {
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return false;
  }
  for (const pid of pids) {
    try {
      if (readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '') === exe) return true;
    } catch {
      // quiet: another user's process, or one that just exited.
    }
  }
  return false;
}

/** Start a program on its own, answering once it started (or failed to). */
function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Is a process running this executable? Windows: one PowerShell question. */
function runningWindowsExe(exe: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `if (Get-Process | Where-Object { $_.Path -eq $args[0] } | Select-Object -First 1) { 'yes' }`, exe],
      { timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve(!error && String(stdout).trim() === 'yes')
    );
  });
}

async function defaultLaunch(appPath: string, platform: NodeJS.Platform): Promise<void> {
  const sandboxed = platform === 'linux' ? sandboxCommand(appPath, []) : null;
  if (sandboxed) {
    if (await sandboxRunning(appPath)) return;
    return spawnDetached(sandboxed.command, sandboxed.args);
  }
  if (platform === 'win32') {
    // As on Linux: a second start of a running browser opens a window.
    if (await runningWindowsExe(appPath)) return;
    return spawnDetached(appPath, []);
  }
  if (platform === 'linux') {
    // Running a browser's executable again while it runs opens a new window;
    // the connection is only late, so leave the window count alone. Linux has
    // no `open -g`: a browser started here may come to the front.
    if (runningExe(appPath)) return Promise.resolve();
    return spawnDetached(appPath, []);
  }
  return new Promise((resolve, reject) => {
    // -g: do not bring it to the front; the user keeps working where they are.
    execFile('/usr/bin/open', ['-g', '-a', appPath], (error) => (error ? reject(error) : resolve()));
  });
}

function defaultOpenWith(appPath: string | null, target: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') return appPath ? spawnDetached(appPath, [target]) : spawnDetached('explorer.exe', [target]);
  if (platform === 'linux') {
    const sandboxed = appPath ? sandboxCommand(appPath, [target]) : null;
    if (sandboxed) return spawnDetached(sandboxed.command, sandboxed.args);
    return appPath ? spawnDetached(appPath, [target]) : spawnDetached('xdg-open', [target]);
  }
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', appPath ? ['-a', appPath, target] : [target], (error) =>
      error ? reject(error) : resolve()
    );
  });
}

const isPipe = (path: string): boolean => path.startsWith('\\\\.\\pipe\\');

/** A pre-handshake host-hello carried the token itself; constant-time compare. */
function legacyTokenMatches(token: string, sent: unknown): boolean {
  if (typeof sent !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(sent);
  return a.length === b.length && timingSafeEqual(a, b);
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
  const platform = deps.platform ?? process.platform;
  const supported = platform === 'darwin' || platform === 'linux' || platform === 'win32';
  // What the model and the user are told this computer is.
  const here = platform === 'darwin' ? 'Mac' : 'computer';
  const paths = deps.paths ?? browserInstallPaths();
  const launch = deps.launch ?? ((app: string) => defaultLaunch(app, platform));
  const launchWaitMs = deps.launchWaitMs ?? LAUNCH_WAIT_MS;
  const aliveProbeMs = deps.aliveProbeMs ?? ALIVE_PROBE_MS;
  const restartWaitMs = deps.restartWaitMs ?? RESTART_WAIT_MS;
  /** One restart per stuck connection, however many of its actions ran out of time. */
  const restarting = new WeakMap<Conn, Promise<string>>();
  const openWith = deps.openWith ?? ((app: string | null, target: string) => defaultOpenWith(app, target, platform));
  /** A browser Stem knows, or on Linux an AppImage that vouches for itself. */
  const mayLaunch = (app: string): boolean => launchableBrowser(app, platform) || (platform === 'linux' && launchableAppImage(app));
  const conns = new Map<string, Conn>();
  const connectWaiters = new Set<() => void>();
  /** Upload folders per thread, removed when the run ends. */
  const uploadDirs = new Map<string, Set<string>>();
  /** The same in sandboxed browsers' folders, by browser and folder name: removed through the held-open folder. */
  const sandboxUploads = new Map<string, Array<{ app: string; name: string }>>();
  /** The profile each live thread last named (KnownBrowser.id), until its run ends. */
  const threadProfile = new Map<string, string>();
  let server: Server | null = null;
  /** Loopback, for sandboxed browsers' relays; up only while one is set up for this profile. */
  let relayServer: Server | null = null;
  let config: BrowserHostConfig | null = null;
  /**
   * Browsers that may still run extension code older than the files on disk:
   * each gets one reload on its next hello, then leaves the set — the reloaded
   * extension says hello again, and a second reload would loop forever.
   */
  const reloadOwed = new Set<string>();
  /**
   * Profiles the user removed while their extension was connected. It was told
   * to uninstall itself; one too old to know how would reconnect and be
   * remembered again, so its hellos are refused until Set up runs again.
   */
  const removed = new Set<string>();
  /** Profiles a stale native host was already refused for, logged once each: an old one retries every two seconds. */
  const staleLogged = new Set<string>();

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
    for (const c of conns.values()) if (c.key && !known.some((b) => b.id === c.key)) known.push({ id: c.key, name: c.appName });
    const names = profileNames(known);
    const browsers: BrowserInfo[] = known.map((b) => {
      const c = conns.get(b.id);
      const profile = names.get(b.id);
      return {
        id: b.id,
        name: b.name,
        ...(profile ? { profile } : {}),
        ...(b.label ? { named: true } : {}),
        ...(b.hint ? { hint: b.hint } : {}),
        connected: !!c,
        ...(c?.version ? { version: c.version } : {})
      };
    });
    return { browsers, chosen: defaultId({ ...settings, known }) ?? null, enabled: settings.enabled };
  }

  async function announce(): Promise<void> {
    if (!supported) return;
    const { browsers, chosen, enabled } = await browsersNow();
    await deps
      .invoke('browserHost:announce', [
        {
          enabled,
          platform: platform === 'darwin' || platform === 'win32' ? platform : 'linux',
          // The sites open in a profile stay on this computer.
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          browsers: browsers.map(({ hint, named, ...b }) => b),
          ...(chosen ? { chosen } : {}),
          enforcesProfiles: true
        }
      ])
      .catch((e) => {
        log('browser-host', 'could not announce', { error: e instanceof Error ? e.message : String(e) });
      });
  }

  /** Tell every connected extension what Stem calls its profile (a rename can shift the others' "Arc 2"). */
  async function sendNames(): Promise<void> {
    const known = (await readBrowserHostSettings()).known;
    const names = profileNames(known);
    for (const b of known) {
      const c = conns.get(b.id);
      if (c) send(c, { type: 'profile', name: nameOf(b, names) });
    }
  }

  /**
   * Remember the profile behind a hello. An entry from before profiles were
   * told apart (the bare app path) is taken over by the first profile of that
   * app to connect, keeping its place as the default.
   */
  async function remember(conn: Conn, key: string, hint: string | undefined): Promise<void> {
    await updateBrowserHostSettings((cur) => {
      const at = cur.known.findIndex((b) => b.id === key);
      if (at >= 0) {
        const known = [...cur.known];
        known[at] = { ...known[at]!, name: conn.appName, ...(hint ? { hint } : {}) };
        return { ...cur, known };
      }
      const entry: KnownBrowser = { id: key, name: conn.appName, ...(hint ? { hint } : {}) };
      const legacy = key !== conn.appPath ? cur.known.findIndex((b) => b.id === conn.appPath) : -1;
      if (legacy >= 0 && !conns.has(conn.appPath)) {
        const known = [...cur.known];
        known[legacy] = { ...entry, ...(known[legacy]!.label ? { label: known[legacy]!.label } : {}) };
        return { ...cur, known, ...(cur.chosen === conn.appPath ? { chosen: key } : {}) };
      }
      return { ...cur, known: [...cur.known, entry] };
    });
  }

  async function onHello(conn: Conn, message: Extract<FromExtension, { type: 'hello' }>): Promise<void> {
    conn.version = typeof message.extensionVersion === 'string' ? message.extensionVersion : undefined;
    const profile =
      typeof message.profileId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(message.profileId) ? message.profileId : null;
    // An extension from before 0.7.0 sends no profile id: one entry per app, as then.
    const key = profile ? `${conn.appPath}#${profile}` : conn.appPath;
    const old = conns.get(key);
    if (old && old !== conn && conn.startedAt < old.startedAt) {
      // A native host older than the one connected for this profile: the
      // browser left it running when the extension's worker restarted, and it
      // replays the old worker's hello on every retry. Letting it in would
      // throw the live connection off, whose host would then retry and throw
      // this one off, every two seconds (2026-11-02). Told to quit instead.
      if (!staleLogged.has(key)) {
        staleLogged.add(key);
        log('browser-host', 'refused a stale native host; a newer one has this profile', { browser: conn.appName });
      }
      conn.replaced = true;
      send(conn, { type: 'replaced' });
      conn.socket.end();
      return;
    }
    log('browser-host', 'the extension said hello', { browser: conn.appName, version: conn.version, profile: !!profile });
    if (conn.key !== key) {
      if (conn.key && conns.get(conn.key) === conn) conns.delete(conn.key);
      // A browser that restarted, or an extension whose worker restarted,
      // connects again before the old socket is noticed gone: the newer
      // connection wins, and the old host is told to stop retrying.
      if (old && old !== conn) {
        old.replaced = true;
        send(old, { type: 'replaced' });
        old.socket.end();
        setTimeout(() => old.socket.destroy(), 1_000).unref?.();
      }
      conn.key = key;
      conns.set(key, conn);
    }
    if (removed.has(key)) {
      send(conn, { type: 'uninstall' });
      conn.socket.end();
      return;
    }
    if (reloadOwed.delete(key) || reloadOwed.delete(conn.appPath)) {
      send(conn, { type: 'reload' });
      return;
    }
    await remember(conn, key, asHint(message.hint)).catch((e) =>
      log('browser-host', 'could not remember a browser', { error: String(e) })
    );
    for (const wake of [...connectWaiters]) wake();
    await sendNames();
    await announce();
  }

  function onFrame(conn: Conn, message: FromExtension): void {
    if (message.type === 'hello') {
      void onHello(conn, message);
      return;
    }
    if (message.type === 'result') {
      const settle = conn.pending.get(message.id);
      if (settle) {
        conn.pending.delete(message.id);
        const r = message.result;
        // A relay cannot copy downloads to the spool as the Node host does.
        if (conn.sandbox && r.ok && r.downloads?.length) {
          void spoolDownloads(r.downloads).then((downloads) => settle({ ...r, downloads }));
        } else {
          settle(r);
        }
      }
      return;
    }
    if (message.type === 'stopped' && typeof message.threadId === 'string' && message.threadId) {
      void deps
        .invoke('browserHost:event', [{ threadId: message.threadId, kind: 'stopped' }])
        .catch(() => undefined);
    }
  }

  /**
   * Copy a sandboxed browser's finished downloads into the spool
   * (native-host-main.ts does this for an unsandboxed one). Only plain files
   * inside the Downloads folder (relay.ts openDownload): the path is the
   * sandbox's word, and this side reads with all the user's rights.
   */
  async function spoolDownloads(downloads: ExtensionDownload[]): Promise<ExtensionDownload[]> {
    const out: ExtensionDownload[] = [];
    for (const d of downloads) {
      try {
        const handle = await openDownload(typeof d.path === 'string' ? d.path : '', deps.home);
        const dir = join(paths.spoolDir, randomBytes(8).toString('hex'));
        try {
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const to = join(dir, basename(d.name || d.path) || 'download');
          await pipeline(handle.createReadStream(), createWriteStream(to, { flags: 'wx', mode: 0o600 }));
          out.push({ ...d, path: to });
        } finally {
          await handle.close().catch(() => undefined);
        }
      } catch (e) {
        log('browser-host', 'could not spool a download', { error: e instanceof Error ? e.message : String(e) });
        // Left as it was: remoteResult sends up only spool copies.
        out.push(d);
      }
    }
    return out;
  }

  /** The connection's frames after its handshake: the extension's messages, and a closed socket ending its actions. */
  function serve(socket: Socket, conn: Conn, reader: FrameReader, rest?: Buffer): void {
    const take = (chunk: Buffer): void => {
      let bodies: Buffer[];
      try {
        bodies = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const body of bodies) {
        try {
          onFrame(conn, JSON.parse(body.toString('utf8')) as FromExtension);
        } catch {
          // Not JSON: dropped.
        }
      }
    };
    socket.on('data', take);
    if (rest?.length) take(rest);
  }

  function dropConn(conn: Conn): void {
    for (const settle of conn.pending.values()) {
      settle({
        ok: false,
        error: conn.replaced
          ? `Stem's link to ${conn.appName} was handed to a newer one from the same profile during the action ` +
            '(the extension restarted; nothing the user did, and the browser is still connected). ' +
            'The action may or may not have happened: check the page, then carry on.'
          : `Stem lost its link to ${conn.appName} during the action (the browser quit, or its Stem extension restarted). ` +
            'The action may or may not have happened: check the page before repeating it, and try once more ' +
            'before asking the user to do anything.'
      });
    }
    conn.pending.clear();
    if (conn.key && conns.get(conn.key) === conn) {
      conns.delete(conn.key);
      void announce();
    }
  }

  /**
   * A sandboxed browser's relay (relay.ts) on the loopback port. Anyone on
   * this computer can reach the port, so nothing is accepted before the relay
   * proves it holds the token, and only for a Snap or Flatpak browser that is
   * set up here — Stem names it, not the relay.
   */
  function acceptRelay(socket: Socket): void {
    let text = '';
    let nonce: string | null = null;
    let claimed: { appPath: string; appName: string; key: string } | null = null;
    const timer = setTimeout(() => socket.destroy(), 10_000);
    timer.unref?.();
    socket.on('error', () => undefined);
    const onText = (chunk: Buffer): void => {
      text += chunk.toString('latin1');
      for (let at = text.indexOf('\n'); at >= 0 && !socket.destroyed; at = text.indexOf('\n')) {
        const line = text.slice(0, at);
        text = text.slice(at + 1);
        if (!nonce) {
          const hello = parseRelayHello(line);
          const dir = hello ? browserDirs(deps.home ?? homedir(), platform).find((d) => d.sandbox === hello.app) : undefined;
          if (!hello || !dir || !config) {
            log('browser-host', 'refused a relay that did not start the handshake for a browser set up here');
            socket.destroy();
            return;
          }
          // That browser's own key: a relay can prove only the browser it was written for.
          claimed = { appPath: hello.app, appName: dir.name, key: relayKey(config.relaySecret, hello.app) };
          nonce = newNonce();
          socket.write(`${nonce} ${handshakeProof(claimed.key, 'stem', hello.nonce)}\n`);
          continue;
        }
        if (!claimed || !proofMatches(claimed.key, 'host', nonce, line.trim())) {
          log('browser-host', 'refused a relay without the right token');
          socket.destroy();
          return;
        }
        clearTimeout(timer);
        socket.off('data', onText);
        const conn: Conn = {
          socket,
          key: null,
          appPath: claimed.appPath,
          appName: claimed.appName,
          startedAt: 0,
          pending: new Map(),
          sandbox: claimed.appPath
        };
        socket.on('close', () => dropConn(conn));
        // What the Node host tells the extension once it reaches Stem.
        send(conn, { type: 'host', connected: true });
        // Which profile this is arrives with the extension's hello, right behind.
        serve(socket, conn, new FrameReader(), Buffer.from(text, 'latin1'));
        return;
      }
      if (text.length > 1024) socket.destroy();
    };
    socket.on('data', onText);
    socket.on('close', () => clearTimeout(timer));
  }

  /** Listen on loopback for relays, on the config's port, or a new one when another program has it. */
  async function listenRelay(): Promise<void> {
    if (platform !== 'linux' || relayServer) return;
    config = config ?? (await ensureHostConfig(paths));
    for (let attempt = 0; attempt < 5; attempt++) {
      const s = createServer(acceptRelay);
      const ok = await new Promise<boolean>((resolve) => {
        s.once('error', () => resolve(false));
        s.listen(config!.relayPort, '127.0.0.1', () => resolve(true));
      });
      if (ok) {
        s.on('error', (e) => log('browser-host', 'relay port error', { error: String(e) }));
        relayServer = s;
        return;
      }
      log('browser-host', 'the relay port is taken; moving to another', { port: config.relayPort });
      config = await writeHostConfig(paths, { ...config, relayPort: newRelayPort() });
    }
    throw new Error('no free port for sandboxed browsers');
  }

  function accept(socket: Socket): void {
    const reader = new FrameReader();
    let conn: Conn | null = null;
    /** Between the host's hello and its proof: what it claimed, and the nonce it must answer. */
    let pending: { appPath: string; appName: string; startedAt: number; nonce: string } | null = null;
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
        if (!conn && !pending) {
          const h = message as Partial<HostHello> & { token?: unknown };
          if (h?.type === 'host-hello' && config && !('nonce' in h) && legacyTokenMatches(config.token, h.token)) {
            // A native host from before the handshake (Stem ≤ 0.6), still
            // running because the browser kept its port open across a Stem
            // update: it would retry every two seconds forever and the
            // profile would never connect (2026-10-19). It relays whatever
            // comes back unchecked, so tell the extension to reload — that
            // closes the port, the old host exits, and the browser starts the
            // one on disk.
            log('browser-host', 'an old native host connected; reloading the extension so the browser starts the new one');
            clearTimeout(hello);
            socket.end(encodeFrame({ type: 'reload' } satisfies ToExtension));
            return;
          }
          if (h?.type !== 'host-hello' || !config || !isNonce(h.nonce) || typeof h.appPath !== 'string') {
            log('browser-host', 'refused a native host that did not start the handshake');
            socket.destroy();
            return;
          }
          pending = {
            appPath: h.appPath,
            appName: typeof h.appName === 'string' && h.appName ? h.appName : 'Browser',
            startedAt: typeof h.startedAt === 'number' && Number.isFinite(h.startedAt) && h.startedAt > 0 ? h.startedAt : 0,
            nonce: newNonce()
          };
          socket.write(encodeFrame({ type: 'server-hello', nonce: pending.nonce, proof: handshakeProof(config.token, 'stem', h.nonce) }));
          continue;
        }
        if (!conn && pending) {
          const p = message as { type?: unknown; proof?: unknown };
          if (p?.type !== 'host-proof' || !config || !proofMatches(config.token, 'host', pending.nonce, p.proof)) {
            log('browser-host', 'refused a native host without the right token');
            socket.destroy();
            return;
          }
          clearTimeout(hello);
          const { appPath, appName, startedAt } = pending;
          pending = null;
          // Which profile this is arrives with the extension's own hello,
          // right behind (the native host replays it on every connection).
          conn = { socket, key: null, appPath, appName, startedAt, pending: new Map() };
          continue;
        }
        if (conn) onFrame(conn, message as FromExtension);
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(hello);
      if (conn) dropConn(conn);
    });
  }

  async function listen(): Promise<void> {
    if (!supported || server) return;
    config = await ensureHostConfig(paths);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    // A socket file left by a previous run (or a crash) would make listen fail.
    // A Windows pipe goes away with its last handle.
    if (!isPipe(config.socketPath)) await rm(config.socketPath, { force: true });
    const s = createServer(accept);
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(config!.socketPath, () => resolve());
    });
    if (!isPipe(config.socketPath)) await chmod(config.socketPath, 0o600).catch(() => undefined);
    s.on('error', (e) => log('browser-host', 'socket error', { error: String(e) }));
    server = s;
  }

  /** The connection for a known browser (the default when none is named), launching it when it is not running. */
  async function connectionFor(
    settings: BrowserHostSettings,
    id?: string,
    scope?: Scope
  ): Promise<{ ok: true; conn: Conn } | { ok: false; error: string }> {
    const chosen = id ?? defaultId(scope?.settings ?? settings) ?? (scope?.limited ? undefined : [...conns.keys()][0]);
    if (!chosen && scope?.limited) {
      return {
        ok: false,
        error:
          'This conversation may use only some of the browser profiles on this Mac, and none of those is set up ' +
          'there any more. Tell the user to check which profiles it may use (the persona’s browser pin, or ' +
          'Settings → Features → Browser control for chats).'
      };
    }
    if (!chosen) {
      return {
        ok: false,
        error:
          `No browser with the Stem extension has connected on this ${here} yet. Tell the user to set it up in ` +
          `Settings → Features → Browser control → Set up, on that ${here}.`
      };
    }
    const live = conns.get(chosen);
    if (live) return { ok: true, conn: live };
    const entry = settings.known.find((b) => b.id === chosen);
    const app = appOf(chosen);
    const profiles = settings.known.filter((b) => appOf(b.id) === app).length;
    const name = entry ? nameOf(entry, profileNames(settings.known)) : chosen;
    if (!mayLaunch(app)) {
      // The id came from a native host's word; Stem starts only browsers it knows.
      return {
        ok: false,
        error: `${name} is not running, and Stem only starts browsers it knows on this ${here}. Tell the user to open it.`
      };
    }
    try {
      await launch(app);
    } catch (e) {
      return { ok: false, error: `${name} could not be started on this ${here}: ${e instanceof Error ? e.message : String(e)}` };
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
    if (profiles > 1) {
      return {
        ok: false,
        error:
          `The browser profile “${name}” is not open, and starting ${entry?.name ?? 'the browser'} did not bring it up ` +
          `within ${Math.round(launchWaitMs / 1000)}s. Ask the user to open a window of that profile, or use another profile.`
      };
    }
    return {
      ok: false,
      error:
        `${name} was started, but the Stem extension did not connect within ${Math.round(launchWaitMs / 1000)}s. It may be ` +
        `disabled or removed there; tell the user to check Settings → Features → Browser control on that ${here}.`
    };
  }

  /** One action on one connection. */
  function ask(conn: Conn, request: DeviceBrowserRequest, action: ExtensionAction): Promise<ExtensionResult> {
    return new Promise<ExtensionResult>((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(request.requestId);
        void timedOut(conn).then((error) => resolve({ ok: false, error }));
      }, deps.actionTimeoutMs ?? actionTimeoutMs(action));
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
  }

  /**
   * An action ran out of time. A slow or stuck page is the usual reason, and
   * the model checks the page and carries on. But when the extension does not
   * even answer a peek, its worker is wedged: every action in that profile,
   * a bare `tabs` included, would time out the same way (2026-11-03, a jbrow
   * profile went quiet after twelve idle minutes and the model handed the
   * form back to the user). Stem restarts the extension then, and says
   * whether it came back.
   */
  async function timedOut(conn: Conn): Promise<string> {
    const slow =
      `${conn.appName} did not finish the action in time. It may or may not have happened: check the page ` +
      '(snapshot) before repeating it.';
    const key = conn.key;
    if (!key || conn.replaced || conns.get(key) !== conn) return slow;
    const pending = restarting.get(conn);
    if (pending) return pending;
    if (await answers(conn, aliveProbeMs)) return slow;
    if (conns.get(key) !== conn) return slow;
    const restart = restartStuck(conn, key);
    restarting.set(conn, restart);
    return restart;
  }

  /** Whether the extension answers a peek (whatever it says) within `ms`. */
  function answers(conn: Conn, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const id = `alive-${randomUUID()}`;
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        resolve(false);
      }, ms);
      conn.pending.set(id, () => {
        clearTimeout(timer);
        resolve(true);
      });
      if (!send(conn, { type: 'peek', id })) {
        clearTimeout(timer);
        conn.pending.delete(id);
        resolve(false);
      }
    });
  }

  async function restartStuck(conn: Conn, key: string): Promise<string> {
    log('browser-host', 'the extension stopped answering; restarting it', { browser: conn.appName });
    const back = new Promise<boolean>((resolve) => {
      const wake = (): void => {
        const c = conns.get(key);
        if (!c || c === conn) return;
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, restartWaitMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        connectWaiters.delete(wake);
      };
      connectWaiters.add(wake);
    });
    send(conn, { type: 'reload' });
    if (await back) {
      log('browser-host', 'the restarted extension is back', { browser: conn.appName });
      return (
        `${conn.appName}'s Stem extension had stopped answering (nothing the user did), so Stem restarted it, and it ` +
        'is connected again. The action did not finish: take a new snapshot of the tab (tab ids stay the same) and ' +
        'carry on yourself.'
      );
    }
    log('browser-host', 'the restarted extension did not come back', { browser: conn.appName });
    return (
      `${conn.appName}'s Stem extension stopped answering and did not come back after Stem restarted it. Try once ` +
      'more. If it fails again and another browser profile is open, a page that needs no sign-in can be done ' +
      `there; otherwise ask the user to quit and reopen ${conn.appName}.`
    );
  }

  function peekConn(conn: Conn): Promise<{ url: string; title: string } | null> {
    return new Promise((resolve) => {
      const id = `peek-${randomUUID()}`;
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        resolve(null);
      }, PEEK_TIMEOUT_MS);
      conn.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r.ok && r.page ? r.page : null);
      });
      if (!send(conn, { type: 'peek', id })) {
        clearTimeout(timer);
        conn.pending.delete(id);
        resolve(null);
      }
    });
  }

  /** Arc's sidebar tabs the extension could not list, as lines to add to a `tabs` answer. */
  async function arcExtra(loadedUrls: string[]): Promise<string> {
    const sidebar = await (deps.readArcSidebar ?? readArcSidebar)();
    return 'error' in sidebar ? sidebar.error : arcSidebarText(sidebar.tabs, loadedUrls);
  }

  /**
   * `tabs` with no profile named, on a Mac with several: every open profile's
   * tabs, under its name, so the model can find a page wherever it is. The
   * thread's own profile is listed (and started) even when it is closed.
   */
  async function tabsEverywhere(
    request: DeviceBrowserRequest,
    full: BrowserHostSettings,
    scope: Scope,
    current: string | undefined
  ): Promise<ExtensionResult> {
    const { settings, names } = scope;
    const targets: { entry: KnownBrowser; conn: Conn | null; error?: string }[] = [];
    for (const entry of settings.known) {
      const live = conns.get(entry.id) ?? null;
      if (live) targets.push({ entry, conn: live });
      else if (entry.id === current) {
        const opened = await connectionFor(full, entry.id);
        targets.push(opened.ok ? { entry, conn: opened.conn } : { entry, conn: null, error: opened.error });
      }
    }
    const answers = await Promise.all(
      targets.map(async (t) => (t.conn ? ask(t.conn, request, { kind: 'tabs' }) : ({ ok: false, error: t.error ?? '' } as const)))
    );
    const sections: string[] = [];
    const arcUrls: string[] = [];
    const downloads: ExtensionDownload[] = [];
    let arc = false;
    targets.forEach((t, i) => {
      const r = answers[i]!;
      const marks = [t.entry.id === current ? 'your current profile' : '', t.entry.id === defaultId(full) ? 'default' : '']
        .filter(Boolean)
        .join(', ');
      const name = nameOf(t.entry, names);
      const head = `## Profile “${name}”${name === t.entry.name ? '' : ` (${t.entry.name})`}${marks ? ` — ${marks}` : ''}`;
      sections.push(`${head}\n${r.ok ? (r.text ?? '') : `Its tabs could not be listed: ${r.error}`}`);
      if (r.ok && r.downloads) downloads.push(...r.downloads);
      if (t.conn && /\/Arc\.app$/.test(t.conn.appPath)) {
        arc = true;
        if (r.ok) arcUrls.push(...(r.urls ?? []));
      }
    });
    const closed = settings.known.filter((b) => !targets.some((t) => t.entry.id === b.id));
    const lines = [
      `${scope.limited ? 'This conversation may use' : "This Mac's browser has"} ${settings.known.length} profiles ` +
        `with Stem: ${profileList(settings.known, names)}. A tab id ` +
        'belongs to its profile: to work in a tab of another profile than your current one, pass that `profile` too ' +
        '(it then stays your profile for later calls).',
      ...sections,
      ...(closed.length ? [`Not open right now: ${profileList(closed, names)}.`] : [])
    ];
    if (arc) {
      const extra = await arcExtra(arcUrls);
      if (extra) lines.push(extra);
    }
    if (!answers.some((r) => r.ok)) return { ok: false, error: lines.join('\n\n') };
    return { ok: true, text: lines.join('\n\n'), ...(downloads.length ? { downloads } : {}) };
  }

  /** The device's action, as the extension takes it: an upload's files fetched to this Mac first. */
  async function localAction(request: DeviceBrowserRequest, conn: Conn): Promise<ExtensionAction> {
    const action = request.action;
    if (action.kind !== 'upload') return action;
    for (const f of action.files) {
      if (typeof f.id !== 'string' || !/^[0-9a-f]{32}$/.test(f.id)) throw new Error('an upload named a file the server never queued');
    }
    // A folder name of our own, never one built from what came over the wire.
    const name = randomBytes(8).toString('hex');
    const fetchInto = async (dir: string) => {
      const local: string[] = [];
      for (const f of action.files) local.push(await deps.downloadOutbox(f.id, dir, f.name));
      return local;
    };
    let local: string[];
    if (conn.sandbox) {
      // The sandboxed browser's own folder, which it can read — and write:
      // the folder is held open while the files land (relay.ts sandboxDir),
      // each created fresh (O_EXCL), and the browser told the real path.
      const app = conn.sandbox;
      const list = sandboxUploads.get(request.threadId) ?? [];
      list.push({ app, name });
      sandboxUploads.set(request.threadId, list);
      local = await inSandboxDir(app, deps.home ?? homedir(), ['uploads', name], async (dir) =>
        (await fetchInto(dir.at)).map((p) => join(dir.real, basename(p)))
      );
    } else {
      const dir = join(paths.uploadsDir, name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const dirs = uploadDirs.get(request.threadId) ?? new Set<string>();
      dirs.add(dir);
      uploadDirs.set(request.threadId, dirs);
      local = await fetchInto(dir);
    }
    return { kind: 'upload', ref: action.ref, paths: local, ...(action.tab !== undefined ? { tab: action.tab } : {}) };
  }

  /** Stream finished downloads up; a failure is a line in the text, not a failed action. */
  async function remoteResult(result: ExtensionResult): Promise<DeviceBrowserResult> {
    if (!result.ok) return result;
    // `urls` is for execute (Arc's sidebar), never the server.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { downloads, urls, ...rest } = result;
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
        notes.push(`Download “${d.name}” finished on the ${here} but could not be copied for Stem; ask the user for the file.`);
        continue;
      }
      try {
        const handle = await deps.uploadFile(real);
        receipts.push({ handle, name: d.name, size: d.size, ...(d.mime ? { mime: d.mime } : {}) });
      } catch (e) {
        notes.push(`Download “${d.name}” finished on the ${here} but could not be sent to Stem: ${e instanceof Error ? e.message : String(e)}`);
      }
      // The spool copy has done its job either way.
      void rm(folder, { recursive: true, force: true });
    }
    const text = [rest.text, ...notes].filter(Boolean).join('\n');
    return { ...rest, ...(text ? { text } : {}), ...(receipts.length ? { downloads: receipts } : {}) };
  }

  async function execute(request: DeviceBrowserRequest): Promise<DeviceBrowserResult> {
    if (!supported) return { ok: false, error: 'Browser control is only available on macOS, Windows and Linux.' };
    if (!(await readBrowserHostSettings()).enabled) {
      return {
        ok: false,
        error:
          `This ${here} does not let Stem drive its browser. The switch is in Settings → Features → Browser control, ` +
          'on that computer.'
      };
    }
    const full = await readBrowserHostSettings();
    // The persona's pin or the chat setting may limit the profiles: outside
    // them a profile is not listed, not found by name and never a fallback.
    const allowed = Array.isArray(request.allowed)
      ? request.allowed.filter((a): a is string => typeof a === 'string')
      : undefined;
    const scope = scopeOf(full, allowed);
    const settings = scope.settings;
    if (allowed && allowed.length === 0) {
      return {
        ok: false,
        error:
          'The user allowed this conversation none of the browser profiles on this Mac. Do not retry; tell the ' +
          'user, and that they can tick one in the persona’s browser pin or Settings → Features → Browser control.'
      };
    }
    // Which profile: the one named in this call, else the one this thread
    // named last, else the default.
    let id: string | undefined;
    const wanted = typeof request.profile === 'string' ? request.profile.trim() : '';
    if (wanted) {
      const hit = findProfile(settings.known, wanted, scope.names);
      if (!hit) {
        const what = scope.limited ? 'This conversation may use no browser profile called' : 'This Mac has no browser profile called';
        const list = scope.limited ? 'The ones it may use' : 'Its profiles';
        return {
          ok: false,
          error: settings.known.length
            ? `${what} “${wanted.slice(0, 60)}”. ${list}: ${profileList(settings.known, scope.names)}.`
            : scope.limited
              ? `This conversation may use no browser profile called “${wanted.slice(0, 60)}”.`
              : `No browser has connected the Stem extension on this Mac yet, so there is no profile “${wanted.slice(0, 60)}”.`
        };
      }
      id = hit.id;
      threadProfile.set(request.threadId, id);
    } else {
      const last = threadProfile.get(request.threadId);
      id = last && settings.known.some((b) => b.id === last) ? last : undefined;
    }
    if (request.action.kind === 'tabs' && !wanted && settings.known.length > 1) {
      return remoteResult(await tabsEverywhere(request, full, scope, id ?? defaultId(settings)));
    }
    const target = await connectionFor(full, id ?? defaultId(settings), scope);
    if (!target.ok) return { ok: false, error: target.error };
    const conn = target.conn;
    let action: ExtensionAction;
    try {
      action = await localAction(request, conn);
    } catch (e) {
      return { ok: false, error: `The files could not be brought to the ${here} for the upload: ${e instanceof Error ? e.message : String(e)}` };
    }
    const result = await ask(conn, request, action);
    if (action.kind === 'tabs' && result.ok && /\/Arc\.app$/.test(conn.appPath)) {
      const extra = await arcExtra(result.urls ?? []);
      if (extra) result.text = [result.text, extra].filter(Boolean).join('\n\n');
    }
    return remoteResult(result);
  }

  /** Reload every connected browser now, and owe one to each known browser that is not. */
  async function oweReload(): Promise<void> {
    for (const b of (await readBrowserHostSettings()).known) if (!conns.has(b.id)) reloadOwed.add(b.id);
    for (const c of conns.values()) send(c, { type: 'reload' });
  }

  async function refreshInstall(): Promise<void> {
    try {
      if (relaysHere(paths, deps.home, platform).length) await listenRelay();
      const refreshed = await refreshBrowserControl(deps.installSource(), paths, deps.home, platform);
      if (refreshed?.extensionChanged) {
        await oweReload();
      }
    } catch (e) {
      log('browser-host', 'could not refresh the installed extension', { error: String(e) });
    }
  }

  async function state(): Promise<BrowserHostLocalState> {
    const { browsers, chosen, enabled } = await browsersNow();
    return {
      supported,
      enabled,
      browsers,
      chosen,
      extensionPath: existsSync(paths.extensionDir) ? paths.extensionDir : null,
      setupBrowsers: supported ? setupBrowsers(deps.home, platform) : []
    };
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
      threadProfile.delete(threadId);
      for (const c of conns.values()) send(c, { type: 'end', threadId });
      for (const dir of uploadDirs.get(threadId) ?? []) void rm(dir, { recursive: true, force: true });
      uploadDirs.delete(threadId);
      for (const { app, name } of sandboxUploads.get(threadId) ?? []) {
        void inSandboxDir(app, deps.home ?? homedir(), ['uploads'], (dir) => removeInSandbox(dir.at, name)).catch(
          () => undefined
        );
      }
      sandboxUploads.delete(threadId);
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

    async rename(id, name) {
      const label = name.trim().replace(/\s+/g, ' ').slice(0, MAX_PROFILE_NAME);
      await updateBrowserHostSettings((cur) => {
        if (!cur.known.some((b) => b.id === id)) return cur;
        if (label && cur.known.some((b) => b.id !== id && b.label?.toLowerCase() === label.toLowerCase())) {
          throw new Error(`Another browser profile is already called “${label}”.`);
        }
        return {
          ...cur,
          known: cur.known.map((b) => {
            if (b.id !== id) return b;
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { label: _old, ...rest } = b;
            return label ? { ...rest, label } : rest;
          })
        };
      });
      await sendNames();
      await announce();
      return state();
    },

    async forget(id) {
      const conn = conns.get(id);
      if (conn) {
        // Still open in that profile: remove the extension, or it would come straight back.
        removed.add(id);
        send(conn, { type: 'uninstall' });
        conn.socket.end();
        dropConn(conn);
      }
      await updateBrowserHostSettings((cur) => {
        const known = cur.known.filter((b) => b.id !== id);
        if (cur.chosen !== id) return { ...cur, known };
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { chosen: _gone, ...rest } = cur;
        return { ...rest, known };
      });
      reloadOwed.delete(id);
      await sendNames();
      await announce();
      return state();
    },

    async setUp() {
      if (!supported) return state();
      removed.clear();
      await listen().catch((e) => log('browser-host', 'could not listen for the extension', { error: String(e) }));
      if (hasSandboxedBrowsers(deps.home, platform)) {
        // Before the relays are written: they carry the port.
        await listenRelay().catch((e) => log('browser-host', 'could not listen for sandboxed browsers', { error: String(e) }));
      }
      const result = await installBrowserControl(deps.installSource(), paths, deps.home, platform);
      log('browser-host', 'set up browser control', { registered: result.registered });
      if (result.extensionChanged) {
        await oweReload();
      }
      return state();
    },

    async openExtensionsPage(browserId) {
      const settings = await readBrowserHostSettings();
      const known = browserId ?? defaultId(settings);
      const app = (known ? appOf(known) : null) ?? setupBrowsers(deps.home, platform)[0]?.app ?? null;
      // A Snap or Flatpak browser loads its own copy, the one it can read.
      const sandboxed = app && platform === 'linux' && sandboxOf(app) ? sandboxRoot(app, deps.home) : null;
      const folder = sandboxed ? join(sandboxed, 'extension') : paths.extensionDir;
      // The path goes on the clipboard first, while Stem still has focus: Load
      // unpacked's picker takes it with ⌘⇧G (Ctrl+L in GTK's), which beats
      // hunting for a folder inside Application Support or ~/.config.
      try {
        deps.copyText?.(folder);
      } catch (e) {
        log('browser-host', 'could not copy the extension folder', { error: String(e) });
      }
      // Browsers refuse chrome:// URLs from outside, so the reliable half is
      // the folder: Finder (or the file manager) shows it, ready for Load unpacked. The browser still
      // comes forward, so typing its extensions page is all that is left.
      await openWith(null, folder).catch(() => undefined);
      // The renderer names the app; on Linux that is a program to run, so only a known browser.
      if (app && mayLaunch(app)) {
        await openWith(app, extensionsPageUrl(app)).catch(() => undefined);
      }
    },

    async peekWindow(app, title) {
      // Switched off here: Stem does not drive this browser, nor read what is in it.
      if (!supported || !(await readBrowserHostSettings()).enabled) return { ready: false, page: null };
      const mine = [...conns.values()].filter((c) => c.key && sameBrowser(app, c.appName));
      if (!mine.length) return { ready: false, page: null };
      const pages = await Promise.all(mine.map(peekConn));
      // Two profiles of one app each have a front tab: the window's title names
      // the right one. Either may be the longer: Chrome's window adds " - Google
      // Chrome", Arc's drops the page title's " - Wikipedia".
      const found = pages.filter((p): p is { url: string; title: string } => !!p);
      const page = (found.length === 1 ? found[0] : found.find((p) => sameTitle(p.title, title))) ?? null;
      return { ready: true, page };
    },

    close() {
      for (const c of conns.values()) c.socket.destroy();
      conns.clear();
      server?.close();
      server = null;
      relayServer?.close();
      relayServer = null;
      if (config && !isPipe(config.socketPath)) void rm(config.socketPath, { force: true });
    }
  };
}
