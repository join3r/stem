// The desktop half of the `browser` tool (desktop/browser-host): a unix socket
// the extension's native host connects to with the profile's token, the
// switch read fresh on every request, launching the chosen browser when it is
// closed, and the file traffic around uploads and downloads. The native host
// is played here by a socket peer speaking the same frames.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBrowserHost, type BrowserHost } from '../../src/desktop/browser-host';
import { browserInstallPaths, ensureHostConfig } from '../../src/desktop/browser-host/install';
import { writeBrowserHostEnabled } from '../../src/desktop/browser-host/store';
import { encodeFrame, FrameReader, type ToExtension } from '../../src/shared/browser-native';
import type { DeviceBrowserRequest } from '../../src/shared/types';

interface Peer {
  socket: Socket;
  received: ToExtension[];
  send(message: unknown): void;
  next(type: ToExtension['type']): Promise<ToExtension>;
  closed: Promise<void>;
}

async function connectPeer(socketPath: string, hello: Record<string, unknown>): Promise<Peer> {
  const socket = createConnection(socketPath);
  const reader = new FrameReader();
  const received: ToExtension[] = [];
  const waiters: Array<() => void> = [];
  socket.on('data', (chunk: Buffer) => {
    for (const body of reader.push(chunk)) received.push(JSON.parse(body.toString('utf8')) as ToExtension);
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(encodeFrame(hello));
  const send = (message: unknown): void => void socket.write(encodeFrame(message));
  const next = async (type: ToExtension['type']): Promise<ToExtension> => {
    for (;;) {
      const at = received.findIndex((m) => m.type === type);
      if (at >= 0) return received.splice(at, 1)[0]!;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return { socket, received, send, next, closed };
}

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('createBrowserHost', () => {
  let root: string;
  let host: BrowserHost;
  let invoked: Array<{ channel: string; args: unknown[] }>;
  let launched: string[];
  let uploads: string[];
  let token: string;
  let socketPath: string;
  const peers: Peer[] = [];

  beforeEach(async () => {
    // A short root: unix socket paths are capped near 104 bytes.
    root = mkdtempSync(join(tmpdir(), 'sbh-'));
    process.env.STEM_BROWSER_HOST_FILE = join(root, 'browser-host.json');
    const paths = browserInstallPaths(root);
    const config = await ensureHostConfig(paths);
    token = config.token;
    socketPath = config.socketPath;
    invoked = [];
    launched = [];
    uploads = [];
    host = createBrowserHost({
      invoke: async (channel, args) => {
        invoked.push({ channel, args });
        return undefined;
      },
      uploadFile: async (path) => {
        uploads.push(path);
        return `stem-upload:${uploads.length}`;
      },
      downloadOutbox: async (id, dir, name) => {
        mkdirSync(dir, { recursive: true });
        const path = join(dir, name);
        writeFileSync(path, `bytes of ${id}`);
        return path;
      },
      installSource: () => ({ extensionSource: root, hostScript: '/dev/null', nodeCommand: '/bin/false' }),
      launch: async (app) => void launched.push(app),
      openWith: async () => undefined,
      paths,
      platform: 'darwin',
      launchWaitMs: 300
    });
    await host.start();
  });

  afterEach(() => {
    for (const p of peers.splice(0)) p.socket.destroy();
    host.close();
    rmSync(root, { recursive: true, force: true });
    delete process.env.STEM_BROWSER_HOST_FILE;
  });

  const arc = () => ({ type: 'host-hello', token, appPath: '/Applications/Arc.app', appName: 'Arc' });
  const result = (requestId: string) =>
    invoked.find((c) => c.channel === 'browserHost:result' && c.args[0] === requestId)?.args[1] as
      | { ok: boolean; error?: string; text?: string; downloads?: unknown[] }
      | undefined;
  const request = (requestId: string, action: DeviceBrowserRequest['action'], threadId = 't1'): DeviceBrowserRequest => ({
    requestId,
    threadId,
    action
  });

  it('refuses while the switch is off, without touching the browser', async () => {
    host.onRequest(request('r1', { kind: 'tabs' }));
    await until(() => !!result('r1'));
    expect(result('r1')).toMatchObject({ ok: false, error: expect.stringContaining('does not let Stem drive its browser') });
  });

  it('says how to set up when no browser has ever connected', async () => {
    await writeBrowserHostEnabled(true);
    host.onRequest(request('r1', { kind: 'tabs' }));
    await until(() => !!result('r1'));
    expect(result('r1')?.error).toContain('Set up');
  });

  it('drops a native host without the right token', async () => {
    const peer = await connectPeer(socketPath, { ...arc(), token: 'nope' });
    peers.push(peer);
    await peer.closed;
  });

  it('relays a request to the connected browser and its answer back, and announces it', async () => {
    await writeBrowserHostEnabled(true);
    const peer = await connectPeer(socketPath, arc());
    peers.push(peer);
    peer.send({ type: 'hello', protocol: 1, extensionId: 'x', extensionVersion: '0.6.0', userAgent: 'UA' });
    await until(() => invoked.some((c) => c.channel === 'browserHost:announce' && JSON.stringify(c.args).includes('0.6.0')));
    const announced = invoked.filter((c) => c.channel === 'browserHost:announce').at(-1)!.args[0];
    expect(announced).toMatchObject({
      enabled: true,
      platform: 'darwin',
      browsers: [{ id: '/Applications/Arc.app', name: 'Arc', connected: true, version: '0.6.0' }],
      chosen: '/Applications/Arc.app'
    });

    host.onRequest(request('r1', { kind: 'open', url: 'https://example.com' }));
    const sent = await peer.next('request');
    expect(sent).toMatchObject({ type: 'request', id: 'r1', threadId: 't1', action: { kind: 'open' } });
    peer.send({ type: 'result', id: 'r1', result: { ok: true, text: 'Opened tab 7', tab: 7 } });
    await until(() => !!result('r1'));
    expect(result('r1')).toEqual({ ok: true, text: 'Opened tab 7', tab: 7 });
  });

  it('launches the chosen browser when it is closed and carries on once the extension connects', async () => {
    await writeBrowserHostEnabled(true);
    const first = await connectPeer(socketPath, arc());
    await until(() => invoked.some((c) => c.channel === 'browserHost:announce' && JSON.stringify(c.args).includes('"connected":true')));
    first.socket.destroy();
    await first.closed;
    await until(() => invoked.some((c) => c.channel === 'browserHost:announce' && JSON.stringify(c.args).includes('"connected":false')));

    host.onRequest(request('r1', { kind: 'tabs' }));
    await until(() => launched.length === 1);
    expect(launched).toEqual(['/Applications/Arc.app']);
    const again = await connectPeer(socketPath, arc());
    peers.push(again);
    const sent = await again.next('request');
    again.send({ type: 'result', id: (sent as { id: string }).id, result: { ok: true, text: 'tabs' } });
    await until(() => !!result('r1'));
    expect(result('r1')).toMatchObject({ ok: true });
  });

  it('gives up on a launched browser whose extension never connects', async () => {
    await writeBrowserHostEnabled(true);
    const first = await connectPeer(socketPath, arc());
    await until(() => invoked.some((c) => JSON.stringify(c.args).includes('"connected":true')));
    first.socket.destroy();
    await first.closed;
    host.onRequest(request('r1', { kind: 'tabs' }));
    await until(() => !!result('r1'));
    expect(result('r1')?.error).toContain('did not connect');
  });

  it('fetches an upload’s files to this Mac first, and streams finished downloads up', async () => {
    await writeBrowserHostEnabled(true);
    const peer = await connectPeer(socketPath, arc());
    peers.push(peer);
    host.onRequest(
      request('r1', { kind: 'upload', ref: 'e4', files: [{ id: 'abc', name: 'cv.pdf', size: 3 }] })
    );
    const sent = (await peer.next('request')) as Extract<ToExtension, { type: 'request' }>;
    expect(sent.action.kind).toBe('upload');
    const paths = (sent.action as { paths: string[] }).paths;
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/uploads\/r1\/cv\.pdf$/);

    peer.send({
      type: 'result',
      id: 'r1',
      result: { ok: true, text: 'Attached cv.pdf', downloads: [{ path: '/tmp/x/report.pdf', name: 'report.pdf', size: 9 }] }
    });
    await until(() => !!result('r1'));
    expect(uploads).toEqual(['/tmp/x/report.pdf']);
    expect(result('r1')).toEqual({
      ok: true,
      text: 'Attached cv.pdf',
      downloads: [{ handle: 'stem-upload:1', name: 'report.pdf', size: 9 }]
    });
  });

  it('forwards Stop to the server and the end of a run to the extension', async () => {
    await writeBrowserHostEnabled(true);
    const peer = await connectPeer(socketPath, arc());
    peers.push(peer);
    await until(() => invoked.some((c) => JSON.stringify(c.args).includes('"connected":true')));
    peer.send({ type: 'stopped', threadId: 't9' });
    await until(() => invoked.some((c) => c.channel === 'browserHost:event'));
    expect(invoked.find((c) => c.channel === 'browserHost:event')!.args).toEqual([{ threadId: 't9', kind: 'stopped' }]);
    host.onEnd({ threadId: 't9' });
    expect(await peer.next('end')).toEqual({ type: 'end', threadId: 't9' });
  });

  it('fails an in-flight action when the browser disconnects mid-way', async () => {
    await writeBrowserHostEnabled(true);
    const peer = await connectPeer(socketPath, arc());
    host.onRequest(request('r1', { kind: 'click', ref: 'e2' }));
    await peer.next('request');
    peer.socket.destroy();
    await until(() => !!result('r1'));
    expect(result('r1')?.error).toContain('may or may not have happened');
  });
});
