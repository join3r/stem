// The transport itself, driven over a real loopback socket: the bearer token,
// the request-origin (DNS-rebinding) check, the reuse of the IPC arg-spec table,
// the body cap, and SSE framing/fan-out. The handlers under /rpc are registered
// through the real registerServer, so this exercises the same registry the app
// uses.
//
// This file began as the phone's half of the wire, back when a curated allowlist
// and a per-channel args/result policy sat between a token and the registry.
// Those went with the phone role; what they were layered on top of did not, and
// it is what is checked here. transport.test.ts drives the same server from the
// desktop proxy's side, i.e. through the real client.
import { request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ipcMain } from '../electron-stub';
import { registerServer } from '../../src/server/ipc';
import { dispatchLocal, serverChannels } from '../../src/server/ipc/guard';
import { stageUpload } from '../../src/server/files/staging';
import { resolveDownload } from '../../src/server/startup/transport';
import { hashEquals, hashToken, requestOriginProblem } from '../../src/server/transport/auth';
import {
  MAX_UPLOAD_BYTES,
  startTransportServer,
  type TransportServer
} from '../../src/server/transport/server';
import type { DeviceKind } from '../../src/shared/types';

const TOKEN = 'a'.repeat(64);
const TOKEN_HASH = hashToken(TOKEN);
/** A second device, so revocation has something it must NOT disturb. */
const OTHER_TOKEN = 'c'.repeat(64);
const OTHER_HASH = hashToken(OTHER_TOKEN);

/** Codes the fake `pair` will honour, so /pair can be driven without the store. */
const PAIR_CODES = new Map<string, { deviceId: string; token: string }>();
/** What each redemption claimed to be — the route's job is to pass this on intact. */
const pairedKinds: DeviceKind[] = [];

let server: TransportServer;
let base: string;
/** The throwaway Files folder from setup-unit.ts — what GET /files may serve. */
const filesDir = process.env.STEM_FILES_DIR!;
/** Channels the fake handlers saw, so we can prove a rejected call never lands. */
const calls: { channel: string; args: unknown[] }[] = [];

beforeAll(async () => {
  registerServer('backend:startTurn', (_e, input) => {
    calls.push({ channel: 'backend:startTurn', args: [input] });
    return { threadId: 't-1', turnId: 'turn-1' };
  });
  registerServer('memory:forget', (_e, id) => {
    calls.push({ channel: 'memory:forget', args: [id] });
    return true;
  });
  registerServer('chats:list', () => {
    calls.push({ channel: 'chats:list', args: [] });
    throw new Error('pi is not running');
  });
  server = await startTransportServer({
    port: 0,
    authenticate: (presented) => {
      if (typeof presented !== 'string' || !presented) return null;
      const hash = hashToken(presented);
      if (hashEquals(TOKEN_HASH, hash)) return { id: 'dev-1', role: 'device' };
      if (hashEquals(OTHER_HASH, hash)) return { id: 'dev-2', role: 'device' };
      return null;
    },
    dispatch: dispatchLocal,
    registeredChannels: serverChannels,
    pair: async (code, kind) => {
      pairedKinds.push(kind);
      const grant = PAIR_CODES.get(code.toUpperCase());
      if (!grant) throw Object.assign(new Error('that pairing code is not valid'), { status: 401 });
      PAIR_CODES.delete(code.toUpperCase());
      return grant;
    },
    // The real staging store and the real download resolver, wired exactly as
    // startTransport wires them — the point of the two file routes is what they
    // are connected to, and a fake on either end would test the plumbing only.
    stageUpload,
    openDownload: resolveDownload
  });
  base = `http://127.0.0.1:${server.port}`;

  mkdirSync(join(filesDir, 'Recipes'), { recursive: true });
  writeFileSync(join(filesDir, 'Recipes', 'cake.pdf'), 'chocolate');
});

afterAll(async () => {
  await server.close();
  ipcMain.removeHandler('backend:startTurn');
  ipcMain.removeHandler('memory:forget');
  ipcMain.removeHandler('chats:list');
});

/**
 * A request node:http sends verbatim. `fetch` normalizes the path (`/../x` →
 * `/x`) and refuses to let a caller set Host, so the two things the origin check
 * and the traversal guard actually defend against are unreachable through it.
 */
function raw(
  path: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolveRaw, rejectRaw) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: server.port, path, method: body === undefined ? 'GET' : 'POST', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => resolveRaw({ status: res.statusCode ?? 0, body: text }));
      }
    );
    req.on('error', rejectRaw);
    req.end(body);
  });
}

