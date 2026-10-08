// The `computer` tool, both halves and the seam between them:
//
//  - the extension side: the tool registers, refuses without the gate, maps
//    Anthropic-shaped calls to helper actions, raises exactly one sentinel
//    elicitation, and renders the answer as text + an image block;
//  - the runtime side (PiRuntime.handleComputerBridgeRequest): the Mac comes
//    from the persona's computer pin on the live turn, never from the payload,
//    and an unpinned turn is refused before the bridge.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPUTER_BRIDGE_TITLE } from '../../src/server/pi/protocol';
import { PiRuntime } from '../../src/server/pi/runtime';
import { newTurnContext } from '../../src/server/pi/normalize';
import type { ComputerBridge, ComputerRequest } from '../../src/server/backend/types';

const configDir = mkdtempSync(join(tmpdir(), 'stem-computer-bridge-'));
writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ servers: {} }));
process.env.STEM_MCP_CONFIG = join(configDir, 'mcp.json');

const { default: stemMcpBridge, computerActionFrom } =
  await import('../../src/server/pi/stem-mcp-extension.mjs');

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
  ) => Promise<{
    content: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    isError?: boolean;
  }>;
}

async function registeredComputer(): Promise<RegisteredTool> {
  const registered: RegisteredTool[] = [];
  const fakePi = {
    registerTool: (tool: RegisteredTool) => registered.push(tool),
    on: () => {},
    getActiveTools: () => [] as string[],
    setActiveTools: () => {}
  };
  await stemMcpBridge(fakePi);
  const tool = registered.find((t) => t.name === 'computer');
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
function gate(computer: boolean): void {
  writeFileSync(gatePath, JSON.stringify({ mail: false, scheduled: false, computer }));
}

describe('computerActionFrom', () => {
  it('maps the Anthropic shape to helper actions', () => {
    expect(computerActionFrom({ action: 'screenshot' })).toEqual({
      ok: true,
      action: { kind: 'screenshot' }
    });
    expect(computerActionFrom({ action: 'left_click', coordinate: [10.4, 20] })).toEqual({
      ok: true,
      action: { kind: 'click', x: 10, y: 20, button: 'left', count: 1 }
    });
    expect(computerActionFrom({ action: 'double_click' })).toEqual({
      ok: true,
      action: { kind: 'click', button: 'left', count: 2 }
    });
    expect(computerActionFrom({ action: 'right_click', coordinate: [1, 1] })).toMatchObject({
      action: { button: 'right' }
    });
    expect(
      computerActionFrom({
        action: 'left_click_drag',
        start_coordinate: [1, 2],
        coordinate: [3, 4]
      })
    ).toEqual({
      ok: true,
      action: { kind: 'drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }
    });
    expect(
      computerActionFrom({
        action: 'scroll',
        coordinate: [5, 5],
        scroll_direction: 'up',
        scroll_amount: 99
      })
    ).toEqual({
      ok: true,
      action: { kind: 'scroll', x: 5, y: 5, dir: 'up', amount: 50 }
    });
    expect(computerActionFrom({ action: 'key', text: ' cmd+shift+t ' })).toEqual({
      ok: true,
      action: { kind: 'key', combo: 'cmd+shift+t' }
    });
    expect(computerActionFrom({ action: 'hold_key', text: 'shift', duration: 99 })).toEqual({
      ok: true,
      action: { kind: 'hold', combo: 'shift', ms: 5000 }
    });
    expect(computerActionFrom({ action: 'wait', duration: 2 })).toEqual({
      ok: true,
      action: { kind: 'wait', ms: 2000 }
    });
    expect(computerActionFrom({ action: 'zoom', region: [1, 2, 30, 40] })).toEqual({
      ok: true,
      action: { kind: 'zoom', x: 1, y: 2, w: 30, h: 40 }
    });
  });

  it('maps the window-mode actions, and refuses them without their ids', () => {
    expect(computerActionFrom({ action: 'list_windows' })).toEqual({ ok: true, action: { kind: 'list_windows' } });
    expect(computerActionFrom({ action: 'select_window', window_id: 42 })).toEqual({
      ok: true,
      action: { kind: 'select_window', windowId: 42 }
    });
    expect(computerActionFrom({ action: 'select_window', app: ' Discord ', title: '#test' })).toEqual({
      ok: true,
      action: { kind: 'select_window', app: 'Discord', title: '#test' }
    });
    // No arguments = back to the whole screen.
    expect(computerActionFrom({ action: 'select_window' })).toEqual({ ok: true, action: { kind: 'select_window' } });
    expect(computerActionFrom({ action: 'snapshot', depth: 99 })).toEqual({
      ok: true,
      action: { kind: 'snapshot', depth: 30 }
    });
    expect(computerActionFrom({ action: 'press', element_id: 7 })).toEqual({ ok: true, action: { kind: 'press', id: 7 } });
    expect(computerActionFrom({ action: 'focus', element_id: 0 })).toEqual({ ok: true, action: { kind: 'focus', id: 0 } });
    expect(computerActionFrom({ action: 'menu', element_id: 3 })).toEqual({ ok: true, action: { kind: 'menu', id: 3 } });
    expect(computerActionFrom({ action: 'set_value', element_id: 3, text: '' })).toEqual({
      ok: true,
      action: { kind: 'set_value', id: 3, text: '' }
    });
    expect(computerActionFrom({ action: 'press' }).ok).toBe(false);
    expect(computerActionFrom({ action: 'press', element_id: 1.5 }).ok).toBe(false);
    expect(computerActionFrom({ action: 'set_value', element_id: 1 }).ok).toBe(false);
  });

  it('refuses what the helper could not do', () => {
    expect(computerActionFrom({ action: 'teleport' }).ok).toBe(false);
    expect(computerActionFrom({ action: 'mouse_move' }).ok).toBe(false);
    expect(computerActionFrom({ action: 'left_click', coordinate: [-1, 5] }).ok).toBe(false);
    expect(computerActionFrom({ action: 'left_click', coordinate: [1] }).ok).toBe(false);
    expect(computerActionFrom({ action: 'type' }).ok).toBe(false);
    expect(computerActionFrom({ action: 'scroll', scroll_direction: 'sideways' }).ok).toBe(false);
    expect(computerActionFrom({ action: 'zoom', region: [1, 2] }).ok).toBe(false);
  });
});

describe('extension side', () => {
  it('lists every action, raises one sentinel elicitation, and returns text + the image block', async () => {
    gate(true);
    try {
      const tool = await registeredComputer();
      expect(tool.parameters.properties.action.enum).toContain('left_click_drag');
      expect(tool.description).toContain('PIXELS OF THE LAST PICTURE');
      expect(tool.description).toContain('START WITH `list_windows`');
      const { asks, ctx } = scriptedCtx(() =>
        JSON.stringify({
          ok: true,
          screenshot: { jpegBase64: 'QUJD', width: 640, height: 400 },
          cursor: { x: 7, y: 8 }
        })
      );
      const result = await tool.execute!(
        'c1',
        { action: 'left_click', coordinate: [7, 8] },
        undefined,
        undefined,
        ctx
      );
      expect(asks).toHaveLength(1);
      expect(asks[0]!.title).toBe(COMPUTER_BRIDGE_TITLE);
      expect(JSON.parse(asks[0]!.payload)).toEqual({
        action: { kind: 'click', x: 7, y: 8, button: 'left', count: 1 }
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Screen 640×400 px. Cursor at (7, 8).'
      });
      expect(result.content[1]).toEqual({
        type: 'image',
        data: 'QUJD',
        mimeType: 'image/jpeg'
      });
    } finally {
      rmSync(gatePath, { force: true });
    }
  });

  it('a zoom answer is labelled as not clickable, and a refusal is an error', async () => {
    gate(true);
    try {
      const tool = await registeredComputer();
      const zoom = scriptedCtx(() =>
        JSON.stringify({
          ok: true,
          screenshot: {
            jpegBase64: 'QUJD',
            width: 1568,
            height: 800,
            zoomed: true
          },
          cursor: {}
        })
      );
      const z = await tool.execute!(
        'c',
        { action: 'zoom', region: [0, 0, 10, 10] },
        undefined,
        undefined,
        zoom.ctx
      );
      expect(z.content[0]!.text).toContain('not clickable');
      const refused = scriptedCtx(() =>
        JSON.stringify({
          ok: false,
          error: 'The user took over the computer.'
        })
      );
      const r = await tool.execute!('c', { action: 'screenshot' }, undefined, undefined, refused.ctx);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain('took over');
    } finally {
      rmSync(gatePath, { force: true });
    }
  });

  it('renders a windows list without an image, and a window frame with its target line', async () => {
    gate(true);
    try {
      const tool = await registeredComputer();
      const list = scriptedCtx(() => JSON.stringify({ ok: true, text: '12  Discord  "#test"  otherSpace' }));
      const l = await tool.execute!('c', { action: 'list_windows' }, undefined, undefined, list.ctx);
      expect(l.isError).toBeFalsy();
      expect(l.content).toHaveLength(1);
      expect(l.content[0]!.text).toContain('Discord');
      const win = scriptedCtx(() =>
        JSON.stringify({
          ok: true,
          screenshot: { jpegBase64: 'QUJD', width: 800, height: 600 },
          text: '1  textarea "Message #test" focused',
          target: { app: 'Discord', title: '#test', windowId: 12 }
        })
      );
      const w = await tool.execute!('c', { action: 'snapshot' }, undefined, undefined, win.ctx);
      expect(w.content[0]!.text).toContain('Window "#test" (Discord), 800×600 px');
      expect(w.content[0]!.text).toContain('textarea "Message #test"');
      expect(w.content[1]).toMatchObject({ type: 'image', data: 'QUJD' });
      const back = scriptedCtx(() =>
        JSON.stringify({ ok: true, screenshot: { jpegBase64: 'QUJD', width: 8, height: 6 }, cursor: { x: 1, y: 1 }, target: null })
      );
      const b = await tool.execute!('c', { action: 'select_window' }, undefined, undefined, back.ctx);
      expect(b.content[0]!.text).toContain('Screen 8×6 px');
    } finally {
      rmSync(gatePath, { force: true });
    }
  });

  it('runs `actions` in order: no picture until the last step, intermediate text kept', async () => {
    gate(true);
    try {
      const tool = await registeredComputer();
      let n = 0;
      const { asks, ctx } = scriptedCtx(() => {
        n++;
        // Step 1: a current Mac's text-only answer; step 2: an older Mac's frame
        // (ignored); step 3: the last step's picture.
        if (n === 1) return JSON.stringify({ ok: true, text: 'Done.' });
        if (n === 2)
          return JSON.stringify({
            ok: true,
            screenshot: { jpegBase64: 'T0xE', width: 1, height: 1 },
            text: 'A new DaVinci Resolve window opened: 77 "Import Media".'
          });
        return JSON.stringify({ ok: true, screenshot: { jpegBase64: 'QUJD', width: 640, height: 400 }, cursor: { x: 1, y: 2 } });
      });
      const result = await tool.execute!(
        'c',
        {
          actions: [
            { action: 'key', text: 'Home' },
            { action: 'double_click', coordinate: [512, 300] },
            { action: 'key', text: 'F9' }
          ]
        },
        undefined,
        undefined,
        ctx
      );
      expect(asks.map((a) => JSON.parse(a.payload))).toEqual([
        { action: { kind: 'key', combo: 'Home' }, shot: false },
        { action: { kind: 'click', x: 512, y: 300, button: 'left', count: 2 }, shot: false },
        { action: { kind: 'key', combo: 'F9' } }
      ]);
      expect(result.isError).toBeFalsy();
      const text = result.content[0]!.text!;
      expect(text).toContain('Ran 3 steps in order: 1. key "Home", 2. double_click (512, 300), 3. key "F9"');
      expect(text).toContain('Step 2 (double_click (512, 300)):\nA new DaVinci Resolve window opened');
      expect(text).not.toContain('Done.');
      expect(text).toContain('Screen 640×400 px');
      expect(result.content).toHaveLength(2);
      expect(result.content[1]).toMatchObject({ type: 'image', data: 'QUJD' });
    } finally {
      rmSync(gatePath, { force: true });
    }
  });

  it('a failed step stops the batch, says what was done, and shows one picture of the state', async () => {
    gate(true);
    try {
      const tool = await registeredComputer();
      const { asks, ctx } = scriptedCtx((_t, payload) => {
        const kind = JSON.parse(payload).action.kind;
        if (kind === 'press') return JSON.stringify({ ok: false, error: 'press 4: the control is gone; take a new snapshot.' });
        if (kind === 'screenshot')
          return JSON.stringify({ ok: true, screenshot: { jpegBase64: 'Tk9X', width: 8, height: 6 }, cursor: { x: 0, y: 0 } });
        return JSON.stringify({ ok: true, text: 'Done.' });
      });
      const result = await tool.execute!(
        'c',
        {
          actions: [
            { action: 'key', text: 'Home' },
            { action: 'press', element_id: 4 },
            { action: 'key', text: 'F9' }
          ]
        },
        undefined,
        undefined,
        ctx
      );
      expect(asks.map((a) => JSON.parse(a.payload).action.kind)).toEqual(['key', 'press', 'screenshot']);
      expect(result.isError).toBe(true);
      const text = result.content[0]!.text!;
      expect(text).toContain('Step 2 of 3 (press 4) failed: press 4: the control is gone');
      expect(text).toContain('Done before it: 1. key "Home". Not run: 3. key "F9".');
      expect(text).toContain('Screen 8×6 px');
      expect(result.content[1]).toMatchObject({ type: 'image', data: 'Tk9X' });
    } finally {
      rmSync(gatePath, { force: true });
    }
  });

  it('the user taking over mid-batch stops dead: no further step, no picture', async () => {
    gate(true);
    try {
      const tool = await registeredComputer();
      const { asks, ctx } = scriptedCtx((_t, payload) =>
        JSON.parse(payload).action.kind === 'type'
          ? JSON.stringify({ ok: false, error: 'The user took over the computer.', aborted: true })
          : JSON.stringify({ ok: true, text: 'Done.' })
      );
      const result = await tool.execute!(
        'c',
        { actions: [{ action: 'key', text: 'cmd+l' }, { action: 'type', text: 'hello' }, { action: 'key', text: 'Return' }] },
        undefined,
        undefined,
        ctx
      );
      expect(asks).toHaveLength(2);
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.text).toContain('Step 2 of 3 (type "hello") failed: The user took over');
      expect(result.content[0]!.text).toContain('Done before it: 1. key "cmd+l"');
    } finally {
      rmSync(gatePath, { force: true });
    }
  });

  it('checks every step before running any: both forms, too many, a look mid-batch, a bad step', async () => {
    gate(true);
    try {
      const tool = await registeredComputer();
      const { asks, ctx } = scriptedCtx(() => JSON.stringify({ ok: true, text: 'Done.' }));
      const run = (params: Record<string, unknown>) => tool.execute!('c', params, undefined, undefined, ctx);
      expect((await run({ action: 'screenshot', actions: [{ action: 'screenshot' }] })).content[0]!.text).toContain(
        'not both'
      );
      expect((await run({})).content[0]!.text).toContain('`actions`');
      const eleven = Array.from({ length: 11 }, () => ({ action: 'key', text: 'Down' }));
      expect((await run({ actions: eleven })).content[0]!.text).toContain('at most 10');
      expect(
        (await run({ actions: [{ action: 'zoom', region: [0, 0, 5, 5] }, { action: 'key', text: 'a' }] })).content[0]!.text
      ).toContain('zoom only as the last step');
      const bad = await run({ actions: [{ action: 'key', text: 'Home' }, { action: 'left_click', coordinate: [1] }] });
      expect(bad.isError).toBe(true);
      expect(bad.content[0]!.text).toContain('Step 2 (left_click): coordinate must be [x, y].');
      expect(asks).toHaveLength(0);
      // A zoom as the last step is fine.
      await run({ actions: [{ action: 'key', text: 'Home' }, { action: 'zoom', region: [0, 0, 5, 5] }] });
      expect(asks).toHaveLength(2);
    } finally {
      rmSync(gatePath, { force: true });
    }
  });

  it('refuses up front when the gate says no computer pin — and when the gate is absent', async () => {
    gate(false);
    try {
      const tool = await registeredComputer();
      const { asks, ctx } = scriptedCtx(() => JSON.stringify({ ok: true }));
      const result = await tool.execute!('c', { action: 'screenshot' }, undefined, undefined, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('computer pin');
      expect(result.content[0]!.text).toContain('Settings → Features');
      expect(asks).toHaveLength(0);
      // An older main that never wrote the field: the tool stays shut (unlike coding).
      writeFileSync(gatePath, JSON.stringify({ mail: true }));
      const absent = await tool.execute!('c', { action: 'screenshot' }, undefined, undefined, ctx);
      expect(absent.isError).toBe(true);
      expect(asks).toHaveLength(0);
    } finally {
      rmSync(gatePath, { force: true });
    }
  });
});

describe('runtime side', () => {
  function runtimeWithBridge(bridge: ComputerBridge | null) {
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
      handleComputerBridgeRequest: (worker: unknown, id: string, payload: string | undefined) => void;
    };
    worker.proc = { send: (m) => sent.push(m) };
    runtime.setComputerBridge(bridge);
    return { internal, worker, sent };
  }

  async function settleSends(sent: unknown[]): Promise<void> {
    for (let i = 0; i < 20 && sent.length === 0; i++) await Promise.resolve();
  }

  it('takes the Mac from the persona pin and the thread from the live turn, never from the payload', async () => {
    const seen: ComputerRequest[] = [];
    const { internal, worker, sent } = runtimeWithBridge({
      handleComputerRequest: async (req) => {
        seen.push(req);
        return {
          ok: true,
          screenshot: { jpegBase64: 'QUJD', width: 1, height: 1 },
          cursor: { x: 0, y: 0 }
        };
      },
      resolveNamedMac: async () => ({ ok: false, error: 'never' }),
      endThread: () => {},
      settleAll: () => {}
    });
    worker.currentTurn = newTurnContext('the-real-thread', 'turn-1');
    worker.currentTurn.isScheduled = true;
    worker.currentTurn.computerGrant = { kind: 'pin', device: 'mac-1' };
    internal.handleComputerBridgeRequest(
      worker,
      'elicit-1',
      JSON.stringify({
        action: { kind: 'screenshot' },
        device: 'mac-forged',
        threadId: 'forged'
      })
    );
    await settleSends(sent);
    expect(seen[0]).toEqual({
      device: 'mac-1',
      threadId: 'the-real-thread',
      action: { kind: 'screenshot' }
    });
    expect(JSON.parse(sent[0]!.value)).toMatchObject({ ok: true });
    expect(sent[0]!.id).toBe('elicit-1');
  });

  it('forwards shot: false for a step in the middle of a batch, and only then', async () => {
    const seen: ComputerRequest[] = [];
    const { internal, worker, sent } = runtimeWithBridge({
      handleComputerRequest: async (req) => {
        seen.push(req);
        return { ok: true, text: 'Done.' };
      },
      resolveNamedMac: async () => ({ ok: false, error: 'never' }),
      endThread: () => {},
      settleAll: () => {}
    });
    worker.currentTurn = newTurnContext('t', 'turn-1');
    worker.currentTurn.computerGrant = { kind: 'pin', device: 'mac-1' };
    internal.handleComputerBridgeRequest(worker, 'e1', JSON.stringify({ action: { kind: 'key', combo: 'a' }, shot: false }));
    await settleSends(sent);
    internal.handleComputerBridgeRequest(worker, 'e2', JSON.stringify({ action: { kind: 'key', combo: 'b' }, shot: 'no' }));
    for (let i = 0; i < 20 && sent.length < 2; i++) await Promise.resolve();
    expect(seen[0]).toEqual({ device: 'mac-1', threadId: 't', action: { kind: 'key', combo: 'a' }, shot: false });
    expect(seen[1]).toEqual({ device: 'mac-1', threadId: 't', action: { kind: 'key', combo: 'b' } });
  });

  it('refuses a turn with no computer pin before the bridge, in any turn kind', async () => {
    const seen: ComputerRequest[] = [];
    const { internal, worker, sent } = runtimeWithBridge({
      handleComputerRequest: async (req) => {
        seen.push(req);
        return { ok: false, error: 'never' };
      },
      resolveNamedMac: async () => ({ ok: false, error: 'never' }),
      endThread: () => {},
      settleAll: () => {}
    });
    worker.currentTurn = newTurnContext('t', 'turn-1');
    worker.currentTurn.codingGrant = { kind: 'pin', pin: {
      agent: 'claude',
      cwd: '/repo',
      device: 'mac-1'
    } }; // a code pin is not a computer pin
    internal.handleComputerBridgeRequest(
      worker,
      'elicit-1',
      JSON.stringify({ action: { kind: 'screenshot' } })
    );
    await settleSends(sent);
    expect(seen).toHaveLength(0);
    expect(JSON.parse(sent[0]!.value)).toMatchObject({
      ok: false,
      error: expect.stringContaining('not available')
    });
    sent.length = 0;
    worker.currentTurn.isMail = true;
    worker.currentTurn.computerRefusal = 'runs as the persona “Critic”, which controls no computer';
    internal.handleComputerBridgeRequest(
      worker,
      'elicit-2',
      JSON.stringify({ action: { kind: 'screenshot' } })
    );
    await settleSends(sent);
    expect(seen).toHaveLength(0);
    expect(JSON.parse(sent[0]!.value)).toMatchObject({ ok: false, error: expect.stringContaining('Critic') });
  });

  it('a plain chat with a fixed Mac drives that Mac, whatever the payload names', async () => {
    const seen: ComputerRequest[] = [];
    const { internal, worker, sent } = runtimeWithBridge({
      handleComputerRequest: async (req) => {
        seen.push(req);
        return { ok: true, screenshot: { jpegBase64: 'QUJD', width: 1, height: 1 }, cursor: { x: 0, y: 0 } };
      },
      resolveNamedMac: async () => ({ ok: true, deviceId: 'never' }),
      endThread: () => {},
      settleAll: () => {}
    });
    worker.currentTurn = newTurnContext('t', 'turn-1');
    worker.currentTurn.computerGrant = { kind: 'chat', device: 'mac-1' };
    internal.handleComputerBridgeRequest(
      worker,
      'elicit-1',
      JSON.stringify({ action: { kind: 'screenshot' }, device: 'Other Mac' })
    );
    await settleSends(sent);
    expect(seen[0]).toMatchObject({ device: 'mac-1' });
  });

  it('a model-chooses chat resolves the named Mac through the bridge, and passes on its refusal', async () => {
    const seen: ComputerRequest[] = [];
    const named: string[] = [];
    const { internal, worker, sent } = runtimeWithBridge({
      handleComputerRequest: async (req) => {
        seen.push(req);
        return { ok: true, screenshot: { jpegBase64: 'QUJD', width: 1, height: 1 }, cursor: { x: 0, y: 0 } };
      },
      resolveNamedMac: async (name) => {
        named.push(name);
        return name === 'MacBook'
          ? { ok: true, deviceId: 'mac-1' }
          : { ok: false, error: `“${name}” is not connected right now.` };
      },
      endThread: () => {},
      settleAll: () => {}
    });
    const wait = async () => {
      for (let i = 0; i < 200 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
    };
    worker.currentTurn = newTurnContext('t', 'turn-1');
    worker.currentTurn.computerGrant = { kind: 'chat', device: null };
    internal.handleComputerBridgeRequest(
      worker,
      'elicit-1',
      JSON.stringify({ action: { kind: 'screenshot' }, device: 'MacBook' })
    );
    await wait();
    expect(seen[0]).toMatchObject({ device: 'mac-1' });

    sent.length = 0;
    internal.handleComputerBridgeRequest(
      worker,
      'elicit-2',
      JSON.stringify({ action: { kind: 'screenshot' }, device: 'Studio' })
    );
    await wait();
    expect(seen).toHaveLength(1);
    expect(JSON.parse(sent[0]!.value).error).toContain('not connected');

    sent.length = 0;
    internal.handleComputerBridgeRequest(worker, 'elicit-3', JSON.stringify({ action: { kind: 'screenshot' } }));
    await wait();
    expect(JSON.parse(sent[0]!.value).error).toContain('Name the Mac');
    expect(named).toEqual(['MacBook', 'Studio']);
  });
});
