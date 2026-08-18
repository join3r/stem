// The host shim: everything the server needs from the process that is hosting
// it, expressed as an interface instead of importing `app` from Electron.
//
// (Phrased that way on purpose. Ripgrepping this directory for an Electron
// import is the one-line check people actually run for the invariant, and a
// comment that spells the forbidden import out is a false positive in it.)
//
// The server is on its way to being a plain Node process that runs on a machine
// with no windows, no keychain prompt, and no Dock — while the same code keeps
// running inside Electron on the desktop, where those things exist and are
// better. Rather than branching on `process.versions.electron` in a dozen files,
// every Electron capability the server used becomes a method here, with a
// headless default and an Electron override the desktop installs at boot.
//
// This is `tests/electron-stub.ts` promoted to production code: the unit suite
// has been running these same modules under plain Node against a hand-written
// fake for a long time, which is the evidence that the set below is complete and
// that nothing deeper in pi/recall/skills/exec needs Electron at all.
//
// Deliberately NOT here: dialogs, window management, tray, global shortcuts,
// and `shell.showItemInFolder`. Those act on the machine a *person* is sitting
// at, which after the split is the client, not the server. They stay on the
// desktop side as client-owned channels.

import { fork } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_KEY_FILE, MIN_PASSPHRASE_LENGTH, passphraseKeyWrapper, readPassphraseFile } from './passphrase-key';

/**
 * A bidirectional message channel to a forked worker script. Kept identical to
 * the shape `utilityProcess.fork` was already wrapped in, so the recall managers
 * and their in-memory test fakes are unaffected by who does the forking.
 */
export interface WorkerTransport {
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  onExit(cb: (code: number | undefined) => void): void;
  kill(): void;
}

/**
 * Wraps/unwraps the data key that encrypts MCP secrets at rest. Electron backs
 * this with safeStorage (macOS Keychain, libsecret/kwallet on Linux). A host
 * that returns null from {@link StemHost.keyWrapper} gets the documented
 * plaintext-0600 degradation instead — the same path a Linux box with no keyring
 * has always taken, never a lockout.
 */
export interface KeyWrapper {
  wrap(plain: string): Buffer;
  unwrap(wrapped: Buffer): string;
}

/** How to spawn one of Stem's own bundled Node scripts (pi's CLI, the recall MCP server). */
export interface NodeSpawn {
  /** The executable: plain `node` headless, Electron's binary on the desktop. */
  command: string;
  /** Extra env the child needs — `ELECTRON_RUN_AS_NODE` under Electron, nothing headless. */
  env: Record<string, string>;
}

export interface StemHost {
  /**
   * What is hosting the server: the desktop app on somebody's own computer, or
   * a headless `stem-server` (a VPS, a container, a home box).
   *
   * The one thing this is for is telling the assistant the truth about where it
   * is. Its shell, its files and every unpinned MCP server run HERE, which on a
   * server deployment is not the machine the person is typing on — and an
   * assistant that assumes otherwise sends them looking for a `uvx` on the wrong
   * computer. Everything else about the two hosts is a capability difference and
   * belongs in one of the methods below, not in a branch on this.
   */
  kind(): 'desktop' | 'server';
  /** Root of every Stem-owned store. Electron's `app.getPath('userData')`. */
  stateRoot(): string;
  /** Container the alternate-profile dirs live beside. Electron's `app.getPath('appData')`. */
  appDataRoot(): string;
  /** Where the app's own files (RELEASE_NOTES.md, build assets, src/) can be found. */
  appRoot(): string;
  /** The running version, for release notes. */
  appVersion(): string;
  /** Key wrapping for secrets at rest, or null when the platform offers none. */
  keyWrapper(): KeyWrapper | null;
  /** Fork a bundled worker script (recall's embed + scan workers). */
  forkWorker(entry: string, opts: { serviceName: string }): WorkerTransport;
  /** How to launch a bundled Node script. */
  nodeSpawn(): NodeSpawn;
  /**
   * Open a URL in the user's browser. On the desktop this is `shell.openExternal`;
   * headless it is a no-op, because there is no browser on the server and the
   * URL has already been emitted to the clients as an `auth:event` for whoever
   * IS in front of a browser to open.
   */
  openExternal(url: string): void;
  /** Register a cleanup to run when the host is shutting down. */
  onShutdown(fn: () => void): void;
}