function rpc(body: unknown, init: { token?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...init.headers };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  return fetch(`${base}/rpc`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('POST /rpc auth', () => {
  it('rejects an absent or wrong token and accepts the right one', async () => {
    const before = calls.length;

    const anonymous = await rpc({ channel: 'backend:startTurn', args: [{ input: 'hi' }] }, { token: null });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ ok: false, error: 'unauthorized' });

    const wrong = await rpc({ channel: 'backend:startTurn', args: [{ input: 'hi' }] }, { token: 'b'.repeat(64) });
    expect(wrong.status).toBe(401);

    // A token of a different length must be refused, not throw out of
    // timingSafeEqual (which rejects mismatched lengths).
    const short = await rpc({ channel: 'backend:startTurn', args: [{ input: 'hi' }] }, { token: 'abc' });
    expect(short.status).toBe(401);

    expect(calls.length).toBe(before); // no rejected call reached a handler

    const ok = await rpc({ channel: 'backend:startTurn', args: [{ input: 'hi' }] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, result: { threadId: 't-1', turnId: 'turn-1' } });
    expect(calls.at(-1)).toEqual({ channel: 'backend:startTurn', args: [{ input: 'hi' }] });
  });

  it('does not accept the token as a query parameter', async () => {
    // It used to, because the phone's EventSource could not set headers. Nothing
    // needs it now, and a credential in a URL is a credential in an access log
    // the moment a reverse proxy is put in front — so the query form is refused
    // rather than merely unused.
    const res = await fetch(`${base}/rpc?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'chats:list', args: [] })
    });
    expect(res.status).toBe(401);

    const stream = await fetch(`${base}/events?token=${TOKEN}`);
    expect(stream.status).toBe(401);
    await stream.body?.cancel();
  });
});

describe('request-origin check', () => {
  it('refuses a cross-origin caller even with a valid token', async () => {
    const before = calls.length;
    const res = await rpc(
      { channel: 'backend:startTurn', args: [{ input: 'hi' }] },
      { headers: { origin: 'https://evil.example' } }
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/does not match Host/);
    expect(calls.length).toBe(before);
  });

  it('refuses a cross-site fetch and a rebound hostname', async () => {
    const site = await rpc(
      { channel: 'backend:startTurn', args: [{ input: 'hi' }] },
      { headers: { 'sec-fetch-site': 'cross-site' } }
    );
    expect(site.status).toBe(403);

    // The DNS-rebinding shape: the socket is ours, the Host header is not — and
    // Origin agrees with Host, which is exactly why Host is what gets checked.
    const before = calls.length;
    const rebound = await raw(
      '/rpc',
      {
        host: 'rebound.example',
        origin: 'http://rebound.example',
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json'
      },
      JSON.stringify({ channel: 'backend:startTurn', args: [{ input: 'hi' }] })
    );
    expect(rebound.status).toBe(403);
    expect(JSON.parse(rebound.body).error).toMatch(/unexpected Host/);
    expect(calls.length).toBe(before);
  });

  it('accepts our own client, loopback and tailnet alike', () => {
    const policy = { port: 8823 };
    expect(requestOriginProblem({ host: '127.0.0.1:8823' }, policy)).toBeNull();
    expect(
      requestOriginProblem(
        { host: '127.0.0.1:8823', origin: 'http://127.0.0.1:8823', 'sec-fetch-site': 'same-origin' },
        policy
      )
    ).toBeNull();
    expect(
      requestOriginProblem({ host: 'mac.tail1234.ts.net', origin: 'https://mac.tail1234.ts.net' }, policy)
    ).toBeNull();
    // Right socket, wrong port in the Host header — not a URL we ever serve.
    expect(requestOriginProblem({ host: '127.0.0.1:9999' }, policy)).toMatch(/unexpected Host/);
    expect(requestOriginProblem({}, policy)).toBe('missing Host header');
    expect(requestOriginProblem({ host: '127.0.0.1:8823', origin: 'null' }, policy)).toBe('opaque Origin');
  });
});

describe('the registry as the surface', () => {
  it('refuses a channel nothing registered, in the guard\'s own words', async () => {
    const before = calls.length;
    const res = await rpc({ channel: 'nope:notAThing', args: [] });
    // 400, not 403: an unregistered channel is a caller mistake, and the answer
    // has to reach the renderer in the words dispatchLocal would have used —
    // which is why there is no pre-check here reproducing them by hand.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Rejected local call to nope:notAThing: no handler registered/);
    expect(calls.length).toBe(before);
  });

  it('reaches a registered handler with no allowlist in the way', async () => {
    // memory:forget is destructive and used to be refused for the phone. With one
    // role, being registered is the whole permission story.
    const res = await rpc({ channel: 'memory:forget', args: [7] });
    expect(res.status).toBe(200);
    expect(calls.at(-1)).toEqual({ channel: 'memory:forget', args: [7] });
  });

  it('tells a client what it may call: the registry, whole', async () => {
    const res = await fetch(`${base}/channels`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: string[] };
    expect(result).toContain('backend:startTurn');
    expect(result).toContain('memory:forget');
    expect(result).toEqual([...serverChannels()]);
    // …and it is still behind the token.
    expect((await fetch(`${base}/channels`)).status).toBe(401);
  });
});

describe('argument validation', () => {
  it('reuses the IPC arg-spec table to reject a malformed backend:startTurn', async () => {
    const before = calls.length;
    for (const args of [['not-an-object'], [], [{ input: 'hi' }, 'extra']]) {
      const res = await rpc({ channel: 'backend:startTurn', args });
      expect(res.status).toBe(400);
      expect((await res.json()).ok).toBe(false);
    }
    expect(calls.length).toBe(before);
  });

  it('rejects a body that is not {channel, args}', async () => {
    expect((await rpc({ channel: 42, args: [] })).status).toBe(400);
    expect((await rpc({ channel: 'backend:startTurn', args: 'nope' })).status).toBe(400);
    const notJson = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{'
    });
    expect(notJson.status).toBe(400);
  });

  it('reports a handler failure as a 500, distinct from a rejected call', async () => {
    const res = await rpc({ channel: 'chats:list', args: [] });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'pi is not running' });
  });
});

describe('POST /upload', () => {
  /** Send raw bytes the way the desktop's file-transfer does. */
  function upload(
    body: string | Buffer,
    init: { name?: string; token?: string | null; headers?: Record<string, string> } = {}
  ) {
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream', ...init.headers };
    if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
    return fetch(`${base}/upload?name=${encodeURIComponent(init.name ?? 'notes.txt')}`, {
      method: 'POST',
      headers,
      // A Buffer IS a Uint8Array and fetch takes one at runtime, but BodyInit
      // admits only a view backed by a plain ArrayBuffer, and Buffer's is typed
      // ArrayBufferLike (it may be shared). Copied into one rather than cast:
      // the bodies here are a few bytes each, and a cast would be asserting
      // something about the allocator that this file has no way to know.
      body: typeof body === 'string' ? body : new Uint8Array(body)
    });
  }

  it('takes a file and answers with a handle that stands for it', async () => {
    const res = await upload('chocolate', { name: 'cake.pdf' });
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: { handle: string; name: string; size: number } };
    expect(result.name).toBe('cake.pdf');
    expect(result.size).toBe('chocolate'.length);
    // The handle is what the client passes where a path would have gone; the
    // server side of that substitution is covered in uploads.test.ts.
    expect(result.handle).toMatch(/^stem-upload:[0-9a-f-]{36}$/);
  });

  it('is behind the token and the origin check, like every route but /pair', async () => {
    expect((await upload('x', { token: null })).status).toBe(401);
    expect((await upload('x', { token: 'b'.repeat(64) })).status).toBe(401);
    expect((await upload('x', { headers: { origin: 'https://evil.example' } })).status).toBe(403);

    // The rebinding shape, which fetch cannot produce (it will not set Host).
    const rebound = await raw(
      '/upload?name=notes.txt',
      { host: 'rebound.example', authorization: `Bearer ${TOKEN}` },
      'x'
    );
    expect(rebound.status).toBe(403);
  });

  it('refuses an over-sized file on the declared length, before any of it arrives', async () => {
    const res = await raw(
      '/upload?name=huge.bin',
      {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/octet-stream',
        'content-length': String(MAX_UPLOAD_BYTES + 1)
      },
      'x'
    );
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error).toMatch(/too large/);
  });

  it('cuts off a body that lies about its size', async () => {
    // No Content-Length to pre-check, so the cap has to bite on the wire — the
    // whole reason the route streams rather than buffering.
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const status = await new Promise<number>((resolveStatus, rejectStatus) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/upload?name=liar.bin',
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/octet-stream',
            'transfer-encoding': 'chunked'
          }
        },
        (r) => {
          r.resume();
          resolveStatus(r.statusCode ?? 0);
        }
      );
      req.on('error', rejectStatus);
      const pump = (sent: number): void => {
        if (sent > MAX_UPLOAD_BYTES + chunk.length) {
          req.end();
          return;
        }
        if (req.write(chunk)) setImmediate(() => pump(sent + chunk.length));
        else req.once('drain', () => pump(sent + chunk.length));
      };
      pump(0);
    }).catch(() => 413); // a destroyed request is the same refusal, seen from the client
    expect(status).toBe(413);
  }, 30_000);
});

describe('GET /files', () => {
  function download(path: string, init: { token?: string | null } = {}) {
    const headers: Record<string, string> = {};
    if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
    return fetch(`${base}${path}`, { headers });
  }

  it('streams one file out of the Files folder', async () => {
    const res = await download('/files/Recipes/cake.pdf');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('chocolate');
    // Never sniffed from the extension, and never rendered: a stored file that
    // the browser decides is script is how a file store becomes an XSS.
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename\*=UTF-8''cake\.pdf/);
  });

  it('is behind the token', async () => {
    expect((await download('/files/Recipes/cake.pdf', { token: null })).status).toBe(401);
    expect((await download('/files/Recipes/cake.pdf', { token: 'b'.repeat(64) })).status).toBe(401);
  });

  it('does not become a way to read the rest of the machine', async () => {
    // A device token is not a licence to read the server's disk. Every one of
    // these is textually under /files/ and resolves somewhere it must not.
    for (const path of [
      '/files/../package.json',
      '/files/..%2Fpackage.json',
      '/files/%2e%2e%2fpackage.json',
      '/files/Recipes/../../package.json',
      '/files//etc/passwd',
      '/files/'
    ]) {
      const res = await raw(path, { authorization: `Bearer ${TOKEN}` });
      expect(`${path}: ${res.status}`).toBe(`${path}: 404`);
      expect(res.body).not.toMatch(/"name": "stem"/);
      expect(res.body).not.toMatch(/root:/);
    }
  });

  it('answers a missing file exactly as it answers a forbidden one', async () => {
    // Same 404 for both: a different status would confirm that something is
    // there, which is the one thing a caller probing for paths wants to learn.
    const missing = await download('/files/Recipes/nothing.pdf');
    const forbidden = await raw('/files/../package.json', { authorization: `Bearer ${TOKEN}` });
    expect(missing.status).toBe(404);
    expect(forbidden.status).toBe(404);
    expect((await missing.json()).error).toBe(JSON.parse(forbidden.body).error);
  });
});

describe('routes', () => {
  it('serves no files: anything that is not one of the six routes is a 404', async () => {
    // This server used to serve the phone's bundle out of dist/renderer, with a
    // traversal guard behind it. Both are gone; every client loads its own UI off
    // its own disk. The traversal cases are kept as a regression: if a static
    // route ever comes back, it must not come back by accident.
    for (const path of ['/', '/mobile.html', '/app.js', '/manifest.webmanifest', '/icons/stem-192.png']) {
      const res = await fetch(`${base}${path}`);
      expect(`${path}: ${res.status}`).toBe(`${path}: 404`);
    }
    for (const path of ['/..%2fpackage.json', '/%2e%2e%2fpackage.json', '/../package.json']) {
      const res = await raw(path);
      expect(res.status).toBe(404);
      expect(res.body).not.toMatch(/"name": "stem"/);
    }
  });
});

describe('POST /pair', () => {
  it('is the one route that answers without a token', async () => {
    PAIR_CODES.set('ABCD-EFGH', { deviceId: 'dev-9', token: 'd'.repeat(64) });
    const res = await fetch(`${base}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'abcd-efgh' })
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { deviceId: 'dev-9', token: 'd'.repeat(64) } });
  });

  it('passes a refusal through with the status the pairing layer chose', async () => {
    const res = await fetch(`${base}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ZZZZ-ZZZZ' })
    });
    // 401, not 500: a wrong code is a failed authentication, and the caller has
    // to be able to tell "try again" from "this server is broken".
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/not valid/);
  });

  it('still refuses a rebound host, token or no token', async () => {
    PAIR_CODES.set('WXYZ-WXYZ', { deviceId: 'dev-8', token: 'e'.repeat(64) });
    const res = await raw(
      '/pair',
      { host: 'rebound.example', 'content-type': 'application/json' },
      JSON.stringify({ code: 'WXYZ-WXYZ' })
    );
    // Being unauthenticated is exactly why the origin check still has to apply:
    // a page in a browser must not be able to spend a code it overheard.
    expect(res.status).toBe(403);
    expect(PAIR_CODES.has('WXYZ-WXYZ')).toBe(true);
  });

  // What the device says it is, which decides whether it is ever offered as a
  // host for a device-pinned MCP server (docs/mcp-device-pinning.md, ⑦).
  it('carries the kind the device claims, and reads its absence as a desktop', async () => {
    pairedKinds.length = 0;
    PAIR_CODES.set('MOBI-MOBI', { deviceId: 'dev-7', token: 'f'.repeat(64) });
    PAIR_CODES.set('OLDC-LNT0', { deviceId: 'dev-6', token: '9'.repeat(64) });
    const pair = (body: unknown) =>
      fetch(`${base}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    expect((await pair({ code: 'MOBI-MOBI', kind: 'mobile' })).status).toBe(200);
    // A client from before the field existed says nothing, and a desktop is the
    // only thing it can have been — nothing else could speak this route then.
    expect((await pair({ code: 'OLDC-LNT0' })).status).toBe(200);
    expect(pairedKinds).toEqual(['mobile', 'desktop']);
  });

  it('refuses a kind that is not one of ours rather than coercing it', async () => {
    pairedKinds.length = 0;
    PAIR_CODES.set('BADK-INDX', { deviceId: 'dev-5', token: '8'.repeat(64) });
    for (const kind of ['laptop', 42, null]) {
      const res = await fetch(`${base}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'BADK-INDX', kind })
      });
      expect(res.status).toBe(400);
    }
    // The code is untouched — a malformed body must not spend one.
    expect(pairedKinds).toEqual([]);
    expect(PAIR_CODES.has('BADK-INDX')).toBe(true);
  });

  it('rejects a body that is not a code, and one that is far too big to be one', async () => {
    for (const body of ['{', JSON.stringify({}), JSON.stringify({ code: 42 })]) {
      const res = await raw('/pair', { 'content-type': 'application/json' }, body);
      expect(res.status).toBe(400);
    }
    // The unauthenticated route gets its own cap — a kilobyte, not the 25 MB
    // /rpc allows for attachments.
    const huge = await raw(
      '/pair',
      { 'content-type': 'application/json' },
      JSON.stringify({ code: 'x'.repeat(4096) })
    );
    expect(huge.status).toBe(400);
  });
});

/** A parsed SSE block: the `id:` line the server stamps, plus its `data:` JSON. */
interface Frame {
  id: string | null;
  channel: string;
  payload: unknown;
}

/**
 * One block off the wire, whatever kind it is. `event` names a control frame
 * (`snapshot`, `resync`); a data frame has none, which is the whole of how the
 * two are told apart.
 */
interface Block {
  id: string | null;
  event: string | null;
  data: {
    channel?: string;
    payload?: unknown;
    liveTurns?: unknown;
    head?: unknown;
    /** An addressed frame's payload (see the pushTo tests). */
    requestId?: string;
    server?: string;
  };
}

/**
 * Read SSE blocks off a live stream until `count` of them carry data, or the
 * stream ends. Kept separate from the frames helper because the resume tests care
 * about the control frames the ordinary fan-out tests never see.
 */
async function collectBlocks(res: Response, count: number): Promise<Block[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const blocks: Block[] = [];
  let buffer = '';
  while (blocks.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const lines = raw.split('\n');
      const data = lines
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');
      if (data) {
        blocks.push({
          id: lines.find((line) => line.startsWith('id: '))?.slice(4) ?? null,
          event: lines.find((line) => line.startsWith('event: '))?.slice(7) ?? null,
          data: JSON.parse(data) as Block['data']
        });
        // One TCP read can contain several SSE blocks (pushTo then a broadcast
        // in the same tick). Stop at `count` so callers asking for the first
        // event do not also get whatever arrived in the same chunk.
        if (blocks.length >= count) break;
      }
      split = buffer.indexOf('\n\n');
    }
  }
  await reader.cancel().catch(() => undefined);
  return blocks;
}

/** Read SSE frames off a live stream until `count` data events have arrived. */
async function collectFrames(res: Response, count: number): Promise<Frame[]> {
  const blocks = await collectBlocks(res, count);
  return blocks
    .filter((b) => !b.event)
    .map((b) => ({ id: b.id, channel: b.data.channel!, payload: b.data.payload }));
}

describe('GET /events', () => {
  it('requires the token', async () => {
    const res = await fetch(`${base}/events`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it('frames pushes as one-line JSON data events and fans out to every client', async () => {
    const a = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const b = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(a.headers.get('cache-control')).toMatch(/no-cache/);

    // Both streams have to be registered before the push, and registration
    // happens as the response headers are written — which we've now seen.
    expect(server.clientCount()).toBe(2);

    const collected = Promise.all([collectFrames(a, 2), collectFrames(b, 2)]);
    // A payload with a newline and a quote: it must survive as one `data:` line.
    server.push({
      id: 1,
      channel: 'backend:event',
      payload: { method: 'item/agentMessage/delta', params: { delta: 'line one\nline "two"' } }
    });
    server.push({ id: 2, channel: 'mcp:status', payload: { servers: [] } });

    const [fromA, fromB] = await collected;
    expect(fromA).toEqual([
      {
        id: `${server.epoch}.1`,
        channel: 'backend:event',
        payload: { method: 'item/agentMessage/delta', params: { delta: 'line one\nline "two"' } }
      },
      { id: `${server.epoch}.2`, channel: 'mcp:status', payload: { servers: [] } }
    ]);
    expect(fromB).toEqual(fromA);
  });

  it('stamps every frame with the id the caller gave it, under this run\'s epoch', async () => {
    // Ids come from the caller, not from the fan-out, so the sequence is the
    // caller's to keep monotonic. The epoch in front of it is the server's, and
    // is what stops a bookmark from a previous run — whose sequence started over
    // at 1 — from being read as a position in this one.
    const stream = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const collected = collectFrames(stream, 2);
    server.push({ id: 42, channel: 'mcp:status', payload: { servers: [] } });
    server.push({ id: 43, channel: 'backend:event', payload: { method: 'turn/completed' } });
    expect((await collected).map((f) => f.id)).toEqual([
      `${server.epoch}.42`,
      `${server.epoch}.43`
    ]);
  });

  it('cuts a revoked device off its stream, and leaves every other device alone', async () => {
    const revoked = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const kept = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${OTHER_TOKEN}` } });
    expect(server.clientCount()).toBe(2);

    // Removing the record decides the device's NEXT request; this decides the
    // socket it already has open. Without it, a withdrawn device would keep
    // receiving every push for as long as the connection survived.
    expect(server.dropDevice('dev-1')).toBe(1);
    expect(server.clientCount()).toBe(1);

    const stillThere = collectFrames(kept, 1);
    server.push({ id: 7, channel: 'mcp:status', payload: { servers: [] } });
    expect((await stillThere).map((f) => f.channel)).toEqual(['mcp:status']);

    // The revoked stream is gone, not merely skipped over.
    await revoked.body?.cancel().catch(() => undefined);
    expect(server.dropDevice('dev-1')).toBe(0);
  });

  it('drops a disconnected client instead of writing to a dead response', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal
    });
    expect(res.status).toBe(200);
    controller.abort();
    // Give the server's 'close' handler a tick to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(() => server.push({ id: 4, channel: 'backend:event', payload: { method: 'turn/completed' } })).not.toThrow();
    expect(server.clientCount()).toBe(0);
  });
});

