import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { readableFilePath } from '../files/store';
import { liveTurnSnapshot } from '../live-turns';
import { stageUpload, startStagingSweeper, stopStagingSweeper } from '../files/staging';
import { dispatchLocal, serverChannels } from '../ipc/guard';
import { log } from '../log';
import { resolveDevice } from '../transport/auth';
import { redeemPairingCode } from '../transport/pairing';
import {
  startTransportServer,
  type DeviceIdentity,
  type DownloadTarget,
  type TransportServer
} from '../transport/server';
import type { ExecApprovalRequest, HarnessApprovalRequest } from '../../shared/types';
import { serverEndpointPath } from '../workspace/paths';

/**
 * The server's front door. Every client — the Electron app on this machine, and
 * every device paired to it from elsewhere — reaches the handler registry through
 * here and nowhere else. There is deliberately no in-process shortcut for the
 * embedded case: a path only the embedded deployment exercises is a path the
 * remote deployment never gets tested on.
 *
 * One listener. There used to be two — a second, fixed-port one that
 * `tailscale serve` was pointed at, bound and rebound by Settings → Mobile —
 * because the phone's web client needed a stable address to put in a QR code.
 * That client is gone, and with it the toggle, the port setting, the public-URL
 * setting and the phone role. A deployment that wants to be reachable from
 * elsewhere now terminates TLS in front of this single loopback socket.
 *
 * This file does NOT mint a credential for anyone. A server that hands itself a
 * bearer token at boot would have to write it down somewhere readable, which is
 * the exact property hashing the registry was for. Clients acquire their own:
 * off shared disk (src/desktop/client-store.ts) or through a pairing code.
 *
 * Binding is fatal by design: with no transport there is no client.
 */

interface TransportConfig {
  /** ELECTRON_RENDERER_URL in dev; null in a packaged app. Kept for the log line. */
  devUrl: string | null;
}

/** Where this server is listening. Exactly one of these is ever set. */
export interface TransportEndpoint {
  /** Origin of the listener, e.g. `http://127.0.0.1:52413`; null on a socket. */
  url: string | null;
  /** The Unix socket it is listening on, or null when it took a TCP port. */
  socket: string | null;
}

let primary: TransportServer | null = null;
/** Monotonic SSE event id (see PushEvent.id). */
let eventSeq = 0;

/**
 * The exec approval cards still waiting for an answer, for the connect snapshot.
 *
 * A seam rather than an import because the ExecService is constructed in
 * server/index.ts, which imports this file — and because a client's first
 * question on connecting ("what is waiting on me?") should be answered by the
 * one component that knows, not by a second copy kept in sync with it.
 */
let pendingExecApprovals: () => ExecApprovalRequest[] = () => [];

/** Wired once, at boot, right after the ExecService exists. */
export function setPendingApprovalsSource(source: () => ExecApprovalRequest[]): void {
  pendingExecApprovals = source;
}

/** Same seam for the HarnessService's cards — a card raised into an empty room must replay. */
let pendingHarnessApprovals: () => HarnessApprovalRequest[] = () => [];

export function setPendingHarnessApprovalsSource(source: () => HarnessApprovalRequest[]): void {
  pendingHarnessApprovals = source;
}

/** Who is calling: the device registry's answer, and nothing else on top of it. */
async function authenticate(presented: string | null): Promise<DeviceIdentity | null> {
  const device = await resolveDevice(presented);
  return device ? { id: device.id, role: device.role } : null;
}

/**
 * Where the listener binds. Loopback either way — startTransportServer refuses
 * anything else — but which loopback address matters on a host whose `localhost`
 * resolves to ::1 before 127.0.0.1, and a deployment that fronts the server with
 * a proxy wants to say so rather than infer it.
 */
function primaryHost(): string {
  return process.env.STEM_SERVER_HOST?.trim() || '127.0.0.1';
}

/**
 * The Unix socket to listen on instead of a port, or null for the ordinary
 * loopback bind.
 *
 * This is the container's shape: docker-compose.yml puts a volume at /run/stem,
 * mounts it into Caddy as well, and sets this. The result is a server with no
 * TCP listener anywhere in its namespace — the reverse proxy is not merely the
 * recommended way in, it is the only one there is.
 */
