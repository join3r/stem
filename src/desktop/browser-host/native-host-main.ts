// The Stem browser extension's native-messaging host: the program a browser
// starts when the extension calls connectNative('com.stem.browser'). Bundled to
// dist/main/browser-native-host.js and run by the Stem app binary as Node
// (ELECTRON_RUN_AS_NODE, from the wrapper script Set up writes — a native
// messaging manifest cannot pass arguments or environment itself).
//
// It is a relay and little else: frames from the extension (stdin) go to the
// Stem app's unix socket, frames from the socket go to the extension (stdout).
// Both legs use Chrome's framing, so a frame passes through unparsed — except:
//
// - Every socket connection opens with a handshake (handshake.ts): this host's
//   `host-hello` names the browser that launched it, read off the parent
//   process, and each side proves it holds the token from the config Set up
//   wrote (0600, this profile's state folder) without sending it. Nothing is
//   relayed until the desktop has proved itself. Proof that both were installed
//   by this Stem — not proof against malware running as the same user, which
//   can read the same file.
// - A result that carries finished downloads has each file copied out of the
//   user's Downloads into Stem's spool first. This process is the browser's
//   child, so macOS attributes that read to the browser, which already has
//   Downloads; the Stem app reading it directly would raise a privacy prompt.
//   (Linux has no such prompt; the copy is kept so both take one path.)
//
// It never exits on its own while the browser keeps the port open: with Stem
// not running it retries the socket every two seconds, and that open port is
// what keeps the extension's service worker alive to see Stem come back. The
// one exception is Stem saying `replaced`: a newer host of the same profile
// holds the link (the browser left this one running when the extension's
// worker restarted), so this one stops retrying and exits.
//
// No Electron imports: this runs as plain Node.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { basename, join, win32 } from 'node:path';
import { handshakeProof, isNonce, newNonce, proofMatches } from './handshake';
import {
  encodeFrame,
  FrameReader,
  MAX_TO_EXTENSION_BYTES,
  type ExtensionDownload,
  type FromExtension,
  type HostHello,
  appImageName,
  linuxBrowserName,
  windowsBrowserName
} from '../../shared/browser-native';

interface HostConfig {
  socketPath: string;
  token: string;
  spoolDir: string;
}

const RETRY_MS = 2000;

/**
 * The browser and its name, from the process that started us: a Mac reports
 * the binary inside the bundle and the bundle is the browser; on Linux the
 * executable is the browser (and what launching it again runs).
 */
export function browserOf(command: string): { appPath: string; appName: string } {
  const at = command.indexOf('.app/');
  if (at >= 0 || command.endsWith('.app')) {
    const appPath = at >= 0 ? command.slice(0, at + 4) : command;
    return { appPath, appName: basename(appPath).replace(/\.app$/, '') || 'Browser' };
  }
  if (/^[a-z]:\\/i.test(command)) {
    return { appPath: command, appName: windowsBrowserName(command) ?? (win32.basename(command).replace(/\.exe$/i, '') || 'Browser') };
  }
  const appName = linuxBrowserName(command) ?? (/\.appimage$/i.test(command) ? appImageName(command) : basename(command) || 'Browser');
  return { appPath: command, appName };
}

/**
 * Linux: the AppImage a browser runs from, by the environment it passed us
 * (the AppImage runtime sets APPIMAGE and APPDIR; the browser's own
 * /proc/<pid>/environ is no help, Chromium writes its process title over it).
 * The executable sits in a mount that changes on every launch, so the
 * AppImage file is what stays the same and what starts the browser again.
 * The executable must be inside APPDIR: a browser started from another
 * AppImage (Stem's own) inherits its variables.
 */
export function appImageOf(exe: string, env: NodeJS.ProcessEnv): string | null {
  const image = env.APPIMAGE;
  const dir = env.APPDIR?.replace(/\/+$/, '');
  if (!image?.startsWith('/') || !dir?.startsWith('/') || !exe.startsWith(`${dir}/`)) return null;
  return image;
}

/**
 * Windows: the browser starts a batch-file host through cmd.exe, so the
 * browser is the first ancestor that is not cmd.exe. One PowerShell call walks
 * the chain (Node has no API for another process's executable).
 */
const WINDOWS_PARENT = [
  '$p = Get-CimInstance Win32_Process -Filter "ProcessId=$args";',
  'while ($p -and $p.Name -ieq "cmd.exe") { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" }',
  'if ($p) { $p.ExecutablePath }'
].join(' ');

function parentCommand(): string {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `& { ${WINDOWS_PARENT} } ${process.ppid}`],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true }
      ).trim();
      return out || 'Browser';
    }
    if (process.platform === 'linux') {
      // `ps -o comm=` is cut to 15 characters there; the exe link is the whole
      // path. A browser updated in place while running reads "… (deleted)".
      const exe = readlinkSync(`/proc/${process.ppid}/exe`).replace(/ \(deleted\)$/, '');
      return appImageOf(exe, process.env) ?? exe;
    }
    return execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim();
  } catch {
    return 'Browser';
  }
}

function log(message: string): void {
  // stderr goes to the browser's log, never to the extension.
  process.stderr.write(`stem-browser-host: ${message}\n`);
}