// A frame written to ONE device's streams (docs/mcp-device-pinning.md, ⑧). The
// two properties worth having in a test are the two that make it safe: it goes
// only where it is addressed, and it never lands in the replay buffer, which
// every authenticated device may read back on its next reconnect.
describe('pushTo — an addressed control frame', () => {
  /**
   * Streams opened by these tests, torn down between them. Cancelling a reader
   * is not enough: the server learns a stream is gone from its socket's 'close',
   * which arrives whenever it arrives — and every assertion here is about which
   * devices the server believes are connected.
   */
  let open: AbortController[] = [];

  async function openStream(token: string): Promise<Response> {
    const controller = new AbortController();
    open.push(controller);
    const res = await fetch(`${base}/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    expect(res.status).toBe(200);
    return res;
  }

  afterEach(async () => {
    for (const controller of open) controller.abort();
    open = [];
    for (let i = 0; i < 200 && server.clientCount() > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(server.clientCount()).toBe(0);
  });

  it('reaches only that device, and does not become a frame anyone can replay', async () => {
    // Two streams for the same device — a desktop with the app and the overlay,
    // or one mid-reconnect — so "how many did it reach" is not trivially one.
    const mineA = await openStream(TOKEN);
    const mineB = await openStream(TOKEN);
    const theirs = await openStream(OTHER_TOKEN);
    expect(server.clientCount()).toBe(3);

    const bufferedBefore = server.bufferedFrames();
    const addressed = Promise.all([collectBlocks(mineA, 1), collectBlocks(mineB, 1)]);
    // The other device collects one block too — and the assertion is that the one
    // it gets is the BROADCAST below, not this. Pushing the broadcast second is
    // what makes that a proof rather than a guess about timing: had the addressed
    // frame gone to everybody, it would be the first block on that stream.
    const bystander = collectBlocks(theirs, 1);

    expect(server.pushTo('dev-1', 'mcp-request', { requestId: 'r-1', server: 'files', op: 'tools' })).toBe(2);
    // THE invariant. An addressed frame carries one device's tool arguments, and
    // the ring is replayed wholesale to whoever reconnects with an old bookmark.
    expect(server.bufferedFrames()).toBe(bufferedBefore);

    server.push({ id: 11, channel: 'mcp:status', payload: { servers: [] } });
    // ...and the same counter does move for an ordinary push, so the assertion
    // above is about pushTo rather than about a buffer that never fills.
    expect(server.bufferedFrames()).toBe(bufferedBefore + 1);

    for (const blocks of await addressed) {
      expect(blocks).toHaveLength(1);
      // Named with SSE's own `event:` field, which is what makes it impossible
      // for a client to take it for a push — and carrying no `id:`, because it
      // is not a position in the stream to resume from.
      expect(blocks[0].event).toBe('mcp-request');
      expect(blocks[0].id).toBeNull();
      expect(blocks[0].data).toEqual({ requestId: 'r-1', server: 'files', op: 'tools' });
    }
    const other = await bystander;
    expect(other).toHaveLength(1);
    expect(other[0].event).toBeNull();
    expect(other[0].data.channel).toBe('mcp:status');
  });

  it('answers zero for a device with nothing open, rather than pretending it landed', async () => {
    // The whole reason the count comes back: a caller that knows nobody was
    // there can refuse immediately instead of holding a tool call open for two
    // minutes waiting on an answer that was never coming.
    expect(server.pushTo('dev-1', 'mcp-request', { requestId: 'r-2' })).toBe(0);
    expect(server.pushTo('nobody-by-that-name', 'mcp-request', { requestId: 'r-3' })).toBe(0);
  });

  it('reports which devices are connected, and forgets one as its stream goes', async () => {
    expect(server.connectedDevices()).toEqual(new Set());
    await openStream(OTHER_TOKEN);
    // Availability and deliverability are deliberately the same fact: this is
    // the set of devices a pushTo would reach, read off the same clients.
    expect(server.connectedDevices()).toEqual(new Set(['dev-2']));

    for (const controller of open) controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.connectedDevices()).toEqual(new Set());
  });
});

// What a client gets back when its stream dropped and came again. The promise
// this is here to keep is a plain one: close the lid mid-answer, open it, and the
// answer is finished on screen — not truncated, and not a spinner that never
// resolves.
//
// Its own server, because the assertions are about a sequence and the shared one
// above has been pushed to with whatever ids its tests found convenient.
describe('resuming a dropped stream', () => {
  let resumed: TransportServer;
  let origin: string;
  /** What connectSnapshot answers with — set per test. */
  let liveTurns: { threadId: string; turnId: string }[] = [];
  const bearer = { authorization: `Bearer ${TOKEN}` };

  beforeAll(async () => {
    resumed = await startTransportServer({
      port: 0,
      authenticate: () => ({ id: 'dev-1', role: 'device' }),
      dispatch: dispatchLocal,
      registeredChannels: serverChannels,
      connectSnapshot: () => ({ liveTurns })
    });
    origin = `http://127.0.0.1:${resumed.port}`;
  });

  afterAll(async () => {
    await resumed.close();
  });

  /** Push `count` frames, continuing a sequence the caller keeps. */
  function pushRange(from: number, count: number): void {
    for (let i = 0; i < count; i++) {
      resumed.push({ id: from + i, channel: 'backend:event', payload: { seq: from + i } });
    }
  }

  it('opens every stream with a live-turn snapshot before anything that happened', async () => {
    liveTurns = [{ threadId: 't-live', turnId: 'turn-9' }];
    const stream = await fetch(`${origin}/events`, { headers: bearer });
    const blocks = collectBlocks(stream, 2);
    pushRange(1, 1);

    const [first, second] = await blocks;
    // First, so that the frames behind it can carry the client forward through
    // the same history it missed. The other order would let a snapshot re-mark as
    // running a turn whose terminal frame the client has just been handed.
    expect(first.event).toBe('snapshot');
    expect(first.data.liveTurns).toEqual([{ threadId: 't-live', turnId: 'turn-9' }]);
    // A control frame is not a position in the stream and must not be bookmarked
    // as one, or a client would resume past whatever came next.
    expect(first.id).toBeNull();
    expect(second.event).toBeNull();
    expect(second.data.channel).toBe('backend:event');
    liveTurns = [];
  });

  it('replays the gap, exactly once each, and then goes live', async () => {
    // The classic bug this is written against: the window between "finished
    // replaying" and "attached to the live stream". A frame that falls in it is
    // delivered twice or not at all, and neither is visible from one end alone —
    // so both ends are asserted, on one sequence, in one stream.
    pushRange(2, 5); // 2..6 land with nobody listening, as they would mid-outage

    const stream = await fetch(`${origin}/events`, {
      headers: { ...bearer, 'last-event-id': `${resumed.epoch}.3` }
    });
    // Five blocks: the snapshot, the three replayed, and the live one. A frame
    // delivered twice would take the live one's place and fail the sequence
    // below; one delivered not at all would leave a hole in it.
    const blocks = collectBlocks(stream, 5);
    // Pushed while the reconnect is being served, which is precisely where a
    // dropped or doubled frame would come from.
    pushRange(7, 1);

    const seen = (await blocks).filter((b) => !b.event).map((b) => b.data.payload as { seq: number });
    expect(seen.map((p) => p.seq)).toEqual([4, 5, 6, 7]);
  });

  it('sends nothing back to a client that missed nothing', async () => {
    const stream = await fetch(`${origin}/events`, {
      headers: { ...bearer, 'last-event-id': `${resumed.epoch}.7` }
    });
    const blocks = collectBlocks(stream, 2);
    pushRange(8, 1);
    const seen = await blocks;
    expect(seen[0].event).toBe('snapshot');
    // Straight to the new frame: no replay of what it already has, no resync.
    expect(seen[1].event).toBeNull();
    expect(seen[1].data.payload).toEqual({ seq: 8 });
  });

  // Serial from here: these share one sequence, and overflowing the buffer is
  // what the resync cases below need to have happened.
  it('bounds the buffer by frames, dropping the oldest', async () => {
    const before = resumed.bufferedFrames();
    pushRange(100, 1_200); // ids 100..1299
    // 1,000 frames is the cap; what is left is the newest of them.
    expect(resumed.bufferedFrames()).toBe(1_000);
    expect(resumed.bufferedFrames()).toBeGreaterThan(before);

    const stream = await fetch(`${origin}/events`, {
      headers: { ...bearer, 'last-event-id': `${resumed.epoch}.1297` }
    });
    const blocks = await collectBlocks(stream, 3);
    // Two frames still inside the ring come back; nothing is resynced.
    expect(blocks.map((b) => b.event)).toEqual(['snapshot', null, null]);
    expect(blocks.slice(1).map((b) => b.data.payload)).toEqual([{ seq: 1298 }, { seq: 1299 }]);
  });

  it('asks for a resync rather than replaying half a gap', async () => {
    // The buffer is bounded, so a client that was away long enough falls off the
    // back of it — frames 1..8 were evicted by the test above. A partial replay
    // would be silently wrong (the client cannot tell which of its frames are
    // missing) where a refetch is merely a round trip.
    const stream = await fetch(`${origin}/events`, {
      headers: { ...bearer, 'last-event-id': `${resumed.epoch}.8` }
    });
    const blocks = await collectBlocks(stream, 2);
    expect(blocks.map((b) => b.event)).toEqual(['snapshot', 'resync']);
    // Carrying where the client now stands, so the refetch moves its bookmark and
    // the next drop does not ask to cross the same gap again.
    expect(blocks[1].data.head).toBe(`${resumed.epoch}.1299`);
    expect(blocks[1].id).toBeNull();
  });

  it('asks for a resync when the bookmark belongs to a server that has restarted', async () => {
    // The kill -9 case. The sequence begins again at 1 after a restart, so a bare
    // number from the previous run would name a frame in this one — a client that
    // was at 900 would be told it is ahead of a server that has only reached 8,
    // and would silently miss everything since. The epoch is what makes that
    // impossible to get wrong.
    const stream = await fetch(`${origin}/events`, {
      headers: { ...bearer, 'last-event-id': 'deadbeef.900' }
    });
    const blocks = await collectBlocks(stream, 2);
    expect(blocks.map((b) => b.event)).toEqual(['snapshot', 'resync']);
  });

  it('treats an unparseable bookmark as a resync, never as "you are up to date"', async () => {
    for (const header of ['not-an-id', `${resumed.epoch}.`, `${resumed.epoch}.-1`, '.5']) {
      const stream = await fetch(`${origin}/events`, { headers: { ...bearer, 'last-event-id': header } });
      const blocks = await collectBlocks(stream, 2);
      expect(blocks.map((b) => b.event)).toEqual(['snapshot', 'resync']);
    }
  });

  it('bounds the buffer by bytes as well, so a few huge frames cannot fill memory', async () => {
    // Frames alone is not a bound: 1,000 of these would be 500 MB. The byte cap
    // is what makes the buffer's cost a number rather than a hope.
    const fat = 'x'.repeat(512 * 1024);
    resumed.push({ id: 2000, channel: 'backend:event', payload: { seq: 2000, fat } });
    for (let i = 1; i <= 8; i++) {
      resumed.push({ id: 2000 + i, channel: 'backend:event', payload: { seq: 2000 + i, fat } });
    }
    // 4 MB / 512 KB: well under the 1,000-frame cap, so bytes are what bit.
    expect(resumed.bufferedFrames()).toBeLessThan(9);
    expect(resumed.bufferedFrames()).toBeGreaterThan(0);
  });

  it('replays the same frames to a device that was not connected when they were sent', async () => {
    // The buffer is global and the delivery is per-device, so this is the check
    // that the two cannot disagree: every frame in it was broadcast to every
    // device, which is the only reason handing one back to a device that was
    // offline at the time discloses nothing. There is no device-scoped push in
    // this transport to make it otherwise — `push()` has no parameter for one.
    resumed.push({ id: 3000, channel: 'mcp:status', payload: { servers: ['a'] } });
    const first = await fetch(`${origin}/events`, {
      headers: { ...bearer, 'last-event-id': `${resumed.epoch}.2999` }
    });
    const other = await fetch(`${origin}/events`, {
      headers: { authorization: `Bearer ${OTHER_TOKEN}`, 'last-event-id': `${resumed.epoch}.2999` }
    });
    const [a, b] = await Promise.all([collectBlocks(first, 2), collectBlocks(other, 2)]);
    expect(a[1].data).toEqual(b[1].data);
    expect(a[1].data.payload).toEqual({ servers: ['a'] });
  });
});

