import { degrade } from '../degrade';
import { log } from '../log';
import { readMcpConfig, type PiMcpServer } from '../pi/mcp-config';
import { deviceMcpRouter, type DeviceMcpRouter } from './router';
import type { DeviceMcpResult } from '../../shared/types';

// The pi side of a device-located server: one payload in, one result out.
//
// The bridge extension raises a ctx.ui.input carrying
// `{ op, server, tool?, args? }` under DEVICE_MCP_BRIDGE_TITLE; PiRuntime hands
// the payload here and answers the held elicitation with what comes back. This
// file is that middle step and nothing else — the router already owns the
// correlation id, the timeouts, the availability check and the refusal text, and
// duplicating any of it here would give the same question two answers.
//
// The one decision that belongs here is which machine a server runs on, and it
// is resolved from mcp.json rather than taken from the payload. The extension
// runs inside the pi process, which is exactly what a compromised MCP server
// gets to talk to: if it could name the device, it could aim a call at a machine
// the user never pinned that server to.

export interface DeviceMcpBridgeDeps {
  /** Every entry in mcp.json, decrypted. Where the pin is read from. */
  readServers(): Promise<Record<string, PiMcpServer>>;
  router(): DeviceMcpRouter;
}

const wiredDeps: DeviceMcpBridgeDeps = {
  readServers: async () => (await readMcpConfig()).servers,
  router: deviceMcpRouter
};

/**
 * Run one bridge op. Always resolves: the extension is holding a tool call open
 * on the other side of this, so every path — a malformed payload, an unknown
 * server, an unpinned one — ends in a `{ ok: false, error }` it can show.
 */
export async function runDeviceMcpBridgeOp(
  payload: string | undefined,
  deps: DeviceMcpBridgeDeps = wiredDeps
): Promise<DeviceMcpResult> {
  let request: { op?: unknown; server?: unknown; tool?: unknown; args?: unknown };
  try {
    request = JSON.parse(payload ?? '{}') as typeof request;
  } catch {
    // quiet: the extension is holding a tool call open on the other side of
    // this, and every path here ends in an error it shows.
    return { ok: false, error: 'Stem could not read that request.' };
  }
  const server = typeof request.server === 'string' ? request.server : '';
  if (!server) return { ok: false, error: 'No MCP server was named.' };

  // A config nobody can read pins nothing: every server is refused by name
  // rather than routed on a guess.
  const servers = await deps.readServers().catch((err) => {
    // Refusing is right, but the sentence below then blames the pin — it tells the
    // model the server "is not configured to run on one of your devices" when the
    // truth is that mcp.json would not read, which is the same answer it would
    // give for a server the user really did delete.
    degrade('mcp-device', 'refused every device-pinned MCP server because the config would not read', err);
    return {} as Record<string, PiMcpServer>;
  });
  const deviceId = servers[server]?.location?.deviceId;
  if (!deviceId) {
    // Either the entry is gone or it is a server-located one, which the bridge
    // connects itself and must never reach this path with.
    return { ok: false, error: `"${server}" is not configured to run on one of your devices.` };
  }

  const router = deps.router();
  if (request.op === 'tools') return router.listTools(deviceId, server);
  if (request.op === 'call' || request.op === 'describe') {
    const tool = typeof request.tool === 'string' ? request.tool : '';
    if (!tool) return { ok: false, error: `No tool was named on "${server}".` };
    return request.op === 'describe'
      ? router.describeTool(deviceId, server, tool)
      : router.callTool(deviceId, server, tool, request.args);
  }
  log('mcp-device', 'the bridge asked for an operation that does not exist', { server, op: String(request.op) });
  return { ok: false, error: `Stem does not know how to "${String(request.op)}" an MCP server.` };
}
