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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_BRIDGE_TITLE } from '../../src/server/pi/protocol';
import { PiRuntime } from '../../src/server/pi/runtime';
import { newTurnContext } from '../../src/server/pi/normalize';
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
      fresh_session: true
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
    const internal = runtime as unknown as {
      proc: { send: (m: { id: string; value: string }) => void } | null;
      currentTurn: ReturnType<typeof newTurnContext> | null;
      handleHarnessBridgeRequest: (id: string, payload: string | undefined) => void;
    };
    internal.proc = { send: (m) => sent.push(m) };
    runtime.setHarnessBridge(bridge);
    return { internal, sent };
  }

  async function settleSends(sent: unknown[]): Promise<void> {
    // The handler answers asynchronously; a couple of microtask turns suffice.
    for (let i = 0; i < 20 && sent.length === 0; i++) await Promise.resolve();
  }

  it('injects the live turn identity and never trusts the payload', async () => {
    const seen: HarnessRequest[] = [];
    const { internal, sent } = runtimeWithBridge({
      handleHarnessRequest: async (req) => {
        seen.push(req);
        return { ok: true, text: 'done' };
      },
      abortThread: () => {},
      settleAll: () => {}
    });
    internal.currentTurn = newTurnContext('the-real-thread', 'turn-1');
    internal.currentTurn.isScheduled = true;
    internal.handleHarnessBridgeRequest(
      'elicit-1',
      JSON.stringify({ agent: 'claude', prompt: 'go', threadId: 'forged-thread', isScheduled: false })
    );
    await settleSends(sent);
    expect(seen[0]).toMatchObject({ agent: 'claude', threadId: 'the-real-thread', isScheduled: true });
    expect(JSON.parse(sent[0].value)).toEqual({ ok: true, text: 'done' });
    expect(sent[0].id).toBe('elicit-1');
  });

  it('answers honestly when no bridge is wired', async () => {
    const { internal, sent } = runtimeWithBridge(null);
    internal.handleHarnessBridgeRequest('elicit-1', JSON.stringify({ agent: 'claude', prompt: 'go' }));
    await settleSends(sent);
    expect(JSON.parse(sent[0].value)).toMatchObject({ ok: false });
  });

  it('refuses to answer a replaced process', async () => {
    let release: (() => void) | null = null;
    const { internal, sent } = runtimeWithBridge({
      handleHarnessRequest: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, text: 'late' });
        }),
      abortThread: () => {},
      settleAll: () => {}
    });
    internal.handleHarnessBridgeRequest('elicit-1', JSON.stringify({ agent: 'claude', prompt: 'go' }));
    // The pi child restarts while the harness turn runs; the reply must not
    // land on the new process's unrelated elicitation table.
    internal.proc = { send: () => {} };
    await new Promise((resolve) => setTimeout(resolve, 0));
    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(0);
  });
});
