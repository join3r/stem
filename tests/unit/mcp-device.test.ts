// An MCP server that runs on a device rather than on the machine hosting
// stem-server, from the server's side (docs/mcp-device-pinning.md, step 2).
//
// Step 2 is the skeleton: there is no client host yet, so the thing at the far
// end here is a stub that answers whatever a test tells it to — which is exactly
// the seam step 3 fills. Everything on this side of it is real: the router, the
// fingerprint, the three channels, and in the last describe a live transport with
// the actual desktop proxy reading an addressed control frame off its SSE stream.
//
// Three properties carry the security of the whole feature, and each has a test
// here by name: a correlation id is unguessable and single-use, a spec's
// fingerprint covers its credentials and not just its shape, and a device that is
// not connected is refused immediately, in a sentence naming both the server and
// the machine.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createDeviceMcpRouter, deviceMcpRouter, type DeviceMcpRouter } from '../../src/server/mcp-device/router';
import { emptyCatalog, type DeviceMcpCatalogStore } from '../../src/server/mcp-device/catalog';
import { canonicalMcpSpec, mcpSpecFingerprint } from '../../src/shared/mcp-fingerprint';
import { addMcpServer, removeMcpServer, setMcpServerEnabled } from '../../src/server/pi/mcp';
import { readMcpConfig, writeMcpConfig, type PiMcpServer } from '../../src/server/pi/mcp-config';
import { secretKeyHex } from '../../src/server/pi/secrets';
import { forgetCachedDevices, readDevices } from '../../src/server/transport/auth';
import { registerMcpIpc } from '../../src/server/ipc/mcp';
import { registerDevicesIpc } from '../../src/server/ipc/devices';
import { closeExecDeviceRouter, execDeviceRouter } from '../../src/server/exec-device/router';
import type { IpcDeps } from '../../src/server/ipc/deps';
import { closeTransport, startTransport } from '../../src/server/startup/transport';
import { createServerProxy, type ServerProxy } from '../../src/desktop/proxy';
import { clientCredentials } from '../../src/desktop/server-endpoint';
import { readClientIdentity } from '../../src/desktop/client-store';
import {
  devicesStorePath,
  execDeviceHostsPath,
  piMcpConfigPath,
  piMcpDeviceCatalogPath
} from '../../src/server/workspace/paths';
import type {
  DeviceMcpCatalog,
  DeviceMcpRequest,
  DeviceMcpResult,
  DeviceMcpSpec
} from '../../src/shared/types';

describe('the spec fingerprint', () => {
  const spec: DeviceMcpSpec = {
    command: '/usr/bin/mcp-files',
    args: ['--root', '/Users/ada'],
    env: { API_KEY: 'read-only', REGION: 'eu' }
  };

  it('does not move when nothing about what would run has moved', () => {
    // The order somebody typed their environment variables in is not a fact
    // about the program. If it were, an approval would be revoked by a config
    // rewrite that changed nothing — every launch, forever.
    expect(mcpSpecFingerprint({ ...spec, env: { REGION: 'eu', API_KEY: 'read-only' } })).toBe(
      mcpSpecFingerprint(spec)
    );
    // Absent and empty are the same thing to the process that gets spawned.
    expect(mcpSpecFingerprint({ command: '/bin/x' })).toBe(
      mcpSpecFingerprint({ command: '/bin/x', args: [], env: {}, headers: {} })
    );
  });

  it('moves when an env VALUE changes, not merely when a variable appears', () => {
    // The one this exists for. Swapping a read-only token for an admin one is a
    // different program with different powers, on somebody's own computer, and a
    // fingerprint over variable NAMES would wave it through on an approval that
    // was given for something else (④).
    expect(mcpSpecFingerprint({ ...spec, env: { ...spec.env, API_KEY: 'admin' } })).not.toBe(
      mcpSpecFingerprint(spec)
    );
    expect(canonicalMcpSpec(spec)).toContain('read-only');
  });

  it('moves for a changed header value, an added argument, and a reordered one', () => {
    const http: DeviceMcpSpec = { url: 'http://nas.local/mcp', headers: { Authorization: 'Bearer one' } };
    expect(mcpSpecFingerprint({ ...http, headers: { Authorization: 'Bearer two' } })).not.toBe(
      mcpSpecFingerprint(http)
    );
    expect(mcpSpecFingerprint({ ...spec, args: [...spec.args!, '--write'] })).not.toBe(
      mcpSpecFingerprint(spec)
    );
    // Arguments are a list, not a set: `--root /tmp` and `/tmp --root` are not
    // the same command line, so their order is part of the identity.
    expect(mcpSpecFingerprint({ ...spec, args: ['/Users/ada', '--root'] })).not.toBe(
      mcpSpecFingerprint(spec)
    );
  });

  it('is a hash rather than the spec itself, so the client can store it', () => {
    // The client writes this into an approval file on its own disk, and the
    // canonical form it covers has the API keys in it.
    const print = mcpSpecFingerprint(spec);
    expect(print).toMatch(/^[0-9a-f]{64}$/);
    expect(print).not.toContain('read-only');
  });
});

