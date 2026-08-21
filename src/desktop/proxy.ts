import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { log } from '../server/log';
import {
  EXEC_REQUEST_FRAME,
  MCP_ASSIGNMENTS_FRAME,
  MCP_REQUEST_FRAME,
  type AuthUiEvent,
  type BackendEventEnvelope,
  type DeviceExecRequest,
  type DeviceMcpRequest,
  type ExecApprovalRequest,
  type HarnessApprovalRequest,
  type QuickChatSettings,
  type StartTurnInput,
  type TurnAttachment
} from '../shared/types';
import { uploadFile } from './file-transfer';
import { createOfflineCache } from './offline-cache';
import type { OAuthCourier } from './oauth-courier';
import { updateClientQuickChat, withClientSettings } from './settings';

// The desktop's half of the wire. Everything the renderer asks for that this
// machine cannot answer itself leaves through here as `POST /rpc`, and everything
// the server pushes arrives here on one SSE stream and is fanned out to the three
// windows.
//
// Embedded or remote, it is the same socket. The server usually runs in this very
// process (started at boot unless STEM_SERVER_URL points elsewhere), and there is
// deliberately NO short-circuit for that case: a turn typed at the desk is
// serialized, written to a loopback socket, read back and parsed, exactly as it
// would be from a VPS. A fast path only the embedded deployment takes is a path
// the remote deployment never gets tested on.
//
// ---------------------------------------------------------------------------
//
// Which side answers a channel. Three buckets, and the middle one is the reason
// this file exists rather than a switch somewhere:
//
// CLIENT-OWNED — never registered on the server, never on the wire. They act on
// THIS machine, so a server that might be elsewhere cannot answer them:
//
//   client:info                                  this client's device id and where
//                                                it is connected — the server has
//                                                no notion of who is calling
//   client:pair, client:useBuiltIn               changing which server this client
//                                                talks to. Answered here for the
//                                                obvious reason: the server being
//                                                replaced cannot broker it
//   releaseNotes:get, releaseNotes:markSeen,     the "what's new" popup, decided
//   settings:updateReleaseNotes                  from the version installed HERE
//                                                and the notes shipped beside it
//   updates:get, updates:check,                  whether a newer release exists
//   updates:install, settings:updateUpdates      and what to do about it — a fact
//                                                about the build installed HERE
//                                                (see desktop/updates.ts)
//   dialog:openFiles, dialog:openDirectory       native pickers
//   files:reveal, files:preview                  shell.showItemInFolder; preview
//                                                reads an image path that, by
//                                                construction, is on the client's
//                                                own disk (the `att.path` branch
//                                                of renderer/attachments.ts)
//   files:download                               GET /files/<rel>, saved into this
//                                                machine's Downloads folder and
//                                                shown there. Not an RPC: the file
//                                                streams, and where it lands is a
//                                                fact about this desk
//   cfolders:reveal, cfolders:revealWorkspace    shell.showItemInFolder. The PATH
//                                                comes from the server, so these
//                                                only mean anything when both
//                                                halves share a disk — and refuse
//                                                when they don't (desktop/local)
//   quickchat:*, main:reveal                     the overlay/HUD windows
//   quickchat:handoffSnapshot, renderer:ready    ipcMain.on, not invoke
//   getPathForFile                               webUtils, not a channel at all
//   pushes: quickchat:focus/adopt/sessionStarted/status/handoffRequest,
//           hud:playChime
//
//   They live in desktop/local/, desktop/quickchat/ and desktop/ipc-bridge.ts.
//
// WRAPPED — client behavior AND a server call, in a fixed order. They are
// declared as data below rather than special-cased at the call site on purpose:
// an ad-hoc `if (channel === …)` in the invoke path is how the next one appears
// without anybody deciding to add it.
//
//   chats:open                 the sidebar opening the overlay's live thread is an
//                              implicit hand-off. It runs HERE and FIRST — capture
//                              the snapshot, flip ownership through the barrier,
//                              hide the overlay, replay the buffered events — and
//                              only then is the open forwarded. Refusing it throws
//                              before anything is sent, which is how its two error
//                              strings still reach the renderer unchanged.
//   every settings:* channel   they all answer with the WHOLE settings document,
//   + auth:completeOnboarding  and part of that document lives on this machine
//                              (see ./settings.ts). So every one of them is
//                              merged on the way back — not just settings:get,
//                              or the next unrelated toggle would hand the
//                              renderer a document with the hotkey reset.
//   settings:updateQuickChat   the same merge, plus the two things that are not
//                              settings once they leave the file: the global
//                              accelerator (a grab on an OS) and the overlay's
//                              cached preferences. The machine's half of the
//                              patch is stored only after the server's half has
//                              landed, so a failed call changes neither side.
//   auth:providerLogin,        a sign-in ends in a browser, and the browser is
//   mcp:login                  HERE. Both do nothing but tell the OAuth courier
//                              that the authorization URL about to arrive on the
//                              push stream is one this machine asked for — the
//                              stream is a broadcast, and every other device
//                              paired to the same server sees it too.
//   backend:startTurn,         both carry paths to files on THIS disk, which is
//   files:add                  only a thing the server can read when it is on
//                              this disk too. When it isn't, the bytes are
//                              streamed up first and the paths are replaced with
//                              handles to them — see attachmentsForServer(). The
//                              REMOTE case only: a local install keeps handing
//                              over paths, because copying every pasted
//                              screenshot through loopback to prove a point
//                              would be a cost with nothing on the other side
//                              of it.
//
// SERVER-OWNED — everything else (~110 channels). The server's registry IS the
// surface; this client asks for it at connect time (GET /channels) rather than
// keeping a copy, which is what lets one build talk to an embedded server and a
// standalone one.
//
// ---------------------------------------------------------------------------
//
// One more thing passes through here, and this is the only file that sees
// enough to do it: the offline cache (./offline-cache.ts). Every chats:list and
// chats:open answer is written through on its way to the renderer, and read back
// — only in the branch below where fetch itself threw — when the server cannot
// be reached at all. Remote installs only; an embedded server cannot be absent
// from the process it is running in.
//
// The two questions this file must not confuse: `deps.remote` is whether the
// server is somebody else's machine, decided once at startup and never again;
// `reachable` below is whether it is answering right now. Remote decides whether
// there is a cache; reachable decides whether it is read.

