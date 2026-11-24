// Image generation on the ChatGPT subscription (generate_image):
//
//  - the pure half (image-gen.mjs): the Codex request body, the SSE parser,
//    the dispatcher model pick, image lookup by id and the context stubbing;
//  - the bridge tool: hidden and refused without the turn-context gate, one
//    Codex call with the openai-codex login only, the picture returned as an
//    image block for the model plus a ref in details for the chat.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountIdFromJwt,
  buildImageRequest,
  dispatcherCandidates,
  findImageInEntries,
  knownImageIds,
  parseImageSse,
  pngSize,
  stubOldImages
} from '../../src/server/pi/image-gen.mjs';

const configDir = mkdtempSync(join(tmpdir(), 'stem-image-gen-'));
writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ servers: {} }));
process.env.STEM_MCP_CONFIG = join(configDir, 'mcp.json');

const { default: stemMcpBridge } = await import('../../src/server/pi/stem-mcp-extension.mjs');

// A 1×1 PNG, so pngSize has a real IHDR to read.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function jwt(accountId: string): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.sig`;
}

function sse(events: unknown[], splitAt?: number): AsyncIterable<Uint8Array> {
  const text = events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  const cut = splitAt ?? bytes.length;
  return (async function* () {
    yield bytes.slice(0, cut);
    if (cut < bytes.length) yield bytes.slice(cut);
  })();
}

const imageDone = (b64 = PNG_B64) => ({
  type: 'response.output_item.done',
  item: { type: 'image_generation_call', result: b64, revised_prompt: 'A sprout, flat icon' }
});

