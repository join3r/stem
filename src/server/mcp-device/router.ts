import { randomBytes } from 'node:crypto';
import { log } from '../log';
import { readMcpConfig, type PiMcpServer } from '../pi/mcp-config';
import { readDevices } from '../transport/auth';
import { connectedDeviceIds, pushToDevice } from '../startup/transport';
import { mcpSpecFingerprint } from '../../shared/mcp-fingerprint';
import { fileCatalogStore, normalizeAnnouncement, type DeviceMcpCatalogStore } from './catalog';
import {
  MCP_ASSIGNMENTS_FRAME,
  MCP_REQUEST_FRAME,
  type DeviceMcpAssignment,
  type DeviceMcpCatalog,
  type DeviceMcpRequest,
  type DeviceMcpResult,
  type DeviceMcpSpec
} from '../../shared/types';

// The server's half of an MCP server that runs somewhere else.
//
// Everything about a device-located server that is not the transport and not the
// UI is here: which servers a device is asked to host, what it reported back,
// and the round-trip for one call — out as an addressed control frame, back as
// an ordinary POST /rpc on `mcpHost:result`.
//
// It lives in its own directory rather than under pi/ or transport/ because it
// belongs to neither. pi is one caller of it (the bridge's McpDeviceClient, in
// step 4 of docs/mcp-device-pinning.md) and will not be the last; the transport
// is a socket it writes to and knows nothing of MCP. server/push/ is the closest
// neighbour in shape — a per-device out-of-band path with its own folder — and
// this sits beside it for the same reason.
//
// ---- What holds the security of this, since it is not obvious ----
//
// Every server channel is also bound to ipcMain on the desktop
// (src/desktop/ipc-bridge.ts), which means a renderer CAN call `mcpHost:result`,
// and it does so with a perfectly valid device identity — its own. So "only the
// right device may answer" is not, on its own, a defence against the machine
// that is itself the right device. What is left is the correlation id: 128 random
// bits, spent on first use, forgotten on timeout. A forged answer can therefore
// affect exactly one thing — a request that device was legitimately handed, in
// the window it was legitimately open — which is a request that device could
// have answered wrongly anyway. That is the whole argument; keep the id
// unguessable and single-use and it holds, weaken either and it does not.

/**
 * How long a call may take. A tool call is a program doing real work on somebody
 * else's computer — a build, a query, a browser — so it gets two minutes; a tool
 * LISTING is a connected client reading a list it already has in memory, and if
 * that takes thirty seconds something is wrong that waiting will not fix.
 *
 * Neither is the availability check. A machine that is simply asleep is refused
 * immediately and never waits at all (see refusal() below) — these bound the
 * case where the device is there and the server on it is not answering, which is
 * the only case where waiting is the right thing to do.
 */
const CALL_TIMEOUT_MS = 120_000;
const LIST_TIMEOUT_MS = 30_000;

/**
 * And a schema is faster still. `describe_tool` used to answer from memory in
 * microseconds; asking the hosting machine for the real schema put a round trip
 * in the middle of a turn, which is worth it — the alternative was a schema
 * rebuilt from a truncated summary — but only while it is quick.
 *
 * The host answers this from the tool definitions it already holds from its
 * handshake: no process is consulted, nothing is computed. So anything past a
 * couple of seconds does not mean busy, it means the far end is wedged, and the
 * partial schema the fallback produces is a better answer than half a minute of
 * a stalled turn.
 */
const DESCRIBE_TIMEOUT_MS = 5_000;

/** One call, out on the wire and waiting to be answered or to run out of time. */
interface Pending {
  deviceId: string;
  server: string;
  settle(result: DeviceMcpResult): void;
  timer: NodeJS.Timeout;
}

export interface DeviceMcpRouterDeps {
  /** Write an addressed control frame; the count is how many streams it reached. */
  pushTo(deviceId: string, name: string, data: unknown): number;
  /** Which devices have a stream open right now — the availability signal (③). */
  connectedDevices(): Set<string>;
  /**
   * How to name a device in a refusal (⑤), or null when no device with that id
   * is paired any more. The two answers are two different sentences: one machine
   * is asleep, the other was unpaired and is never coming back on its own.
   */
  deviceLabel(deviceId: string): Promise<string | null>;
  /** Every entry in mcp.json, decrypted — where a device's assignments come from. */
  readServers(): Promise<Record<string, PiMcpServer>>;
  /** Where announcements are remembered across a disconnection. */
  catalog: DeviceMcpCatalogStore;
}