function socketPath(): string | null {
  return process.env.STEM_SERVER_SOCKET?.trim() || null;
}

/**
 * Host headers to accept beyond loopback-with-our-port and the tailnet.
 *
 * A fronted deployment needs this: a request that reached Caddy at
 * `stem.example.com` arrives here carrying that name, which is neither our
 * loopback port nor a `.ts.net` address, and the rebinding check would refuse it.
 * Naming the hostnames explicitly keeps the check meaningful — it is still a
 * closed set, just one the deployment declares rather than one we guess.
 */
function trustedHosts(): string[] {
  return (process.env.STEM_TRUSTED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}

/**
 * What GET /files/<rel> is allowed to send back, and the route's whole
 * authorization decision. Deliberately one call: it is the SAME resolver the
 * `files:*` channels bound their paths with, so a file this serves is by
 * construction one the Files panel already lists. A second containment check
 * written here would be a second check that could disagree with that one.
 */
export async function resolveDownload(rel: string): Promise<DownloadTarget | null> {
  const path = await readableFilePath(rel);
  if (!path) return null;
  return { path, name: basename(path), size: (await stat(path)).size };
}

/** An origin a client can put in a URL — IPv6 literals need their brackets. */
function originFor(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/**
 * Publish where we are listening, so a client that did NOT start this process can
 * find it. The desktop in embedded mode is handed the endpoint directly and never
 * reads this file; a standalone `stem-server` is the reason it exists.
 *
 * On a socket there is no address a client could dial, and the file says so —
 * `url: null` and the socket path — rather than inventing one. It is still
 * written, because its OTHER job does not depend on the address at all: its mere
 * presence in the state root is how src/desktop/server-endpoint.ts knows the
 * server shares this disk and a device record can be minted rather than paired.
 * In the container nothing is reading it; on a machine where somebody runs
 * `stem-server` behind a local proxy, both facts still hold.
 */
async function writeEndpointFile(endpoint: TransportEndpoint): Promise<void> {
  const path = serverEndpointPath();
  // quiet: the writeFile below says when the endpoint could not be published, and
  // a directory that will not be made is that same failure one line earlier.
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const body = { ...endpoint, pid: process.pid, startedAt: new Date().toISOString() };
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8').catch((e) =>
    log('transport', 'could not publish the endpoint', { error: String((e as Error)?.message ?? e) })
  );
}

/**
 * Bind the listener. Resolves with where it is; throws if the socket cannot be
 * bound, because a server nothing can reach is not a server.
 */
export async function startTransport(cfg: TransportConfig): Promise<TransportEndpoint> {
  // STEM_SERVER_PORT pins the port for a deployment that fronts it; ephemeral
  // otherwise, so two profiles (or two E2E runs) can never collide.
  const requested = Number(process.env.STEM_SERVER_PORT ?? 0);
  const host = primaryHost();
  const extraHosts = trustedHosts();
  const socket = socketPath();
  // Loud, and before the bind, because the symptom otherwise is every request
  // through the proxy answering 403 with the reason only in the log: on a socket
  // the Host header carries the proxy's public name, and nothing else can pass
  // the rebinding check (there is no port of ours for a loopback Host to name).
  if (socket && extraHosts.length === 0) {
    log('transport', 'listening on a socket with no STEM_TRUSTED_HOSTS — every proxied request will be refused', {
      socket
    });
  }
  primary = await startTransportServer({
    port: Number.isFinite(requested) ? requested : 0,
    host,
    socketPath: socket ?? undefined,
    authenticate,
    // dispatchLocal applies the same per-channel argument validation the
    // renderer's IPC always got, then the real handler. The caller rides along
    // untouched: it is the one input a client cannot write for itself, which is
    // what makes `devices:registerPush` able to mean "this device".
    dispatch: (channel, args, caller) => dispatchLocal(channel, args, caller),
    registeredChannels: serverChannels,
    pair: async (code, kind) => {
      const minted = await redeemPairingCode(code, kind);
      return { deviceId: minted.device.id, token: minted.token };
    },
    stageUpload,
    openDownload: resolveDownload,
    // What a client is told the instant it connects. A turn that kept running
    // while it was away is otherwise indistinguishable from one that finished
    // without it — both look like a thread that stopped producing deltas — and
    // the two need opposite things on screen.
    //
    // Approval cards are here for the same reason and a sharper one: they exist
    // only as pushes, so one raised while nobody was attached (or across a
    // stream gap) was previously unrecoverable — the assistant sat blocked on a
    // question no surface was showing, until it expired.
    connectSnapshot: () => ({
      liveTurns: liveTurnSnapshot(),
      execApprovals: pendingExecApprovals(),
      harnessApprovals: pendingHarnessApprovals()
    }),
    extraHosts
  });
  // Uploads outlive the request that made them, so somebody has to notice the
  // ones nothing ever came back for. Started with the listener because that is
  // what makes them possible in the first place.
  startStagingSweeper();
  const endpoint: TransportEndpoint = socket
    ? { url: null, socket }
    : { url: originFor(host, primary.port), socket: null };
  log('transport', 'listening', {
    ...(socket ? { socket } : { host, port: primary.port }),
    dev: !!cfg.devUrl,
    extraHosts
  });
  await writeEndpointFile(endpoint);
  return endpoint;
}

/**
 * Fan an event out to every connected client. Filtering is the client's job —
 * each one keys on threadId exactly as the main window always did — and with a
 * single role there is nothing here that decides who may see what.
 *
 * That last property is load-bearing now that the transport keeps a replay
 * buffer: every frame in it went to every device, so handing one back to a
 * device that was offline at the time discloses nothing it would not have been
 * sent live. A push aimed at a single device would break that, which is why
 * there is no parameter here to aim one with.
 *
 * Phase 4's APNs wake-ups are per-device and do not contradict any of that,
 * because they are not on this path at all. server/push/ addresses one phone
 * over Apple's network with a payload that is an id and a short label — no
 * message, no state, nothing to replay — so nothing device-scoped ever reaches
 * this fan-out or the buffer behind it. This stays the sole channel by which a
 * client learns what happened; a push only asks it to come and look.
 */
export function pushToClients(channel: string, payload: unknown): void {
  if (!primary) return;
  primary.push({ id: ++eventSeq, channel, payload });
}

/**
 * Write one control frame to a single device's streams, answering with how many
 * it reached. The one addressed thing on this socket, and the exception that
 * proves the rule above: it never touches the replay buffer, because the frame it
 * writes is by definition one the other devices were not entitled to (see the
 * ring's comment in transport/server.ts).
 *
 * Zero reached is not an error to log and forget — it is the answer the caller
 * acts on, and the whole reason the router can refuse a call to a sleeping
 * machine immediately instead of holding a tool call open for two minutes.
 */
export function pushToDevice(deviceId: string, name: string, data: unknown): number {
  return primary?.pushTo(deviceId, name, data) ?? 0;
}

/**
 * Which devices are connected right now. Availability, for anything that needs
 * to decide whether work can be sent to a particular machine — and deliberately
 * the same fact as "can we write to it", rather than a second notion of liveness
 * kept beside it (docs/mcp-device-pinning.md, ③).
 */
export function connectedDeviceIds(): Set<string> {
  return primary?.connectedDevices() ?? new Set();
}

/**
 * Cut every event stream a device has open. Called with (not instead of) revoking
 * its record: the registry decides the next request, this decides the one already
 * in flight, and a revocation that only did the first would leave a removed
 * device watching the stream indefinitely.
 */
export function dropDeviceStreams(deviceId: string): number {
  return primary?.dropDevice(deviceId) ?? 0;
}

/** Shut the listener down (app quit). Resolves even with SSE streams open. */
export async function closeTransport(): Promise<void> {
  const current = primary;
  primary = null;
  stopStagingSweeper();
  if (!current) return;
  await current
    .close()
    .catch((e) => log('transport', 'close failed', { error: String((e as Error)?.message ?? e) }));
}