/** Origin of an external server to use instead of starting one in-process. */
export const EXTERNAL_SERVER_URL = process.env.STEM_SERVER_URL?.trim() || null;

/**
 * Deliberately generous. An RPC is not a request to a web service — it is a
 * handler that may be waiting on pi to accept a prompt, on an OAuth callback, or
 * on a model download. The timeout exists so a wedged server cannot wedge the
 * renderer forever, not to bound normal work, so it is set well past anything
 * that legitimately happens.
 */
const RPC_TIMEOUT_MS = 10 * 60_000;

/** Reconnect backoff for the event stream. */
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 10_000;

/** Backend events that mean a turn is over, however it ended. */
const SETTLED_TURN_METHODS = new Set(['turn/completed', 'turn/failed', 'turn/aborted']);

/**
 * A channel with behavior on both sides of the wire. `before` runs on this
 * machine and can refuse the call by throwing; anything it RETURNS replaces the
 * arguments that go on the wire. `after` runs once the server has answered, with
 * what it answered, and anything it returns replaces that answer on the way to
 * the renderer. Either may return nothing to leave its side alone.
 */
export interface WrappedChannel {
  before?: (args: unknown[]) => Promise<unknown[] | void> | unknown[] | void;
  after?: (args: unknown[], result: unknown) => unknown;
}

const mergeSettingsAnswer: WrappedChannel = { after: (_args, result) => withClientSettings(result) };

/**
 * Channels whose answer is the entire settings document, and which therefore all
 * need this machine's half merged back into it. `settings:updateQuickChat` is
 * absent because it has more to do than merge, and gets its own entry below.
 */
const SETTINGS_CHANNELS = [
  'settings:get',
  'auth:completeOnboarding',
  'settings:updateWebSearch',
  'settings:updateEscapeAction',
  'settings:updateMemory',
  'settings:updateSkills',
  'settings:updateChats',
  'settings:updateTasks',
  'settings:updateDefaults',
  'settings:updateExec',
  'settings:updateHarness',
  'settings:updateCustomInstructions',
  'settings:updateRetrieval'
];

