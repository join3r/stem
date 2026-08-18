import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { Transform, type Readable } from 'node:stream';
import { log } from '../log';
import { presentedToken, requestOriginProblem, type DeviceRole, type OriginPolicy } from './auth';
import type { DeviceKind } from '../../shared/types';

// Stem's transport: a node:http server bound to 127.0.0.1 — or to a Unix socket,
// which is narrower still. Every client reaches the server through this file and
// nothing else.
//
// Binding loopback is the outermost layer of the security model — nothing but a
// process on this machine can open the socket at all, so a misconfigured tunnel
// cannot expose it. Never bind 0.0.0.0: the address is an option (a standalone
// stem-server takes it from the environment), and LOOPBACK_HOSTS is what keeps
// that option from becoming a public listener.
//
// The deployed configuration takes that one step further and binds no TCP port
// at all: `socketPath` puts the listener on a Unix domain socket in a volume the
// container shares with Caddy, so inside the container there is nothing for a
// port scan to find and no interface to misconfigure. It is a widening of the
// bind guard, not a hole in it — a filesystem path cannot name a network
// interface, so the set of things this server will answer on is still "this
// machine only", by a mechanism the kernel enforces rather than a header we read.
//
// Six routes:
//   POST /rpc      {channel, args}  → {ok:true, result} | {ok:false, error}
//   GET  /events                    → Server-Sent Events, server → client
//   GET  /channels                  → what this client may invoke
//   POST /upload?name=…  raw bytes  → {handle}, to pass where a path would go
//   GET  /files/<rel>               → the bytes of one file in the Files folder
//   POST /pair     {code, kind?}    → {deviceId, token}, the ONE unauthenticated one
//
// The two file routes exist because a path is not portable. Everything else a
// client sends fits in an RPC envelope; a file does not — an attachment must not
// have to be base64 inside a JSON body to reach the server, and a file the user
// wants back must not have to come the other way in one. So they stream, and they
// are the only routes here with a body that is not JSON.
//
// They are not a file server. /files serves one folder — the Files place, which
// is the folder the user themselves put things in — and the containment rule for
// it lives in files/store.ts with the handlers that already enforce it, not in a
// second copy here. Everything else on this machine is unreachable through this
// server except through a registered channel, which is how it was when the only
// route was /rpc, and how it stays.
//
// This server used to serve the phone's web bundle out of dist/renderer, with a
// traversal guard and a dev-mode proxy to Vite behind it; that client is gone,
// every remaining client loads its own UI off its own disk, and a static file
// server nobody reads from is only ever a way to leak a file. Anything that is
// not one of the six routes is a 404.
//
// SSE rather than a WebSocket on purpose: it is one-directional (which is exactly
// the shape of the push side), it survives a reverse proxy without an upgrade
// dance — and node:http can serve it with no new dependency, which a WebSocket
// could not. It also comes with resumption built into the protocol: every frame
// carries an `id:`, a client echoes the last one back as `Last-Event-ID`, and
// GET /events answers it out of a bounded buffer of what it recently sent. A gap
// that reaches further back than the buffer is answered with a `resync` control
// frame instead of a partial replay — see the buffer's own comment below.
//
// Everything security-relevant is injected (authentication, dispatch, the origin
// policy) so this file stays a transport and the tests can drive it end to end
// over a real socket.

/** 25 MB: base64-encoded photo attachments ride POST /rpc as startTurn arguments. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

/** A pairing code and its JSON wrapper. Unauthenticated, so it gets its own cap. */
const MAX_PAIR_BODY_BYTES = 1024;

/**
 * 100 MB for one uploaded file. Four times what an RPC body may be, because an
 * upload is the route that exists precisely so a big file does NOT have to ride
 * in an RPC — but still a cap, and enforced twice: the declared Content-Length is
 * refused before a byte is read, and a sender that lies about it (or sends
 * chunked) is cut off at the line. Uploads are authenticated, so this is not a
 * defence against a stranger; it is what stops one wrong drag from filling the
 * disk of a server that may be a small VPS.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Keepalive cadence for idle SSE streams. Comfortably under the 60s idle timeout
 * a reverse proxy typically applies — an idled-out stream would silently stop
 * delivering turns with the phone still showing "connected".
 */
const SSE_KEEPALIVE_MS = 25_000;

/** How long the client should wait before reconnecting a dropped stream. */
const SSE_RETRY_MS = 3_000;

/**
 * How much of the recent past a returning client can be handed back.
 *
 * Two bounds, because either one alone has a shape that breaks it. Frames alone
 * would let a thousand tool results (or one pasted screenshot echoed back) sit in
 * memory; bytes alone would let a torrent of two-character deltas grow the array
 * without limit. Whichever bites first evicts from the front.
 *
 * 1,000 frames is roughly two or three turns of streamed answer — comfortably
 * more than a reconnect takes, since the client's backoff tops out at ten
 * seconds. 4 MB is not a size the buffer is expected to reach: a typical turn's
 * frames come to a couple of hundred kilobytes, and the cap exists for the frame
 * that is pathologically large rather than for the ordinary case.
 *
 * Everything past those bounds is not a data loss, it is a `resync`: the client
 * refetches, which is strictly more correct than a partial replay and only
 * costs a round trip.
 */
