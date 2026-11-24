import { describe, expect, it } from 'vitest';
import { ipcMain } from '../electron-stub';
import { a, argsProblem, dispatchLocal, hasLocalHandler, ipcArgSpecs, registerServer, serverChannels } from '../../src/server/ipc';
import { bindServerChannels, handleLocal, senderProblem } from '../../src/desktop/ipc-bridge';

// The IPC guard, split across the two sides: src/server/ipc/guard.ts holds the
// registry and the per-channel argument validation; src/desktop/ipc-bridge.ts holds
// the trusted-sender check and the ipcMain binding. What the renderer sees has to
// be identical either way, so these exercise the pair together.
//
// In the app, bindServerChannels(serverChannels(), dispatchLocal) is handed the channel list the proxy fetched
// over GET /channels and an invoke that goes out over the wire. Here it is handed
// the registry directly and dispatchLocal, which is the same pair with the socket
// taken out — the socket itself is transport.test.ts's job.

/** A minimal IpcMainInvokeEvent stand-in: one top-level frame at `url`. */
function eventFrom(url: string) {
  const frame = { url };
  return { senderFrame: frame, sender: { mainFrame: frame } };
}

const trusted = eventFrom('file:///app/index.html');

describe('senderProblem', () => {
  it('trusts only our own top-level frames', () => {
    expect(senderProblem(eventFrom('file:///Applications/Stem.app/renderer/index.html') as never)).toBeNull();
    expect(senderProblem(eventFrom('https://evil.example/page') as never)).toMatch(/untrusted sender/);

    // The dev server origin is trusted only when electron-vite advertises it.
    const dev = eventFrom('http://localhost:5173/index.html');
    expect(senderProblem(dev as never)).toMatch(/untrusted sender/);
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';
    try {
      expect(senderProblem(dev as never)).toBeNull();
    } finally {
      delete process.env.ELECTRON_RENDERER_URL;
    }

    // A subframe never gets IPC, whatever it displays.
    const sub = { senderFrame: { url: 'file:///x.html' }, sender: { mainFrame: { url: 'file:///x.html' } } };
    expect(senderProblem(sub as never)).toBe('IPC from a subframe');
    expect(senderProblem({ senderFrame: null, sender: { mainFrame: null } } as never)).toBe('no sender frame');
  });
});

describe('argsProblem', () => {
  it('checks arity and shallow types, honoring optional and nullish', () => {
    expect(argsProblem([a.string, a.boolean], ['x', true])).toBeNull();
    expect(argsProblem([a.string], ['x', 'extra'])).toMatch(/at most 1/);
    expect(argsProblem([a.string], [42])).toBe('argument 1 must be a string');
    expect(argsProblem([a.number], [Number.NaN])).toMatch(/finite number/);
    expect(argsProblem([a.object], [['not', 'plain']])).toMatch(/an object/);
    expect(argsProblem([a.stringArray], [['ok', 'fine']])).toBeNull();
    expect(argsProblem([a.oneOf(['on', 'off'])], ['dim'])).toMatch(/one of on\|off/);
    expect(argsProblem([a.nullish(a.string)], [null])).toBeNull();
    expect(argsProblem([a.nullish(a.string)], [undefined])).toBeNull();
    expect(argsProblem([a.string, a.optional(a.string)], ['just-one'])).toBeNull();
    // A required argument cannot simply be omitted.
    expect(argsProblem([a.string], [])).toBe('argument 1 must be a string');
  });
});

describe('providers:testLocal', () => {
  it('accepts every custom API flavor as argument 4', () => {
    // The flavor set here must track LocalProviderApi. A flavor the UI can send
    // but the guard rejects dies as "request failed" before it reaches the probe
    // — which is exactly how openai-responses was blocked before this entry.
    const specs = ipcArgSpecs('providers:testLocal');
    for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
      expect(argsProblem(specs, ['custom', 'http://localhost:8080', 'key', api])).toBeNull();
    }
    // Auto-detect still sends no flavor, and a bogus one is still rejected.
    expect(argsProblem(specs, ['custom', 'http://localhost:8080'])).toBeNull();
    expect(argsProblem(specs, ['custom', 'http://localhost:8080', 'key', 'openai-bogus'])).toMatch(
      /one of openai-completions\|openai-responses\|anthropic-messages/
    );
  });
});

