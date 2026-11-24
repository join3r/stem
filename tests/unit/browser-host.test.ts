// The desktop half of the `browser` tool (desktop/browser-host): a unix socket
// the extension's native host connects to with the profile's token, the
// switch read fresh on every request, launching the chosen browser when it is
// closed, and the file traffic around uploads and downloads. The native host
// is played here by a socket peer speaking the same frames.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBrowserHost, profileTag, type BrowserHost } from '../../src/desktop/browser-host';
import { parseArcTabs, type ArcSidebarTab } from '../../src/desktop/browser-host/arc-tabs';
import { browserInstallPaths, ensureHostConfig } from '../../src/desktop/browser-host/install';
import { relayKey } from '../../src/desktop/browser-host/relay';
import { writeBrowserHostEnabled } from '../../src/desktop/browser-host/store';
import { encodeFrame, FrameReader, type ServerHello, type ToExtension } from '../../src/shared/browser-native';
import { handshakeProof, newNonce, proofMatches } from '../../src/desktop/browser-host/handshake';
import { isReplaced, serverProved } from '../../src/desktop/browser-host/native-host-main';
import type { DeviceBrowserRequest } from '../../src/shared/types';

interface Peer {
  socket: Socket;
  received: ToExtension[];
  send(message: unknown): void;
  next(type: ToExtension['type']): Promise<ToExtension>;
  closed: Promise<void>;
}

/** The extension's own hello, from before profiles (no profileId). */
const LEGACY_HELLO = { type: 'hello', protocol: 1, extensionId: 'x', extensionVersion: '0.6.0', userAgent: 'UA' };

/**
 * A native host: the handshake (handshake.ts) with the token in `hello`, which
 * never goes on the wire, then — as the real one replays it on every
 * connection — the extension's hello (`ext`; null for a host whose extension
 * has not said it yet). Resolves once the host has sent its proof, or once the
 * desktop hung up on it.
 */
