// The coding_agent bridge, both halves and the seam between them:
//
//  - the extension side (stem-mcp-extension.mjs, imported directly as .mjs with
//    a fake pi): the tool registers, validates its inputs, raises exactly one
//    ctx.ui.input with the sentinel title and a JSON payload, and renders the
//    JSON answer as the tool result;
//  - the runtime side (PiRuntime.handleHarnessBridgeRequest): the payload is
//    routed to the wired HarnessBridge with the CURRENT turn's threadId and
//    scheduled flag injected — never trusted from the payload — and the answer
//    goes to the process that ASKED, not to a replacement.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_BRIDGE_TITLE } from '../../src/server/pi/protocol';
import { PiRuntime } from '../../src/server/pi/runtime';
import { newTurnContext } from '../../src/server/pi/normalize';
import { clampPinnedCwd } from '../../src/server/harness/pin';
import type { HarnessBridge, HarnessRequest } from '../../src/server/backend/types';

// The factory returns before registering anything without a readable mcp.json
// (the same file PiRuntime always writes before spawning pi).
const configDir = mkdtempSync(join(tmpdir(), 'stem-harness-bridge-'));
writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ servers: {} }));
process.env.STEM_MCP_CONFIG = join(configDir, 'mcp.json');

const { default: stemMcpBridge } = await import('../../src/server/pi/stem-mcp-extension.mjs');

interface RegisteredTool {
  name: string;
  description: string;
  execute?: (
    id: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown
  ) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
}

async function registeredCodingAgent(): Promise<RegisteredTool> {
  const registered: RegisteredTool[] = [];
  const fakePi = {
    registerTool: (tool: RegisteredTool) => registered.push(tool),
    on: () => {},
    getActiveTools: () => [] as string[],
    setActiveTools: () => {}
  };
  await stemMcpBridge(fakePi);
  const tool = registered.find((t) => t.name === 'coding_agent');
  expect(tool).toBeTruthy();
  return tool!;
}

/** A ctx whose ui.input records the ask and answers with a scripted string. */
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

