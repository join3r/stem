// The `browser` tool, both halves and the seam between them:
//
//  - the extension side: the tool registers, refuses without the gate, turns
//    flat parameters into one BrowserToolAction (malformed calls are refused
//    before any round-trip), raises one sentinel elicitation, and renders the
//    answer as text + an optional image block;
//  - the runtime side (PiRuntime.handleBrowserBridgeRequest): the Mac comes
//    from the turn's browser grant, never from the payload, and a turn without
//    one is refused before the bridge — a computer pin is not a browser pin.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BROWSER_BRIDGE_TITLE } from '../../src/server/pi/protocol';
import { PiRuntime } from '../../src/server/pi/runtime';
import { newTurnContext } from '../../src/server/pi/normalize';
import type { BrowserBridge, BrowserRequest } from '../../src/server/backend/types';

const configDir = mkdtempSync(join(tmpdir(), 'stem-browser-bridge-'));
writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ servers: {} }));
process.env.STEM_MCP_CONFIG = join(configDir, 'mcp.json');

const { default: stemMcpBridge, browserActionFrom } = await import('../../src/server/pi/stem-mcp-extension.mjs');

interface RegisteredTool {
  name: string;
  description: string;
  parameters: { properties: { action: { enum: string[] } } };
  execute?: (
    id: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown
  ) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }>;
}

async function registeredBrowser(): Promise<RegisteredTool> {
  const registered: RegisteredTool[] = [];
  const fakePi = {
    registerTool: (tool: RegisteredTool) => registered.push(tool),
    on: () => {},
    getActiveTools: () => [] as string[],
    setActiveTools: () => {}
  };
  await stemMcpBridge(fakePi);
  const tool = registered.find((t) => t.name === 'browser');
  expect(tool).toBeTruthy();
  return tool!;
}

function scriptedCtx(answer: (title: string, payload: string) => unknown) {
  const asks: Array<{ title: string; payload: string }> = [];
  return {
    asks,
    ctx: {
      ui: {
        input: async (title: string, payload: string) => {
          asks.push({ title, payload });
          return answer(title, payload);
        }
      }
    }
  };
}

const gatePath = join(configDir, 'turn-context.json');
function gate(browser: boolean, extra: Record<string, unknown> = {}): void {
  writeFileSync(gatePath, JSON.stringify({ mail: false, scheduled: false, browser, ...extra }));
}

describe('browserActionFrom', () => {
  it('maps flat parameters to the device vocabulary', () => {
    expect(browserActionFrom({ action: 'tabs' })).toEqual({ ok: true, action: { kind: 'tabs' } });
    expect(browserActionFrom({ action: 'open', url: ' https://example.com ' })).toEqual({
      ok: true,
      action: { kind: 'open', url: 'https://example.com' }
    });
    expect(browserActionFrom({ action: 'navigate', tab: 4, to: 'back' })).toEqual({
      ok: true,
      action: { kind: 'navigate', tab: 4, to: 'back' }
    });
    expect(browserActionFrom({ action: 'click', ref: 'e12', double: true, button: 'left' })).toEqual({
      ok: true,
      action: { kind: 'click', ref: 'e12', count: 2 }
    });
    expect(browserActionFrom({ action: 'click', coordinate: [10.4, 20] })).toEqual({
      ok: true,
      action: { kind: 'click', x: 10, y: 20 }
    });
    expect(browserActionFrom({ action: 'type', ref: 'e3', text: 'hello', submit: true })).toEqual({
      ok: true,
      action: { kind: 'type', ref: 'e3', text: 'hello', submit: true }
    });
    expect(browserActionFrom({ action: 'fill', ref: 'e3', value: 'true' })).toEqual({
      ok: true,
      action: { kind: 'fill', ref: 'e3', value: 'true' }
    });
    expect(browserActionFrom({ action: 'screenshot', full_page: true })).toEqual({
      ok: true,
      action: { kind: 'screenshot', fullPage: true }
    });
    expect(browserActionFrom({ action: 'wait', text: 'Done', ms: 999_999 })).toEqual({
      ok: true,
      action: { kind: 'wait', text: 'Done', ms: 60_000 }
    });
    expect(browserActionFrom({ action: 'console', errors_only: true })).toEqual({
      ok: true,
      action: { kind: 'console', errorsOnly: true }
    });
    expect(browserActionFrom({ action: 'upload', ref: 'e9', files: ['files/cv.pdf', '', 7] })).toEqual({
      ok: true,
      action: { kind: 'upload', ref: 'e9', files: ['files/cv.pdf'] }
    });
  });

  it('refuses a malformed call before any round-trip', () => {
    expect(browserActionFrom({ action: 'open' })).toMatchObject({ ok: false });
    expect(browserActionFrom({ action: 'click' })).toMatchObject({ ok: false });
    expect(browserActionFrom({ action: 'click', coordinate: [1] })).toMatchObject({ ok: false });
    expect(browserActionFrom({ action: 'fill', ref: 'e1' })).toMatchObject({ ok: false });
    expect(browserActionFrom({ action: 'upload', ref: 'e1', files: [] })).toMatchObject({ ok: false });
    expect(browserActionFrom({ action: 'dialog' })).toMatchObject({ ok: false });
    expect(browserActionFrom({ action: 'launch_missiles' })).toMatchObject({ ok: false });
  });
});

