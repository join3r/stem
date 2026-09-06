// The assistant reaching a server that runs on somebody's own computer
// (docs/mcp-device-pinning.md, step 4).
//
// Steps 2 and 3 built the two ends; this is the part that makes them one thing.
// A pinned server now joins the same clients map every other routed server is
// in, so invoke_tool and describe_tool know nothing about it — and that map is
// exactly where decision ③ has to hold: the server belongs there whether or not
// the machine is up, because a server that drops out of it while a laptop is
// closed takes the capability with it, and the assistant starts saying it cannot
// do something it can do perfectly well tomorrow morning.
//
// So the properties under test are, in order of how much they matter:
//
//  - an offline device's server is still listed, with its tools, and only the
//    CALL fails — in a sentence naming the machine to wake;
//  - the injected catalog is stamped with availability at injection time, not at
//    pi start, and the two catalogs (bridge / device) stay separate;
//  - the round-trip itself, sentinel to router and back;
//  - which device a server belongs to is read from mcp.json, never from the
//    payload the bridge extension sent.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEVICE_MCP_BRIDGE_TITLE } from '../../src/server/pi/protocol';
import { createDeviceMcpRouter, type DeviceMcpRouter } from '../../src/server/mcp-device/router';
import { renderDeviceCatalogBlock, type DeviceMcpCatalogStore } from '../../src/server/mcp-device/catalog';
import { runDeviceMcpBridgeOp } from '../../src/server/mcp-device/pi-bridge';
import { secretKeyHex } from '../../src/server/pi/secrets';
import { forgetCachedDevices, mintDevice, readDevices } from '../../src/server/transport/auth';
import { devicesStorePath, piMcpConfigPath, piMcpDeviceCatalogPath } from '../../src/server/workspace/paths';
import type { PiMcpServer } from '../../src/server/pi/mcp-config';
import type { DeviceMcpCatalog, DeviceMcpRequest } from '../../src/shared/types';

// Which devices have a stream open, as every per-turn availability check sees
// it. A plain mutable set, because the point of ③ is that this answer can be
// different on the next turn without anything else changing.
const connected = new Set<string>();
vi.mock('../../src/server/startup/transport', () => ({
  connectedDeviceIds: () => connected,
  pushToDevice: () => 0
}));

const {
  buildMcpCatalogContext,
  forgetMcpCatalogCaches,
  piMcpCatalogPath: bridgeCatalogPath,
  writeMcpConfig
} = await import('../../src/server/pi/mcp-config');
const { default: stemMcpBridge, mcpConnectionsSettledForTests, resetMcpConnectionCacheForTests, setLiveCtxForTests } =
  await import('../../src/server/pi/stem-mcp-extension.mjs');

/** A catalog holding one device with one server and one tool. */
function catalogWith(
  deviceId: string,
  server: { name: string; status?: 'ready' | 'failed' | 'unapproved'; error?: string; tools?: number }
): DeviceMcpCatalog {
  const count = server.tools ?? 1;
  return {
    version: 1,
    devices: {
      [deviceId]: {
        deviceId,
        announcedAt: '2026-08-16T09:00:00.000Z',
        servers: [
          {
            name: server.name,
            status: server.status ?? 'ready',
            ...(server.error ? { error: server.error } : {}),
            tools: Array.from({ length: count }, (_, i) => ({
              name: `tool_${i}`,
              description: `Does thing ${i}.`,
              signature: '(path, limit?)'
            }))
          }
        ]
      }
    }
  };
}