/**
 * This machine's MCP host: whatever runs the servers pinned to this device
 * (docs/mcp-device-pinning.md). A dependency rather than a call into a module
 * because there is nothing to run yet — index.ts wires a stub that refuses, and
 * step 3 replaces it with the real one without this file learning anything about
 * stdio processes or HTTP clients.
 *
 * Answering is the host's job, not this file's: the reply goes back as an
 * ordinary `mcpHost:result` RPC whenever it is ready, which may be two minutes
 * from now. Nothing here waits.
 */
export interface DeviceMcpHostBinding {
  onRequest(request: DeviceMcpRequest): void;
  /**
   * What this machine is asked to host changed on the server. Carries nothing —
   * the host asks for the new list itself — so there is no payload here to be
   * wrong about.
   */
  onAssignmentsChanged(): void;
}

/**
 * This machine's exec host: whatever runs the commands the server addresses to
 * this device (run_command's `device` target). Same seam, same reasons as
 * DeviceMcpHostBinding above — the reply goes back as an ordinary
 * `execHost:result` RPC whenever it is ready, and nothing here waits.
 */
export interface DeviceExecHostBinding {
  onRequest(request: DeviceExecRequest): void;
}

export interface ProxyDeps {
  /** Origin of the server, e.g. `http://127.0.0.1:52413`. */
  url: string;
  /** This device's bearer token (the `desktop` role). */
  token: string;
  /**
   * False when the server runs in this very process, and therefore reads this
   * machine's disk. The one place that distinction changes what goes on the wire
   * (see the WRAPPED table above); everything else here is identical either way.
   */
  remote: boolean;
  /** Push to the main window through its ready-queue (see RendererPushQueue). */
  sendToMain(channel: string, payload: unknown): void;
  /** Push to the Quick Chat overlay window. */
  sendToOverlay(channel: string, payload: unknown): void;
  /** Bring the overlay back when it owns `threadId` (approval cards). */
  revealIfOwns(threadId: string | null | undefined): void;
  /** Hand a backend thread event to the overlay / HUD / main-window routing. */
  routeBackendEvent(event: BackendEventEnvelope): void;
  /** Raise + focus the main window (notify_user prominence). */
  revealMainWindow(): void;
  /** OS-level attention nudge (dock bounce / taskbar flash). */
  requestAttention(): void;
  /** The implicit Quick Chat hand-off, run before a thread is opened. */
  threadOpened(threadId: string): Promise<void>;
  /**
   * The stream came back with a gap too old to replay: everything this client
   * believes about the open thread and the chat list may be stale, and only a
   * refetch can settle it.
   */
  resync(): void;
  /**
   * Which threads the server says are still running, as of the instant this
   * stream opened. Authoritative in both directions — a thread absent from the
   * list is settled — which is what stops a turn that finished while the client
   * was away from spinning forever.
   */
  liveTurns(turns: { threadId: string; turnId: string | null }[]): void;
  /**
   * The server started or stopped answering. Fired on transitions only, and
   * decided by the transport rather than by anything in an answer: a 500 is a
   * server that is up and unhappy, which is not the same fact and must not raise
   * the same banner. Drives the offline banner, the disabled composer, and the
   * "needs the server" states in memory / skills / search.
   */
  connection(reachable: boolean): void;
  /** Catches OAuth callbacks for a server that is not on this machine. */
  oauthCourier: OAuthCourier;
  /** Runs the MCP servers pinned to this device. See DeviceMcpHostBinding. */
  mcpHost: DeviceMcpHostBinding;
  /** Runs the commands addressed to this device. See DeviceExecHostBinding. */
  execHost: DeviceExecHostBinding;
  /** Quick Chat settings were persisted: apply the parts that are not settings. */
  applyQuickChatSettings(patch: Partial<QuickChatSettings>, next: QuickChatSettings): void;
}

export interface ServerProxy {
  /** Ask what we may call and open the event stream. Resolves once both are up. */
  start(): Promise<string[]>;
  /** Call a server channel: wrapped client behavior, then POST /rpc. */
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  /** Drop the stream and stop reconnecting (quit; tests). */
  close(): void;
}

