import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { host } from '../../server/host';
import { BROWSER_EXTENSION_ID, BROWSER_NATIVE_HOST } from '../../shared/browser-native';
import type { SetupBrowser } from '../../shared/types';

// Putting the Stem extension within reach of the user's browsers: the files to
// Load unpacked, the native-messaging host the extension talks to, and the
// manifests that tell each browser where that host is.
//
// Everything lives in this profile's state folder:
//
//   <state>/browser-extension/   the unpacked extension (stamped with a content hash)
//   <state>/browser/config.json  socket path, token, spool folder (0600)
//   <state>/browser/stem-browser-host   the wrapper script the manifests point at
//   <state>/browser/spool/       downloads the host copied out of ~/Downloads
//   <state>/browser/uploads/     files fetched from the server for one upload
//
// The manifests are per BROWSER, not per profile — one com.stem.browser per
// browser — so the last profile to run Set up owns them. Startup refreshes them
// only when they already point at this profile's wrapper, so an isolated dev
// instance (STEM_PROFILE) never takes over the real install by being launched.

export interface BrowserInstallPaths {
  stateDir: string;
  extensionDir: string;
  configPath: string;
  wrapperPath: string;
  spoolDir: string;
  uploadsDir: string;
}

export interface BrowserHostConfig {
  socketPath: string;
  token: string;
  spoolDir: string;
}

export function browserInstallPaths(stateRoot = host().stateRoot()): BrowserInstallPaths {
  const stateDir = join(stateRoot, 'browser');
  return {
    stateDir,
    extensionDir: join(stateRoot, 'browser-extension'),
    configPath: join(stateDir, 'config.json'),
    wrapperPath: join(stateDir, 'stem-browser-host'),
    spoolDir: join(stateDir, 'spool'),
    uploadsDir: join(stateDir, 'uploads')
  };
}

/** Unix sockets cap their path near 104 bytes; a long profile path falls back to a short one in tmp. */
export function socketPathFor(stateDir: string): string {
  const preferred = join(stateDir, 'host.sock');
  if (Buffer.byteLength(preferred) < 100) return preferred;
  const tag = createHash('sha256').update(stateDir).digest('hex').slice(0, 16);
  return join(tmpdir(), `stem-browser-${tag}.sock`);
}

/** The config the host and the desktop share, created on first use; the token never changes after. */
export async function ensureHostConfig(paths = browserInstallPaths()): Promise<BrowserHostConfig> {
  try {
    const parsed = JSON.parse(await readFile(paths.configPath, 'utf8')) as Partial<BrowserHostConfig>;
    if (typeof parsed.token === 'string' && parsed.token.length >= 32 && typeof parsed.socketPath === 'string') {
      return { socketPath: parsed.socketPath, token: parsed.token, spoolDir: paths.spoolDir };
    }
  } catch {
    // quiet: absent or unreadable — written fresh below, which only costs a
    // re-run of the native host's handshake.
  }
  const config: BrowserHostConfig = {
    socketPath: socketPathFor(paths.stateDir),
    token: randomBytes(32).toString('hex'),
    spoolDir: paths.spoolDir
  };
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(paths.configPath, 0o600).catch(() => undefined);
  return config;
}

/** Where a browser keeps its native-messaging manifests, by the folder that says it is installed. */
interface BrowserDir {
  name: string;
  /** The app's bundle name in /Applications, what `open -a` takes. */
  app: string;
  /** Its bundle id, to spot the system's default browser. */
  bundleId: string;
  /** Present when the browser has ever run for this user. */
  dataDir: string;
  hostsDir: string;
}