async function connectPeer(
  socketPath: string,
  hello: Record<string, unknown>,
  ext: Record<string, unknown> | null = LEGACY_HELLO
): Promise<Peer> {
  const { token, ...claim } = hello as { token: string };
  const socket = createConnection(socketPath);
  const reader = new FrameReader();
  const received: ToExtension[] = [];
  const waiters: Array<() => void> = [];
  const nonce = newNonce();
  let proved: () => void = () => undefined;
  const handshake = new Promise<void>((resolve) => (proved = resolve));
  socket.on('data', (chunk: Buffer) => {
    for (const body of reader.push(chunk)) {
      const m = JSON.parse(body.toString('utf8')) as ToExtension | ServerHello;
      if (m.type === 'server-hello') {
        expect(proofMatches(token, 'stem', nonce, m.proof) || token === 'nope').toBe(true);
        socket.write(encodeFrame({ type: 'host-proof', proof: handshakeProof(token, 'host', m.nonce) }));
        proved();
        continue;
      }
      received.push(m);
    }
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(encodeFrame({ ...claim, nonce }));
  const proof = await Promise.race([handshake.then(() => true), closed.then(() => false)]);
  if (proof && ext) socket.write(encodeFrame(ext));
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

/** Two seconds of polling, by the clock: Windows rounds a 5 ms timer up to ~16 ms. */
const until = async (cond: () => boolean): Promise<void> => {
  const end = Date.now() + 2000;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};

describe('the native host', () => {
  it('relays only to a peer that proves it holds the token', () => {
    const token = 'a'.repeat(64);
    const nonce = newNonce();
    const hello = (proof: string) => Buffer.from(JSON.stringify({ type: 'server-hello', nonce: newNonce(), proof }));
    expect(serverProved(token, nonce, hello(handshakeProof(token, 'stem', nonce)))).toBe(true);
    // A squatter on the socket: no token, or a proof replayed for another nonce, or the host's own role.
    expect(serverProved(token, nonce, hello(handshakeProof('b'.repeat(64), 'stem', nonce)))).toBe(false);
    expect(serverProved(token, nonce, hello(handshakeProof(token, 'stem', newNonce())))).toBe(false);
    expect(serverProved(token, nonce, hello(handshakeProof(token, 'host', nonce)))).toBe(false);
    expect(serverProved(token, nonce, Buffer.from('{"type":"request"}'))).toBe(false);
  });

  it('knows Stem’s word that a newer host has its profile, and nothing else', () => {
    expect(isReplaced(Buffer.from('{"type":"replaced"}'))).toBe(true);
    expect(isReplaced(Buffer.from('{"type":"host","connected":false}'))).toBe(false);
    expect(isReplaced(Buffer.from('{"type":"request","id":"replaced"}'))).toBe(false);
    expect(isReplaced(Buffer.from('not json'))).toBe(false);
  });
});

describe('createBrowserHost', () => {
  let root: string;
  let host: BrowserHost;
  let invoked: Array<{ channel: string; args: unknown[] }>;
  let sidebar: { tabs: ArcSidebarTab[] } | { error: string };
  let launched: string[];
  let uploads: string[];
  let token: string;
  let socketPath: string;
  let extSource: string;
  const peers: Peer[] = [];

  beforeEach(async () => {
    // A short root: unix socket paths are capped near 104 bytes.
    root = mkdtempSync(join(tmpdir(), 'sbh-'));
    extSource = join(root, 'ext-src');
    mkdirSync(extSource);
    writeFileSync(join(extSource, 'manifest.json'), '{"manifest_version":3}');
    mkdirSync(join(root, 'home', 'Library', 'Application Support', 'Google', 'Chrome'), { recursive: true });
    process.env.STEM_BROWSER_HOST_FILE = join(root, 'browser-host.json');
    const paths = browserInstallPaths(root);
    const config = await ensureHostConfig(paths);
    token = config.token;
    socketPath = config.socketPath;
    invoked = [];
    sidebar = { tabs: [] };
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
      installSource: () => ({ extensionSource: extSource, hostScript: '/dev/null', nodeCommand: '/bin/false' }),
      home: join(root, 'home'),
      launch: async (app) => void launched.push(app),
      readArcSidebar: async () => sidebar,
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

  /** A host from before the handshake: its hello carries the token itself. Answers what came back. */
  const preHandshakeHost = async (sent: string): Promise<string> => {
    const socket = createConnection(socketPath);
    const seen: Buffer[] = [];
    socket.on('data', (c: Buffer) => seen.push(c));
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(encodeFrame({ type: 'host-hello', token: sent, appPath: '/Applications/Arc.app', appName: 'Arc' }));
    await new Promise<void>((resolve) => socket.on('close', () => resolve()));
    return Buffer.concat(seen).toString('utf8');
  };

  it('tells the extension behind a pre-handshake host to reload, and never sends the token itself', async () => {
    const seen = await preHandshakeHost(token);
    expect(seen).toContain('"type":"reload"');
    expect(seen).not.toContain(token);
  });

  it('drops a pre-handshake host with the wrong token without a word', async () => {
    expect(await preHandshakeHost('nope')).toBe('');
  });

  it('relays a request to the connected browser and its answer back, and announces it', async () => {
    await writeBrowserHostEnabled(true);
    const peer = await connectPeer(socketPath, arc());
    peers.push(peer);
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

  it('reads the page in front of a browser window it is connected to, and nothing while switched off', async () => {
    expect(await host.peekWindow('Arc', 'Issues')).toEqual({ ready: false, page: null });
    await writeBrowserHostEnabled(true);
    const peer = await connectPeer(socketPath, arc());
    peers.push(peer);
    await until(() => invoked.some((c) => c.channel === 'browserHost:announce' && JSON.stringify(c.args).includes('0.6.0')));
    const peeking = host.peekWindow('Arc', 'Issues');
    const sent = (await peer.next('peek')) as { id: string };
    peer.send({ type: 'result', id: sent.id, result: { ok: true, page: { url: 'https://linear.app/a', title: 'Issues' } } });
    expect(await peeking).toEqual({ ready: true, page: { url: 'https://linear.app/a', title: 'Issues' } });
    // Another browser's window: not this extension's to answer for.
    expect(await host.peekWindow('Google Chrome', 'Issues')).toEqual({ ready: false, page: null });
    await writeBrowserHostEnabled(false);
    expect(await host.peekWindow('Arc', 'Issues')).toEqual({ ready: false, page: null });
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

  it('fetches an upload’s files to this Mac first, and streams up only the spool’s download copies', async () => {
    await writeBrowserHostEnabled(true);
    const peer = await connectPeer(socketPath, arc());
    peers.push(peer);
    host.onRequest(
      request('r1', { kind: 'upload', ref: 'e4', files: [{ id: 'a'.repeat(32), name: 'cv.pdf', size: 3 }] })
    );
    const sent = (await peer.next('request')) as Extract<ToExtension, { type: 'request' }>;
    expect(sent.action.kind).toBe('upload');
    const paths = (sent.action as { paths: string[] }).paths;
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/uploads[\\/][0-9a-f]{16}[\\/]cv\.pdf$/);

    // The native host's spool copy is sent up; a path anywhere else never is.
    const spooled = join(root, 'browser', 'spool', 'abcd');
    mkdirSync(spooled, { recursive: true });
    writeFileSync(join(spooled, 'report.pdf'), 'REPORT');
    const outside = join(root, 'secret.txt');
    writeFileSync(outside, 'SECRET');
    peer.send({
      type: 'result',
      id: 'r1',
      result: {
        ok: true,
        text: 'Attached cv.pdf',
        downloads: [
          { path: join(spooled, 'report.pdf'), name: 'report.pdf', size: 9 },
          { path: outside, name: 'secret.txt', size: 6 },
          { path: join(spooled, '..', '..', 'secret.txt'), name: 'sneaky.txt', size: 6 }
        ]
      }
    });
    await until(() => !!result('r1'));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatch(/spool[\\/]abcd[\\/]report\.pdf$/);
    const res = result('r1') as { ok: boolean; text: string; downloads: unknown[] };
    expect(res.downloads).toEqual([{ handle: 'stem-upload:1', name: 'report.pdf', size: 9 }]);
    expect(res.text).toContain('“secret.txt” finished on the Mac but could not be copied');
    expect(res.text).toContain('“sneaky.txt”');
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

  describe('an action that runs out of time', () => {
    const quick = () =>
      createBrowserHost({
        invoke: async (channel, args) => {
          invoked.push({ channel, args });
          return undefined;
        },
        uploadFile: async () => 'x',
        downloadOutbox: async () => 'x',
        installSource: () => ({ extensionSource: extSource, hostScript: '/dev/null', nodeCommand: '/bin/false' }),
        home: join(root, 'home'),
        launch: async () => undefined,
        openWith: async () => undefined,
        paths: browserInstallPaths(root),
        platform: 'darwin',
        launchWaitMs: 300,
        actionTimeoutMs: 100,
        aliveProbeMs: 100,
        restartWaitMs: 1_000
      });

    beforeEach(async () => {
      host.close();
      host = quick();
      await host.start();
      await writeBrowserHostEnabled(true);
    });

    it('blames the page, without a restart, while the extension still answers', async () => {
      const peer = await connectPeer(socketPath, arc());
      peers.push(peer);
      host.onRequest(request('r1', { kind: 'snapshot' }));
      await peer.next('request');
      const probe = (await peer.next('peek')) as { id: string };
      peer.send({ type: 'result', id: probe.id, result: { ok: true } });
      await until(() => !!result('r1'));
      expect(result('r1')?.error).toContain('did not finish the action in time');
      expect(peer.received.filter((m) => m.type === 'reload')).toEqual([]);
    });

    it('restarts an extension that stopped answering and says it is back', async () => {
      const peer = await connectPeer(socketPath, arc());
      host.onRequest(request('r1', { kind: 'snapshot' }));
      await peer.next('request');
      await peer.next('peek');
      expect(await peer.next('reload')).toEqual({ type: 'reload' });
      peer.socket.destroy();
      await peer.closed;
      const again = await connectPeer(socketPath, arc());
      peers.push(again);
      await until(() => !!result('r1'));
      expect(result('r1')?.error).toContain('Stem restarted it, and it is connected again');
    });

    it('says so when the restarted extension does not come back', async () => {
      const peer = await connectPeer(socketPath, arc());
      peers.push(peer);
      host.onRequest(request('r1', { kind: 'tabs' }));
      await peer.next('request');
      await peer.next('reload');
      await new Promise((r) => setTimeout(r, 1_200));
      expect(result('r1')?.error).toContain('did not come back');
    });
  });

  it('reloads each browser once when the extension files change, never on every hello', async () => {
    const peer = await connectPeer(socketPath, arc());
    await until(() => invoked.some((c) => JSON.stringify(c.args).includes('"connected":true')));
    writeFileSync(join(extSource, 'background.js'), '// v2');
    await host.setUp();
    expect(await peer.next('reload')).toEqual({ type: 'reload' });

    // The reloaded extension comes back and says hello: no second reload.
    peer.socket.destroy();
    await peer.closed;
    const again = await connectPeer(socketPath, arc());
    peers.push(again);
    await until(() => invoked.filter((c) => JSON.stringify(c.args).includes('"connected":true')).length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(again.received.filter((m) => m.type === 'reload')).toEqual([]);
  });

  it('owes one reload to a known browser that was closed when the files changed', async () => {
    const first = await connectPeer(socketPath, arc());
    await until(() => invoked.some((c) => JSON.stringify(c.args).includes('"connected":true')));
    first.socket.destroy();
    await first.closed;
    await until(() => invoked.some((c) => JSON.stringify(c.args).includes('"connected":false')));
    writeFileSync(join(extSource, 'background.js'), '// v3');
    await host.setUp();

    const back = await connectPeer(socketPath, arc());
    expect(await back.next('reload')).toEqual({ type: 'reload' });
    back.socket.destroy();
    await back.closed;
    const reloaded = await connectPeer(socketPath, arc());
    peers.push(reloaded);
    await until(() => invoked.some((c) => c.channel === 'browserHost:announce' && JSON.stringify(c.args).includes('"version":"0.6.0"')));
    await new Promise((r) => setTimeout(r, 50));
    expect(reloaded.received.filter((m) => m.type === 'reload')).toEqual([]);
  });

  it('adds the Arc sidebar tabs the extension cannot see to the tab list, and only for Arc', async () => {
    await writeBrowserHostEnabled(true);
    const peer = await connectPeer(socketPath, arc());
    peers.push(peer);
    await until(() => invoked.some((c) => JSON.stringify(c.args).includes('"connected":true')));
    sidebar = {
      tabs: [
        { space: 'Work', location: 'pinned', title: 'Grafana', url: 'https://grafana.example/' },
        { space: 'Personal', location: 'unpinned', title: 'Thumb', url: 'https://thumb.example/play/1' },
        { space: 'Personal', location: 'unpinned', title: 'Extensions', url: 'arc://extensions/' }
      ]
    };
    host.onRequest(request('r1', { kind: 'tabs' }));
    await peer.next('request');
    peer.send({
      type: 'result',
      id: 'r1',
      result: { ok: true, text: '1 open tab.\n- 5 · Thumb', urls: ['https://thumb.example/play/1', 'arc://extensions/'] }
    });
    await until(() => !!result('r1'));
    const r = result('r1')!;
    expect(r).not.toHaveProperty('urls');
    expect(r.text).toContain('1 open tab.');
    expect(r.text).toContain('Arc also has 1 sidebar tab');
    expect(r.text).toContain('Space “Work”:\n- Grafana — https://grafana.example/ (pinned)');
    expect(r.text).not.toContain('Personal');

    sidebar = { error: 'macOS did not let Stem read Arc’s sidebar.' };
    host.onRequest(request('r2', { kind: 'tabs' }));
    // peer.next above took r1 out of `received`, so r2 is the only request left there.
    await peer.next('request');
    peer.send({ type: 'result', id: 'r2', result: { ok: true, text: '0 open tabs.', urls: [] } });
    await until(() => !!result('r2'));
    expect(result('r2')!.text).toBe('0 open tabs.\n\nmacOS did not let Stem read Arc’s sidebar.');
  });

  describe('two native hosts claiming one profile', () => {
    const PROFILE = 'cccccccc-3333-4333-8333-333333333333';
    const ext = { ...LEGACY_HELLO, profileId: PROFILE };
    const hostAt = (startedAt?: number) => ({ ...arc(), ...(startedAt ? { startedAt } : {}) });
    const connected = () =>
      (invoked.filter((c) => c.channel === 'browserHost:announce').at(-1)?.args[0] as
        | { browsers: Array<{ connected: boolean }> }
        | undefined)?.browsers.filter((b) => b.connected).length ?? 0;

    // 2026-11-02: jbrow restarted the extension's worker but left its old
    // native host running. The old host replayed its hello every two seconds,
    // each hello threw the live connection off, and an action in flight failed
    // as "jbrow disconnected" though the user had done nothing.
    it('lets the newer host take over, tells the old one to quit, and keeps refusing it', async () => {
      await writeBrowserHostEnabled(true);
      const old = await connectPeer(socketPath, hostAt(1_000), ext);
      peers.push(old);
      await until(() => connected() === 1);
      host.onRequest(request('r1', { kind: 'click', ref: 'e2' }));
      await old.next('request');

      const fresh = await connectPeer(socketPath, hostAt(2_000), ext);
      peers.push(fresh);
      await old.next('replaced');
      await old.closed;
      await until(() => !!result('r1'));
      expect(result('r1')?.error).toContain('nothing the user did');

      // The old host retries, as one from before 0.8.0 would: refused, and the newer one stays.
      const retry = await connectPeer(socketPath, hostAt(1_000), ext);
      peers.push(retry);
      await retry.next('replaced');
      await retry.closed;
      const legacy = await connectPeer(socketPath, hostAt(), ext);
      peers.push(legacy);
      await legacy.next('replaced');
      await legacy.closed;
      expect(fresh.socket.destroyed).toBe(false);
      expect(fresh.received.some((m) => m.type === 'replaced')).toBe(false);

      host.onRequest(request('r2', { kind: 'click', ref: 'e2' }));
      const req = (await fresh.next('request')) as Extract<ToExtension, { type: 'request' }>;
      fresh.send({ type: 'result', id: req.id, result: { ok: true, text: 'clicked' } });
      await until(() => !!result('r2'));
      expect(result('r2')).toMatchObject({ ok: true, text: 'clicked' });
    });
  });

  describe('several profiles of one browser', () => {
    const profileHello = (profileId: string, hint?: string) => ({ ...LEGACY_HELLO, profileId, ...(hint ? { hint } : {}) });
    const WORK = 'aaaaaaaa-1111-4111-8111-111111111111';
    const HOME = 'bbbbbbbb-2222-4222-8222-222222222222';
    const lastAnnounce = () =>
      invoked.filter((c) => c.channel === 'browserHost:announce').at(-1)?.args[0] as
        | { browsers: Array<{ id: string; name: string; profile?: string; connected: boolean; hint?: string }>; chosen?: string }
        | undefined;
    const bothUp = () => lastAnnounce()?.browsers.filter((b) => b.connected).length === 2;

    async function twoProfiles(): Promise<{ work: Peer; home: Peer }> {
      await writeBrowserHostEnabled(true);
      const work = await connectPeer(socketPath, arc(), profileHello(WORK, 'jira.example, mail.google.com'));
      peers.push(work);
      await until(() => lastAnnounce()?.browsers.length === 1);
      const home = await connectPeer(socketPath, arc(), profileHello(HOME));
      peers.push(home);
      await until(bothUp);
      return { work, home };
    }

    it('keeps both connected, numbers them, keeps the sites hint on this Mac, and tells each extension its name', async () => {
      const { work, home } = await twoProfiles();
      await new Promise((r) => setTimeout(r, 50));
      expect(work.socket.destroyed).toBe(false);
      expect(home.socket.destroyed).toBe(false);
      expect(lastAnnounce()!.browsers).toEqual([
        { id: `/Applications/Arc.app#${WORK}`, name: 'Arc', profile: 'Arc 1', connected: true, version: '0.6.0' },
        { id: `/Applications/Arc.app#${HOME}`, name: 'Arc', profile: 'Arc 2', connected: true, version: '0.6.0' }
      ]);
      expect(lastAnnounce()!.chosen).toBe(`/Applications/Arc.app#${WORK}`);
      expect((await host.localState()).browsers[0]).toMatchObject({ hint: 'jira.example, mail.google.com' });
      expect(work.received.filter((m) => m.type === 'profile').at(-1)).toEqual({ type: 'profile', name: 'Arc 1' });
      expect(home.received.filter((m) => m.type === 'profile').at(-1)).toEqual({ type: 'profile', name: 'Arc 2' });

      await host.rename(`/Applications/Arc.app#${HOME}`, '  Personal ');
      await until(() => home.received.some((m) => m.type === 'profile' && m.name === 'Personal'));
      expect(lastAnnounce()!.browsers[1]).toMatchObject({ profile: 'Personal' });
      await expect(host.rename(`/Applications/Arc.app#${WORK}`, 'personal')).rejects.toThrow('already called');
    });

    it('routes to the named profile, which then sticks for the thread, while other threads keep the default', async () => {
      const { work, home } = await twoProfiles();
      await host.rename(`/Applications/Arc.app#${HOME}`, 'Personal');

      host.onRequest({ ...request('r1', { kind: 'snapshot' }), profile: 'personal' });
      expect(await home.next('request')).toMatchObject({ id: 'r1' });
      home.send({ type: 'result', id: 'r1', result: { ok: true, text: 'outline' } });
      await until(() => !!result('r1'));

      host.onRequest(request('r2', { kind: 'snapshot' }));
      expect(await home.next('request')).toMatchObject({ id: 'r2' });
      home.send({ type: 'result', id: 'r2', result: { ok: true, text: 'outline' } });
      await until(() => !!result('r2'));

      host.onRequest(request('r3', { kind: 'snapshot' }, 't2'));
      expect(await work.next('request')).toMatchObject({ id: 'r3' });

      host.onRequest({ ...request('r4', { kind: 'snapshot' }), profile: 'Office' });
      await until(() => !!result('r4'));
      expect(result('r4')?.error).toBe('This Mac has no browser profile called “Office”. Its profiles: “Arc 1” (Arc), “Personal” (Arc).');

      // Its run over, the thread starts again from the default.
      host.onEnd({ threadId: 't1' });
      host.onRequest(request('r5', { kind: 'snapshot' }));
      expect(await work.next('request')).toMatchObject({ id: 'r5' });
    });

    it('lists every open profile’s tabs under its name when no profile is named', async () => {
      const { work, home } = await twoProfiles();
      await host.rename(`/Applications/Arc.app#${WORK}`, 'Work');
      sidebar = { tabs: [{ space: 'S', location: 'pinned', title: 'Unloaded', url: 'https://unloaded.example/' }] };
      host.onRequest(request('r1', { kind: 'tabs' }));
      const [a, b] = await Promise.all([work.next('request'), home.next('request')]);
      work.send({ type: 'result', id: (a as { id: string }).id, result: { ok: true, text: '- 3 · Jira', urls: ['https://jira.example/'] } });
      home.send({ type: 'result', id: (b as { id: string }).id, result: { ok: false, error: 'boom' } });
      await until(() => !!result('r1'));
      const text = result('r1')!.text!;
      expect(text).toContain('2 profiles with Stem: “Work” (Arc), “Arc 2” (Arc)');
      expect(text).toContain('## Profile “Work” (Arc) — your current profile, default\n- 3 · Jira');
      expect(text).toContain('## Profile “Arc 2” (Arc)\nIts tabs could not be listed: boom');
      expect(text).toContain('Arc also has 1 sidebar tab');
    });

    it('keeps a turn limited to its allowed profiles: names, fallback and the tab list', async () => {
      const { work, home } = await twoProfiles();
      await host.rename(`/Applications/Arc.app#${HOME}`, 'Personal');
      const onlyHome = [`/Applications/Arc.app#${HOME}`];

      // Named outside the list: refused, and only the allowed names are offered.
      host.onRequest({ ...request('r1', { kind: 'snapshot' }), profile: 'Arc 1', allowed: onlyHome });
      await until(() => !!result('r1'));
      expect(result('r1')?.error).toBe(
        'This conversation may use no browser profile called “Arc 1”. The ones it may use: “Personal” (Arc).'
      );
      // No name: the Mac's default (Work) is outside the list, so the allowed one is used.
      host.onRequest({ ...request('r2', { kind: 'snapshot' }, 't2'), allowed: onlyHome });
      expect(await home.next('request')).toMatchObject({ id: 'r2' });
      // `tabs` asks only the allowed profile.
      host.onRequest({ ...request('r3', { kind: 'tabs' }, 't3'), allowed: onlyHome });
      expect(await home.next('request')).toMatchObject({ id: 'r3' });
      home.send({ type: 'result', id: 'r3', result: { ok: true, text: '- 9 · Netflix' } });
      await until(() => !!result('r3'));
      expect(work.received.filter((m) => m.type === 'request')).toEqual([]);
      // Nothing allowed is set up any more: refused, never a fallback to another profile.
      host.onRequest({ ...request('r4', { kind: 'snapshot' }, 't4'), allowed: ['/Applications/Arc.app#gone'] });
      await until(() => !!result('r4'));
      expect(result('r4')?.error).toContain('none of those is set up');
      expect(work.received.filter((m) => m.type === 'request')).toEqual([]);
      // Every profile unticked: refused as the user's choice.
      host.onRequest({ ...request('r5', { kind: 'snapshot' }, 't5'), allowed: [] });
      await until(() => !!result('r5'));
      expect(result('r5')?.error).toContain('allowed this conversation none of the browser profiles');
      expect(work.received.filter((m) => m.type === 'request')).toEqual([]);
    });

    it('lets the first profile take over an entry from before profiles, and removes a profile, open or closed', async () => {
      writeFileSync(
        process.env.STEM_BROWSER_HOST_FILE!,
        JSON.stringify({ version: 1, enabled: true, chosen: '/Applications/Arc.app', known: [{ id: '/Applications/Arc.app', name: 'Arc', label: 'Work' }] })
      );
      const { home } = await twoProfiles();
      const state = await host.localState();
      expect(state.browsers.map((b) => [b.id, b.profile])).toEqual([
        [`/Applications/Arc.app#${WORK}`, 'Work'],
        [`/Applications/Arc.app#${HOME}`, 'Arc 2']
      ]);
      expect(state.chosen).toBe(`/Applications/Arc.app#${WORK}`);

      // Still open: the extension is told to remove itself, and the profile goes at once.
      const after = await host.forget(`/Applications/Arc.app#${HOME}`);
      expect(await home.next('uninstall')).toEqual({ type: 'uninstall' });
      await home.closed;
      expect(after.browsers.map((b) => b.id)).toEqual([`/Applications/Arc.app#${WORK}`]);
      // An app's only profile goes by the app's name unless the user named it.
      expect(after.browsers[0]!.profile).toBe('Work');
      await until(() => lastAnnounce()?.browsers.length === 1);

      // An extension too old to remove itself reconnects: refused, not remembered again.
      const again = await connectPeer(socketPath, arc(), profileHello(HOME));
      peers.push(again);
      expect(await again.next('uninstall')).toEqual({ type: 'uninstall' });
      await again.closed;
      expect((await host.localState()).browsers.map((b) => b.id)).toEqual([`/Applications/Arc.app#${WORK}`]);
    });
  });

  it('parses the AppleScript output once per tab, however many windows list the Spaces', () => {
    const rec = (...f: string[]) => f.join('\u001f');
    const out = [rec('Work', 'pinned', 'A', 'https://a/'), rec('Work', 'pinned', 'A', 'https://a/'), rec('Home', 'topApp', 'B', 'https://b/')].join('\u001e') + '\n';
    expect(parseArcTabs(out)).toEqual([
      { space: 'Work', location: 'pinned', title: 'A', url: 'https://a/' },
      { space: 'Home', location: 'topApp', title: 'B', url: 'https://b/' }
    ]);
    expect(parseArcTabs('\n')).toEqual([]);
  });
});

describe('createBrowserHost on Linux', () => {
  let root: string;
  let host: BrowserHost;
  let invoked: Array<{ channel: string; args: unknown[] }>;
  let launched: string[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'sbl-'));
    const extSource = join(root, 'ext-src');
    mkdirSync(extSource);
    writeFileSync(join(extSource, 'manifest.json'), '{"manifest_version":3}');
    mkdirSync(join(root, 'home', '.config', 'google-chrome'), { recursive: true });
    process.env.STEM_BROWSER_HOST_FILE = join(root, 'browser-host.json');
    invoked = [];
    launched = [];
    host = createBrowserHost({
      invoke: async (channel, args) => void invoked.push({ channel, args }),
      uploadFile: async () => 'unused',
      downloadOutbox: async () => 'unused',
      installSource: () => ({ extensionSource: extSource, hostScript: '/dev/null', nodeCommand: '/bin/false' }),
      home: join(root, 'home'),
      launch: async (app) => void launched.push(app),
      openWith: async () => undefined,
      paths: browserInstallPaths(root),
      platform: 'linux',
      launchWaitMs: 300
    });
    await host.start();
  });

  afterEach(() => {
    host.close();
    rmSync(root, { recursive: true, force: true });
    delete process.env.STEM_BROWSER_HOST_FILE;
  });

  it('is supported, says “computer”, and announces as linux', async () => {
    expect((await host.localState()).supported).toBe(true);
    await writeBrowserHostEnabled(true);
    host.onRequest({ requestId: 'r0', threadId: 't1', action: { kind: 'tabs' } });
    await until(() => invoked.some((c) => c.channel === 'browserHost:result'));
    const error = (invoked.find((c) => c.channel === 'browserHost:result')!.args[1] as { error: string }).error;
    expect(error).toContain('on this computer');
    expect(error).not.toContain('Mac');

    const { token, socketPath } = await ensureHostConfig(browserInstallPaths(root));
    const chrome = '/opt/google/chrome/chrome';
    const peer = await connectPeer(socketPath, { type: 'host-hello', token, appPath: chrome, appName: 'Google Chrome' });
    peer.send({ type: 'hello', protocol: 1, extensionId: 'x', extensionVersion: '0.7.0', userAgent: 'UA' });
    await until(() => invoked.some((c) => c.channel === 'browserHost:announce' && JSON.stringify(c.args).includes('0.7.0')));
    expect(invoked.filter((c) => c.channel === 'browserHost:announce').at(-1)!.args[0]).toMatchObject({
      platform: 'linux',
      browsers: [{ id: chrome, name: 'Google Chrome', connected: true }]
    });

    // Closed: the executable is what gets started again.
    peer.socket.destroy();
    await peer.closed;
    host.onRequest({ requestId: 'r1', threadId: 't1', action: { kind: 'tabs' } });
    await until(() => launched.length === 1);
    expect(launched).toEqual([chrome]);
  });

  it('never starts a program a native host merely claimed is its browser', async () => {
    await writeBrowserHostEnabled(true);
    const { token, socketPath } = await ensureHostConfig(browserInstallPaths(root));
    const peer = await connectPeer(socketPath, { type: 'host-hello', token, appPath: '/tmp/evil', appName: 'Evil' });
    // The connect remembers the browser on its own schedule; choose it once it is known.
    let known = false;
    for (let i = 0; i < 200 && !known; i++) {
      known = (await host.localState()).browsers.some((b) => b.id === '/tmp/evil');
      if (!known) await new Promise((r) => setTimeout(r, 5));
    }
    await host.choose('/tmp/evil');
    peer.socket.destroy();
    await peer.closed;
    host.onRequest({ requestId: 'r2', threadId: 't1', action: { kind: 'tabs' } });
    await until(() => invoked.some((c) => c.channel === 'browserHost:result'));
    expect((invoked.find((c) => c.channel === 'browserHost:result')!.args[1] as { error: string }).error).toContain(
      'only starts browsers it knows'
    );
    expect(launched).toEqual([]);
  });
});

/** bash with /dev/tcp and `wait -n` (4.3+), and sha256sum: what the relay needs. macOS's bash 3.2 is not it. */
const relayRuns = (() => {
  if (process.platform === 'win32') return false;
  const r = spawnSync('bash', ['-c', '(( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 3) )) && command -v sha256sum'], { encoding: 'utf8' });
  return r.status === 0;
})();

describe.skipIf(!relayRuns)('createBrowserHost with a Snap browser, through the real relay', () => {
  let root: string;
  let home: string;
  let host: BrowserHost;
  let invoked: Array<{ channel: string; args: unknown[] }>;
  let launched: string[];
  let uploads: string[];
  const relays: ChildProcess[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'sbs-'));
    home = join(root, 'home');
    const extSource = join(root, 'ext-src');
    mkdirSync(extSource);
    writeFileSync(join(extSource, 'manifest.json'), '{"manifest_version":3}');
    const data = join(home, 'snap', 'chromium', 'common', 'chromium');
    mkdirSync(join(data, 'Default'), { recursive: true });
    writeFileSync(join(data, 'Local State'), '{}');
    process.env.STEM_BROWSER_HOST_FILE = join(root, 'browser-host.json');
    invoked = [];
    launched = [];
    uploads = [];
    host = createBrowserHost({
      invoke: async (channel, args) => void invoked.push({ channel, args }),
      uploadFile: async (path) => {
        uploads.push(path);
        return `stem-upload:${uploads.length}`;
      },
      downloadOutbox: async (id, dir, name) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), `bytes of ${id}`);
        return join(dir, name);
      },
      installSource: () => ({ extensionSource: extSource, hostScript: '/dev/null', nodeCommand: '/bin/false' }),
      home,
      launch: async (app) => void launched.push(app),
      openWith: async () => undefined,
      paths: browserInstallPaths(root),
      platform: 'linux',
      launchWaitMs: 300
    });
    await host.start();
    await host.setUp();
    await writeBrowserHostEnabled(true);
  });

  afterEach(() => {
    for (const r of relays.splice(0)) r.kill();
    host.close();
    rmSync(root, { recursive: true, force: true });
    delete process.env.STEM_BROWSER_HOST_FILE;
  });

  /** The browser's side: start the relay as Chromium would, and talk native messaging on its stdio. */
  function startRelay() {
    const child = spawn(join(home, 'snap', 'chromium', 'common', 'stem', 'stem-browser-host'), [], { stdio: ['pipe', 'pipe', 'inherit'] });
    relays.push(child);
    const reader = new FrameReader();
    const received: ToExtension[] = [];
    child.stdout!.on('data', (c: Buffer) => {
      for (const body of reader.push(c)) received.push(JSON.parse(body.toString('utf8')) as ToExtension);
    });
    const next = async (type: ToExtension['type']): Promise<ToExtension> => {
      await until(() => received.some((m) => m.type === type));
      const at = received.findIndex((m) => m.type === type);
      expect(at).toBeGreaterThanOrEqual(0);
      return received.splice(at, 1)[0]!;
    };
    const send = (m: unknown) => void child.stdin!.write(encodeFrame(m));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, next, send, exited };
  }

  const result = (requestId: string) =>
    invoked.find((c) => c.channel === 'browserHost:result' && c.args[0] === requestId)?.args[1] as
      | { ok: boolean; error?: string; text?: string; downloads?: unknown[] }
      | undefined;

  it('connects through the relay, stages uploads where the snap can read them, and copies its downloads itself', async () => {
    const ext = startRelay();
    ext.send({ type: 'hello', protocol: 1, extensionId: 'x', extensionVersion: '0.7.5', userAgent: 'UA', profileId: 'profile-1234' });
    expect(await ext.next('host')).toEqual({ type: 'host', connected: true });
    await until(() => JSON.stringify(invoked).includes('0.7.5'));
    expect(invoked.filter((c) => c.channel === 'browserHost:announce').at(-1)!.args[0]).toMatchObject({
      browsers: [{ id: 'snap:chromium#profile-1234', name: 'Chromium (Snap)', connected: true }]
    });

    host.onRequest({ requestId: 'r1', threadId: 't1', action: { kind: 'upload', ref: 'e1', files: [{ id: 'a'.repeat(32), name: 'cv.pdf', size: 3 }] } });
    const sent = (await ext.next('request')) as Extract<ToExtension, { type: 'request' }>;
    const paths = (sent.action as { paths: string[] }).paths;
    expect(paths[0]!.startsWith(join(home, 'snap', 'chromium', 'common', 'stem', 'uploads') + '/')).toBe(true);

    mkdirSync(join(home, 'Downloads'));
    writeFileSync(join(home, 'Downloads', 'report.pdf'), 'REPORT');
    // What a compromised sandboxed browser could claim: a file outside Downloads, or a link to one inside it.
    writeFileSync(join(home, 'id_ed25519'), 'SECRET');
    symlinkSync(join(home, 'id_ed25519'), join(home, 'Downloads', 'key.txt'));
    // A FIFO would hang a blocking open forever.
    expect(spawnSync('mkfifo', [join(home, 'Downloads', 'pipe')]).status).toBe(0);
    ext.send({
      type: 'result',
      id: 'r1',
      result: {
        ok: true,
        text: 'done',
        downloads: [
          { path: join(home, 'Downloads', 'report.pdf'), name: 'report.pdf', size: 6 },
          { path: join(home, 'id_ed25519'), name: 'id_ed25519', size: 6 },
          { path: join(home, 'Downloads', 'key.txt'), name: 'key.txt', size: 6 },
          { path: join(home, 'Downloads', '..', 'id_ed25519'), name: 'sneaky', size: 6 },
          { path: join(home, 'Downloads', 'pipe'), name: 'pipe', size: 0 }
        ]
      }
    });
    await until(() => !!result('r1'));
    expect(result('r1')).toMatchObject({ ok: true, downloads: [{ handle: 'stem-upload:1', name: 'report.pdf' }] });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatch(/spool[\\/][0-9a-f]{16}[\\/]report\.pdf$/);
    expect(result('r1')!.text).toContain('“id_ed25519” finished on the computer but could not be copied');
    expect(result('r1')!.text).toContain('“pipe”');
    expect(existsSync(paths[0]!)).toBe(true);
    host.onEnd({ threadId: 't1' });
    await until(() => !existsSync(paths[0]!));
    expect(existsSync(paths[0]!)).toBe(false);

    // The browser closes the port: the relay exits and Stem sees the browser gone, then starts it by its snap.
    ext.child.stdin!.end();
    expect(await ext.exited).toBe(0);
    await until(() => invoked.filter((c) => c.channel === 'browserHost:announce').at(-1)!.args[0] !== undefined &&
      JSON.stringify(invoked.filter((c) => c.channel === 'browserHost:announce').at(-1)!.args[0]).includes('"connected":false'));
    host.onRequest({ requestId: 'r2', threadId: 't1', action: { kind: 'tabs' } });
    await until(() => launched.length === 1);
    expect(launched).toEqual(['snap:chromium']);
  });

  it('refuses a peer on the port without the token, or for a browser not set up here', async () => {
    const { relayPort, relaySecret, token } = await ensureHostConfig(browserInstallPaths(root));
    const key = relayKey(relaySecret, 'snap:chromium');
    const talk = async (hello: string, proofToken: string) => {
      const s = createConnection(relayPort, '127.0.0.1');
      let text = '';
      s.on('data', (c) => {
        text += c.toString();
        const line = text.split('\n')[0]!;
        if (text.includes('\n') && !s.destroyed) {
          const [nonce] = line.split(' ');
          s.write(`${handshakeProof(proofToken, 'host', nonce!)}\n`);
          s.write(encodeFrame({ type: 'hello', protocol: 1, extensionId: 'x', extensionVersion: 'evil', userAgent: 'UA' }));
        }
      });
      s.on('error', () => undefined);
      await new Promise<void>((r) => s.once('connect', () => r()));
      s.write(hello);
      await new Promise<void>((r) => s.on('close', () => r()));
      return text;
    };
    const nonce = newNonce();
    // Not set up here: no answer at all.
    expect(await talk(`STEM-RELAY 1 ${nonce} snap:brave\n`, token)).toBe('');
    // The wrong key — the profile's token, or another browser's relay key: the
    // desktop proves itself, then hangs up without taking a frame.
    for (const wrong of [token, relayKey(relaySecret, 'flatpak:com.google.Chrome')]) {
      const answer = await talk(`STEM-RELAY 1 ${nonce} snap:chromium\n`, wrong);
      const [, proof] = answer.trim().split(' ');
      expect(proofMatches(key, 'stem', nonce, proof)).toBe(true);
    }
    expect(JSON.stringify(invoked)).not.toContain('evil');
  });
});

describe('profileTag', () => {
  it('shortens the profile id of a connection key for the log', () => {
    expect(profileTag('/Applications/jbrow.app#0f3c2a91-77aa-4c1e-9d0b-5a1e2f3d4c5b')).toBe('0f3c2a91');
    expect(profileTag('/Applications/Google Chrome.app')).toBe('none');
    expect(profileTag(null)).toBeNull();
  });
});