describe('the router', () => {
  /** Frames the transport was asked to write, newest last. */
  let sent: { deviceId: string; name: string; data: DeviceMcpRequest }[] = [];
  /** Which devices the fake transport says have a stream open. */
  let connected: Set<string>;
  /** What mcp.json holds, for the assignment tests. */
  let servers: Record<string, PiMcpServer>;
  let stored: DeviceMcpCatalog;
  let router: DeviceMcpRouter;

  /** The catalog, in memory — the file store has its own coverage below. */
  const memoryCatalog: DeviceMcpCatalogStore = {
    read: () => Promise.resolve(stored),
    write: (next) => {
      stored = next;
      return Promise.resolve();
    }
  };

  /** The stub host: answer whatever the last request was, however it likes. */
  function answerLast(result: unknown): boolean {
    const last = sent[sent.length - 1];
    return router.settle(last.deviceId, last.data.requestId, result);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    connected = new Set(['mac']);
    servers = {};
    stored = emptyCatalog();
    router = createDeviceMcpRouter({
      pushTo: (deviceId, name, data) => {
        if (!connected.has(deviceId)) return 0;
        sent.push({ deviceId, name, data: data as DeviceMcpRequest });
        return 1;
      },
      connectedDevices: () => connected,
      deviceLabel: (deviceId) => Promise.resolve(deviceId === 'mac' ? '“Ada’s MacBook”' : `the device ${deviceId}`),
      readServers: () => Promise.resolve(servers),
      catalog: memoryCatalog
    });
  });

  afterEach(() => {
    router.close();
    vi.useRealTimers();
  });

  it('carries a call to the device and hands back what the host answered', async () => {
    const call = router.callTool('mac', 'files', 'read_file', { path: '/Users/ada/notes.md' });
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toHaveLength(1);
    expect(sent[0].deviceId).toBe('mac');
    expect(sent[0].name).toBe('mcp-request');
    expect(sent[0].data).toMatchObject({
      server: 'files',
      op: 'call',
      tool: 'read_file',
      args: { path: '/Users/ada/notes.md' }
    });

    expect(answerLast({ ok: true, content: 'the notes' })).toBe(true);
    await expect(call).resolves.toEqual({ ok: true, content: 'the notes' });
  });

  it('refuses immediately when the machine is not connected, naming both', async () => {
    connected.clear();
    const result = (await router.callTool('mac', 'home-assistant', 'turn_off', {})) as {
      ok: false;
      error: string;
    };
    // Decision ⑤: the assistant repeats this sentence to the user, who needs to
    // know which computer to go and wake — and the server name is what tells
    // them which of their machines that even is.
    expect(result.ok).toBe(false);
    expect(result.error).toContain('home-assistant');
    expect(result.error).toContain('Ada’s MacBook');
    // Nothing was minted, nothing was sent, and nothing is waiting on a timeout.
    expect(sent).toHaveLength(0);
    expect(router.isAvailable('mac')).toBe(false);
  });

  it('refuses when the stream closes between the availability check and the write', async () => {
    // The two are separate instants and a laptop lid can close between them. The
    // count from the write is the answer that actually tried.
    const flaky = createDeviceMcpRouter({
      pushTo: () => 0,
      connectedDevices: () => new Set(['mac']),
      deviceLabel: () => Promise.resolve('“Ada’s MacBook”'),
      readServers: () => Promise.resolve({}),
      catalog: memoryCatalog
    });
    await expect(flaky.listTools('mac', 'files')).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('not connected to Stem right now')
    });
    flaky.close();
  });

  it('gives a tool call two minutes and a tool listing thirty seconds', async () => {
    let listed = false;
    const listing = router.listTools('mac', 'files').then((r) => {
      listed = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(listed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(listing).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('did not list its tools within 30s')
    });

    let called = false;
    const call = router.callTool('mac', 'files', 'read_file', {}).then((r) => {
      called = true;
      return r;
    });
    // Past the listing's timeout by a long way: a tool call is a program doing
    // real work on somebody's computer, and thirty seconds is not enough of it.
    await vi.advanceTimersByTimeAsync(119_000);
    expect(called).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(call).resolves.toEqual({ ok: false, error: expect.stringContaining('did not finish within 120s') });
  });

  it('mints an unguessable id and spends it once', async () => {
    const first = router.callTool('mac', 'files', 'read_file', {});
    await vi.advanceTimersByTimeAsync(0);
    const second = router.callTool('mac', 'files', 'read_file', {});
    await vi.advanceTimersByTimeAsync(0);

    // 128 bits from the CSPRNG. This is the whole defence against a renderer
    // that can reach mcpHost:result with a perfectly valid device identity —
    // its own — so it is asserted rather than assumed.
    for (const frame of sent) expect(frame.data.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(sent[0].data.requestId).not.toBe(sent[1].data.requestId);

    expect(router.settle('mac', sent[0].data.requestId, { ok: true, content: 'one' })).toBe(true);
    // Spent. A second answer for the same id settles nothing — which is what
    // stops a replayed result from landing on whatever call is open by then.
    expect(router.settle('mac', sent[0].data.requestId, { ok: true, content: 'again' })).toBe(false);
    expect(router.settle('mac', 'not-an-id-anyone-issued', { ok: true, content: 'forged' })).toBe(false);

    await expect(first).resolves.toEqual({ ok: true, content: 'one' });
    expect(router.settle('mac', sent[1].data.requestId, { ok: true, content: 'two' })).toBe(true);
    await expect(second).resolves.toEqual({ ok: true, content: 'two' });
  });

  it('will not let one device answer for another', async () => {
    const call = router.callTool('mac', 'files', 'read_file', {});
    await vi.advanceTimersByTimeAsync(0);
    // Distinct from guessing an id: this is a second paired machine holding one
    // it somehow saw, and it should not be able to answer with it at all.
    expect(router.settle('the-phone', sent[0].data.requestId, { ok: true, content: 'not mine' })).toBe(false);
    expect(router.settle('mac', sent[0].data.requestId, { ok: true, content: 'mine' })).toBe(true);
    await expect(call).resolves.toEqual({ ok: true, content: 'mine' });
  });

  it('turns an unreadable answer into a failure rather than an empty success', async () => {
    const call = router.callTool('mac', 'files', 'read_file', {});
    await vi.advanceTimersByTimeAsync(0);
    answerLast({ nonsense: true });
    // `{ ok: true }` with an undefined payload would reach the model as a tool
    // that ran and returned nothing, which is the one thing it must not read as.
    await expect(call).resolves.toEqual({ ok: false, error: expect.stringContaining('files') });
  });

  it('fails everything in flight when the server stops', async () => {
    const call = router.callTool('mac', 'files', 'read_file', {});
    await vi.advanceTimersByTimeAsync(0);
    router.close();
    await expect(call).resolves.toEqual({ ok: false, error: expect.stringContaining('Stem stopped') });
  });

  it('hands a device its own servers — disabled ones flagged, everyone else’s withheld', async () => {
    servers = {
      files: { command: '/usr/bin/mcp-files', env: { API_KEY: 'k' }, location: { deviceId: 'mac' } },
      'home-assistant': { url: 'http://ha.local/mcp', location: { deviceId: 'mac' }, disabled: true },
      'on-the-laptop': { command: '/usr/bin/other', location: { deviceId: 'laptop' } },
      'stem-recall': { command: '/usr/bin/recall' }
    };
    const assignments = await router.assignmentsFor('mac');

    // A disabled server is sent, flagged. Withholding it would look identical
    // over there to being un-pinned, and the host prunes the approval of a
    // server it is no longer assigned — so an off/on toggle would cost a second
    // approval of a spec nobody edited.
    expect(assignments.map((a) => [a.name, a.disabled ?? false])).toEqual([
      ['files', false],
      ['home-assistant', true]
    ]);
    // Another device's server and a reserved one are withheld outright.
    expect(assignments.map((a) => a.name)).not.toContain('on-the-laptop');
    expect(assignments.map((a) => a.name)).not.toContain('stem-recall');
    // The credentials go with the spec, to the one device the entry names.
    expect(assignments[0].spec).toEqual({ command: '/usr/bin/mcp-files', env: { API_KEY: 'k' } });
    expect(assignments[0].fingerprint).toBe(mcpSpecFingerprint(assignments[0].spec));
    // `location` is not part of what runs, so it is not part of what is approved.
    expect(assignments[0].spec).not.toHaveProperty('location');
  });

  it('remembers what a device announced, capped and with unknown states read as failed', async () => {
    await router.announce('mac', {
      servers: [
        { name: 'files', status: 'ready', tools: [{ name: 'read_file', description: 'Read a file' }] },
        { name: 'shell', status: 'unapproved', fingerprint: 'abc' },
        { name: 'mystery', status: 'whatever-the-client-said' },
        { notEvenANameHere: true }
      ]
    });

    const catalog = await router.catalog();
    expect(catalog.devices.mac.servers.map((s) => [s.name, s.status])).toEqual([
      ['files', 'ready'],
      ['shell', 'unapproved'],
      // A state we cannot name must not be reported to the assistant as ready.
      ['mystery', 'failed']
    ]);
    expect(catalog.devices.mac.servers[0].tools).toEqual([{ name: 'read_file', description: 'Read a file' }]);

    // A device is the authority on its own machine: the next announcement
    // replaces the last one, so a server it no longer hosts can disappear.
    await router.announce('mac', { servers: [{ name: 'files', status: 'failed', error: 'spawn ENOENT' }] });
    const after = await router.catalog();
    expect(after.devices.mac.servers).toEqual([{ name: 'files', status: 'failed', error: 'spawn ENOENT' }]);
  });
});