describe('image-gen helpers', () => {
  it('builds a request with no image model and no quality, refs as input_image', () => {
    const body = buildImageRequest({
      model: 'gpt-6-sol',
      prompt: 'a sprout',
      size: '1024x1536',
      refs: [{ mimeType: 'image/png', data: 'AAA' }]
    }) as { model: string; tools: Array<Record<string, unknown>>; input: Array<{ content: Array<Record<string, unknown>> }> };
    expect(body.model).toBe('gpt-6-sol');
    expect(body.tools).toEqual([{ type: 'image_generation', output_format: 'png', size: '1024x1536' }]);
    expect(body.input[0].content[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,AAA' });
    const auto = buildImageRequest({ model: 'm', prompt: 'p', size: 'auto' }) as { tools: Array<Record<string, unknown>> };
    expect(auto.tools[0]).not.toHaveProperty('size');
  });

  it('parses the image out of an SSE stream split mid-frame', async () => {
    const out = await parseImageSse(sse([{ type: 'response.created' }, imageDone()], 40));
    expect(out).toEqual({ b64: PNG_B64, revisedPrompt: 'A sprout, flat icon' });
  });

  it('rejects a failed response and a stream with no image', async () => {
    await expect(
      parseImageSse(sse([{ type: 'response.failed', response: { error: { message: 'usage_limit_reached' } } }]))
    ).rejects.toMatchObject({ code: 'limit' });
    await expect(parseImageSse(sse([{ type: 'response.completed' }]))).rejects.toMatchObject({ code: 'empty' });
  });

  it('reads the account id from the token and the size from the PNG', () => {
    expect(accountIdFromJwt(jwt('acct-1'))).toBe('acct-1');
    expect(accountIdFromJwt('not-a-jwt')).toBeNull();
    expect(pngSize(Buffer.from(PNG_B64, 'base64'))).toEqual({ width: 1, height: 1 });
    expect(pngSize(Buffer.from('nope'))).toBeNull();
  });

  it('picks only openai-codex dispatcher models, the chat model first', () => {
    const available = [
      { id: 'gpt-6-sol', provider: 'openai-codex' },
      { id: 'gpt-6-terra', provider: 'openai-codex' },
      { id: 'gpt-6-pro', provider: 'openai-codex' },
      { id: 'gpt-6', provider: 'openai' },
      { id: 'grok-5', provider: 'xai' }
    ];
    const ids = (ctxModel?: { id: string; provider: string }) =>
      dispatcherCandidates(ctxModel, available, null).map((m) => m.id);
    expect(ids()).toEqual(['gpt-6-terra', 'gpt-6-sol', 'gpt-6-pro']);
    expect(ids({ id: 'gpt-6-sol', provider: 'openai-codex' })[0]).toBe('gpt-6-sol');
    expect(ids({ id: 'grok-5', provider: 'xai' })).not.toContain('grok-5');
    expect(dispatcherCandidates(undefined, [{ id: 'gpt-6', provider: 'openai' }], null)).toEqual([]);
  });

  it('finds generated images and marked user attachments by id', () => {
    const entries = [
      {
        type: 'message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'edit this <!--stem:images ids="img_aaaaaaaaaa"-->' },
            { type: 'image', data: 'USER', mimeType: 'image/jpeg' }
          ]
        }
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'generate_image',
          content: [{ type: 'text', text: 'Image img_bbbbbbbbbb created' }, { type: 'image', data: 'GEN', mimeType: 'image/png' }],
          details: { stemImage: { id: 'img_bbbbbbbbbb', mime: 'image/png' } }
        }
      }
    ];
    expect(findImageInEntries(entries, 'img_aaaaaaaaaa')).toEqual({ mimeType: 'image/jpeg', data: 'USER' });
    expect(findImageInEntries(entries, 'img_bbbbbbbbbb')).toEqual({ mimeType: 'image/png', data: 'GEN' });
    expect(findImageInEntries(entries, 'img_cccccccccc')).toBeNull();
    expect(knownImageIds(entries)).toEqual(['img_aaaaaaaaaa', 'img_bbbbbbbbbb']);
  });

  it('keeps the pixels of the newest images and the current turn only', () => {
    const gen = (n: number) => ({
      role: 'toolResult',
      toolName: 'generate_image',
      content: [{ type: 'text', text: `made ${n}` }, { type: 'image', data: `D${n}`, mimeType: 'image/png' }],
      details: { stemImage: { id: `img_${String(n).repeat(10)}` } }
    });
    const messages = [gen(1), gen(2), { role: 'user', content: 'more' }, gen(3), gen(4), gen(5)];
    const out = stubOldImages(messages, 2, 1) as typeof messages;
    const hasImage = (m: (typeof messages)[number]) =>
      Array.isArray(m.content) && m.content.some((p) => (p as { type: string }).type === 'image');
    // 3–5 are after the last user message (this turn): all kept; 1–2 stubbed.
    expect(out.map(hasImage)).toEqual([false, false, false, true, true, true]);
    expect(JSON.stringify(out[0])).toContain('img_1111111111');
    const untouched = [gen(1)];
    expect(stubOldImages(untouched, 3)).toBe(untouched);
  });

  it('stubs older images in whole blocks, so the cached prefix moves once per block', () => {
    const gen = (n: number) => ({
      role: 'toolResult',
      toolName: 'generate_image',
      content: [{ type: 'image', data: `D${n}`, mimeType: 'image/png' }],
      details: { stemImage: { id: `img_${String(n % 10).repeat(10)}` } }
    });
    const hasImage = (m: { content?: unknown }) =>
      Array.isArray(m.content) && m.content.some((p) => (p as { type: string }).type === 'image');
    const turn = (count: number) => {
      const messages: Array<Record<string, unknown>> = [];
      for (let n = 1; n <= count; n++) messages.push(gen(n), { role: 'user', content: `next ${n}` });
      return (stubOldImages(messages, 3, 4) as typeof messages).filter((m) => m.role === 'toolResult').map(hasImage);
    };
    // Up to keep + block - 1 = 6 images keep their pixels; the 7th stubs the oldest four at once.
    expect(turn(6)).toEqual([true, true, true, true, true, true]);
    expect(turn(7)).toEqual([false, false, false, false, true, true, true]);
    expect(turn(10)).toEqual([false, false, false, false, true, true, true, true, true, true]);
  });
});

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details?: { stemImage?: Record<string, unknown> };
  isError?: boolean;
}
interface RegisteredTool {
  name: string;
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<ToolResult>;
}