describe('body cap', () => {
  it('refuses an over-sized body on the declared length, before any of it arrives', async () => {
    const before = calls.length;
    const res = await raw(
      '/rpc',
      {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        // 26 MB declared; one byte actually sent. The answer must come back
        // anyway — nothing is buffered waiting for a body we already refused.
        'content-length': String(26 * 1024 * 1024)
      },
      '{'
    );
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'request body too large' });
    expect(calls.length).toBe(before);
  });

  it('refuses an over-sized chunked body mid-stream', async () => {
    const before = calls.length;
    const chunk = 'x'.repeat(1024 * 1024);
    const res = await new Promise<number>((resolveStatus, rejectStatus) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/rpc',
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
        },
        (r) => {
          r.resume();
          resolveStatus(r.statusCode ?? 0);
        }
      );
      req.on('error', rejectStatus);
      // No Content-Length to pre-check: the cap has to bite on the wire.
      const pump = (sent: number): void => {
        if (sent > 26 * 1024 * 1024) {
          req.end();
          return;
        }
        if (req.write(chunk)) setImmediate(() => pump(sent + chunk.length));
        else req.once('drain', () => pump(sent + chunk.length));
      };
      pump(0);
    }).catch(() => 413); // a destroyed request is the same refusal, seen from the client
    expect(res).toBe(413);
    expect(calls.length).toBe(before);
  });
});