export function browserDirs(home = homedir()): BrowserDir[] {
  const support = join(home, 'Library', 'Application Support');
  const chrome = join(support, 'Google', 'Chrome');
  const dirs: BrowserDir[] = [
    { name: 'Google Chrome', app: 'Google Chrome', bundleId: 'com.google.Chrome', dataDir: chrome, hostsDir: join(chrome, 'NativeMessagingHosts') },
    {
      name: 'Arc',
      app: 'Arc',
      bundleId: 'company.thebrowser.Browser',
      dataDir: join(support, 'Arc', 'User Data'),
      hostsDir: join(support, 'Arc', 'User Data', 'NativeMessagingHosts')
    },
    {
      name: 'Dia',
      app: 'Dia',
      bundleId: 'company.thebrowser.dia',
      dataDir: join(support, 'Dia', 'User Data'),
      hostsDir: join(support, 'Dia', 'User Data', 'NativeMessagingHosts')
    },
    {
      name: 'Brave',
      app: 'Brave Browser',
      bundleId: 'com.brave.Browser',
      dataDir: join(support, 'BraveSoftware', 'Brave-Browser'),
      hostsDir: join(support, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts')
    },
    {
      name: 'Chromium',
      app: 'Chromium',
      bundleId: 'org.chromium.Chromium',
      dataDir: join(support, 'Chromium'),
      hostsDir: join(support, 'Chromium', 'NativeMessagingHosts')
    },
    {
      name: 'Microsoft Edge',
      app: 'Microsoft Edge',
      bundleId: 'com.microsoft.edgemac',
      dataDir: join(support, 'Microsoft Edge'),
      hostsDir: join(support, 'Microsoft Edge', 'NativeMessagingHosts')
    },
    {
      name: 'Google Chrome for Testing',
      app: 'Google Chrome for Testing',
      bundleId: 'com.google.chrome.for.testing',
      dataDir: join(support, 'Google', 'Chrome for Testing'),
      hostsDir: join(support, 'Google', 'Chrome for Testing', 'NativeMessagingHosts')
    }
  ];
  // Arc has been seen reading Chrome's folder rather than its own, so with Arc
  // present Chrome's folder gets the manifest too, installed or not.
  const arcPresent = existsSync(dirs[1]!.dataDir);
  return dirs.filter((d) => existsSync(d.dataDir) || (arcPresent && d.dataDir === chrome));
}

/** The address of a browser's extensions page, by app name or bundle path. */
export function extensionsPageUrl(app: string): string {
  if (/(^|\/)Arc(\.app)?$/.test(app)) return 'arc://extensions';
  if (/(^|\/)Microsoft Edge(\.app)?$/.test(app)) return 'edge://extensions';
  return 'chrome://extensions';
}

/** The bundle id of the user's default web browser, or null when it cannot be read. */
export function defaultBrowserBundleId(home = homedir()): string | null {
  const plist = join(home, 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist');
  if (!existsSync(plist)) return null;
  try {
    const out = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8', timeout: 2000 });
    const handlers = (JSON.parse(out) as { LSHandlers?: { LSHandlerURLScheme?: string; LSHandlerRoleAll?: string }[] })
      .LSHandlers;
    return handlers?.find((h) => h.LSHandlerURLScheme === 'https')?.LSHandlerRoleAll ?? null;
  } catch {
    // quiet: an unreadable plist only costs the default browser its place at the top.
    return null;
  }
}

/**
 * The browsers the user can Load unpacked into, for Set up's steps: used on
 * this Mac (a data folder) and still installed (an app bundle), the default
 * browser first. Not Chrome for Testing, which only the dev harness drives.
 */
export function setupBrowsers(
  home = homedir(),
  appDirs = ['/Applications', join(home, 'Applications')],
  defaultBundleId = defaultBrowserBundleId(home)
): SetupBrowser[] {
  const isDefault = (d: BrowserDir) => d.bundleId.toLowerCase() === defaultBundleId?.toLowerCase();
  return browserDirs(home)
    .filter((d) => d.name !== 'Google Chrome for Testing' && existsSync(d.dataDir))
    .filter((d) => appDirs.some((dir) => existsSync(join(dir, `${d.app}.app`))))
    .sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)))
    .map((d) => ({ name: d.name, app: d.app, extensionsUrl: extensionsPageUrl(d.app) }));
}