const REPLAY_MAX_FRAMES = 1_000;
const REPLAY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The only addresses this server will bind, enforced rather than documented.
 *
 * A standalone `stem-server` takes its bind address from the environment, which
 * is exactly the knob somebody reaches for when they want to run it on a VPS —
 * so the refusal has to live here, at the socket, where no caller can route
 * around it. Stem speaks no TLS; being reachable from elsewhere is a proxy's job
 * (Caddy in the deployed configuration), and the proxy talks to this loopback
 * socket. That stays true even on a public domain, which is the point: there is
 * no configuration in which Stem itself answers a public interface.
 *
 * A fronted deployment does need one thing from us — its own hostname arrives in
 * the Host header instead of our port — and that is what `extraHosts` is for.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * The longest a Unix socket path may be, near enough. The kernel's `sun_path` is
 * 108 bytes on Linux and 104 on macOS, and a path past it fails deep in bind()
 * with an errno nobody reads as "your path is too long" — so it is checked here,
 * where the message can say which path and how long it was.
 */
const MAX_SOCKET_PATH = 100;

/**
 * Why this cannot be a socket path, or null when it can.
 *
 * Absolute only, and that is load-bearing rather than tidy: `server.listen()`
 * takes a string as a pipe path ONLY when it does not parse as a number, so
 * `listen('8080')` opens a TCP port on every interface. Requiring a leading
 * slash (or a Windows named pipe, which Node treats the same way) is what makes
 * "this is a filesystem path" a fact instead of a hope, and keeps the one bind
 * that skips the loopback check from being reachable with a port in its hand.
 */
function socketPathProblem(path: string): string | null {
  if (!path.startsWith('/') && !path.startsWith('\\\\.\\pipe\\')) {
    return `refusing to bind ${path}: a socket path must be absolute. A relative or numeric value ` +
      'would be taken for a TCP port, which is exactly the bind this server does not do.';
  }
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
    return `refusing to bind ${path}: that is ${Buffer.byteLength(path)} bytes, and the kernel's limit ` +
      `for a socket path is about ${MAX_SOCKET_PATH}. Put it somewhere shorter — /run/stem/stem.sock.`;
  }
  return null;
}

/**
 * Clear a socket file that nothing is listening on.
 *
 * A Unix socket is a file, and Node removes it on a clean close — but a container
 * that is killed rather than stopped (an OOM, `docker kill`, a host reboot) leaves
 * one behind in the shared volume, and the next boot's bind fails with EADDRINUSE
 * for a socket with no server on the other end. So: connect to it. A refused
 * connection means the file has outlived its process and can go; a connection that
 * is accepted (or hangs) means something IS serving there, and taking the file
 * away from it would be the worse outcome by far.
 */
async function clearStaleSocket(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const live = await new Promise<boolean>((resolveLive) => {
    const probe = connect(path);
    const settle = (answer: boolean): void => {
      probe.destroy();
      resolveLive(answer);
    };
    probe.once('connect', () => settle(true));
    probe.once('error', () => settle(false));
    // Accepted-but-silent counts as alive: the only safe way to be wrong here is
    // to refuse to start rather than to unlink somebody else's listener.
    probe.setTimeout(2_000, () => settle(true));
  });
  if (live) {
    throw new Error(
      `refusing to bind ${path}: something is already listening on it. Another Stem is running — ` +
        'stop it before starting this one.'
    );
  }
  log('transport', 'removed a socket left behind by a previous run', { path });
  await rm(path, { force: true });
}

/** Who a request turned out to be, resolved once per request from its token. */
export interface DeviceIdentity {
  /** The registry id, so a stream can be torn down when that device is revoked. */
  id: string;
  role: DeviceRole;
}

/** What a redeemed pairing code hands back to the device that spent it. */
export interface PairingGrant {
  deviceId: string;
  token: string;
}