describe('exec channels', () => {
  it('exec:resolveApproval takes a string id and a known decision', async () => {
    let got: unknown[] = [];
    registerServer('exec:resolveApproval', (_e, ...args) => {
      got = args;
      return 'ok';
    });
    bindServerChannels(serverChannels(), dispatchLocal);
    await expect(ipcMain._invoke('exec:resolveApproval', trusted, 'ap-1', 'alwaysAllow')).resolves.toBe('ok');
    expect(got).toEqual(['ap-1', 'alwaysAllow']);
    expect(() => ipcMain._invoke('exec:resolveApproval', trusted, 'ap-1', 'yes'))
      .toThrow(/one of allowOnce\|alwaysAllow\|deny/);
    expect(() => ipcMain._invoke('exec:resolveApproval', trusted, 7, 'deny')).toThrow(/must be a string/);
  });

  it('settings:updateExec takes an object patch', async () => {
    registerServer('settings:updateExec', () => 'ok');
    bindServerChannels(serverChannels(), dispatchLocal);
    await expect(ipcMain._invoke('settings:updateExec', trusted, { enabled: false })).resolves.toBe('ok');
    expect(() => ipcMain._invoke('settings:updateExec', trusted, 'enabled')).toThrow(/an object/);
  });
});

describe('bindServerChannels', () => {
  it('rejects bad senders and bad args before the handler runs; passes good calls through', async () => {
    let ran = 0;
    registerServer('chats:rename', (_e, threadId, name) => {
      ran += 1;
      return `${String(threadId)}:${String(name)}`;
    });
    bindServerChannels(serverChannels(), dispatchLocal);

    await expect(ipcMain._invoke('chats:rename', trusted, 't-1', 'New name')).resolves.toBe('t-1:New name');
    expect(ran).toBe(1);

    expect(() => ipcMain._invoke('chats:rename', eventFrom('https://evil.example'), 't-1', 'x'))
      .toThrow(/untrusted sender/);
    expect(() => ipcMain._invoke('chats:rename', trusted, 't-1', 42)).toThrow(/argument 2 must be a string/);
    expect(ran).toBe(1); // neither rejected call reached the handler

    // A channel with no spec entry takes no arguments at all.
    registerServer('runtime:status', () => 'ok');
    bindServerChannels(serverChannels(), dispatchLocal);
    await expect(ipcMain._invoke('runtime:status', trusted)).resolves.toBe('ok');
    expect(() => ipcMain._invoke('runtime:status', trusted, 'sneaky')).toThrow(/at most 0/);
  });
});

// Channels the desktop answers itself (native pickers, reveal, the Quick Chat
// windows). They never reach the server's registry, and the renderer must not be
// able to tell: same sender check, same argument validation, same wording.
describe('handleLocal', () => {
  it('guards a client-owned channel exactly as a server-owned one', () => {
    let got: unknown[] = [];
    handleLocal('cfolders:reveal', (_e, ...args) => {
      got = args;
      return 'revealed';
    });

    expect(ipcMain._invoke('cfolders:reveal', trusted, 'cf-1')).toBe('revealed');
    expect(got).toEqual(['cf-1']);
    expect(() => ipcMain._invoke('cfolders:reveal', trusted, 7)).toThrow(
      'Rejected IPC call to cfolders:reveal: argument 1 must be a string.'
    );
    expect(() => ipcMain._invoke('cfolders:reveal', eventFrom('https://evil.example'), 'cf-1'))
      .toThrow(/untrusted sender/);

    // Nothing on the server knows this channel exists.
    expect(hasLocalHandler('cfolders:reveal')).toBe(false);
  });
});

// The registry the phone bridge dispatches through: same handlers, same argument
// validation, no caller event (see the registry comment in guard.ts).
describe('dispatchLocal', () => {
  it('routes to the registered handler with the same arg validation, and no event', async () => {
    let sawEvent: unknown = 'not called';
    registerServer('chats:rename', (event, threadId, name) => {
      sawEvent = event;
      return `${String(threadId)}:${String(name)}`;
    });

    expect(hasLocalHandler('chats:rename')).toBe(true);
    await expect(dispatchLocal('chats:rename', ['t-1', 'From the phone'])).resolves.toBe('t-1:From the phone');
    expect(sawEvent).toBeUndefined();

    // Same per-channel spec table as the IPC path.
    await expect(dispatchLocal('chats:rename', ['t-1', 42])).rejects.toThrow(/argument 2 must be a string/);
    await expect(dispatchLocal('chats:rename', [])).rejects.toThrow(/argument 1 must be a string/);
  });

  it('refuses a channel nothing registered', async () => {
    expect(hasLocalHandler('nope:notAThing')).toBe(false);
    await expect(dispatchLocal('nope:notAThing', [])).rejects.toThrow(/no handler registered/);
  });

  it('surfaces a handler rejection rather than swallowing it', async () => {
    registerServer('backend:newConversation', () => Promise.reject(new Error('backend is down')));
    await expect(dispatchLocal('backend:newConversation', [])).rejects.toThrow('backend is down');
  });
});