// ---- the headless default ----

/**
 * Electron's userData/appData layout, reimplemented so a headless server lands
 * on the same directories an Electron install would. That is not cosmetic: it is
 * what lets `stem-server` be pointed at an existing desktop profile, and what
 * makes the desktop's own injected `app.getPath('userData')` a no-op change
 * rather than a migration.
 */
function defaultAppDataRoot(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

function defaultStateRoot(): string {
  // STEM_STATE_DIR is the deployment knob (a container mounts one volume) and
  // the test seam — the unit suite points it at a per-process throwaway dir.
  //
  // Tripwire: vitest launched WITHOUT desktop/vitest.config.ts (say, from the
  // repo's parent directory) never runs tests/setup-unit.ts, so nothing sets
  // STEM_STATE_DIR and this fallback aims the whole suite at the developer's
  // REAL profile — on macOS's case-insensitive disk, 'Stem' IS the live
  // Electron 'stem' dir. That has happened: store tests overwrote real state
  // and cost this machine its server pairing. Refuse loudly instead.
  if (process.env.VITEST && !process.env.STEM_STATE_DIR) {
    throw new Error(
      'running under vitest without STEM_STATE_DIR — run the suite from desktop/ so vitest.config.ts loads tests/setup-unit.ts'
    );
  }
  return process.env.STEM_STATE_DIR || join(defaultAppDataRoot(), 'Stem');
}

/** Resolved once and kept; `undefined` means "not looked for yet". */
let headlessWrapper: KeyWrapper | null | undefined;

function keyFilePath(): string {
  return process.env.STEM_KEY_FILE?.trim() || DEFAULT_KEY_FILE;
}

/**
 * The key file this host wraps secrets with, or null when there isn't one.
 *
 * A container is handed its passphrase as a Compose secret — a file at
 * /run/secrets/stem_key, mounted from the host, never in the image and never in
 * an environment variable somebody can `docker inspect` back out. Read once at
 * first use and held for the life of the process, exactly as the Keychain-backed
 * wrapper on the desktop is: the alternative is re-deriving scrypt on a path that
 * pi/secrets.ts calls at module init.
 *
 * No key file means the documented plaintext-0600 degradation, unchanged — the
 * same thing a Linux desktop with no keyring has always done. That is a
 * deliberate non-escalation: `stem-server` on somebody's own machine must not
 * start refusing to run because a path that only a container has is missing.
 */
function headlessKeyWrapper(): KeyWrapper | null {
  if (headlessWrapper !== undefined) return headlessWrapper;
  const path = keyFilePath();
  if (!existsSync(path)) return (headlessWrapper = null);
  let passphrase: string;
  try {
    // readPassphraseFile, not readFileSync, and that is the whole of the
    // compatibility: `stem-server import` unwrapped the archive's data key by
    // this same rule (the bytes, minus one trailing newline), so a key file
    // written with `echo` opens on both sides or neither. Reading it any other
    // way here would leave an imported state root whose MCP sign-ins silently
    // refuse to open.
    passphrase = readPassphraseFile(path);
  } catch (err) {
    // Present but unreadable (a directory, a permission we don't have). The
    // fallback is the same plaintext as an absent file, but the two are not the
    // same situation: somebody deliberately put a key here, and them not
    // noticing that it stopped being used is the whole failure. Said on stderr
    // rather than through degrade(), which reaches log → paths → this file.
    console.warn(
      `[stem] the key file at ${path} could not be read (${err instanceof Error ? err.message : String(err)}). ` +
        'Falling back to 0600 plaintext, as if there were no key file at all.'
    );
    return (headlessWrapper = null);
  }
  if (!passphrase) return (headlessWrapper = null);
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    // Not refused: this passphrase already opens an imported state root, and a
    // rule tightened after the fact must never lock somebody out of their own
    // data. Warned about, once, where an operator will see it.
    console.warn(
      `[stem] the passphrase in ${path} is shorter than ${MIN_PASSPHRASE_LENGTH} characters. It is what ` +
        'stands between a copy of this disk and every tool you are signed in to.'
    );
  }
  return (headlessWrapper = passphraseKeyWrapper(passphrase));
}

function readPackageVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    // quiet: not running from a tree with a package.json (bundled, or an odd
    // cwd), which is why STEM_VERSION is read first and 0.0.0 is a documented
    // answer rather than a failure.
  }
  return '0.0.0';
}

export function headlessHost(): StemHost {
  const shutdownHooks: Array<() => void> = [];
  let installedSignals = false;
  const appRoot = process.env.STEM_APP_ROOT || process.cwd();

  return {
    kind: () => 'server',
    stateRoot: defaultStateRoot,
    appDataRoot: defaultAppDataRoot,
    appRoot: () => appRoot,
    appVersion: () => process.env.STEM_VERSION || readPackageVersion(appRoot),
    // No keyring to reach for — but in a container there is a key file, and it
    // is a better answer than either: see headlessKeyWrapper. Without one, the
    // 0600-plaintext fallback the Linux no-keyring path has always used.
    keyWrapper: headlessKeyWrapper,
    forkWorker: (entry, opts) => forkNodeWorker(entry, opts.serviceName),
    nodeSpawn: () => ({ command: process.execPath, env: {} }),
    openExternal: () => {},
    onShutdown: (fn) => {
      shutdownHooks.push(fn);
      if (installedSignals) return;
      installedSignals = true;
      const run = (): void => {
        for (const hook of shutdownHooks.splice(0)) {
          try {
            hook();
          } catch {
            // quiet: a cleanup that throws must not block the ones after it, and
            // by here the process is on its way out — the log chain is async and
            // would never flush. What a hook leaves behind (a stale socket) is
            // found and cleared by the next boot, which does say so.
          }
        }
      };
      process.once('exit', run);
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        // Only when nobody else owns the signal. The standalone `stem-server`
        // entry installs its own handler first, because draining the backend is
        // asynchronous and the exit below would cut it off mid-drain; its exit
        // still fires the 'exit' hook above, so these cleanups run either way.
        if (process.listenerCount(signal) > 0) continue;
        process.once(signal, () => {
          run();
          process.exit(0);
        });
      }
    }
  };
}

/**
 * `child_process.fork` in the shape of a WorkerTransport. The Electron host
 * overrides this with `utilityProcess.fork`, which is the same thing with a
 * service name Activity Monitor can show — but plain fork is what a server has,
 * and the message protocol either side speaks is identical.
 */
function forkNodeWorker(entry: string, _serviceName: string): WorkerTransport {
  // 'advanced' (structured clone), not the default JSON serialization: the
  // embed worker answers with Float32Array vectors, which JSON flattens into
  // plain index-keyed objects — .buffer undefined, and the vector upserts die
  // with "first argument must be ... Received undefined". Electron's
  // utilityProcess clones structurally; the server's fork must match it.
  const child = fork(entry, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
  return {
    send: (msg) => {
      child.send(msg as never);
    },
    onMessage: (cb) => {
      child.on('message', (msg) => cb(msg));
    },
    onExit: (cb) => {
      child.on('exit', (code) => cb(code ?? undefined));
    },
    kill: () => {
      child.kill();
    }
  };
}

// ---- installation ----

let current: StemHost | null = null;

/**
 * Install the host implementation. The desktop calls this before anything else
 * at boot with an Electron-backed host; a headless server does not have to call
 * it at all. Callers pass a partial override so the Electron host only has to
 * name the handful of methods it actually improves on.
 */
export function setHost(overrides: Partial<StemHost>): void {
  current = { ...(current ?? headlessHost()), ...overrides };
}

/** The installed host, defaulting to the headless one. */
export function host(): StemHost {
  return (current ??= headlessHost());
}

/** Drop the installed host, and the key file it had read (tests). */
export function resetHostForTests(): void {
  current = null;
  headlessWrapper = undefined;
}