export interface TransportServerOptions {
  /** Loopback port to bind. 0 picks a free one (callers read it back off `port`). */
  port: number;
  /** Loopback address to bind. Defaults to 127.0.0.1; see LOOPBACK_HOSTS. */
  host?: string;
  /**
   * Bind this Unix socket instead of a TCP port — the deployed configuration,
   * where the only thing on the other end is Caddy in the next container.
   * `port` and `host` are then unused and `port` reads back 0, because there
   * genuinely is no port: a client that cannot open the file cannot reach this
   * server at all.
   */
  socketPath?: string;
  /**
   * Constant-time bearer check that also answers WHO. Returns the device the
   * token belongs to, or null when nothing matches — so authentication and
   * authorization are decided from one lookup and can never disagree.
   */
  authenticate(presented: string | null): DeviceIdentity | null | Promise<DeviceIdentity | null>;
  /**
   * Runs a registered channel — guard.ts's dispatchLocal. `caller` is the device
   * this request authenticated as, passed through because a handler cannot
   * otherwise know: every other input on this route comes from the body, which is
   * the client's to write. It is an identity, not a permission — see the registry
   * comment in ipc/guard.ts, which is still the whole of the authorization story.
   */
  dispatch(channel: string, args: unknown[], caller: { deviceId: string }): Promise<unknown>;
  /** Every channel registered on the server, for GET /channels to answer with. */
  registeredChannels(): readonly string[];
  /**
   * Spend a pairing code. Rejecting with a `status` property picks the response
   * code (401 for a bad code, 429 once the attempt lockout has tripped); anything
   * else is a 500. Omitted entirely = no /pair route at all, which is what a
   * deployment that only ever pairs off shared disk should do.
   */
  pair?(code: string, kind: DeviceKind): Promise<PairingGrant>;
  /**
   * Take one uploaded file and answer with the handle that stands for it. `body`
   * is already capped at MAX_UPLOAD_BYTES and errors past it, so an
   * implementation only has to write what it is given and clean up if that
   * throws. Omitted = no /upload route.
   */
  stageUpload?(name: string, body: Readable): Promise<UploadHandle>;
  /**
   * Resolve a path from GET /files/<rel> to something safe to send, or null when
   * it names anything the client is not entitled to. THE authorization decision
   * for that route: this file does no containment checking of its own, because a
   * second check written here is a second check that can disagree with the one
   * the `files:*` channels already enforce. Omitted = no /files route.
   */
  openDownload?(rel: string): Promise<DownloadTarget | null>;
  /**
   * What is happening right now, handed to every client the moment its stream
   * opens. Whatever this returns is sent verbatim as the `snapshot` control
   * frame — the transport does not read it, so what counts as "right now" stays
   * a question for the layer that knows about turns (see server/live-turns.ts).
   *
   * MUST be synchronous. The connect handshake writes the snapshot, the replay
   * and the client's registration in one uninterrupted turn of the event loop,
   * which is the whole reason a frame cannot slip between them; an await here
   * would open exactly that window. Omitted = no snapshot frame.
   */
  connectSnapshot?(): unknown;
  /** Host values accepted beyond loopback and the tailnet. */
  extraHosts?: readonly string[];
}

/** What an upload is called afterwards, and what it cost. */
export interface UploadHandle {
  handle: string;
  name: string;
  size: number;
}

/** A file the server has decided this client may have, resolved to its bytes. */
export interface DownloadTarget {
  /** Absolute, already checked, already symlink-resolved. */
  path: string;
  /** Basename to suggest, for the client's own save dialog or filename. */
  name: string;
  size: number;
}

/** One server → client push, already stamped with its place in the stream. */
export interface PushEvent {
  /**
   * Monotonic, per-server-run, and the caller's to keep so — it is what a
   * reconnecting client resumes from. On the wire it is prefixed with this run's
   * epoch (see `epoch` below), so an id minted by a server that has since been
   * restarted is recognisable as one rather than mistaken for a position in the
   * current stream.
   */
  id: number;
  channel: string;
  payload: unknown;
}

export interface TransportServer {
  /** The bound port (resolved, so a `port: 0` caller learns what it got), or 0 on a socket. */
  readonly port: number;
  /** The bound Unix socket, or null when this is a TCP listener. */
  readonly socketPath: string | null;
  /** This run's opaque stream identity, prefixed onto every frame id. */
  readonly epoch: string;
  /** Fan an event out to every connected client, and remember it for replay. */
  push(event: PushEvent): void;
  /**
   * Write one control frame to the streams of a single device, returning how
   * many it reached. Nothing enters the replay buffer — see the invariant on the
   * ring, which this deliberately does not touch.
   *
   * Zero is a meaningful answer, not a failure to report later: it means that
   * device has nothing open right now, and the caller can say so immediately
   * instead of waiting out a timeout for an answer that was never coming.
   */
  pushTo(deviceId: string, name: string, data: unknown): number;
  /**
   * Which devices have at least one stream open. THE availability signal for
   * anything addressed at a device (docs/mcp-device-pinning.md, ③): the channel
   * that would carry the work is the same channel that decides whether it can be
   * carried, so "looks reachable but has nowhere to send work" cannot happen.
   */
  connectedDevices(): Set<string>;
  /** Connected SSE clients — diagnostics and tests. */
  clientCount(): number;
  /** How many frames the replay buffer is currently holding — tests, diagnostics. */
  bufferedFrames(): number;
  /**
   * End every stream belonging to `deviceId`, returning how many were closed.
   * Revoking a device removes its credential, which stops the NEXT request — an
   * already-open event stream would otherwise keep delivering everything the
   * server pushes, for as long as the socket lives.
   */
  dropDevice(deviceId: string): number;
  close(): Promise<void>;
}

/** Marker for a body that blew the cap, so the caller can answer 413 not 400. */
class BodyTooLarge extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // The bridge's responses are per-request state; a proxy must never reuse them.
    'cache-control': 'no-store'
  });
  res.end(text);
}

/**
 * Buffer a request body up to `limit`. An over-cap body is refused rather than
 * accumulated: the declared Content-Length short-circuits before a byte arrives,
 * and a lying (or chunked) sender is cut off the moment it crosses the line.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      rejectBody(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        rejectBody(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

/**
 * The request body as a stream that dies at `limit` rather than a string. Same
 * contract as readBody — a declared over-cap length is refused before a byte
 * arrives, and a lying sender is cut off mid-flight — for the one route whose
 * body must never be held in memory at all.
 */