/** Copy finished downloads into the spool and point the result at the copies. */
async function spoolDownloads(downloads: ExtensionDownload[], spoolDir: string): Promise<ExtensionDownload[]> {
  const out: ExtensionDownload[] = [];
  for (const d of downloads) {
    try {
      const dir = join(spoolDir, randomBytes(8).toString('hex'));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const to = join(dir, basename(d.name || d.path) || 'download');
      await copyFile(d.path, to);
      out.push({ ...d, path: to });
    } catch (e) {
      log(`could not spool a download: ${e instanceof Error ? e.message : String(e)}`);
      // Left as it was: the desktop sends up only spool copies, so it reports
      // this one as not copied rather than reading ~/Downloads itself.
      out.push(d);
    }
  }
  return out;
}

/** Is this frame the desktop's `replaced`: another host of this profile has the link? */
export function isReplaced(body: Buffer): boolean {
  if (body.length > 64) return false;
  try {
    return (JSON.parse(body.toString('utf8')) as { type?: unknown })?.type === 'replaced';
  } catch {
    return false;
  }
}

/** Is this frame the desktop's server-hello, with a proof under the token for our nonce? */
export function serverProved(token: string, nonce: string, body: Buffer): boolean {
  let m: { type?: unknown; nonce?: unknown; proof?: unknown };
  try {
    m = JSON.parse(body.toString('utf8')) as typeof m;
  } catch {
    return false;
  }
  return m?.type === 'server-hello' && isNonce(m.nonce) && proofMatches(token, 'stem', nonce, m.proof);
}

function main(): void {
  const config = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as HostConfig;
  const browser = browserOf(parentCommand());
  const startedAt = Date.now();
  let socket: Socket | null = null;
  /** Stem handed this profile to a newer host: no more retries. */
  let replaced = false;
  let connected = false;
  /** The extension's latest hello, replayed to every new socket connection. */
  let hello: Buffer | null = null;
  /** Serialises outgoing frames from the extension so a spooled result cannot overtake an earlier frame. */
  let toDesktop: Promise<void> = Promise.resolve();

  const toExtension = (frame: Buffer): void => {
    if (frame.length - 4 > MAX_TO_EXTENSION_BYTES) {
      log(`dropped a ${frame.length}-byte frame: over Chrome's 1 MB cap`);
      return;
    }
    process.stdout.write(frame);
  };
  const status = (up: boolean): void => {
    if (connected === up) return;
    connected = up;
    toExtension(encodeFrame({ type: 'host', connected: up }));
  };

  function connect(): void {
    const s = createConnection(config.socketPath);
    socket = s;
    const reader = new FrameReader(MAX_TO_EXTENSION_BYTES);
    const nonce = newNonce();
    /** Set once the desktop proved it holds the token; until then nothing is relayed either way. */
    let verified = false;
    s.on('connect', () => {
      const first: HostHello = { type: 'host-hello', nonce, ...browser, startedAt };
      s.write(encodeFrame(first));
    });
    s.on('data', (chunk: Buffer) => {
      try {
        for (const body of reader.push(chunk)) {
          if (!verified) {
            if (!serverProved(config.token, nonce, body)) {
              log('a peer on the socket could not prove it is Stem; not relaying to it');
              s.destroy();
              return;
            }
            const answer = JSON.parse(body.toString('utf8')) as { nonce: string };
            s.write(encodeFrame({ type: 'host-proof', proof: handshakeProof(config.token, 'host', answer.nonce) }));
            verified = true;
            if (hello) s.write(hello);
            status(true);
            continue;
          }
          const head = Buffer.alloc(4);
          head.writeUInt32LE(body.length, 0);
          if (isReplaced(body)) {
            log('a newer host of this profile has the link to Stem; exiting');
            replaced = true;
            s.destroy();
            // Passed on so a still-running extension skips its quick reconnects.
            process.stdout.write(Buffer.concat([head, body]), () => process.exit(0));
            return;
          }
          toExtension(Buffer.concat([head, body]));
        }
      } catch (e) {
        log(`bad frame from Stem: ${e instanceof Error ? e.message : String(e)}`);
        s.destroy();
      }
    });
    s.on('error', () => undefined);
    s.on('close', () => {
      if (socket === s) socket = null;
      if (replaced) return;
      status(false);
      setTimeout(connect, RETRY_MS).unref?.();
    });
  }

  const fromExtension = new FrameReader();
  process.stdin.on('data', (chunk: Buffer) => {
    let bodies: Buffer[];
    try {
      bodies = fromExtension.push(chunk);
    } catch (e) {
      log(`bad frame from the extension: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    for (const body of bodies) {
      toDesktop = toDesktop.then(async () => {
        let frame: Buffer = Buffer.concat([Buffer.alloc(4), body]);
        frame.writeUInt32LE(body.length, 0);
        let message: FromExtension | null = null;
        try {
          message = JSON.parse(body.toString('utf8')) as FromExtension;
        } catch {
          // Not JSON: relayed as is, and the desktop drops it.
        }
        if (message?.type === 'hello') hello = frame;
        if (message?.type === 'result' && message.result.ok && message.result.downloads?.length) {
          const downloads = await spoolDownloads(message.result.downloads, config.spoolDir);
          frame = encodeFrame({ ...message, result: { ...message.result, downloads } });
        }
        if (socket && connected) socket.write(frame);
      });
    }
  });
  // The browser closed the port (extension reloaded, browser quit): our job is over.
  process.stdin.on('end', () => process.exit(0));

  connect();
}

if (process.argv[2]) main();