/**
 * `node:http` and `node:https` are separate modules that refuse each other's
 * URLs outright — `request()` throws ERR_INVALID_PROTOCOL rather than following
 * the scheme. `fetch` hides that, which is why only the hand-rolled event-stream
 * reader below has to care: everything else here goes through `fetch`. Same
 * dispatch as file-transfer.ts, for the same reason.
 */
function openStream(url: string, options: Parameters<typeof httpRequest>[1], onRes: Parameters<typeof httpRequest>[2]) {
  return (url.startsWith('https:') ? httpsRequest : httpRequest)(url, options, onRes);
}

export function createServerProxy(deps: ProxyDeps): ServerProxy {
  const base = deps.url.replace(/\/$/, '');
  const auth = `Bearer ${deps.token}`;

  // Only a client whose server is elsewhere can be without one. See the note
  // above, and the longer argument in offline-cache.ts.
  const cache = createOfflineCache({ enabled: deps.remote });

  /**
   * Whether the server is answering. Starts optimistic — nothing has failed yet
   * — and only ever changes on evidence from the transport: a fetch or a socket
   * that threw, or one that did not.
   */
  let reachable = true;

  function setReachable(next: boolean): void {
    // Tearing the stream down on quit produces exactly the error a lost server
    // does. Nobody needs to be told the connection went away as the app closes.
    if (closed || reachable === next) return;
    reachable = next;
    log('proxy', next ? 'the server is answering again' : 'the server has stopped answering');
    deps.connection(next);
    // Coming back is the moment to find out what was missed. Bounded to the
    // twenty-five most recent threads that actually changed, and debounced, so a
    // link that flaps does not turn into twenty-five fetches per flap.
    if (next) cache.schedulePrefetch(serverCall);
  }

  const signInStarted: WrappedChannel = { before: () => deps.oauthCourier.expectSignIn() };

  /**
   * Replace every on-disk path in a set of attachments with a handle to bytes the
   * server now has. Pasted images (`dataBase64`) already travel in the envelope
   * and are left exactly as they are — they are small, they are already on the
   * wire, and uploading them separately would be strictly more work.
   *
   * A failure here is deliberately fatal to the call. The alternative is sending
   * the message with the attachment quietly missing, which reads to the user as
   * the assistant ignoring the thing they attached; throwing instead leaves the
   * message in the composer, with the reason on screen, ready to send again.
   */
  async function attachmentsForServer(atts: TurnAttachment[]): Promise<TurnAttachment[]> {
    return Promise.all(
      atts.map(async (att) => {
        if (!att.path) return att;
        return { ...att, path: await uploadFile({ url: base, token: deps.token }, att.path) };
      })
    );
  }

  /** The remote half of `backend:startTurn` and `files:add`; absent when local. */
  const uploadPaths: Record<string, WrappedChannel> = {
    'backend:startTurn': {
      before: async ([input]) => {
        const turn = input as StartTurnInput;
        if (!turn?.attachments?.length) return;
        return [{ ...turn, attachments: await attachmentsForServer(turn.attachments) }];
      }
    },
    'files:add': {
      before: async ([paths, subdir]) => {
        const list = paths as string[];
        if (!Array.isArray(list) || list.length === 0) return;
        const creds = { url: base, token: deps.token };
        return [await Promise.all(list.map((path) => uploadFile(creds, path))), subdir];
      }
    }
  };

  const wrapped: Readonly<Record<string, WrappedChannel>> = {
    'chats:open': {
      before: ([threadId]) => deps.threadOpened(threadId as string)
    },
    'auth:providerLogin': signInStarted,
    'mcp:login': signInStarted,
    ...(deps.remote ? uploadPaths : {}),
    ...Object.fromEntries(SETTINGS_CHANNELS.map((c) => [c, mergeSettingsAnswer])),
    'settings:updateQuickChat': {
      after: async ([patch], result) => {
        const p = patch as Partial<QuickChatSettings>;
        await updateClientQuickChat(p);
        const next = await withClientSettings(result);
        deps.applyQuickChatSettings(p, next.quickChat);
        return next;
      }
    }
  };

  // ---- POST /rpc ----

  async function post(channel: string, args: unknown[], signal?: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${base}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify({ channel, args }),
        // A caller's own signal (a cancellable prefetch) on top of the timeout
        // every call gets. Either one aborting aborts the request.
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(RPC_TIMEOUT_MS)])
          : AbortSignal.timeout(RPC_TIMEOUT_MS)
      });
    } catch (e) {
      // Nothing on the other end answered — as opposed to answering badly. This
      // is the ONLY place the cache is allowed to speak, and the reason is the
      // whole design: a server that replies with an error is a server that is
      // up, and its answer is the truth however unwelcome.
      if (signal?.aborted) throw e;
      setReachable(false);
      const cached = cache.replay(channel, args);
      if (cached !== undefined) return cached;
      // Distinct from a call the server answered, and the only error shape here
      // the renderer could not have seen before the split.
      throw new Error(`Stem's server is unreachable: ${String((e as Error)?.message ?? e)}`);
    }
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: unknown; error?: string }
      | null;
    // Anything with a status line came from the server, including a 401 and a
    // 500. It is up.
    setReachable(true);
    if (res.ok && body?.ok) {
      // The server answered, so it is up. That does not make the stream healthy —
      // a dead stream means missed events — so re-open it now rather than waiting
      // out the backoff.
      if (!streamOpen) retryNow();
      cache.record(channel, args, body.result);
      return body.result;
    }
    // The server's own message, verbatim, so the renderer's error handling cannot
    // tell which side of the wire answered. The guard's `Rejected local call to X:
    // …` wording arrives here intact and is rethrown unchanged.
    throw new Error(body?.error ?? `${channel} failed (HTTP ${res.status})`);
  }

  /** post() as the cache's catch-up run wants it: cancellable, nothing wrapped. */
  const serverCall = (channel: string, args: unknown[], signal: AbortSignal): Promise<unknown> =>
    post(channel, args, signal);

  async function invoke(channel: string, args: unknown[]): Promise<unknown> {
    const hooks = wrapped[channel];
    // A throw from `before` never reaches the wire — that is what lets a refused
    // Quick Chat hand-off cancel the open it was called for, and what makes a
    // failed upload a failed send rather than a send without its attachment.
    let outgoing = args;
    if (hooks?.before) {
      const replaced = await hooks.before(args);
      if (Array.isArray(replaced)) outgoing = replaced;
    }
    const result = await post(channel, outgoing);
    if (!hooks?.after) return result;
    const replacement = await hooks.after(args, result);
    return replacement === undefined ? result : replacement;
  }

  // ---- GET /events ----

  let stream: ReturnType<typeof httpRequest> | null = null;
  let streamOpen = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let attempt = 0;
  let closed = false;
  /**
   * The last frame id this client has actually seen, sent back as Last-Event-ID
   * so the server can replay what was missed. A browser's EventSource keeps this
   * bookmark by itself; this reader is hand-rolled (SSE over node:http, so the
   * bearer token can ride in a header — EventSource has no way to set one), so
   * the bookkeeping is ours.
   *
   * In memory only, on purpose: a restarted client re-reads everything anyway,
   * and a bookmark that outlived the process it belongs to would ask for a replay
   * of a stream nobody is watching any more.
   */
  let lastEventId: string | null = null;

  function deliver(raw: string): void {
    let frame: { channel?: unknown; payload?: unknown };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return; // a truncated frame is not worth taking the app down for
    }
    if (typeof frame.channel !== 'string') return;
    fanOut(frame.channel, frame.payload);
  }

  /**
   * A frame about the stream rather than about anything that happened. They are
   * told apart by SSE's own `event:` field, which a push never carries — so
   * neither can ever be mistaken for the other, however odd the payload.
   */
  function control(name: string, raw: string): void {
    let data: { head?: unknown; liveTurns?: unknown; execApprovals?: unknown; harnessApprovals?: unknown } = {};
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      return;
    }
    // A call for the MCP servers that run on THIS machine. It arrives as a
    // control frame for two reasons that are really one: it was addressed to
    // this device, so it carries no `id:` and must not move the bookmark — the
    // next reconnect has to resume from the last real frame, not from a request
    // that was never a position in the stream — and it is not on the replay ring
    // for the same reason, so there is nothing to resume to anyway.
    if (name === MCP_REQUEST_FRAME) {
      const request = asMcpRequest(data);
      // A frame we cannot read is dropped in silence: without a requestId there
      // is nothing to answer, and the server's own timeout is what covers it.
      if (request) deps.mcpHost.onRequest(request);
      return;
    }
    // mcp.json changed in a way that changes what THIS machine runs — and it was
    // changed somewhere else: another window, a phone, the assistant. Addressed
    // and off the ring for the same reason a request is; nothing to parse,
    // because the host goes and asks.
    if (name === MCP_ASSIGNMENTS_FRAME) {
      deps.mcpHost.onAssignmentsChanged();
      return;
    }
    // A command for THIS machine. Addressed and off the ring exactly as an MCP
    // request is; a frame we cannot read is dropped in silence for the same
    // reason — without a requestId there is nothing to answer, and the server's
    // own timeout covers it.
    if (name === EXEC_REQUEST_FRAME) {
      const request = asExecRequest(data);
      if (request) deps.execHost.onRequest(request);
      return;
    }
    if (name === 'snapshot') {
      const turns = data.liveTurns;
      // Absent (a server with nothing to say) leaves the client's own view alone;
      // present — even empty — is the whole truth about what is running.
      if (Array.isArray(turns)) {
        deps.liveTurns(turns as { threadId: string; turnId: string | null }[]);
      }
      // Approval cards raised while this client was away, or during a gap in the
      // stream. Replayed as ordinary request frames — the card queues dedupe by
      // id, so a card we already have is not shown twice — because a request
      // frame is exactly what this is: the same question, still unanswered.
      const approvals = data.execApprovals;
      if (Array.isArray(approvals)) {
        for (const request of approvals as ExecApprovalRequest[]) {
          if (!request || typeof request.id !== 'string') continue;
          deps.sendToMain('exec:approvalRequest', request);
          deps.sendToOverlay('exec:approvalRequest', request);
        }
      }
      // Harness cards replay the same way, deduped by id in the card queues.
      const harnessApprovals = data.harnessApprovals;
      if (Array.isArray(harnessApprovals)) {
        for (const request of harnessApprovals as HarnessApprovalRequest[]) {
          if (!request || typeof request.id !== 'string') continue;
          deps.sendToMain('harness:approvalRequest', request);
          deps.sendToOverlay('harness:approvalRequest', request);
        }
      }
      return;
    }
    if (name === 'resync') {
      // Move the bookmark to where the server says we now stand BEFORE refetching:
      // the refetch is what closes the gap, and asking to replay across it again
      // on the next drop would only repeat work already done.
      if (typeof data.head === 'string') lastEventId = data.head;
      log('proxy', 'the server asked for a resync');
      deps.resync();
    }
  }

  /**
   * The frame as a request, or null when it is not one. Checked rather than
   * cast: everything else on this stream is state the client renders, and this
   * one ends in a process being spawned or a URL being opened on this machine,
   * so the shape is established before it is handed anywhere.
   */
  function asExecRequest(data: unknown): DeviceExecRequest | null {
    const frame = data as Partial<DeviceExecRequest> | null;
    if (!frame || typeof frame.requestId !== 'string' || !frame.requestId) return null;
    if (typeof frame.command !== 'string' || !frame.command) return null;
    if (typeof frame.timeoutMs !== 'number' || !Number.isFinite(frame.timeoutMs)) return null;
    return {
      requestId: frame.requestId,
      threadId: typeof frame.threadId === 'string' ? frame.threadId : '',
      command: frame.command,
      timeoutMs: frame.timeoutMs,
      ...(typeof frame.cwd === 'string' && frame.cwd ? { cwd: frame.cwd } : {})
    };
  }

  function asMcpRequest(data: unknown): DeviceMcpRequest | null {
    const frame = data as Partial<DeviceMcpRequest> | null;
    if (!frame || typeof frame.requestId !== 'string' || !frame.requestId) return null;
    if (typeof frame.server !== 'string' || !frame.server) return null;
    if (frame.op !== 'tools' && frame.op !== 'call') return null;
    if (frame.op === 'call' && (typeof frame.tool !== 'string' || !frame.tool)) return null;
    return {
      requestId: frame.requestId,
      server: frame.server,
      op: frame.op,
      ...(frame.tool ? { tool: frame.tool } : {}),
      ...(frame.args === undefined ? {} : { args: frame.args })
    };
  }

  /**
   * Which of the desktop's three windows a push is for. This is the table that
   * used to sit behind a direct callback in index.ts; the routing decision and
   * its reasons are unchanged, it just reads from a socket now.
   */
  function fanOut(channel: string, payload: unknown): void {
    switch (channel) {
      // The backend's own event stream. The overlay may own the thread, a
      // hand-off may be buffering — all of that is client state, so the decision
      // is made here and not by the server (see quickchat/index.ts).
      case 'backend:event': {
        const event = payload as BackendEventEnvelope;
        // MCP's OAuth sign-in announces its URL down here rather than on
        // `auth:event` — a different flow, in a different file, with the same
        // loopback callback problem (see ./oauth-courier.ts).
        if (event?.method === 'mcp/login/url') {
          const url = (event.params as { url?: unknown } | undefined)?.url;
          if (typeof url === 'string') deps.oauthCourier.offer(url);
        }
        // A turn that has just ended is a thread whose transcript has changed,
        // and the cache's copy of it is now one answer short. Rather than
        // reassemble the reply from the deltas that went past — which is the
        // renderer's job, done properly, and would be a second implementation of
        // it living in the main process — ask again, debounced, so the thread you
        // were talking in a minute ago is the one that is readable on the train.
        if (SETTLED_TURN_METHODS.has(event?.method)) cache.schedulePrefetch(serverCall);
        deps.routeBackendEvent(event);
        return;
      }
      // Provider sign-in progress. The courier reads the one event that carries
      // an address a browser will be sent to; everything about the push is
      // otherwise unchanged, including that the window still gets it.
      case 'auth:event': {
        const event = payload as AuthUiEvent | undefined;
        if (event?.kind === 'auth-url') deps.oauthCourier.offer(event.url);
        deps.sendToMain(channel, payload);
        return;
      }
      // Things only a machine with a screen can do. They arrive as pushes rather
      // than as calls into this process because a server has no window to raise.
      case 'client:revealMainWindow':
        deps.revealMainWindow();
        return;
      case 'client:requestAttention':
        deps.requestAttention();
        return;
      // Approval cards: both surfaces mount them, and the overlay hides itself
      // while a turn runs — bring it back when the request belongs to its thread,
      // or mounting the card would not actually make the confirmation visible.
      case 'exec:approvalRequest':
      case 'harness:approvalRequest':
      case 'mcp:adminApproval':
      case 'instructions:approvalRequest':
      case 'skills:approvalRequest':
        deps.revealIfOwns((payload as { threadId?: string } | undefined)?.threadId);
        deps.sendToMain(channel, payload);
        deps.sendToOverlay(channel, payload);
        return;
      // Resolutions and catalog/status changes: rendered by both surfaces, and
      // harmlessly ignored by whichever one has no listener mounted.
      case 'exec:approvalArmed':
      case 'exec:approvalResolved':
      case 'harness:approvalArmed':
      case 'harness:approvalResolved':
      case 'mcp:adminApprovalResolved':
      case 'instructions:approvalResolved':
      case 'skills:approvalResolved':
      case 'mcp:changed':
      case 'mcp:status':
      case 'skills:changed':
        deps.sendToMain(channel, payload);
        deps.sendToOverlay(channel, payload);
        return;
      default:
        // Everything else is main-window furniture: sign-in progress, the task
        // feed and its alerts, background-activity and model-download status.
        deps.sendToMain(channel, payload);
    }
  }

  function clearRetry(): void {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleReconnect(): void {
    if (closed) return;
    clearRetry();
    attempt += 1;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  /**
   * Open the stream. Every handler checks it is still the current request: a
   * replaced one can fire once more on its way out, and a stale error must not
   * tear down a healthy connection.
   */
  function connect(): void {
    if (closed) return;
    clearRetry();
    stream?.destroy();
    streamOpen = false;
    const req = openStream(
      `${base}/events`,
      {
        method: 'GET',
        headers: {
          authorization: auth,
          accept: 'text/event-stream',
          // The one header that turns a reconnect into a resumption. Omitted on a
          // first connect, which is how the server knows there is no gap to fill.
          ...(lastEventId ? { 'last-event-id': lastEventId } : {})
        }
      },
      (res) => {
        if (stream !== req) return;
        if (res.statusCode !== 200) {
          // Refused, but refused BY something — the server is up and saying no,
          // which is not the offline case.
          setReachable(true);
          // 401 means this device's token is not in the registry. There is no
          // pairing UX to fall back to on the desktop (unlike the phone, which
          // stops and asks), so this is logged and retried: a server that
          // re-read its registry can still recover the connection.
          log('proxy', 'event stream refused', { status: res.statusCode });
          res.resume();
          stream = null;
          scheduleReconnect();
          return;
        }
        attempt = 0;
        streamOpen = true;
        setReachable(true);
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', (chunk: string) => {
          if (stream !== req) return;
          buffer += chunk;
          let split = buffer.indexOf('\n\n');
          while (split !== -1) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            // Comment lines (`: keepalive`) and the `retry:` preamble carry no
            // `data:` and fall out here on their own.
            const lines = block.split('\n');
            const data = lines
              .filter((line) => line.startsWith('data: '))
              .map((line) => line.slice(6))
              .join('\n');
            const name = lines.find((line) => line.startsWith('event: '))?.slice(7);
            const id = lines.find((line) => line.startsWith('id: '))?.slice(4);
            if (data && name) control(name, data);
            else if (data) {
              deliver(data);
              // Bookmark AFTER delivering, never before: a frame that is recorded
              // as seen and then lost on the way to a window is a frame the server
              // will never send again.
              if (id) lastEventId = id;
            }
            split = buffer.indexOf('\n\n');
          }
        });
        const dropped = (): void => {
          if (stream !== req) return;
          stream = null;
          streamOpen = false;
          scheduleReconnect();
        };
        res.on('end', dropped);
        res.on('error', dropped);
        res.on('close', dropped);
      }
    );
    stream = req;
    req.on('error', () => {
      if (stream !== req) return;
      stream = null;
      streamOpen = false;
      // A connect that could not even be made. Note this fires on the RECONNECT,
      // not on the drop that caused it: a stream ending is routine (a proxy
      // recycling a connection, a laptop's wifi handing over) and the honest
      // test of whether the server is gone is whether we can get back to it.
      setReachable(false);
      scheduleReconnect();
    });
    req.end();
  }

  function retryNow(): void {
    if (closed || streamOpen) return;
    attempt = 0;
    connect();
  }

  /**
   * What this client may call, asked once at connect time.
   *
   * This is also the first thing a launch does, which makes it the first thing
   * that fails when Stem is opened somewhere with no signal — and until Phase 2
   * it failed by taking the app down, which is a poor answer for a client whose
   * whole reason to keep a cache is to be useful in exactly that moment. So a
   * remote client that has connected before falls back to the list it was given
   * last time. Every one of those channels still goes over the wire and still
   * fails; the handful that can be answered from the cache are answered, and the
   * rest say the server is unreachable, which is the truth.
   */
  async function channels(): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(`${base}/channels`, {
        headers: { authorization: auth },
        signal: AbortSignal.timeout(30_000)
      });
    } catch (e) {
      // Nothing answered. The same distinction post() makes, for the same
      // reason: a server that refuses is a server that is there.
      const remembered = cache.cachedChannels();
      if (!remembered) throw e;
      log('proxy', 'starting offline against the last known channel list', {
        channels: remembered.length
      });
      setReachable(false);
      return remembered;
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: string[] } | null;
    setReachable(true);
    if (!res.ok || !body?.ok || !Array.isArray(body.result)) {
      throw new Error(`Stem's server would not list its channels (HTTP ${res.status})`);
    }
    cache.rememberChannels(body.result);
    return body.result;
  }

  return {
    async start() {
      const list = await channels();
      connect();
      // The catch-up run for an ordinary launch. setReachable only fires on
      // transitions, and a client that starts connected never has one.
      if (reachable) cache.schedulePrefetch(serverCall);
      return list;
    },
    invoke,
    close() {
      closed = true;
      clearRetry();
      stream?.destroy();
      stream = null;
      streamOpen = false;
      // Nothing in flight for a cache may outlive the app that wanted it.
      cache.close();
    }
  };
}