export interface DeviceMcpRouter {
  /** The servers pinned to `deviceId` — the answer to `mcpHost:hello`. */
  assignmentsFor(deviceId: string): Promise<DeviceMcpAssignment[]>;
  /** Record what a device says it is hosting — `mcpHost:announce`. */
  announce(deviceId: string, report: unknown): Promise<void>;
  /**
   * Answer one held call — `mcpHost:result`. Returns whether the id was live:
   * false for an id that never existed, was already spent, or timed out, all of
   * which are the same non-event and none of which is an error to the caller.
   */
  settle(deviceId: string, requestId: string, result: unknown): boolean;
  /** Ask the device hosting `server` what tools it has. */
  listTools(deviceId: string, server: string): Promise<DeviceMcpResult>;
  /** Ask it for one tool's real input schema — the on-demand half of the catalog. */
  describeTool(deviceId: string, server: string, tool: string): Promise<DeviceMcpResult>;
  /** Run one tool on the device hosting `server`. */
  callTool(deviceId: string, server: string, tool: string, args: unknown): Promise<DeviceMcpResult>;
  /**
   * Tell a device that what it is asked to host has changed, so it re-runs its
   * hello and reconciles. Returns how many of its streams the frame reached —
   * zero for a machine that is asleep, which needs nothing done about it: the
   * host asks again the moment it comes back (proxy.connection → refresh).
   */
  assignmentsChanged(deviceId: string): number;
  /** Whether that device could be sent work this instant. */
  isAvailable(deviceId: string): boolean;
  /** Everything announced so far, for the catalog block step 4 injects. */
  catalog(): Promise<DeviceMcpCatalog>;
  /**
   * Drop everything a device announced, because it is not paired any more.
   *
   * The pin in `mcp.json` is NOT touched — that is ⑩, and the panel is where a
   * person decides what becomes of it. What goes is the claim made to the model:
   * the catalog is what tells the assistant a tool exists, and a tool on a
   * machine this Stem can no longer be reached by is not a capability it has.
   */
  forget(deviceId: string): Promise<void>;
  /** Fail everything in flight (shutdown, tests) so nothing waits on a dead server. */
  close(): void;
}

/**
 * The transport half of a config entry: what the hosting machine needs to
 * connect, and nothing else.
 *
 * `location` is deliberately absent — the device already knows which machine it
 * is, and including it would put a field in the fingerprint that says nothing
 * about what runs. `disabled` is absent for the same kind of reason: a disabled
 * server is not sent at all (see assignmentsFor).
 *
 * Exported because it is also what "what is this device asked to host" is
 * computed from when mcp.json is written (pi/mcp.ts): the two answers must be
 * the same one, or a change that reaches the device would be decided by a
 * second, subtly different reading of the same entry.
 */
export function deviceSpecFor(def: PiMcpServer): DeviceMcpSpec {
  return {
    ...(def.command ? { command: def.command } : {}),
    ...(def.args?.length ? { args: [...def.args] } : {}),
    ...(def.env && Object.keys(def.env).length ? { env: { ...def.env } } : {}),
    ...(def.url ? { url: def.url } : {}),
    ...(def.headers && Object.keys(def.headers).length ? { headers: { ...def.headers } } : {})
  };
}