async function bridge() {
  const registered: RegisteredTool[] = [];
  const handlers: Record<string, Array<(e: unknown) => unknown>> = {};
  let active: string[] = ['read', 'generate_image'];
  await stemMcpBridge({
    registerTool: (t: RegisteredTool) => registered.push(t),
    on: (name: string, fn: (e: unknown) => unknown) => (handlers[name] ??= []).push(fn),
    getActiveTools: () => active,
    setActiveTools: (next: string[]) => {
      active = next;
    }
  });
  const tool = registered.find((t) => t.name === 'generate_image');
  expect(tool).toBeTruthy();
  return { tool: tool!, handlers, active: () => active };
}

const gatePath = join(configDir, 'turn-context.json');
function gate(fields: Record<string, unknown>): void {
  writeFileSync(gatePath, JSON.stringify({ mail: false, scheduled: false, ...fields }));
}

function codexCtx(models = [{ id: 'gpt-6-sol', provider: 'openai-codex' }], branch: unknown[] = []) {
  const authCalls: string[] = [];
  return {
    authCalls,
    ctx: {
      model: undefined,
      modelRegistry: {
        getAvailable: () => models,
        getApiKeyAndHeaders: async (m: { id: string; provider: string }) => {
          authCalls.push(`${m.provider}/${m.id}`);
          return { ok: true, apiKey: jwt('acct-9') };
        }
      },
      sessionManager: { getBranch: () => branch }
    }
  };
}