describe('extension side', () => {
  it('raises one sentinel elicitation with the JSON payload and returns the answer text', async () => {
    const tool = await registeredCodingAgent();
    expect(tool.description).toContain('BLOCKING');
    expect(tool.description).toContain('continues the SAME');
    const { asks, ctx } = scriptedCtx(() => JSON.stringify({ ok: true, text: 'flag added' }));
    const result = await tool.execute!('call-1', {
      agent: 'claude',
      prompt: 'add a flag',
      cwd: '/tmp/proj',
      fresh_session: true
    }, undefined, undefined, ctx);
    expect(asks).toHaveLength(1);
    expect(asks[0].title).toBe(HARNESS_BRIDGE_TITLE);
    expect(JSON.parse(asks[0].payload)).toEqual({
      agent: 'claude',
      prompt: 'add a flag',
      cwd: '/tmp/proj',
      fresh_session: true,
      // The tool call id, echoed back on harness:progress to target the row.
      item_id: 'call-1'
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe('flag added');
  });

  it('renders an {ok: false} answer as a tool error', async () => {
    const tool = await registeredCodingAgent();
    const { ctx } = scriptedCtx(() => JSON.stringify({ ok: false, error: 'disabled in Settings' }));
    const result = await tool.execute!('call-1', { agent: 'claude', prompt: 'go' }, undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('disabled in Settings');
  });

  it('validates its inputs before raising anything', async () => {
    const tool = await registeredCodingAgent();
    const { asks, ctx } = scriptedCtx(() => '');
    const noAgent = await tool.execute!('c', { prompt: 'go' }, undefined, undefined, ctx);
    const noPrompt = await tool.execute!('c', { agent: 'claude' }, undefined, undefined, ctx);
    expect(noAgent.isError).toBe(true);
    expect(noPrompt.isError).toBe(true);
    expect(asks).toHaveLength(0);
  });

  it('survives a cancelled elicitation and a malformed answer', async () => {
    const tool = await registeredCodingAgent();
    const cancelled = scriptedCtx(() => undefined);
    const garbled = scriptedCtx(() => '{ not json');
    const a = await tool.execute!('c', { agent: 'claude', prompt: 'go' }, undefined, undefined, cancelled.ctx);
    const b = await tool.execute!('c', { agent: 'claude', prompt: 'go' }, undefined, undefined, garbled.ctx);
    expect(a.isError).toBe(true);
    expect(b.isError).toBe(true);
  });

  it('refuses up front when the turn-context gate says coding is off (unpinned mail persona)', async () => {
    const gatePath = join(configDir, 'turn-context.json');
    writeFileSync(gatePath, JSON.stringify({ mail: true, scheduled: true, coding: false }));
    try {
      const tool = await registeredCodingAgent();
      const { asks, ctx } = scriptedCtx(() => JSON.stringify({ ok: true, text: 'never' }));
      const result = await tool.execute!('c', { agent: 'claude', prompt: 'go' }, undefined, undefined, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('code personas');
      // No round-trip: the refusal is the point of the gate.
      expect(asks).toHaveLength(0);
      // An older main that writes no `coding` field reads as allowed — the
      // bridge in main is the boundary either way.
      writeFileSync(gatePath, JSON.stringify({ mail: true, scheduled: true }));
      const allowed = await tool.execute!('c', { agent: 'claude', prompt: 'go' }, undefined, undefined, ctx);
      expect(allowed.isError).toBeFalsy();
      expect(asks).toHaveLength(1);
    } finally {
      rmSync(gatePath, { force: true });
    }
  });
});

describe('the pin clamp (clampPinnedCwd)', () => {
  const pin = { agent: 'claude', cwd: '/repo', device: 'dev-1' };

  it('no requested cwd means the pinned folder', () => {
    expect(clampPinnedCwd(undefined, pin)).toEqual({ ok: true, cwd: '/repo' });
    expect(clampPinnedCwd('  ', pin)).toEqual({ ok: true, cwd: '/repo' });
  });

  it('folders inside the pin pass, relative or absolute', () => {
    expect(clampPinnedCwd('/repo/packages/x', pin)).toEqual({ ok: true, cwd: '/repo/packages/x' });
    expect(clampPinnedCwd('packages/x', pin)).toEqual({ ok: true, cwd: '/repo/packages/x' });
    expect(clampPinnedCwd('/repo', pin)).toEqual({ ok: true, cwd: '/repo' });
  });

  it('escapes are refused: outside paths, siblings, traversal', () => {
    expect(clampPinnedCwd('/etc', pin).ok).toBe(false);
    expect(clampPinnedCwd('/repository', pin).ok).toBe(false); // prefix, not a subfolder
    expect(clampPinnedCwd('../elsewhere', pin).ok).toBe(false);
    expect(clampPinnedCwd('/repo/../etc', pin).ok).toBe(false);
  });

  it('windows pins keep windows shapes', () => {
    const win = { agent: 'claude', cwd: 'C:\\repo', device: 'dev-1' };
    expect(clampPinnedCwd('C:\\repo\\x', win)).toEqual({ ok: true, cwd: 'C:\\repo\\x' });
    expect(clampPinnedCwd('C:\\other', win).ok).toBe(false);
  });

  it('a blank pinned cwd: scratch locally, refused on a device', () => {
    expect(clampPinnedCwd('/anywhere', { agent: 'claude', cwd: '' })).toEqual({ ok: true });
    const onDevice = clampPinnedCwd(undefined, { agent: 'claude', cwd: '', device: 'dev-1' });
    expect(onDevice.ok).toBe(false);
    if (!onDevice.ok) expect(onDevice.error).toContain('folder');
  });
});

describe('runtime side', () => {
  function runtimeWithBridge(bridge: HarnessBridge | null) {
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
      handleHarnessBridgeRequest: (worker: unknown, id: string, payload: string | undefined) => void;
    };
    worker.proc = { send: (m) => sent.push(m) };
    runtime.setHarnessBridge(bridge);
    return { internal, worker, sent };
  }

  async function settleSends(sent: unknown[]): Promise<void> {
    // The handler answers asynchronously; a couple of microtask turns suffice.
    for (let i = 0; i < 20 && sent.length === 0; i++) await Promise.resolve();
  }

  it('injects the live turn identity and never trusts the payload', async () => {
    const seen: HarnessRequest[] = [];
    const { internal, worker, sent } = runtimeWithBridge({
      handleHarnessRequest: async (req) => {
        seen.push(req);
        return { ok: true, text: 'done' };
      },
      abortThread: () => {},
      settleAll: () => {}
    });
    worker.currentTurn = newTurnContext('the-real-thread', 'turn-1');
    worker.currentTurn.isScheduled = true;
    internal.handleHarnessBridgeRequest(
      worker,
      'elicit-1',
      JSON.stringify({ agent: 'claude', prompt: 'go', threadId: 'forged-thread', isScheduled: false })
    );
    await settleSends(sent);
    expect(seen[0]).toMatchObject({ agent: 'claude', threadId: 'the-real-thread', isScheduled: true });
    expect(JSON.parse(sent[0].value)).toEqual({ ok: true, text: 'done' });
    expect(sent[0].id).toBe('elicit-1');
  });

  it('refuses a mail turn whose persona has no coding pin, before the bridge', async () => {
    const seen: HarnessRequest[] = [];
    const { internal, worker, sent } = runtimeWithBridge({
      handleHarnessRequest: async (req) => {
        seen.push(req);
        return { ok: true, text: 'never' };
      },
      abortThread: () => {},
      settleAll: () => {}
    });
    worker.currentTurn = newTurnContext('t', 'turn-1');
    worker.currentTurn.isMail = true;
    worker.currentTurn.isScheduled = true;
    internal.handleHarnessBridgeRequest(
      worker,
      'elicit-1',
      JSON.stringify({ agent: 'claude', prompt: 'go', device: 'MacBook', cwd: '/anywhere' })
    );
    await settleSends(sent);
    expect(seen).toHaveLength(0);
    const answer = JSON.parse(sent[0].value) as { ok: boolean; error?: string };
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('code personas');
  });

  it('clamps a pinned mail persona to its pin: agent and device forced, cwd bounded', async () => {
    const seen: HarnessRequest[] = [];
    const { internal, worker, sent } = runtimeWithBridge({
      handleHarnessRequest: async (req) => {
        seen.push(req);
        return { ok: true, text: 'done' };
      },
      abortThread: () => {},
      settleAll: () => {}
    });
    worker.currentTurn = newTurnContext('t', 'turn-1');
    worker.currentTurn.isMail = true;
    worker.currentTurn.isScheduled = true;
    worker.currentTurn.personaHarness = { agent: 'opencode', cwd: '/repo', device: 'dev-1' };
    // The tool call tries to hop agent and machine; only the in-repo cwd survives.
    internal.handleHarnessBridgeRequest(
      worker,
      'elicit-1',
      JSON.stringify({ agent: 'claude', prompt: 'go', device: 'OtherMac', cwd: '/repo/packages/x' })
    );
    await settleSends(sent);
    expect(seen[0]).toMatchObject({ agent: 'opencode', device: 'dev-1', cwd: '/repo/packages/x' });

    // A cwd outside the pinned folder is refused without reaching the bridge.
    sent.length = 0;
    internal.handleHarnessBridgeRequest(
      worker,
      'elicit-2',
      JSON.stringify({ agent: 'claude', prompt: 'go', cwd: '/etc' })
    );
    await settleSends(sent);
    expect(seen).toHaveLength(1);
    const refused = JSON.parse(sent[0].value) as { ok: boolean; error?: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('pinned');
  });

  it("carries the persona's model pin only when the pinned agent is the one running", async () => {
    const seen: HarnessRequest[] = [];
    const { internal, worker, sent } = runtimeWithBridge({
      handleHarnessRequest: async (req) => {
        seen.push(req);
        return { ok: true, text: 'done' };
      },
      abortThread: () => {},
      settleAll: () => {}
    });
    worker.currentTurn = newTurnContext('t', 'turn-1');
    worker.currentTurn.personaHarness = { agent: 'claude', cwd: '/repo', model: 'claude-haiku-4-5' };
    // A chat turn with no agent named: the pin fills agent AND model.
    internal.handleHarnessBridgeRequest(worker, 'elicit-1', JSON.stringify({ prompt: 'go' }));
    await settleSends(sent);
    expect(seen[0]).toMatchObject({ agent: 'claude', model: 'claude-haiku-4-5' });

    // A chat turn that names a different agent: a claude model id means nothing to it.
    sent.length = 0;
    internal.handleHarnessBridgeRequest(worker, 'elicit-2', JSON.stringify({ agent: 'opencode', prompt: 'go' }));
    await settleSends(sent);
    expect(seen[1].agent).toBe('opencode');
    expect(seen[1].model).toBeUndefined();

    // Under the mail clamp the pinned agent always runs, so the model always rides.
    sent.length = 0;
    worker.currentTurn.isMail = true;
    worker.currentTurn.isScheduled = true;
    internal.handleHarnessBridgeRequest(worker, 'elicit-3', JSON.stringify({ agent: 'opencode', prompt: 'go' }));
    await settleSends(sent);
    expect(seen[2]).toMatchObject({ agent: 'claude', model: 'claude-haiku-4-5', cwd: '/repo' });

    // The tool payload itself cannot pick a model.
    sent.length = 0;
    worker.currentTurn.personaHarness = undefined;
    worker.currentTurn.isMail = false;
    worker.currentTurn.isScheduled = false;
    internal.handleHarnessBridgeRequest(worker, 'elicit-4', JSON.stringify({ agent: 'claude', prompt: 'go', model: 'claude-opus-5' }));
    await settleSends(sent);
    expect(seen[3].model).toBeUndefined();
  });

  it('answers honestly when no bridge is wired', async () => {
    const { internal, worker, sent } = runtimeWithBridge(null);
    internal.handleHarnessBridgeRequest(worker, 'elicit-1', JSON.stringify({ agent: 'claude', prompt: 'go' }));
    await settleSends(sent);
    expect(JSON.parse(sent[0].value)).toMatchObject({ ok: false });
  });

  it('refuses to answer a replaced process', async () => {
    let release: (() => void) | null = null;
    const { internal, worker, sent } = runtimeWithBridge({
      handleHarnessRequest: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, text: 'late' });
        }),
      abortThread: () => {},
      settleAll: () => {}
    });
    internal.handleHarnessBridgeRequest(worker, 'elicit-1', JSON.stringify({ agent: 'claude', prompt: 'go' }));
    // The pi child restarts while the harness turn runs; the reply must not
    // land on the new process's unrelated elicitation table.
    worker.proc = { send: () => {} };
    await new Promise((resolve) => setTimeout(resolve, 0));
    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(0);
  });
});
