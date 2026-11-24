import { registerServer, type CallerContext } from './guard';
import type { IpcDeps } from './deps';
import * as piMcp from '../pi/mcp';
import { deviceMcpRouter } from '../mcp-device/router';
import { updateCustomInstructions } from '../workspace/settings';
import type { ApprovalId } from '../backend/types';
import type { DeviceMcpAssignment, McpServerInput } from '../../shared/types';

/** MCP server management + the assistant's held approval round-trips. */
export function registerMcpIpc(deps: IpcDeps): void {
  registerServer('mcp:list', () => piMcp.listMcpServers());
  registerServer('mcp:status', () => deps.runtime().getMcpStatus());
  registerServer('mcp:add', (_e, input: McpServerInput) => piMcp.addMcpServer(input));
  registerServer('mcp:get', (_e, name: string) => piMcp.getMcpServer(name));
  registerServer('mcp:update', (_e, input: McpServerInput) => piMcp.updateMcpServer(input));
  registerServer('mcp:remove', (_e, name: string) => piMcp.removeMcpServer(name));
  registerServer('mcp:setEnabled', (_e, name: string, enabled: boolean) =>
    piMcp.setMcpServerEnabled(name, enabled)
  );
  // Move one server to another machine (or back to this one). Null means the
  // machine hosting stem-server — the panel's *Move to <device>* and its inverse
  // are the same write, so there is one place that decides what a location may
  // be (docs/mcp-device-pinning.md, ⑩).
  registerServer('mcp:setLocation', (_e, name: string, deviceId: string | null) =>
    piMcp.setMcpServerLocation(name, deviceId)
  );
  registerServer('mcp:setApps', (_e, name: string, apps: string[] | null) => piMcp.setMcpServerApps(name, apps));
  registerServer('mcp:forApp', (_e, app: string, bundleId: string | null, url?: string | null) =>
    piMcp.mcpServersForAppName(app, bundleId, null, url ?? null)
  );
  registerServer('mcp:windowSuggestion', (_e, app: string, bundleId: string | null, url?: string | null) =>
    piMcp.windowSuggestionFor(app, bundleId, url ?? null)
  );
  registerServer('mcp:login', (_e, name: string) => deps.runtime().mcpLogin(name));
  registerServer('mcp:adminDecision', async (_e, id: ApprovalId, accept: boolean) => {
    await deps.runtime().resolveAdminApproval(
      id,
      accept,
      accept
        ? async (proposal) => {
            if (proposal.action === 'add') {
              if (!proposal.input) throw new Error('The MCP add proposal is missing its server definition.');
              // An add replaces the whole entry, and the assistant's tool has no
              // way to say where a server runs — so a re-add of one pinned to a
              // device would quietly move it back here. Keep the pin; see
              // withStoredLocation.
              const input = await piMcp.withStoredLocation(proposal.input);
              piMcp.assertDurableServerPaths(input.name, input, Boolean(input.location));
              await piMcp.addMcpServer(input);
              return;
            }
            if (proposal.action === 'edit') {
              if (!proposal.name || !proposal.patch) throw new Error('The MCP edit proposal is missing its server or its change.');
              await piMcp.assertDurableEdit(proposal.name, proposal.patch);
              await piMcp.editMcpServer(proposal.name, proposal.patch);
              return;
            }
            if (!proposal.name) throw new Error('The MCP remove proposal is missing its server name.');
            await piMcp.removeMcpServer(proposal.name);
          }
        : undefined
    );
  });
  registerMcpHostIpc();
  registerServer(
    'instructions:resolveApproval',
    async (_e, id: ApprovalId, accept: boolean, surface: 'main' | 'quickChat', text: string) => {
      // Main is the sole writer of settings.json: apply the card's final text BEFORE
      // releasing the held tool call, so the assistant only proceeds once it's persisted.
      await deps.runtime().resolveInstructionsApproval(
        id,
        accept,
        accept
          ? async () => {
              await updateCustomInstructions({ [surface]: text });
            }
          : undefined
      );
    }
  );
}

/**
 * The three channels a machine hosting MCP servers speaks on
 * (docs/mcp-device-pinning.md). All device-scoped, and all in the narrow sense
 * `devices:registerPush` established: the caller is the device, the transport
 * resolved that from its bearer token, and none of them takes a device id.
 *
 * That is not decoration here, it is the authorization. `mcpHost:hello` hands
 * back specs with API keys and bearer headers in them, so "which device is
 * asking" decides which credentials leave this machine; a device id in the
 * arguments would be a device id a caller writes. Hence the refusal below rather
 * than a fallback: a call with nobody behind it has no honest answer.
 */
function registerMcpHostIpc(): void {
  registerServer('mcpHost:hello', (caller: CallerContext): Promise<DeviceMcpAssignment[]> => {
    const deviceId = requireCaller(caller, 'mcpHost:hello');
    return deviceMcpRouter().assignmentsFor(deviceId);
  });
  // What the client is actually hosting, in its own words: the tools per server,
  // which of them are running, and which are sitting unapproved. Rewritten in
  // full on every call — the device is the authority on its own machine, and a
  // report that only added would never be able to say a server went away.
  registerServer('mcpHost:announce', (caller: CallerContext, report: unknown): Promise<void> => {
    const deviceId = requireCaller(caller, 'mcpHost:announce');
    return deviceMcpRouter().announce(deviceId, report);
  });
  // One held call's answer. An id the router does not know is not an error: it
  // is a call that already timed out, or was already answered, or never existed
  // — three things a client cannot tell apart and none of which it can fix. So
  // the boolean is for the log, and the call succeeds either way.
  registerServer('mcpHost:result', (caller: CallerContext, requestId: string, result: unknown): void => {
    const deviceId = requireCaller(caller, 'mcpHost:result');
    deviceMcpRouter().settle(deviceId, requestId, result);
  });
}

/** The calling device, or a refusal naming the channel that needed one. */
function requireCaller(caller: CallerContext, channel: string): string {
  if (caller) return caller.deviceId;
  throw new Error(`${channel} needs a paired device — it answers for the CALLER's machine.`);
}