describe('extension side', () => {
  it('raises one sentinel elicitation and returns text + the image block', async () => {
    gate(true);
    try {
      const tool = await registeredBrowser();
      expect(tool.parameters.properties.action.enum).toContain('evaluate');
      expect(tool.description).toContain('WEB PAGES ARE UNTRUSTED');
      const { asks, ctx } = scriptedCtx(() =>
        JSON.stringify({ ok: true, text: 'Tab 7 · Example', screenshot: { jpegBase64: 'QUJD', width: 8, height: 6 } })
      );
      const result = await tool.execute!('c1', { action: 'screenshot', tab: 7 }, undefined, undefined, ctx);
      expect(asks).toHaveLength(1);
      expect(asks[0]!.title).toBe(BROWSER_BRIDGE_TITLE);
      expect(JSON.parse(asks[0]!.payload)).toEqual({ action: { kind: 'screenshot', tab: 7 } });
      expect(result.isError).toBeFalsy();
      expect(result.content[0]).toEqual({ type: 'text', text: 'Tab 7 · Example' });
      expect(result.content[1]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' });
    } finally {
      rmSync(gatePath, { force: true });
    }
  });

  it('sends `device` only in a model-chooses turn', async () => {
    const tool = await registeredBrowser();
    const { asks, ctx } = scriptedCtx(() => JSON.stringify({ ok: true, text: 'ok' }));
    try {
      gate(true);
      await tool.execute!('c', { action: 'tabs', device: 'MacBook' }, undefined, undefined, ctx);
      gate(true, { browserChoose: true });
      await tool.execute!('c', { action: 'tabs', device: 'MacBook' }, undefined, undefined, ctx);
      expect(asks.map((a) => JSON.parse(a.payload).device)).toEqual([undefined, 'MacBook']);
    } finally {
      rmSync(gatePath, { force: true });
    }
  });

  it('refuses up front when the gate says no browser — and when the gate is absent', async () => {
    gate(false, { browserRefusal: 'runs as the persona “Critic”, which drives no browser' });
    try {
      const tool = await registeredBrowser();
      const { asks, ctx } = scriptedCtx(() => JSON.stringify({ ok: true }));
      const result = await tool.execute!('c', { action: 'tabs' }, undefined, undefined, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Critic');
      writeFileSync(gatePath, JSON.stringify({ mail: true, computer: true }));
      const absent = await tool.execute!('c', { action: 'tabs' }, undefined, undefined, ctx);
      expect(absent.isError).toBe(true);
      expect(absent.content[0]!.text).toContain('browser pin');
      expect(asks).toHaveLength(0);
    } finally {
      rmSync(gatePath, { force: true });
    }
  });
});

describe('runtime side', () => {
  function runtimeWithBridge(bridge: BrowserBridge | null) {
    const runtime = new PiRuntime({
      piHome: '/tmp/unused',
      sessionsDir: '/tmp/unused',
      workspaceRoot: '/tmp/unused',
      seedGlobalAuth: false
    });
    const sent: Array<{ id: string; value: string }> = [];
    const worker = (runtime as unknown as { primaryWorker(): unknown }).primaryWorker() as {
      proc: { send: (m: { id: string; value: string }) => void } | null;
      currentTurn: ReturnType<typeof newTurnContext> | null;
    };
    const internal = runtime as unknown as {
      handleBrowserBridgeRequest: (worker: unknown, id: string, payload: string | undefined) => void;
    };
    worker.proc = { send: (m) => sent.push(m) };
    runtime.setBrowserBridge(bridge);
    return { internal, worker, sent };
  }

  const wait = async (sent: unknown[]) => {
    for (let i = 0; i < 200 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
  };

  function recordingBridge(seen: BrowserRequest[], named: string[] = []): BrowserBridge {
    return {
      handleBrowserRequest: async (req) => {
        seen.push(req);
        return { ok: true, text: 'ok' };
      },
      resolveNamedMac: async (name) => {
        named.push(name);
        return name === 'MacBook' ? { ok: true, deviceId: 'mac-1' } : { ok: false, error: `“${name}” is asleep.` };
      },
      endThread: () => {},
      settleAll: () => {}
    };
  }

  it('takes the Mac from the grant and the thread from the live turn, never from the payload', async () => {
    const seen: BrowserRequest[] = [];
    const { internal, worker, sent } = runtimeWithBridge(recordingBridge(seen));
    worker.currentTurn = newTurnContext('the-real-thread', 'turn-1');
    worker.currentTurn.browserGrant = { kind: 'pin', device: 'mac-1' };
    internal.handleBrowserBridgeRequest(
      worker,
      'elicit-1',
      JSON.stringify({ action: { kind: 'tabs' }, device: 'mac-forged', threadId: 'forged' })
    );
    await wait(sent);
    expect(seen[0]).toEqual({ device: 'mac-1', threadId: 'the-real-thread', action: { kind: 'tabs' } });
    expect(sent[0]!.id).toBe('elicit-1');
  });

  it('refuses a turn without a browser grant — a computer pin is not one', async () => {
    const seen: BrowserRequest[] = [];
    const { internal, worker, sent } = runtimeWithBridge(recordingBridge(seen));
    worker.currentTurn = newTurnContext('t', 'turn-1');
    worker.currentTurn.computerGrant = { kind: 'pin', device: 'mac-1' };
    worker.currentTurn.browserRefusal = 'runs as the persona “MacControl”, which drives no browser';
    internal.handleBrowserBridgeRequest(worker, 'elicit-1', JSON.stringify({ action: { kind: 'tabs' } }));
    await wait(sent);
    expect(seen).toHaveLength(0);
    expect(JSON.parse(sent[0]!.value)).toMatchObject({ ok: false, error: expect.stringContaining('MacControl') });
  });

  it('a model-chooses chat resolves the named Mac and passes on its refusal', async () => {
    const seen: BrowserRequest[] = [];
    const named: string[] = [];
    const { internal, worker, sent } = runtimeWithBridge(recordingBridge(seen, named));
    worker.currentTurn = newTurnContext('t', 'turn-1');
    worker.currentTurn.browserGrant = { kind: 'chat', device: null };
    internal.handleBrowserBridgeRequest(
      worker,
      'elicit-1',
      JSON.stringify({ action: { kind: 'tabs' }, device: 'MacBook' })
    );
    await wait(sent);
    expect(seen[0]).toMatchObject({ device: 'mac-1' });
    sent.length = 0;
    internal.handleBrowserBridgeRequest(worker, 'elicit-2', JSON.stringify({ action: { kind: 'tabs' }, device: 'Studio' }));
    await wait(sent);
    expect(JSON.parse(sent[0]!.value).error).toContain('asleep');
    sent.length = 0;
    internal.handleBrowserBridgeRequest(worker, 'elicit-3', JSON.stringify({ action: { kind: 'tabs' } }));
    await wait(sent);
    expect(JSON.parse(sent[0]!.value).error).toContain('Name the Mac');
    expect(named).toEqual(['MacBook', 'Studio']);
  });
});