// The same round-trip with nothing faked between the two ends: a real transport,
// the real IPC channels, and the real desktop proxy reading the addressed frame
// off a live SSE stream. The stub host stands where step 3's real one will.
describe('a call to a device, end to end', () => {
  let proxy: ServerProxy;
  let deviceId: string;
  let serverUrl: string;
  /** What the stub host will answer with next, and what it was asked. */
  let answer: DeviceMcpResult = { ok: true, content: 'nothing yet' };
  const asked: DeviceMcpRequest[] = [];
  const execAsked: { requestId: string; command: string; threadId: string; cwd?: string }[] = [];
  /** How many times the server told this device its assignments had moved. */
  let assignmentNotices = 0;

  /**
   * Enough IpcDeps to register the MCP channels. The three under test reach the
   * router, not the backend; the getters below exist because the other channels
   * in that module declare them, and a test that called one would rather see
   * this sentence than a null dereference.
   */
  const ipcDeps: IpcDeps = {
    e2e: true,
    runtime: () => {
      throw new Error('this test registers the MCP channels; it does not run a backend');
    },
    scheduler: () => null,
    providerAuth: () => null,
    embedManager: () => null,
    remoteHealth: () => null,
    emit: () => undefined,
    onAuthenticated: () => Promise.reject(new Error('no sign-in here')),
    scheduleMemoryRebuild: () => undefined,
    scheduleFolderIndexScan: () => undefined,
    scheduleFolderLearn: () => undefined
  };

  beforeAll(async () => {
    process.env.STEM_SECRET_KEY = secretKeyHex()!;
    rmSync(piMcpConfigPath(), { force: true });
    rmSync(piMcpDeviceCatalogPath(), { force: true });
    rmSync(execDeviceHostsPath(), { force: true });
    await readDevices().catch(() => undefined);
    rmSync(devicesStorePath(), { force: true });
    forgetCachedDevices();

    registerMcpIpc(ipcDeps);
    // The exec host channels live with the devices IPC; registering them here is
    // what lets the second half of this suite run commands over the same wire.
    registerDevicesIpc();
    const endpoint = await startTransport({ devUrl: null });
    if (!endpoint.url) throw new Error('the transport published no URL to talk to');
    serverUrl = endpoint.url;

    // The desktop's real credential path: this process shares the state root, so
    // it mints itself a device record exactly as the app does at startup.
    const credentials = await clientCredentials(serverUrl, { external: false });
    deviceId = (await readClientIdentity())!.deviceId;

    proxy = createServerProxy({
      ...credentials,
      remote: false,
      // The seam step 3 fills. It answers on the same channel the real host will,
      // through the same RPC — so what is exercised here is the whole path, with
      // only the part that spawns a process left out.
      mcpHost: {
        onRequest: (request) => {
          asked.push(request);
          void proxy.invoke('mcpHost:result', [request.requestId, answer]);
        },
        // The real host re-runs its hello here. Counting is enough: what is
        // under test is that the frame arrives at all, on a machine that made
        // no edit and asked nobody.
        onAssignmentsChanged: () => {
          assignmentNotices += 1;
        }
      },
      // The exec twin of the seam above: answers on the channel the real exec
      // host will, through the same RPC, with the spawn itself left out.
      execHost: {
        onRequest: (request) => {
          execAsked.push(request);
          void proxy.invoke('execHost:result', [request.requestId, { ok: true, text: `ran: ${request.command}` }]);
        }
      },
      harnessHost: { onRequest: () => undefined, onCancel: () => undefined },
      oauthCourier: { expectSignIn: () => undefined, offer: () => undefined, close: () => undefined },
      sendToMain: () => undefined,
      sendToOverlay: () => undefined,
      revealIfOwns: () => undefined,
      routeBackendEvent: () => undefined,
      revealMainWindow: () => undefined,
      requestAttention: () => undefined,
      threadOpened: () => Promise.resolve(),
      applyQuickChatSettings: () => undefined,
      resync: () => undefined,
      liveTurns: () => undefined,
      connection: () => undefined
    });
    await proxy.start();

    await addMcpServer({
      name: 'files',
      transport: 'stdio',
      command: '/usr/bin/mcp-files',
      args: ['--root', '/Users/ada'],
      env: { API_KEY: 'read-only' },
      location: { deviceId }
    });
  });

  afterAll(async () => {
    proxy?.close();
    closeExecDeviceRouter();
    await closeTransport();
  });

  /** Wait for `check` — the SSE stream delivers on its own schedule. */
  async function until(check: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 300; i++) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  it('tells a device which servers are its own, credentials and all', async () => {
    const assignments = (await proxy.invoke('mcpHost:hello', [])) as {
      name: string;
      spec: DeviceMcpSpec;
      fingerprint: string;
    }[];

    expect(assignments).toHaveLength(1);
    expect(assignments[0].name).toBe('files');
    // The env value arrives decrypted, because the spec IS what the far machine
    // connects with — and it went to exactly one device, the one named in the
    // entry, over the stream that device authenticated.
    expect(assignments[0].spec).toEqual({
      command: '/usr/bin/mcp-files',
      args: ['--root', '/Users/ada'],
      env: { API_KEY: 'read-only' }
    });
    expect(assignments[0].fingerprint).toBe(mcpSpecFingerprint(assignments[0].spec));
  });

  it('rides an addressed control frame out and an ordinary RPC back', async () => {
    answer = { ok: true, content: 'the contents of notes.md' };
    // `proxy.start()` returns once the channel list is in; the stream it then
    // opens registers a moment later, and availability is that registration.
    await until(() => deviceMcpRouter().isAvailable(deviceId), 'the event stream to register');
    const result = await deviceMcpRouter().callTool(deviceId, 'files', 'read_file', { path: 'notes.md' });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ server: 'files', op: 'call', tool: 'read_file' });
    expect(result).toEqual({ ok: true, content: 'the contents of notes.md' });
  });

  it('stores an announcement where the catalog block will read it', async () => {
    await proxy.invoke('mcpHost:announce', [
      { servers: [{ name: 'files', status: 'ready', tools: [{ name: 'read_file' }] }] }
    ]);

    // On disk, under the pi home, beside mcp.json — so the tools of a machine
    // that is currently asleep are still there to be listed and marked (③).
    const onDisk = JSON.parse(await readFile(piMcpDeviceCatalogPath(), 'utf8')) as DeviceMcpCatalog;
    expect(onDisk.devices[deviceId].servers).toEqual([
      { name: 'files', status: 'ready', tools: [{ name: 'read_file' }] }
    ]);
  });

  it('tells the hosting machine when mcp.json changes under it', async () => {
    // The case this exists for: the edit is made somewhere that is NOT the
    // machine running the server — another window, a phone, the assistant's own
    // add/remove — so nothing on the hosting side has any reason to look. Told
    // at the writer, so every one of those callers is covered by construction.
    await until(() => deviceMcpRouter().isAvailable(deviceId), 'the event stream to register');
    const before = assignmentNotices;

    await setMcpServerEnabled('files', false);
    await until(() => assignmentNotices > before, 'the device to be told its assignments changed');

    // Turning it back on is a second change to what this machine hosts, and it
    // has to arrive too — otherwise the server stays stopped over there until
    // the next launch.
    const afterDisable = assignmentNotices;
    await setMcpServerEnabled('files', true);
    await until(() => assignmentNotices > afterDisable, 'the device to be told the server is back');
  });

  it('does not wake a machine over an edit that has nothing to do with it', async () => {
    await until(() => deviceMcpRouter().isAvailable(deviceId), 'the event stream to register');
    const before = assignmentNotices;

    // A server that runs where stem-server runs. Nothing about it changes what
    // any device hosts, so no device is told; the frame is addressed off the
    // back of a diff, not off the fact that the file was written.
    await addMcpServer({ name: 'server-side', transport: 'stdio', command: '/usr/bin/whatever' });
    await new Promise((r) => setTimeout(r, 50));
    expect(assignmentNotices).toBe(before);

    await removeMcpServer('server-side');
  });

  it('learns whether a device runs commands from its announcement, and shows it in the list', async () => {
    await proxy.invoke('execHost:announce', [{ enabled: true, platform: 'darwin' }]);
    expect(await execDeviceRouter().hostFor(deviceId)).toMatchObject({ enabled: true, platform: 'darwin' });
    const snapshot = (await proxy.invoke('devices:list', [])) as { devices: { id: string; runsCommands?: boolean }[] };
    expect(snapshot.devices.find((d) => d.id === deviceId)?.runsCommands).toBe(true);
  });

  it('runs a command over the same rails: addressed frame out, RPC result back', async () => {
    await until(() => execDeviceRouter().isAvailable(deviceId), 'the event stream to register');
    const result = await execDeviceRouter().run(deviceId, {
      threadId: 'chat-1',
      command: 'echo hello',
      cwd: '/Users/ada/Downloads',
      timeoutMs: 5_000
    });
    expect(execAsked).toHaveLength(1);
    expect(execAsked[0]).toMatchObject({ command: 'echo hello', threadId: 'chat-1', cwd: '/Users/ada/Downloads' });
    expect(result).toEqual({ ok: true, text: 'ran: echo hello' });
  });

  it('refuses a call once the client is gone, and says which machine to wake', async () => {
    proxy.close();
    await until(() => !deviceMcpRouter().isAvailable(deviceId), 'the stream to close');

    const result = (await deviceMcpRouter().callTool(deviceId, 'files', 'read_file', {})) as {
      ok: false;
      error: string;
    };
    const label = (await readDevices()).find((d) => d.id === deviceId)!.label;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('files');
    expect(result.error).toContain(label);
  });

  it('leaves a server that names another machine alone', async () => {
    // Nothing about this feature may change what an ordinary entry does: a
    // server with no location still belongs to the machine hosting stem-server.
    const config = await readMcpConfig();
    config.servers.elsewhere = { command: '/usr/bin/other', location: { deviceId: 'some-other-device' } };
    await writeMcpConfig(config);

    const assignments = await deviceMcpRouter().assignmentsFor(deviceId);
    expect(assignments.map((a) => a.name)).toEqual(['files']);
  });
});
