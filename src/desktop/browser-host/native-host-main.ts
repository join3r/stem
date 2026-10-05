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
// - The first frame on every socket connection is this host's own
//   `host-hello`: the token from the config Set up wrote (0600, this profile's
//   state folder) and the browser that launched it, read off the parent process.
//   Proof that the peer was installed by this Stem — not proof against malware
//   running as the same user, which can read the same file.
// - A result that carries finished downloads has each file copied out of the
//   user's Downloads into Stem's spool first. This process is the browser's
//   child, so macOS attributes that read to the browser, which already has
//   Downloads; the Stem app reading it directly would raise a privacy prompt.
//
// It never exits on its own while the browser keeps the port open: with Stem
// not running it retries the socket every two seconds, and that open port is
// what keeps the extension's service worker alive to see Stem come back.
//
// No Electron imports: this runs as plain Node.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { basename, join } from 'node:path';
import {
  encodeFrame,
  FrameReader,
  MAX_TO_EXTENSION_BYTES,
  type ExtensionDownload,
  type FromExtension,
  type HostHello
} from '../../shared/browser-native';

interface HostConfig {
  socketPath: string;
  token: string;
  spoolDir: string;
}

const RETRY_MS = 2000;

/** The browser's app bundle and name, from the process that started us. */
export function browserOf(command: string): { appPath: string; appName: string } {
  const at = command.indexOf('.app/');
  const appPath = at >= 0 ? command.slice(0, at + 4) : command;
  const appName = basename(appPath).replace(/\.app$/, '') || 'Browser';
  return { appPath, appName };
}

function parentCommand(): string {
  try {
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
      // Left as it was: the desktop tries the original path and reports the failure.
      out.push(d);
    }
  }
  return out;
}

function main(): void {
  const config = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as HostConfig;
  const browser = browserOf(parentCommand());
  let socket: Socket | null = null;
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
    s.on('connect', () => {
      const first: HostHello = { type: 'host-hello', token: config.token, ...browser };
      s.write(encodeFrame(first));
      if (hello) s.write(hello);
      status(true);
    });
    s.on('data', (chunk: Buffer) => {
      try {
        for (const body of reader.push(chunk)) {
          const head = Buffer.alloc(4);
          head.writeUInt32LE(body.length, 0);
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