export function createDeviceMcpRouter(deps: DeviceMcpRouterDeps): DeviceMcpRouter {
  /** In-flight calls by correlation id. Single-use: settling deletes the entry. */
  const pending = new Map<string, Pending>();

  /**
   * A correlation id. 128 bits from the CSPRNG, because this is the only thing
   * standing between a client that can call `mcpHost:result` and a call it was
   * never handed — see the header. Not a counter, not a UUIDv4's 122 bits with a
   * recognisable shape, and never derived from anything a caller can see.
   */
  const mintRequestId = (): string => randomBytes(16).toString('hex');

  /**
   * Why this call cannot be sent, in a sentence somebody can act on.
   *
   * It names the server AND the machine (decision ⑤) because both halves are
   * load-bearing: the assistant repeats this string back to the user, who needs
   * to know which computer to go and wake, and the server name is what tells
   * them which of their machines that even is. "The MCP server is unavailable"
   * is the version of this sentence that helps nobody.
   */
  async function refusal(deviceId: string, server: string): Promise<string> {
    const label = await deps.deviceLabel(deviceId);
    // An orphaned pin (⑩): the machine it names was unpaired, so this is not a
    // computer that will be awake later. Saying "it will work once your Mac is
    // on" here would be advice that never comes true, and the entry would look
    // broken forever with nothing to do about it.
    if (!label) {
      return (
        `The MCP server "${server}" is pinned to a computer that is no longer paired with this Stem, so there is ` +
        `nowhere to run it. Pair that computer again, or open Settings → Tools → MCP servers and move "${server}" to ` +
        'another one.'
      );
    }
    return (
      `The MCP server "${server}" runs on ${label}, and that computer is not connected to Stem right now. ` +
      `Its tools will work again as soon as ${label} is awake and Stem is running on it.`
    );
  }

  async function dispatch(
    deviceId: string,
    server: string,
    op: DeviceMcpRequest['op'],
    extra: { tool?: string; args?: unknown },
    timeoutMs: number
  ): Promise<DeviceMcpResult> {
    // Asked before anything is minted or held. A machine that is asleep is not a
    // slow machine: waiting out two minutes for an answer that was never coming
    // is the failure mode ③ exists to remove.
    if (!deps.connectedDevices().has(deviceId)) {
      return { ok: false, error: await refusal(deviceId, server) };
    }
    const requestId = mintRequestId();
    const request: DeviceMcpRequest = { requestId, server, op, ...extra };
    const reached = deps.pushTo(deviceId, MCP_REQUEST_FRAME, request);
    // The check above and the write below are two separate instants, and a stream
    // can close between them. Rather than trust the first answer, act on the one
    // that actually tried: nothing was written, so nobody is going to answer.
    if (reached === 0) {
      return { ok: false, error: await refusal(deviceId, server) };
    }
    log('mcp-device', 'sent an MCP request', { deviceId, server, op, streams: reached });
    return new Promise<DeviceMcpResult>((resolve) => {
      const timer = setTimeout(() => {
        // Forget it first: a late answer that arrives after this must find
        // nothing, or it would resolve a promise that has already been settled.
        pending.delete(requestId);
        log('mcp-device', 'an MCP request timed out', { deviceId, server, op });
        resolve({
          ok: false,
          error:
            op === 'call'
              ? `The tool did not finish within ${Math.round(timeoutMs / 1000)}s on the computer running "${server}".`
              : `"${server}" did not list its tools within ${Math.round(timeoutMs / 1000)}s.`
        });
      }, timeoutMs);
      // Never hold the process open for a call somebody may have walked away from.
      timer.unref?.();
      pending.set(requestId, { deviceId, server, settle: resolve, timer });
    });
  }

  return {
    async assignmentsFor(deviceId) {
      const servers = await deps.readServers();
      return Object.entries(servers)
        .filter(([, def]) => def.location?.deviceId === deviceId)
        // A disabled server IS sent, flagged, rather than withheld. Withholding
        // it looks identical over there to being un-pinned, and the host prunes
        // an approval it is no longer assigned — so turning a server off and on
        // again would ask you to approve a spec you had already approved, when
        // what `disabled` promises (setMcpServerEnabled) is that the entry keeps
        // its config AND its approval. Nothing disabled ever starts on the far
        // side; "disabled" is still decided here, and the flag is how that
        // decision travels rather than a second place it gets made.
        .map(([name, def]): DeviceMcpAssignment => {
          const spec = deviceSpecFor(def);
          return {
            name,
            spec,
            fingerprint: mcpSpecFingerprint(spec),
            ...(def.disabled ? { disabled: true } : {}),
            // Sent with the spec because it is a fact ABOUT this spec: these
            // values are in mcp.json and this machine could not read them, so the
            // fingerprint the device is being asked to approve is one nobody
            // typed. See DeviceMcpAssignment.lostSecrets.
            ...(def.lostSecrets?.length ? { lostSecrets: [...def.lostSecrets] } : {})
          };
        });
    },

    async announce(deviceId, report) {
      const announcement = normalizeAnnouncement(report);
      const catalog = await deps.catalog.read();
      // The device replaces its own entry wholesale rather than merging into it:
      // it is the authority on what it is hosting, and a merge would keep a
      // server it has since been un-pinned from alive in the catalog forever.
      catalog.devices[deviceId] = {
        deviceId,
        announcedAt: new Date().toISOString(),
        servers: announcement.servers
      };
      await deps.catalog.write(catalog);
      log('mcp-device', 'a device announced its MCP servers', {
        deviceId,
        servers: announcement.servers.length
      });
    },

    settle(deviceId, requestId, result) {
      const held = pending.get(requestId);
      if (!held) return false;
      // Belt to the id's braces. It buys nothing against the machine the request
      // was sent to — that one is answering as itself — but it does stop a second
      // paired device from answering for the first, which is a distinct thing
      // from guessing an id and worth being unable to do at all.
      if (held.deviceId !== deviceId) {
        log('mcp-device', 'refused an MCP result from the wrong device', {
          expected: held.deviceId,
          got: deviceId
        });
        return false;
      }
      // Single-use: gone before it is answered, so a client that sends the same
      // result twice settles nothing the second time.
      pending.delete(requestId);
      clearTimeout(held.timer);
      held.settle(asResult(result, held.server));
      return true;
    },

    listTools: (deviceId, server) => dispatch(deviceId, server, 'tools', {}, LIST_TIMEOUT_MS),

    // A listing's timeout, not a call's: the hosting machine answers this from
    // the tool definitions it already holds from its handshake. Nothing is run.
    describeTool: (deviceId, server, tool) =>
      dispatch(deviceId, server, 'describe', { tool }, DESCRIBE_TIMEOUT_MS),

    callTool: (deviceId, server, tool, args) =>
      dispatch(deviceId, server, 'call', { tool, args }, CALL_TIMEOUT_MS),

    assignmentsChanged(deviceId) {
      const reached = deps.pushTo(deviceId, MCP_ASSIGNMENTS_FRAME, {});
      log('mcp-device', 'told a device its MCP assignments changed', { deviceId, streams: reached });
      return reached;
    },

    isAvailable: (deviceId) => deps.connectedDevices().has(deviceId),

    catalog: () => deps.catalog.read(),

    async forget(deviceId) {
      // Anything in flight to that machine is answered now rather than left to
      // time out: its streams were cut with the same revocation, so the two
      // minutes a call would otherwise wait are two minutes of nothing.
      for (const [requestId, held] of pending) {
        if (held.deviceId !== deviceId) continue;
        pending.delete(requestId);
        clearTimeout(held.timer);
        held.settle({
          ok: false,
          error: `The computer running "${held.server}" was unpaired from this Stem while the tool was running.`
        });
      }
      const catalog = await deps.catalog.read();
      if (!catalog.devices[deviceId]) return;
      delete catalog.devices[deviceId];
      await deps.catalog.write(catalog);
      log('mcp-device', 'forgot what an unpaired device was hosting', { deviceId });
    },

    close() {
      for (const [, held] of pending) {
        clearTimeout(held.timer);
        held.settle({ ok: false, error: 'Stem stopped while the tool was running.' });
      }
      pending.clear();
    }
  };
}