describe('generate_image bridge tool', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is hidden from the tool set and refused when the gate says no', async () => {
    gate({ imageGen: false, imageGenRefusal: 'Image generation is switched off in Settings → Features.' });
    const { tool, handlers, active } = await bridge();
    for (const fn of handlers.turn_start ?? []) fn({});
    expect(active()).not.toContain('generate_image');
    const res = await tool.execute('t1', { prompt: 'a sprout' }, undefined, undefined, codexCtx().ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('switched off');
  });

  it('settles the tool set at before_agent_start, from gates written after the session switch', async () => {
    // Main switches the worker onto the thread (session_start) while the gate
    // still holds the previous turn's context, then writes this turn's gate.
    gate({ imageGen: false });
    const { handlers, active } = await bridge();
    for (const fn of handlers.session_start ?? []) fn({});
    expect(active()).not.toContain('generate_image');
    gate({ imageGen: true });
    // pi picks the first request's tools before turn_start; this is the last hook in time.
    for (const fn of handlers.before_agent_start ?? []) fn({});
    expect(active()).toContain('generate_image');
  });

  it('makes one Codex call and returns the image block plus a ref', async () => {
    gate({ imageGen: true });
    const { tool, handlers, active } = await bridge();
    for (const fn of handlers.turn_start ?? []) fn({});
    expect(active()).toContain('generate_image');
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers['chatgpt-account-id']).toBe('acct-9');
      expect(JSON.parse(String(init.body)).model).toBe('gpt-6-sol');
      return new Response(new TextEncoder().encode(`data: ${JSON.stringify(imageDone())}\n\n`), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { ctx, authCalls } = codexCtx([
      { id: 'gpt-6-sol', provider: 'openai-codex' },
      { id: 'gpt-6', provider: 'openai' }
    ]);
    const res = await tool.execute('t2', { prompt: 'a sprout', size: '1024x1024' }, undefined, undefined, ctx);
    expect(res.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authCalls).toEqual(['openai-codex/gpt-6-sol']);
    expect(res.content[1]).toEqual({ type: 'image', data: PNG_B64, mimeType: 'image/png' });
    const img = res.details!.stemImage!;
    expect(img.id).toMatch(/^img_[0-9a-f]{10}$/);
    expect(img).toMatchObject({ width: 1, height: 1, prompt: 'a sprout', revisedPrompt: 'A sprout, flat icon' });
    expect(res.content[0].text).toContain(String(img.id));
  });

  it('passes a referenced image and names the known ids for an unknown one', async () => {
    gate({ imageGen: true });
    const { tool } = await bridge();
    const branch = [
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'generate_image',
          content: [{ type: 'image', data: 'PREV', mimeType: 'image/png' }],
          details: { stemImage: { id: 'img_0123456789' } }
        }
      }
    ];
    const missing = await tool.execute('t3', { prompt: 'x', references: ['img_ffffffffff'] }, undefined, undefined, codexCtx(undefined, branch).ctx);
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('img_0123456789');
    let body: { input: Array<{ content: Array<{ image_url?: string }> }> } | null = null;
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(`data: ${JSON.stringify(imageDone())}\n\n`, { status: 200 });
    });
    const res = await tool.execute('t4', { prompt: 'darker', references: ['img_0123456789'] }, undefined, undefined, codexCtx(undefined, branch).ctx);
    expect(res.isError).toBeFalsy();
    expect(body!.input[0].content[1].image_url).toBe('data:image/png;base64,PREV');
  });

  it('asks Stem for references the session cannot resolve, and keeps their order', async () => {
    gate({ imageGen: true });
    const { tool } = await bridge();
    const branch = [
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'generate_image',
          content: [{ type: 'image', data: 'PREV', mimeType: 'image/png' }],
          details: { stemImage: { id: 'img_0123456789' } }
        }
      }
    ];
    const asked: Array<{ title: string; payload: string }> = [];
    const base = codexCtx(undefined, branch).ctx;
    const ctx = {
      ...base,
      ui: {
        input: async (title: string, payload: string) => {
          asked.push({ title, payload });
          return JSON.stringify({ ok: true, images: [{ ref: 'public/art/sword.png', mimeType: 'image/png', data: 'FILE' }] });
        }
      }
    };
    let body: { input: Array<{ content: Array<{ image_url?: string }> }> } | null = null;
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(`data: ${JSON.stringify(imageDone())}\n\n`, { status: 200 });
    });
    const res = await tool.execute('t6', { prompt: 'fix the hand', references: ['public/art/sword.png', 'img_0123456789'] }, undefined, undefined, ctx);
    expect(res.isError).toBeFalsy();
    expect(asked).toEqual([{ title: 'stem-image-ref-bridge', payload: JSON.stringify({ refs: ['public/art/sword.png'] }) }]);
    expect(body!.input[0].content[1].image_url).toBe('data:image/png;base64,FILE');
    expect(body!.input[0].content[2].image_url).toBe('data:image/png;base64,PREV');

    const refused = await tool.execute(
      't7',
      { prompt: 'x', references: ['/etc/secret.png'] },
      undefined,
      undefined,
      { ...base, ui: { input: async () => JSON.stringify({ ok: false, error: '“/etc/secret.png” is outside the files Stem may reference.' }) } }
    );
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('outside the files Stem may reference');
  });

  it('retries once with the next model when the account rejects one', async () => {
    gate({ imageGen: true });
    const { tool } = await bridge();
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model as string;
      seen.push(model);
      if (seen.length === 1) return new Response('{"detail":"The model is not supported when using Codex with a ChatGPT account."}', { status: 400 });
      return new Response(`data: ${JSON.stringify(imageDone())}\n\n`, { status: 200 });
    });
    const res = await tool.execute(
      't5',
      { prompt: 'x' },
      undefined,
      undefined,
      codexCtx([
        { id: 'gpt-6-terra', provider: 'openai-codex' },
        { id: 'gpt-6-sol', provider: 'openai-codex' }
      ]).ctx
    );
    expect(res.isError).toBeFalsy();
    // Whichever went first (the last model that worked leads), the retry used the other.
    expect(new Set(seen)).toEqual(new Set(['gpt-6-terra', 'gpt-6-sol']));
  });

  it('answers "Stopped" when the turn is aborted mid-request', async () => {
    gate({ imageGen: true });
    const { tool } = await bridge();
    const ac = new AbortController();
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) => {
      ac.abort();
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError', signal: init.signal }));
    });
    const res = await tool.execute('t6', { prompt: 'x' }, ac.signal, undefined, codexCtx().ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^Stopped/);
  });

  it('is refused for a code persona even with the gate on', async () => {
    gate({ imageGen: true, relay: true });
    const { handlers } = await bridge();
    const verdicts = (handlers.tool_call ?? []).map((fn) => fn({ toolName: 'generate_image', input: {} }));
    expect(verdicts.some((v) => (v as { block?: boolean } | undefined)?.block)).toBe(true);
  });
});