describe('the device half of the tool catalog', () => {
  const everything = { include: () => true, label: (id: string) => (id === 'mac' ? 'Ada’s MacBook' : id) };

  it('lists an available server plainly, naming the machine it runs on', () => {
    const block = renderDeviceCatalogBlock(catalogWith('mac', { name: 'files', tools: 2 }), {
      ...everything,
      isAvailable: () => true
    });
    expect(block.anyAway).toBe(false);
    expect(block.text).toContain('### files (2 tools) — runs on “Ada’s MacBook”');
    expect(block.text).toContain('Search to discover');
    expect(block.text).not.toContain('(path, limit?)');
    expect(block.text).not.toContain('NOT connected');
  });

  it('keeps an unavailable integration discoverable, and marks the machine', () => {
    // The one this whole step exists for. Dropping the section would leave the
    // assistant unable to see a capability it has, and unable to tell the user
    // which computer to wake — it would simply say it cannot do the thing.
    const block = renderDeviceCatalogBlock(catalogWith('mac', { name: 'files', tools: 2 }), {
      ...everything,
      isAvailable: () => false
    });
    expect(block.anyAway).toBe(true);
    expect(block.text).toContain('### files (2 tools) — runs on “Ada’s MacBook”, which is NOT connected right now');
    expect(block.text).toContain('Search to discover');
    expect(block.text).not.toContain('  - tool_');
  });

  it('says when the machine is up but the server on it is not', () => {
    const failed = renderDeviceCatalogBlock(
      catalogWith('mac', { name: 'files', status: 'failed', error: 'uvx: command not found' }),
      { ...everything, isAvailable: () => true }
    );
    expect(failed.text).toContain('where it is not running: uvx: command not found');

    const unapproved = renderDeviceCatalogBlock(catalogWith('mac', { name: 'files', status: 'unapproved' }), {
      ...everything,
      isAvailable: () => true
    });
    expect(unapproved.text).toContain('where nobody has approved it to run yet');
  });

  it('reports an unreachable machine rather than a stale failure from before it left', () => {
    // The report is older than the disconnection, and the sentence somebody can
    // act on is about the computer, not about the program that failed on it.
    const block = renderDeviceCatalogBlock(
      catalogWith('mac', { name: 'files', status: 'failed', error: 'uvx: command not found' }),
      { ...everything, isAvailable: () => false }
    );
    expect(block.text).toContain('which is NOT connected right now');
    expect(block.text).not.toContain('uvx: command not found');
  });

  it('skips a server with no known tools, and one the config no longer pins there', () => {
    const empty: DeviceMcpCatalog = {
      version: 1,
      devices: {
        mac: { deviceId: 'mac', announcedAt: '', servers: [{ name: 'files', status: 'ready' }] }
      }
    };
    // Nothing to call: a heading with nothing under it says only that a name exists.
    expect(renderDeviceCatalogBlock(empty, { ...everything, isAvailable: () => true }).text).toBe('');
    // Announced once, un-pinned since: mcp.json is the authority on what may be
    // called, so a remembered announcement never advertises a tool invoke_tool
    // would refuse.
    const dropped = renderDeviceCatalogBlock(catalogWith('mac', { name: 'files' }), {
      ...everything,
      include: () => false,
      isAvailable: () => true
    });
    expect(dropped.text).toBe('');
  });
});