function cappedBody(req: IncomingMessage, limit: number): Readable {
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > limit) {
        // Stop the sender as well as the pipeline: without this the peer keeps
        // writing a body nobody is reading until it fills a socket buffer.
        req.destroy();
        done(new BodyTooLarge());
        return;
      }
      done(null, chunk);
    }
  });
  req.pipe(meter);
  // pipe() forwards data and nothing else, so a request that dies would leave
  // the meter open forever — and whoever is consuming it waiting forever with a
  // half-written file. Both of these are no-ops once the cap has already
  // destroyed it, which is why the cap can destroy `req` above without racing.
  req.on('error', (e) => meter.destroy(e));
  req.on('aborted', () => meter.destroy(new Error('the connection closed before the body arrived')));
  return meter;
}

/**
 * One SSE frame. JSON.stringify escapes newlines, so `data:` is always one line.
 *
 * The `id:` line is the client's bookmark: a browser's EventSource echoes the
 * last one it saw back as Last-Event-ID on reconnect for free, and Stem's own
 * hand-rolled reader sends the same header deliberately. `epoch.seq` rather than
 * a bare number so that a bookmark from a server that has since been restarted
 * cannot be read as a position in the stream this one is producing — the
 * sequence begins again at 1 after a restart, and without the epoch the two runs'
 * ids would be indistinguishable.
 */
function sseFrame(epoch: string, event: PushEvent): string {
  return `id: ${epoch}.${event.id}\ndata: ${JSON.stringify({ channel: event.channel, payload: event.payload })}\n\n`;
}

/**
 * A control frame: something about the STREAM rather than something that
 * happened. Named with SSE's own `event:` field, which is what makes it
 * structurally impossible for a client to mistake one for a push — a data frame
 * carries no `event:` line, so `resync` can never arrive somewhere expecting a
 * `{channel, payload}` envelope.
 *
 * Deliberately carries no `id:`. A control frame is not a position in the stream:
 * a client that acted on one and then lost the connection must resume from the
 * last real frame it saw, not from a bookmark that would skip whatever came next.
 */