describe('what it will bind', () => {
  /** The three options every bind here shares; only the address changes. */
  const bare = {
    authenticate: (presented: string | null) =>
      presented && hashEquals(TOKEN_HASH, hashToken(presented)) ? { id: 'dev-1', role: 'device' as const } : null,
    dispatch: dispatchLocal,
    registeredChannels: serverChannels
  };

  /**
   * One request over a Unix socket. node:http speaks to a socket path with the
   * same client it speaks to a port with — which is the point: the container's
   * transport is the same transport, reached through the filesystem instead of
   * the loopback interface.
   */
  function overSocket(
    socketPath: string,
    path: string,
    headers: Record<string, string>
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolveReq, rejectReq) => {
      const req = httpRequest({ socketPath, path, method: 'GET', headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => resolveReq({ status: res.statusCode ?? 0, body: text }));
      });
      req.on('error', rejectReq);
      req.end();
    });
  }

  it('refuses a real network interface', async () => {
    // The invariant the whole deployment rests on, checked at the socket rather
    // than in a comment: no configuration makes Stem itself answer the internet.
    for (const host of ['0.0.0.0', '::', '192.168.1.10']) {
      await expect(startTransportServer({ ...bare, port: 0, host })).rejects.toThrow(/loopback-only/);
    }
  });

  it('serves over a Unix socket, where there is no interface to answer at all', async () => {
    // Short, and deliberately not under a mkdtemp: macOS puts TMPDIR somewhere
    // long enough that a nested throwaway directory can blow the kernel's ~104
    // byte limit for a socket path — the exact failure socketPathProblem names.
    const socketPath = join(tmpdir(), `stem-t-${process.pid}.sock`);
    rmSync(socketPath, { force: true });
    const listening = await startTransportServer({
      ...bare,
      port: 0,
      socketPath,
      // What Caddy will be reached under. On a socket this is the ONLY host that
      // can pass the rebinding check: there is no port of ours for a loopback
      // Host to name, so the deployment's declared name is the whole allowlist.
      extraHosts: ['stem.example.com']
    });
    try {
      expect(listening.socketPath).toBe(socketPath);
      expect(listening.port).toBe(0);
      expect(existsSync(socketPath)).toBe(true);
      // Not world-anything: a socket a stranger on the box can open is a socket
      // they can POST /pair to.
      expect(statSync(socketPath).mode & 0o007).toBe(0);

      const proxied = await overSocket(socketPath, '/channels', {
        host: 'stem.example.com',
        authorization: `Bearer ${TOKEN}`
      });
      expect(proxied.status).toBe(200);
      expect(JSON.parse(proxied.body).result).toContain('chats:list');

      // …and the gates are still the gates. Reaching the socket is not
      // authentication, and a Host nobody declared is still a Host nobody declared.
      const anonymous = await overSocket(socketPath, '/channels', { host: 'stem.example.com' });
      expect(anonymous.status).toBe(401);
      const elsewhere = await overSocket(socketPath, '/channels', {
        host: 'stem.attacker.example',
        authorization: `Bearer ${TOKEN}`
      });
      expect(elsewhere.status).toBe(403);
    } finally {
      await listening.close();
    }
    // Closing takes the file with it, so the next boot binds rather than finding
    // its own corpse in the shared volume.
    expect(existsSync(socketPath)).toBe(false);
  });

  it('clears a socket left behind by a run that was killed', async () => {
    const socketPath = join(tmpdir(), `stem-stale-${process.pid}.sock`);
    // What `docker kill` leaves in the volume: a socket file with nothing behind
    // it. Binding must succeed anyway, or the container never comes back up.
    writeFileSync(socketPath, '');
    const listening = await startTransportServer({ ...bare, port: 0, socketPath, extraHosts: ['stem.example.com'] });
    try {
      const res = await overSocket(socketPath, '/channels', {
        host: 'stem.example.com',
        authorization: `Bearer ${TOKEN}`
      });
      expect(res.status).toBe(200);
    } finally {
      await listening.close();
    }
  });

  it('refuses a socket path that is really a port, or a name', async () => {
    // `server.listen('8080')` opens a TCP port on every interface, because Node
    // reads a numeric string as one. The absolute-path rule is what stops the
    // socket option from being a way to say that.
    for (const socketPath of ['8080', 'stem.sock', './stem.sock', '0.0.0.0']) {
      await expect(startTransportServer({ ...bare, port: 0, socketPath })).rejects.toThrow(/must be absolute/);
    }
  });

  it('refuses a socket path longer than the kernel will take', async () => {
    const socketPath = `/tmp/${'d'.repeat(120)}.sock`;
    await expect(startTransportServer({ ...bare, port: 0, socketPath })).rejects.toThrow(/kernel's limit/);
  });
});

describe('close()', () => {
  it('resolves with an SSE stream still open', async () => {
    const other = await startTransportServer({
      port: 0,
      authenticate: () => ({ id: 'dev-1', role: 'device' }),
      dispatch: dispatchLocal,
      registeredChannels: serverChannels
    });
    const res = await fetch(`http://127.0.0.1:${other.port}/events`, {
      headers: { authorization: 'Bearer anything' }
    });
    expect(other.clientCount()).toBe(1);
    // Would hang forever without destroying the socket first.
    await other.close();
    await res.body?.cancel().catch(() => undefined);
  });
});