describe('the block main injects each turn', () => {
  const files: PiMcpServer = { command: '/usr/bin/mcp-files', location: { deviceId: '' } };
  let deviceId = '';

  beforeEach(async () => {
    process.env.STEM_SECRET_KEY = secretKeyHex()!;
    connected.clear();
    rmSync(piMcpConfigPath(), { force: true });
    rmSync(piMcpDeviceCatalogPath(), { force: true });
    rmSync(bridgeCatalogPath(), { force: true });
    await readDevices().catch(() => undefined);
    rmSync(devicesStorePath(), { force: true });
    forgetCachedDevices();
    forgetMcpCatalogCaches();

    await mkdir(dirname(piMcpDeviceCatalogPath()), { recursive: true });
    const { device } = await mintDevice('Ada’s MacBook');
    deviceId = device.id;
    await writeMcpConfig({ servers: { files: { ...files, location: { deviceId } } } });
    await writeFile(piMcpDeviceCatalogPath(), JSON.stringify(catalogWith(deviceId, { name: 'files', tools: 2 })));
  });

  it('stamps availability at injection time, not when the catalog was written', async () => {
    // Nothing about the catalog file changes between these two calls. The only
    // thing that moved is whether that machine has a stream open, which is what
    // ③ says must be asked per turn, with no handshake.
    connected.add(deviceId);
    const awake = await buildMcpCatalogContext();
    expect(awake).toContain('runs on “Ada’s MacBook”');
    expect(awake).not.toContain('NOT connected');

    connected.delete(deviceId);
    const asleep = await buildMcpCatalogContext();
    expect(asleep).toContain('which is NOT connected right now');
    // And the tools are still there, with the instruction that makes them usable
    // to the assistant: name the machine rather than deny the capability.
    expect(asleep).toContain('find_tools');
    expect(asleep).toContain('as soon as that computer is awake');
  });

  it('keeps the bridge’s catalog and the device catalog as two sources, concatenated', async () => {
    await writeFile(bridgeCatalogPath(), JSON.stringify({ text: '### notes (1 tool)\n  - search: Find a note. — (q)' }));
    forgetMcpCatalogCaches();
    connected.add(deviceId);

    const text = (await buildMcpCatalogContext()) ?? '';
    expect(text).toContain('### notes (1 tool)');
    expect(text).toContain('### files (2 tools) — runs on');
    // One heading, one closing instruction: the assistant sees a single list of
    // servers it can call, whichever machine each one happens to be on.
    expect(text.match(/Available integrations/g)).toHaveLength(1);
    expect(text.match(/through `invoke_tool`/g)).toHaveLength(1);
  });

  it('says nothing at all when there is nothing to say', async () => {
    rmSync(piMcpDeviceCatalogPath(), { force: true });
    forgetMcpCatalogCaches();
    expect(await buildMcpCatalogContext()).toBeNull();
  });

  it('drops a device server the user has disabled, even while that machine is away', async () => {
    await writeMcpConfig({ servers: { files: { ...files, location: { deviceId }, disabled: true } } });
    forgetMcpCatalogCaches();
    expect(await buildMcpCatalogContext()).toBeNull();
  });
});