/** sh-quote: the paths go into a script, and "Application Support" has a space. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function wrapperScript(nodeCommand: string, hostScript: string, configPath: string): string {
  return [
    '#!/bin/sh',
    '# Stem browser control: the native-messaging host the Stem extension talks to.',
    '# Written by Stem (Settings → Features → Browser control → Set up); rewritten when Stem moves or updates.',
    `ELECTRON_RUN_AS_NODE=1 exec ${shQuote(nodeCommand)} ${shQuote(hostScript)} ${shQuote(configPath)} "$@"`,
    ''
  ].join('\n');
}

export function hostManifest(wrapperPath: string): Record<string, unknown> {
  return {
    name: BROWSER_NATIVE_HOST,
    description: 'Stem browser control',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${BROWSER_EXTENSION_ID}/`]
  };
}

/** A content hash of the extension folder, so a dev edit reloads like a version bump. */
export function extensionStamp(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else hash.update(relative(dir, p)).update('\0').update(readFileSync(p)).update('\0');
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 16);
}

const STAMP_FILE = '.stem-stamp';

export interface InstallSource {
  /** The bundled extension (dist/browser-extension). */
  extensionSource: string;
  /** The bundled native host script (dist/main/browser-native-host.js). */
  hostScript: string;
  /** What runs it as Node: the Stem binary, with ELECTRON_RUN_AS_NODE set by the wrapper. */
  nodeCommand: string;
}

export interface InstallResult {
  extensionDir: string;
  /** Browsers whose manifest folder now has com.stem.browser. */
  registered: string[];
  /** True when the extension files changed (a connected extension should reload). */
  extensionChanged: boolean;
}

/** Copy the extension when its stamp changed. */
async function syncExtension(src: InstallSource, paths: BrowserInstallPaths): Promise<boolean> {
  const want = extensionStamp(src.extensionSource);
  const have = await readFile(join(paths.extensionDir, STAMP_FILE), 'utf8').catch(() => '');
  if (have.trim() === want) return false;
  await rm(paths.extensionDir, { recursive: true, force: true });
  await mkdir(dirname(paths.extensionDir), { recursive: true });
  await cp(src.extensionSource, paths.extensionDir, { recursive: true });
  await writeFile(join(paths.extensionDir, STAMP_FILE), `${want}\n`);
  return true;
}

async function writeWrapper(src: InstallSource, paths: BrowserInstallPaths): Promise<void> {
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await writeFile(paths.wrapperPath, wrapperScript(src.nodeCommand, src.hostScript, paths.configPath), {
    mode: 0o700
  });
  await chmod(paths.wrapperPath, 0o700).catch(() => undefined);
}

/** Set up: everything, for every installed browser. */
export async function installBrowserControl(
  src: InstallSource,
  paths = browserInstallPaths(),
  home = homedir()
): Promise<InstallResult> {
  await ensureHostConfig(paths);
  const extensionChanged = await syncExtension(src, paths);
  await writeWrapper(src, paths);
  const manifest = `${JSON.stringify(hostManifest(paths.wrapperPath), null, 2)}\n`;
  const registered: string[] = [];
  for (const d of browserDirs(home)) {
    await mkdir(d.hostsDir, { recursive: true });
    await writeFile(join(d.hostsDir, `${BROWSER_NATIVE_HOST}.json`), manifest);
    registered.push(d.name);
  }
  return { extensionDir: paths.extensionDir, registered, extensionChanged };
}

/** Whether some browser's manifest points at THIS profile's wrapper — i.e. Set up ran here last. */
export function installedHere(paths = browserInstallPaths(), home = homedir()): boolean {
  for (const d of browserDirs(home)) {
    try {
      const m = JSON.parse(readFileSync(join(d.hostsDir, `${BROWSER_NATIVE_HOST}.json`), 'utf8')) as { path?: unknown };
      if (m.path === paths.wrapperPath) return true;
    } catch {
      // quiet: no manifest in this browser.
    }
  }
  return false;
}

/**
 * At startup: when Set up ran for this profile, bring the copy up to date —
 * the extension after a Stem update, the wrapper after the app moved. Never
 * registers anything new; that is Set up's job.
 */
export async function refreshBrowserControl(
  src: InstallSource,
  paths = browserInstallPaths(),
  home = homedir()
): Promise<{ extensionChanged: boolean } | null> {
  if (!installedHere(paths, home)) return null;
  const extensionChanged = await syncExtension(src, paths);
  await writeWrapper(src, paths);
  return { extensionChanged };
}