/**
 * What a client sent back, as a result the caller can act on. A device writes
 * this, so nothing about its shape is assumed: anything that is not recognisably
 * one of the two answers becomes a failure that names the server, rather than an
 * `ok: true` with an undefined payload landing in a tool result.
 */
function asResult(raw: unknown, server: string): DeviceMcpResult {
  const value = raw as Partial<DeviceMcpResult> | null;
  if (value && typeof value === 'object' && value.ok === true) {
    const ok = value as Extract<DeviceMcpResult, { ok: true }>;
    return {
      ok: true,
      ...(Array.isArray(ok.tools) ? { tools: ok.tools } : {}),
      ...(ok.content === undefined ? {} : { content: ok.content }),
      // A schema is a plain object with a name on it, or it is nothing. It ends
      // up in a prompt, so an answer shaped like anything else is dropped here
      // rather than rendered as whatever it happened to be.
      ...(ok.schema && typeof ok.schema === 'object' && typeof ok.schema.name === 'string'
        ? { schema: ok.schema }
        : {})
    };
  }
  const error = (value as { error?: unknown } | null)?.error;
  return {
    ok: false,
    error: typeof error === 'string' && error.trim() ? error : `"${server}" answered with nothing usable.`
  };
}

// ---- the wired one ----

let router: DeviceMcpRouter | null = null;

/**
 * The router this server uses, created on first use.
 *
 * Lazy rather than built in the composition root because its dependencies are
 * module-level already (the transport singleton, the device registry, mcp.json)
 * and there is nothing to inject at boot that would not simply be those. Tests
 * build their own with createDeviceMcpRouter and never touch this one.
 */
export function deviceMcpRouter(): DeviceMcpRouter {
  router ??= createDeviceMcpRouter({
    pushTo: pushToDevice,
    connectedDevices: connectedDeviceIds,
    deviceLabel: async (deviceId) => {
      // quiet: the null is read, not dropped — the branch below turns it into the
      // id rather than into a claim about the pairing, which is the whole reason
      // this is a null and not an empty list.
      const devices = await readDevices().catch(() => null);
      // A registry that could not be read is not evidence that the device is
      // gone, so it falls back to the id rather than to the "no longer paired"
      // sentence — an id is at least something the user can look up in
      // Settings → Server → Devices.
      if (!devices) return `the device ${deviceId}`;
      const device = devices.find((d) => d.id === deviceId);
      // Quoted so a label with a space in it reads as one thing. Null for a
      // device that is not in the registry — see refusal(), which has a whole
      // different thing to say about a pin whose machine was unpaired.
      return device ? `“${device.label}”` : null;
    },
    readServers: async () => (await readMcpConfig()).servers,
    catalog: fileCatalogStore()
  });
  return router;
}

/** Drop the wired router (app quit; tests that want a clean singleton). */
export function closeDeviceMcpRouter(): void {
  router?.close();
  router = null;
}