describe('one call, from the bridge extension to the machine that hosts it', () => {
  /** Frames the fake transport was asked to write. */
  let sent: { deviceId: string; data: DeviceMcpRequest }[] = [];
  let servers: Record<string, PiMcpServer> = {};
  let router: DeviceMcpRouter;
  let stored: DeviceMcpCatalog;
  /** What the far-end host answers with, per op. */
  let answer: (request: DeviceMcpRequest) => unknown;
  let root = '';
  /** Every sentinel title the extension raised, in order. */
  let titles: string[] = [];

  const memoryCatalog: DeviceMcpCatalogStore = {
    read: () => Promise.resolve(stored),
    write: (next) => {
      stored = next;
      return Promise.resolve();
    }
  };

  /** The pi ctx the bridge latches: every dialog it raises lands on the router. */
  function fakeCtx() {
    return {
      ui: {
        input: async (title: string, payload: string) => {
          titles.push(title);
          if (title !== DEVICE_MCP_BRIDGE_TITLE) return undefined;
          const result = await runDeviceMcpBridgeOp(payload, {
            readServers: () => Promise.resolve(servers),
            router: () => router
          });
          return JSON.stringify(result);
        },
        confirm: () => Promise.resolve(true)
      }
    };
  }

  /** Start the bridge over a config + remembered catalog and return its tools. */
  async function startBridge(): Promise<Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>> {
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    const fakePi = {
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
        tools.set(tool.name, tool),
      on: () => {},
      getActiveTools: () => [] as string[],
      setActiveTools: () => {}
    };
    await stemMcpBridge(fakePi);
    await mcpConnectionsSettledForTests();
    return tools;
  }

  /** The text of whatever a router tool answered with. */
  function textOf(result: unknown): string {
    const content = (result as { content?: { text?: string }[] }).content ?? [];
    return content.map((c) => c.text ?? '').join('\n');
  }

  beforeEach(async () => {
    sent = [];
    titles = [];
    stored = { version: 1, devices: {} };
    connected.clear();
    connected.add('mac');
    servers = { files: { command: '/usr/bin/mcp-files', trusted: true, location: { deviceId: 'mac' } } };
    answer = () => ({ ok: true, content: [{ type: 'text', text: 'two files' }] });
    router = createDeviceMcpRouter({
      pushTo: (deviceId, _name, data) => {
        if (!connected.has(deviceId)) return 0;
        const request = data as DeviceMcpRequest;
        sent.push({ deviceId, data: request });
        // The far end answers on the next tick, as a POST /rpc would.
        setTimeout(() => router.settle(deviceId, request.requestId, answer(request)), 0);
        return 1;
      },
      connectedDevices: () => connected,
      deviceLabel: (id) => Promise.resolve(id === 'mac' ? '“Ada’s MacBook”' : `the device ${id}`),
      readServers: () => Promise.resolve(servers),
      catalog: memoryCatalog
    });

    root = await mkdtemp(join(tmpdir(), 'stem-device-bridge-'));
    process.env.STEM_MCP_CONFIG = join(root, 'mcp.json');
    await writeFile(process.env.STEM_MCP_CONFIG, JSON.stringify({ servers }));
    // What the machine announced the last time it was up.
    await writeFile(join(root, 'mcp-device-catalog.json'), JSON.stringify(catalogWith('mac', { name: 'files' })));
    setLiveCtxForTests(fakeCtx());
  });

  afterEach(async () => {
    resetMcpConnectionCacheForTests();
    setLiveCtxForTests(null);
    router.close();
    delete process.env.STEM_MCP_CONFIG;
    await rm(root, { recursive: true, force: true });
  });

  it('runs a tool on the machine that hosts it, through the ordinary router tools', async () => {
    answer = (request) =>
      request.op === 'tools'
        ? { ok: true, tools: [{ name: 'list_files', description: 'List files.', signature: '(path)' }] }
        : { ok: true, content: [{ type: 'text', text: `ran ${request.tool}` }] };

    const tools = await startBridge();
    const result = await tools.get('invoke_tool')!.execute('id', { server: 'files', tool: 'list_files', args: { path: '/' } });

    expect(textOf(result)).toBe('ran list_files');
    expect(titles).toEqual([DEVICE_MCP_BRIDGE_TITLE, DEVICE_MCP_BRIDGE_TITLE]); // the listing, then the call
    expect(sent.map((s) => s.data.op)).toEqual(['tools', 'call']);
    expect(sent[1].data).toMatchObject({ server: 'files', tool: 'list_files', args: { path: '/' } });
  });

  it('still offers the tools of a machine that is asleep, and fails the CALL by name', async () => {
    connected.delete('mac');

    const tools = await startBridge();
    // Remembered from the last announcement: the capability is still visible.
    const described = await tools.get('describe_tool')!.execute('id', { server: 'files', tool: 'tool_0' });
    expect(textOf(described)).toContain('"name": "tool_0"');
    // The compact signature is what the device sent, so describe_tool answers
    // with the argument names rather than an empty object that reads as "none".
    expect(textOf(described)).toContain('"path"');

    // And the call is where the truth lands — naming the server AND the machine,
    // because that is the sentence the assistant repeats to whoever asked.
    await expect(
      tools.get('invoke_tool')!.execute('id', { server: 'files', tool: 'tool_0', args: {} })
    ).rejects.toThrow(/“Ada’s MacBook”/);
    await expect(
      tools.get('invoke_tool')!.execute('id', { server: 'files', tool: 'tool_0', args: {} })
    ).rejects.toThrow(/"files"/);
    expect(sent).toHaveLength(0); // refused before anything went on the wire
  });

  // The argument names a device announces are a SUMMARY: one line per tool, cut
  // off after eight arguments. describe_tool is what makes that summary honest —
  // it is the on-demand escape hatch the compact catalog is predicated on — so
  // it has to answer with the schema the server actually declared, not with the
  // summary reflected back with every property empty.
  describe('describe_tool on a pinned server', () => {
    /** A tool with twelve arguments: more than a compact signature can carry. */
    const TWELVE = 'abcdefghijkl'.split('');
    const REAL_SCHEMA = {
      type: 'object',
      properties: Object.fromEntries(
        TWELVE.map((k) => [k, { type: 'string', description: `the ${k} argument`, enum: [`${k}1`, `${k}2`] }])
      ),
      required: ['a']
    };

    beforeEach(async () => {
      // What the machine announced: names only, truncated at eight with a "…".
      await writeFile(
        join(root, 'mcp-device-catalog.json'),
        JSON.stringify({
          version: 1,
          devices: {
            mac: {
              deviceId: 'mac',
              announcedAt: '2026-08-16T09:00:00.000Z',
              servers: [
                {
                  name: 'files',
                  status: 'ready',
                  tools: [{ name: 'wide', description: 'Takes a lot.', signature: '(a, b?, c?, d?, e?, f?, g?, h?, …)' }]
                }
              ]
            }
          }
        })
      );
      answer = (request) =>
        request.op === 'describe'
          ? { ok: true, schema: { name: 'wide', description: 'Takes a lot.', inputSchema: REAL_SCHEMA } }
          : { ok: true, tools: [{ name: 'wide', description: 'Takes a lot.', signature: '(a, b?, c?, d?, e?, f?, g?, h?, …)' }] };
    });

    it('answers with the server’s real schema, arguments past the eighth included', async () => {
      const tools = await startBridge();
      const described = textOf(await tools.get('describe_tool')!.execute('id', { server: 'files', tool: 'wide' }));

      const parsed = JSON.parse(described) as { inputSchema: typeof REAL_SCHEMA };
      // Every argument, with its type, its description and its allowed values —
      // none of which survives a round trip through a compact signature. The
      // ninth through twelfth are the ones that used to be unreachable
      // ENTIRELY: the signature truncates at eight and the parser dropped the
      // "…", so no amount of asking could ever have revealed them.
      expect(Object.keys(parsed.inputSchema.properties)).toEqual(TWELVE);
      expect(parsed.inputSchema.properties.l).toEqual({
        type: 'string',
        description: 'the l argument',
        enum: ['l1', 'l2']
      });
      expect(parsed.inputSchema.required).toEqual(['a']);
      expect(sent.map((s) => s.data.op)).toContain('describe');
    });

    it('discovery supplies the live schema without executing a device tool', async () => {
      const tools = await startBridge();
      const result = JSON.parse(textOf(await tools.get('find_tools')!.execute('id', { query: 'wide', server: 'files' })));
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].inputSchema).toEqual(REAL_SCHEMA);
      expect(sent.map(s => s.data.op)).toContain('describe');
      expect(sent.map(s => s.data.op)).not.toContain('call');
    });

    it('discovery retains an offline tool but explicitly defers its schema', async () => {
      connected.delete('mac');
      const tools = await startBridge();
      const result = JSON.parse(textOf(await tools.get('find_tools')!.execute('id', { query: '', server: 'files' })));
      expect(result.tools[0].name).toBe('wide');
      expect(result.tools[0].schemaDeferred).toBeTruthy();
      expect(result.tools[0].inputSchema).toBeUndefined();
    });

    it('says it is partial, and why, when that computer cannot be asked', async () => {
      connected.delete('mac');
      const tools = await startBridge();
      const described = textOf(await tools.get('describe_tool')!.execute('id', { server: 'files', tool: 'wide' }));
      const parsed = JSON.parse(described) as {
        inputSchema: { description: string; properties: Record<string, unknown>; additionalProperties: boolean };
      };

      // What is known is still offered — the eight names the machine announced —
      // but the schema says out loud that it is a fallback, that types are not
      // known, and that there are further arguments it cannot name. A confident
      // empty-property schema here is what makes a model call a tool wrongly and
      // have no idea why.
      expect(Object.keys(parsed.inputSchema.properties)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
      expect(parsed.inputSchema.description).toContain('PARTIAL SCHEMA');
      expect(parsed.inputSchema.description).toContain('further arguments');
      // And it names the machine to wake, because that is the actionable half.
      expect(parsed.inputSchema.description).toContain('Ada’s MacBook');
      // A schema that is known to be incomplete must not forbid what it omits.
      expect(parsed.inputSchema.additionalProperties).toBe(true);
    });
  });

  it('keeps the device server out of the bridge’s own catalog file', async () => {
    await startBridge();
    const catalog = JSON.parse(await readFile(join(root, 'mcp-catalog.json'), 'utf8')) as { text: string };
    // Main renders this one from the announced catalog instead, so that it can be
    // stamped per turn; a copy here would be a second, staler one in the prompt.
    expect(catalog.text).not.toContain('files');

    const status = JSON.parse(await readFile(join(root, 'mcp-status.json'), 'utf8')) as Record<
      string,
      { status: string; error: string | null }
    >;
    expect(status.files.status).toBe('elsewhere');
    // Elsewhere and healthy: the machine announced it as ready, so there is
    // nothing to say beyond where it is.
    expect(status.files.error).toBeNull();
  });

  it('does not report an unrunnable pinned server as healthy', async () => {
    // No announcement from that machine, ever — because it was unpaired, or
    // because it has not connected since the pin was made. Either way nothing
    // is running this server, and `status: elsewhere, error: null` is what a
    // working one looks like. Anything reading the status file rather than the
    // panel (which knows about orphans separately) saw exactly that.
    await rm(join(root, 'mcp-device-catalog.json'), { force: true });
    servers = {
      files: { command: '/usr/bin/mcp-files', trusted: true, location: { deviceId: 'mac', label: 'Ada’s MacBook' } }
    };
    await writeFile(process.env.STEM_MCP_CONFIG!, JSON.stringify({ servers }));

    await startBridge();
    const status = JSON.parse(await readFile(join(root, 'mcp-status.json'), 'utf8')) as Record<
      string,
      { status: string; error: string | null }
    >;
    // Names the machine as well as the server (⑤), out of the label stored
    // beside the pin — the id would be true and useless.
    expect(status.files.error).toContain('Ada’s MacBook');
    expect(status.files.error).toContain('no longer paired');
  });

  it('takes the device from mcp.json, never from the payload the extension sent', async () => {
    // The extension runs inside the pi process — the thing a compromised MCP
    // server gets to talk to. If it could name the device, it could aim a call
    // at a machine the user never pinned that server to.
    const forged = await runDeviceMcpBridgeOp(
      JSON.stringify({ op: 'call', server: 'files', tool: 't', args: {}, deviceId: 'someone-else' }),
      { readServers: () => Promise.resolve(servers), router: () => router }
    );
    expect(forged.ok).toBe(true);
    expect(sent[0].deviceId).toBe('mac');

    // A server that is not pinned at all is refused rather than routed anywhere.
    const unpinned = await runDeviceMcpBridgeOp(
      JSON.stringify({ op: 'call', server: 'local-only', tool: 't' }),
      { readServers: () => Promise.resolve({ 'local-only': { command: '/bin/x' } }), router: () => router }
    );
    expect(unpinned).toEqual({ ok: false, error: '"local-only" is not configured to run on one of your devices.' });
  });

  it('answers a malformed or unknown op instead of leaving the tool call hanging', async () => {
    const deps = { readServers: () => Promise.resolve(servers), router: () => router };
    expect(await runDeviceMcpBridgeOp('not json', deps)).toEqual({
      ok: false,
      error: 'Stem could not read that request.'
    });
    expect((await runDeviceMcpBridgeOp(JSON.stringify({ op: 'tools' }), deps)).ok).toBe(false);
    expect((await runDeviceMcpBridgeOp(JSON.stringify({ op: 'sudo', server: 'files' }), deps)).ok).toBe(false);
    expect((await runDeviceMcpBridgeOp(JSON.stringify({ op: 'call', server: 'files' }), deps)).ok).toBe(false);
  });
});
