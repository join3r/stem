import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { a, argsProblem, ipcArgSpecs, type ArgSpec, type CallerContext } from '../server/ipc';
import { log } from '../server/log';

// The Electron half of the IPC guard (the other half is src/server/ipc/guard.ts).
// Two things live here because only the client can do them:
//
//  - the trusted-sender check. "Trusted" means a window WE created showing OUR
//    renderer, which is a fact about BrowserWindows — the server has none.
//  - the ipcMain binding itself. On a headless host there is no ipcMain.
//
// Channels come from two places, and the difference is the whole point:
//
//  SERVER-OWNED (~110 channels) — the server's registry IS the desktop's surface.
//    We bind whatever it says it registered (GET /channels) and forward the call
//    over the wire. No allowlist: a channel the server answers is a channel any
//    authenticated client may call, and the token is the whole decision.
//
//  CLIENT-OWNED (the table below) — channels the desktop answers itself because
//    they act on THIS machine: native pickers, revealing a path in the file
//    manager, and the Quick Chat window choreography. They are never registered
//    on the server and never reachable over the wire.
//
// Both paths run the identical sender + argument checks and produce the identical
// rejection message, because the renderer cannot tell (and must not have to) which
// side of the split answers a given channel.

/**
 * Argument shapes for the client-owned channels — the desktop's half of the
 * table in ipc/guard.ts, with the same contract: a channel absent from it takes
 * no arguments at all.
 */
const LOCAL_IPC_ARGS: Record<string, ArgSpec[]> = {
  'files:preview': [a.string],
  'files:download': [a.string],
  'cfolders:reveal': [a.string],
  'client:pair': [a.string, a.string],
  'stem:exportState': [a.object],
  'settings:updateReleaseNotes': [a.object],
  'settings:updateUpdates': [a.object],
  // The MCP host's own channels (see desktop/local/index.ts). `approve` takes
  // the fingerprint the window drew its card from as well as the name: the whole
  // point of ④ is that a yes is given to a spec and not to a label, and the host
  // refuses one whose fingerprint has moved since.
  // (`mcpHost:localState` takes no arguments, so it is absent — see the contract
  // above.)
  'mcpHost:approve': [a.string, a.string],
  'mcpHost:reject': [a.string],
  'mcpHost:test': [a.string],
  // The exec host's switch ('execHost:localState' takes no arguments).
  'execHost:setEnabled': [a.boolean],
  // The harness host's switch ('harnessHost:localState' takes no arguments).
  'harnessHost:setEnabled': [a.boolean],
  // Folders this machine mirrors: the native picker's absolute paths.
  // ('mirror:localState' takes no arguments, so it is absent.)
  'mirror:addLocal': [a.stringArray],
  'quickchat:run': [a.object],
  'quickchat:handoff': [a.object]
};

/**
 * Why the sender is untrusted, or null when it is fine. Trusted = the top-level
 * frame of a window we created, showing our own renderer (packaged file:// or
 * the electron-vite dev server). Subframes and foreign origins never get IPC.
 */
export function senderProblem(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>): string | null {
  const frame = event.senderFrame;
  if (!frame) return 'no sender frame';
  if (frame !== event.sender.mainFrame) return 'IPC from a subframe';
  const url = frame.url;
  if (url.startsWith('file://')) return null;
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev && url.startsWith(dev)) return null;
  return `untrusted sender url ${url}`;
}

/** Channels already handed to ipcMain — a second handle() for one throws. */
const bound = new Set<string>();

/**
 * ipcMain.handle with the sender check and per-channel argument validation
 * applied before `invoke` runs. Rejected calls throw back to the renderer's
 * invoke() and are logged; the handler is never entered.
 */
function bind(channel: string, specs: ArgSpec[], invoke: (args: unknown[]) => unknown): void {
  if (bound.has(channel)) return;
  bound.add(channel);
  ipcMain.handle(channel, (event, ...args) => {
    const problem = senderProblem(event) ?? argsProblem(specs, args);
    if (problem) {
      log('ipc', `rejected ${channel}`, { problem });
      throw new Error(`Rejected IPC call to ${channel}: ${problem}.`);
    }
    return invoke(args);
  });
}

/** The client-owned handlers, looked up per call so a re-registration takes. */
const localHandlers = new Map<string, (event: CallerContext, ...args: unknown[]) => unknown>();

/**
 * Register a channel the DESKTOP answers (see the client-owned bucket above).
 * The handler takes the same first parameter as a server one, so a block of code
 * can move between the two sides unchanged — and it is always undefined here,
 * because a call from one of our own windows arrived over ipcMain and carries no
 * device identity at all. Nothing client-owned wants one: these channels are
 * about this machine, and this machine is the only thing that can call them.
 */
export function handleLocal(
  channel: string,
  handler: (event: CallerContext, ...args: never[]) => unknown
): void {
  localHandlers.set(channel, handler as (event: CallerContext, ...args: unknown[]) => unknown);
  bind(channel, LOCAL_IPC_ARGS[channel] ?? [], (args) => localHandlers.get(channel)!(undefined, ...args));
}

/**
 * Expose the channels the server told us it answers, forwarding each one over the
 * transport. Call once, with the list the proxy fetched at connect time — the
 * registry is the surface, so anything registered later would silently not be
 * reachable from a window.
 *
 * The arguments are validated twice, here and again on the far side, and neither
 * check is waste. This one is what makes a bad call read `Rejected IPC call to X:
 * …` in the renderer, exactly as it did before there was a wire; the server's is
 * the check every OTHER client relies on, and must not be skippable by whoever
 * happens to call in.
 */
export function bindServerChannels(
  channels: readonly string[],
  invoke: (channel: string, args: unknown[]) => Promise<unknown>
): void {
  for (const channel of channels) {
    bind(channel, ipcArgSpecs(channel), (args) => invoke(channel, args));
  }
  // Channels this build knows and the server may not. Bound AFTER the real ones,
  // so a server that does answer them wins; what is left is a window that can
  // still press the button, and gets a sentence instead of Electron's own "No
  // handler registered for 'mcp:setLocation'", which reads as a crash and names
  // nothing anybody can act on.
  for (const [channel, refusal] of Object.entries(NEEDS_A_NEWER_SERVER)) {
    if (channels.includes(channel)) continue;
    log('ipc', 'the server does not answer this channel', { channel });
    bind(channel, ipcArgSpecs(channel), () => {
      throw new Error(refusal);
    });
  }
}

/**
 * What to say when the server is older than this client.
 *
 * A desktop updates itself (or is updated by a package manager) while the server
 * it talks to is a container somebody has to pull, so client-newer-than-server is
 * the ordinary skew and not an exotic one. Only channels a WINDOW can reach
 * belong here: the host's own channels are called by the main process, which has
 * somewhere better to put the same news (see McpHostLocalState.unsupported).
 */
const NEEDS_A_NEWER_SERVER: Record<string, string> = {
  'mcp:setLocation':
    'This Stem server is older than this copy of Stem and cannot pin an MCP server to a computer. Update the server (or its container) and try again.'
};