function controlFrame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function startTransportServer(opts: TransportServerOptions): Promise<TransportServer> {
  const socketPath = opts.socketPath ?? null;
  const bindHost = opts.host ?? '127.0.0.1';
  // Before anything is created, so a misconfigured deployment fails at boot with
  // a sentence rather than by quietly answering the internet. A socket path is
  // the one alternative, and it is checked with the same severity — see
  // socketPathProblem, which is what stops "a socket path" being a way to say 8080.
  if (socketPath) {
    const problem = socketPathProblem(socketPath);
    if (problem) throw new Error(problem);
  } else if (!LOOPBACK_HOSTS.has(bindHost)) {
    throw new Error(
      `refusing to bind ${bindHost}: Stem's transport is loopback-only. Reaching it from another ` +
        'machine goes through a proxy that terminates TLS and forwards to this socket; set ' +
        'STEM_TRUSTED_HOSTS to the name that proxy is reached under.'
    );
  }

  /**
   * Live SSE responses, each tagged with the device that opened it so revocation
   * can find it. A closed client is removed by its own 'close' handler.
   */
  const clients = new Set<{ res: ServerResponse; deviceId: string }>();
  /** Every open socket, so close() can destroy them (see the close() comment). */
  const sockets = new Set<Socket>();

  /**
   * This run's identity. Random rather than a timestamp so that two servers
   * started in the same millisecond (two profiles, two E2E workers) cannot mint
   * the same one, and short because it is on the front of every frame.
   */
  const epoch = randomBytes(4).toString('hex');

  /**
   * The replay buffer: what has been pushed recently, still in the exact bytes it
   * went out as, oldest first.
   *
   * It is a GLOBAL ring holding frames that were sent to EVERY client, which is
   * the only reason replaying it to a device that was not connected at the time
   * is safe. `push()` — the one thing that writes here — has no parameter that
   * could aim a frame at somebody, and the one producer above it broadcasts (see
   * startup/transport.ts), so a frame in here is by construction a frame every
   * authenticated device was already entitled to.
   *
   * Phase 4 added an out-of-band per-device path (server/push/apns.ts wakes one
   * phone through Apple's network), and it deliberately does NOT touch this. An
   * APNs frame never enters the ring, because it is not a position in the stream
   * and carries no state to replay: it is a tap on the shoulder saying "look at
   * Stem", holding an id to deep-link to and a short label, never a message. SSE
   * is still the sole state channel, and a client that missed or ignored a push
   * loses nothing — it re-reads this stream and is whole again.
   *
   * `pushTo()` is the second per-device path and the first one that goes out over
   * THIS socket, so it is the one to be careful about. It writes a control frame
   * to one device's streams and stops there: no `remember()`, no id, no position
   * in the stream. That is not an optimization, it is the invariant — a call
   * addressed to the machine hosting an MCP server carries that server's
   * arguments, and every other paired device would be entitled to read it out of
   * this buffer on its next reconnect. An addressed frame is also not something
   * to replay after the fact: it is a request with a caller waiting on a timeout,
   * and a copy delivered minutes later to whoever happens to reconnect answers
   * nobody. The rule to keep: whatever gains a `deviceId` parameter does not
   * write here, and this buffer therefore never needs per-device knowledge.
   *
   * Cost when nothing ever disconnects — which is every embedded install on a
   * good day — is the memory alone: the text stored here is the SAME string the
   * fan-out writes, built once and referenced, so there is no second
   * serialization and no copy. Steady state is a couple of hundred kilobytes,
   * and REPLAY_MAX_BYTES is the ceiling.
   */
  const ring: { id: number; text: string; bytes: number }[] = [];
  let ringBytes = 0;
  /** The highest id ever pushed, which survives the frames themselves ageing out. */
  let lastPushedId = 0;

  /**
   * Write to one client, reaping it if the socket has already gone. A response
   * can be destroyed between its 'close' event and a write; writing to it would
   * throw ERR_STREAM_DESTROYED into the event emitter.
   *
   * The return value is what makes an addressed frame able to answer "nobody was
   * there" — a broadcast does not care, a request aimed at one device does.
   */
  function writeToClient(client: { res: ServerResponse; deviceId: string }, text: string): boolean {
    if (client.res.writableEnded || client.res.destroyed) {
      clients.delete(client);
      return false;
    }
    try {
      client.res.write(text);
      return true;
    } catch {
      // quiet: the write threw because the socket went between the check above
      // and here. Reaping the client and answering false IS the report — the
      // addressed path counts it as unreached, and the client that comes back
      // replays the frames it missed out of the ring.
      clients.delete(client);
      return false;
    }
  }

  /** Keep one frame, then evict from the front until both bounds hold again. */
  function remember(id: number, text: string): void {
    const bytes = Buffer.byteLength(text);
    ring.push({ id, text, bytes });
    ringBytes += bytes;
    // No floor: a single frame bigger than the byte cap empties the buffer and
    // then evicts itself, which is the honest outcome — the cap is a memory
    // bound, and the client's answer for an empty buffer is a resync it can act
    // on rather than a partial replay it cannot detect.
    while (ring.length > REPLAY_MAX_FRAMES || ringBytes > REPLAY_MAX_BYTES) {
      ringBytes -= ring.shift()!.bytes;
    }
  }

  /**
   * What to do with a client presenting `raw` as its last-seen frame id.
   *
   *   live    — nothing was missed (a fresh stream, or one that dropped between
   *             frames). Attach and carry on.
   *   replay  — the gap is entirely in the buffer. Send it, then attach.
   *   resync  — it is not: too old, or from a previous run of this server. Say so
   *             and let the client refetch, which is complete where a partial
   *             replay would be silently wrong.
   */
  function resumeFor(
    raw: string | string[] | undefined
  ): { kind: 'live' | 'resync' } | { kind: 'replay'; after: number } {
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) return { kind: 'live' };
    // Strict on purpose. Every way of failing to understand a bookmark ends in a
    // resync, never in "you are up to date" — being told to refetch costs a round
    // trip, where being wrongly told there is no gap loses whatever is in it.
    const parsed = /^(\w+)\.(\d+)$/.exec(header);
    if (!parsed || parsed[1] !== epoch) return { kind: 'resync' };
    const seq = Number(parsed[2]);
    if (!Number.isSafeInteger(seq)) return { kind: 'resync' };
    // Level with us, or ahead of us (which only a corrupted bookmark can be).
    if (seq >= lastPushedId) return { kind: 'live' };
    // The first frame we owe them is seq + 1; the buffer serves them only if it
    // still reaches back that far.
    if (ring.length > 0 && ring[0].id <= seq + 1) return { kind: 'replay', after: seq };
    return { kind: 'resync' };
  }

  const originPolicy = (): OriginPolicy => ({ port: boundPort, extraHosts: opts.extraHosts });

  /** Token + origin, the two gates every authenticated route shares. */
  async function gate(
    req: IncomingMessage
  ): Promise<{ device: DeviceIdentity } | { status: number; error: string }> {
    const device = await opts.authenticate(presentedToken(req.headers));
    if (!device) return { status: 401, error: 'unauthorized' };
    const origin = requestOriginProblem(req.headers, originPolicy());
    if (origin) return { status: 403, error: origin };
    return { device };
  }

  async function handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gated = await gate(req);
    if ('error' in gated) {
      log('transport', 'rejected /rpc', { problem: gated.error });
      sendJson(res, gated.status, { ok: false, error: gated.error });
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (e) {
      // quiet: the caller is answered with the reason, 413 or 400.
      if (e instanceof BodyTooLarge) {
        sendJson(res, 413, { ok: false, error: 'request body too large' });
        return;
      }
      sendJson(res, 400, { ok: false, error: 'could not read request body' });
      return;
    }

    let body: { channel?: unknown; args?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      // quiet: the caller sent it and the caller is told what was wrong with it.
      sendJson(res, 400, { ok: false, error: 'body is not JSON' });
      return;
    }
    const channel = body?.channel;
    const args = body?.args ?? [];
    if (typeof channel !== 'string' || !Array.isArray(args)) {
      sendJson(res, 400, { ok: false, error: 'expected {channel: string, args: unknown[]}' });
      return;
    }
    // No allowlist stands between a valid token and the registry: the server's
    // registered handlers ARE the surface, exactly as they were when the desktop
    // reached them through ipcMain. An unregistered channel is refused by
    // dispatch itself, in the guard's own words, and arrives below as a 400 —
    // which is what a pre-check here would have had to reproduce by hand.
    try {
      // dispatch runs the same per-channel argsProblem validation the renderer's
      // IPC gets, then the real handler — so a malformed startTurn is refused
      // here for exactly the reason it would be refused at the desk.
      const result = await opts.dispatch(channel, args, { deviceId: gated.device.id });
      sendJson(res, 200, { ok: true, result: result ?? null });
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      // quiet: the handler's own error goes back over the wire verbatim, which
      // is the whole contract of /rpc — a client that asked gets told.
      //
      // A rejected-call message is the caller's fault (400); anything else is
      // the handler failing, which the client should surface as an error, not a
      // permission problem.
      const status = /^Rejected local call/.test(error) ? 400 : 500;
      sendJson(res, status, { ok: false, error });
    }
  }

  /**
   * What this caller may invoke. A client binds its own IPC surface from this at
   * connect time, so it never has to carry a copy of the server's registry —
   * which is what lets the same desktop build talk to an embedded server and a
   * standalone one.
   */
  async function handleChannels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gated = await gate(req);
    if ('error' in gated) {
      log('transport', 'rejected /channels', { problem: gated.error });
      sendJson(res, gated.status, { ok: false, error: gated.error });
      return;
    }
    sendJson(res, 200, { ok: true, result: [...opts.registeredChannels()] });
  }

  async function handleEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gated = await gate(req);
    if ('error' in gated) {
      log('transport', 'rejected /events', { problem: gated.error });
      sendJson(res, gated.status, { ok: false, error: gated.error });
      return;
    }
    // ---- The connect handshake, and why it is one synchronous block ----
    //
    // Everything from here to clients.add() runs without an await, and that is
    // the whole of the "no duplicate, no dropped frame" argument. Node runs this
    // to completion before any other callback — including push() — so there is no
    // instant at which a frame could be both replayed from the buffer AND written
    // live, and none at which one could fall between the two. Put an await
    // anywhere in here and that window opens.
    //
    // The order on the wire is: snapshot, then either the replay or a resync.
    //
    // Snapshot FIRST, deliberately. It describes the world as of this moment,
    // which is AFTER everything in the replay; the replayed frames then carry the
    // client forward through the same history it missed, and a `turn/completed`
    // among them settles a turn the snapshot never claimed was running anyway.
    // The other order is the one that breaks: a snapshot applied after the replay
    // would re-mark as active a turn whose terminal frame the client has just
    // been given, and the spinner would never resolve — which is the exact
    // failure this step exists to remove.
    const resume = resumeFor(req.headers['last-event-id']);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx (and anything modelled on it) buffers proxied responses by default,
      // which would hold every delta until the turn ends.
      'x-accel-buffering': 'no'
    });
    // Flush the headers and set the client's reconnect backoff in one dispatch;
    // a block with no `data:` field fires no event.
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);
    if (opts.connectSnapshot) res.write(controlFrame('snapshot', opts.connectSnapshot()));
    if (resume.kind === 'replay') {
      for (const frame of ring) {
        if (frame.id > resume.after) res.write(frame.text);
      }
    } else if (resume.kind === 'resync') {
      // Where the client now stands, so its bookmark moves forward with the
      // refetch. Without it a client that resynced and then dropped again before
      // any new frame arrived would present the same stale id and be told to
      // resync a second time, for nothing.
      log('transport', 'replay gap too old, asking for a resync', { deviceId: gated.device.id });
      res.write(controlFrame('resync', { head: `${epoch}.${lastPushedId}` }));
    }
    const client = { res, deviceId: gated.device.id };
    clients.add(client);

    const drop = (): void => {
      clients.delete(client);
    };
    // 'close' covers both a clean disconnect and a dropped connection; the
    // 'error' handler exists so a mid-write reset can't reach the process.
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
  }

  /**
   * Take one file. The client sends the bytes raw, with the name in the query
   * string — there is no multipart parser here and there does not need to be:
   * one request carries one file, which is exactly what the two callers (an
   * attachment on a turn, a drop onto the Files panel) each have.
   *
   * The handle that comes back is what the client passes where it would have
   * passed a path, so nothing downstream has to learn a second shape for "the
   * bytes are over there".
   */
  async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!opts.stageUpload) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    const gated = await gate(req);
    if ('error' in gated) {
      log('transport', 'rejected /upload', { problem: gated.error });
      sendJson(res, gated.status, { ok: false, error: gated.error });
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      sendJson(res, 413, { ok: false, error: 'that file is too large to upload' });
      return;
    }
    const name = new URL(req.url ?? '/', 'http://stem.invalid').searchParams.get('name') ?? 'upload';
    try {
      const staged = await opts.stageUpload(name, cappedBody(req, MAX_UPLOAD_BYTES));
      sendJson(res, 200, { ok: true, result: staged });
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        sendJson(res, 413, { ok: false, error: 'that file is too large to upload' });
        return;
      }
      const error = String((e as Error)?.message ?? e);
      log('transport', 'upload failed', { error });
      sendJson(res, 500, { ok: false, error });
    }
  }

  /**
   * Send one file back. The path after `/files/` is a path relative to the Files
   * folder, and whether it names something inside it is decided entirely by
   * openDownload — see the note on that option.
   *
   * Streamed rather than read: the file may be large, and this server has no
   * business holding one in memory to hand it over.
   */
  async function handleDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!opts.openDownload) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    const gated = await gate(req);
    if ('error' in gated) {
      log('transport', 'rejected /files', { problem: gated.error });
      sendJson(res, gated.status, { ok: false, error: gated.error });
      return;
    }
    const raw = (req.url ?? '/').split('?')[0].slice('/files/'.length);
    let rel: string;
    try {
      rel = decodeURIComponent(raw);
    } catch {
      // quiet: a path that will not decode cannot name a file; the client is told so.
      sendJson(res, 400, { ok: false, error: 'that is not a valid file path' });
      return;
    }
    const target = await opts.openDownload(rel);
    if (!target) {
      // Deliberately the same answer for "no such file" and "not yours": a 403
      // would confirm that something is there, which is the one thing a caller
      // probing for paths is trying to learn.
      log('transport', 'refused /files', { rel });
      sendJson(res, 404, { ok: false, error: 'no such file' });
      return;
    }
    res.writeHead(200, {
      // Never guessed from the extension: a sniffed type is how a stored file
      // becomes script, and no client here renders the response anyway.
      'content-type': 'application/octet-stream',
      'content-length': target.size,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(target.name)}`,
      'cache-control': 'no-store'
    });
    const file = createReadStream(target.path);
    file.on('error', () => res.destroy());
    res.on('close', () => file.destroy());
    file.pipe(res);
  }

  /**
   * Spend a pairing code. The one route that answers without a token, because it
   * is how a device that has no token gets one.
   *
   * The origin check still applies — a page in a browser must not be able to
   * drive it — but the token gate obviously cannot, so the protection is entirely
   * in pairing.ts: a code that only exists for ten minutes, is spent on first
   * use, and locks the route after a handful of wrong guesses. The body cap is
   * its own line of defence: nothing legitimate posts more than a code here.
   */
  async function handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!opts.pair) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    const origin = requestOriginProblem(req.headers, originPolicy());
    if (origin) {
      log('transport', 'rejected /pair', { problem: origin });
      sendJson(res, 403, { ok: false, error: origin });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, MAX_PAIR_BODY_BYTES);
    } catch {
      // quiet: over the cap or cut off mid-body — either way the device pairing
      // is refused to its face, which is the only audience this has.
      sendJson(res, 400, { ok: false, error: 'expected {code: string}' });
      return;
    }
    let body: { code?: unknown; kind?: unknown } | null;
    try {
      body = JSON.parse(raw) as { code?: unknown; kind?: unknown } | null;
    } catch {
      // quiet: the device that sent it is the one told about it.
      sendJson(res, 400, { ok: false, error: 'body is not JSON' });
      return;
    }
    const code = body?.code;
    if (typeof code !== 'string' || !code) {
      sendJson(res, 400, { ok: false, error: 'expected {code: string}' });
      return;
    }
    // What the device says it is, so the server can later offer only desktops as
    // MCP hosts. Optional — a client from before this existed pairs as a desktop,
    // which is what it was — but a value that is present and not one of ours is
    // refused rather than coerced: the same strictness the code itself gets.
    // JSON.parse never yields undefined, so `undefined` here means the field was
    // absent — an explicit `null` is a client saying something, and something
    // that is not one of ours is refused rather than read as "never mind".
    const kind = body?.kind === undefined ? 'desktop' : body.kind;
    if (kind !== 'desktop' && kind !== 'mobile') {
      sendJson(res, 400, { ok: false, error: 'kind must be "desktop" or "mobile"' });
      return;
    }
    try {
      const grant = await opts.pair(code, kind);
      log('transport', 'paired a device', { deviceId: grant.deviceId });
      sendJson(res, 200, { ok: true, result: grant });
    } catch (e) {
      const status = (e as { status?: unknown })?.status;
      const error = String((e as Error)?.message ?? e);
      log('transport', 'pairing refused', { error });
      sendJson(res, typeof status === 'number' ? status : 500, { ok: false, error });
    }
  }

  /**
   * Anything that is not one of the six routes. A JSON 404 rather than a file:
   * this server has no document root any more, and never gets one back without a
   * client that needs it (see the header comment).
   */
  function handleUnknown(req: IncomingMessage, res: ServerResponse): Promise<void> {
    log('transport', 'no such route', { path: (req.url ?? '/').split('?')[0] });
    sendJson(res, 404, { ok: false, error: 'not found' });
    return Promise.resolve();
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const route =
      path === '/rpc' && req.method === 'POST'
        ? handleRpc(req, res)
        : path === '/events' && req.method === 'GET'
          ? handleEvents(req, res)
          : path === '/channels' && req.method === 'GET'
            ? handleChannels(req, res)
            : path === '/upload' && req.method === 'POST'
              ? handleUpload(req, res)
              : path.startsWith('/files/') && req.method === 'GET'
                ? handleDownload(req, res)
                : path === '/pair' && req.method === 'POST'
                  ? handlePair(req, res)
                  : handleUnknown(req, res);
    // No handler above is expected to reject, but a thrown error here would
    // otherwise become an unhandled rejection and leave the socket hanging.
    void route.catch((e) => {
      log('transport', 'request failed', { path, error: String((e as Error)?.message ?? e) });
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
      else res.destroy();
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_err, socket) => {
    socket.destroy();
  });

  if (socketPath) await clearStaleSocket(socketPath);

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      rejectListen(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // A loopback address, never 0.0.0.0 — see LOOPBACK_HOSTS. Or a socket path,
    // which is checked above precisely so this call cannot be talked into a port.
    if (socketPath) server.listen(socketPath);
    else server.listen(opts.port, bindHost);
  });

  if (socketPath) {
    // The socket is created with whatever umask the process has, which on a
    // default image is 0022 — world-readable, and a socket you can open is a
    // socket you can send an unauthenticated /pair to. 0660 keeps it to the
    // container's own user and group; the proxy shares the volume and, in the
    // stock Caddy image, runs as root, so it is unaffected either way.
    await chmod(socketPath, 0o660).catch((e) =>
      log('transport', 'could not tighten the socket permissions', { error: String((e as Error)?.message ?? e) })
    );
  }

  // 0 on a socket: `address()` answers with the path there, and there is no port
  // to report. The origin policy reads this, and a Host of `127.0.0.1:0` is not
  // something any client sends — so on a socket the only Host that can pass is
  // one the deployment declared in STEM_TRUSTED_HOSTS, which is right.
  const boundPort = socketPath ? 0 : ((server.address() as AddressInfo | null)?.port ?? opts.port);

  const keepalive = setInterval(() => {
    for (const client of clients) writeToClient(client, ': keepalive\n\n');
  }, SSE_KEEPALIVE_MS);
  // Never hold the process open for a heartbeat.
  keepalive.unref?.();

  return {
    port: boundPort,
    socketPath,
    epoch,
    clientCount: () => clients.size,
    bufferedFrames: () => ring.length,
    push(event) {
      // Serialized once for everybody: every connected client is entitled to
      // every push now that there is one role. The same string is what the ring
      // keeps, so replay costs no second pass over the payload.
      //
      // Recorded even with nobody connected, which is the case that matters most:
      // a client whose stream just dropped is not connected, and the frames it
      // needs back are precisely the ones produced while it was away.
      const text = sseFrame(epoch, event);
      if (event.id > lastPushedId) lastPushedId = event.id;
      remember(event.id, text);
      for (const client of clients) writeToClient(client, text);
    },
    pushTo(deviceId, name, data) {
      // A control frame, which is what makes this structurally unmistakable for a
      // broadcast at the other end: a data frame carries no `event:` line, so a
      // reader cannot take an addressed frame for a `{channel, payload}` push
      // however odd its contents. And no `id:` — this is not a position in the
      // stream, so a client that acts on one must still resume from the last real
      // frame it saw.
      //
      // Nothing is remembered. See the ring's comment above: an addressed frame
      // is precisely the frame every other device was NOT entitled to.
      const text = controlFrame(name, data);
      let reached = 0;
      for (const client of clients) {
        if (client.deviceId !== deviceId) continue;
        if (writeToClient(client, text)) reached++;
      }
      return reached;
    },
    connectedDevices() {
      const ids = new Set<string>();
      for (const client of clients) {
        // Not merely `clients.size > 0` per device: a stream whose socket died
        // between its 'close' event and this call would otherwise report a
        // machine as available and send work to a socket nobody is reading.
        if (client.res.writableEnded || client.res.destroyed) {
          clients.delete(client);
          continue;
        }
        ids.add(client.deviceId);
      }
      return ids;
    },
    dropDevice(deviceId) {
      let dropped = 0;
      for (const client of clients) {
        if (client.deviceId !== deviceId) continue;
        clients.delete(client);
        dropped++;
        // destroy(), not end(): a revoked device must not get a clean EOF it
        // could mistake for an ordinary reconnect cue — and end() waits on a
        // writable that a wedged client may never drain.
        try {
          client.res.destroy();
        } catch {
          // quiet: already gone, which is what destroy() was for.
        }
      }
      return dropped;
    },
    close: async () => {
      clearInterval(keepalive);
      for (const client of clients) {
        try {
          client.res.end();
        } catch {
          // quiet: already gone, and we are closing anyway — the sockets are
          // destroyed a few lines below regardless.
        }
      }
      clients.clear();
      ring.length = 0;
      ringBytes = 0;
      // server.close() only stops accepting and then waits for every open
      // connection to end — with an SSE stream open that is forever, so the quit
      // path would hang. Destroy the sockets first, then close.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  };
}
