import * as activity from '../activity';
import type { ActivityHandle } from '../activity';
import { HarnessService } from '../harness/service';
import { LocalHarnessHost } from '../harness/local-host';
import type { HarnessHost } from '../harness/host';
import type { HarnessProgressUpdate } from '../harness/service';
import { readSettings } from '../workspace/settings';
import type { ChatBackend } from '../backend';
import type { HarnessApprovalArmed, HarnessApprovalRequest } from '../../shared/types';

/**
 * Coding agents: the assistant's coding_agent tool, routed from the backend to
 * the server's HarnessService via the HarnessBridge wired here. The embedded
 * acpx host is created lazily on the first request, with the registry
 * overrides the settings held at that moment — like pi's models.json, a
 * changed override applies after a server restart, and the enable switch (read
 * fresh per request) is what applies immediately.
 */
export function initHarness(deps: {
  runtime: ChatBackend;
  emitApprovalRequest: (request: HarnessApprovalRequest) => void;
  emitApprovalResolved: (id: string) => void;
  emitApprovalArmed: (armed: HarnessApprovalArmed) => void;
  onProgress?: (update: HarnessProgressUpdate) => void;
}): { service: HarnessService; close: () => Promise<void> } {
  let localHost: LocalHarnessHost | null = null;
  let overrides: Record<string, string> = {};
  // One background-activity entry per run, held by runId rather than the
  // registry's stepped-by-kind correlation: two chats can run two agents at
  // once, and stepped correlation would fold them into one row
  // (mirror/sync-activity.ts precedent).
  const openRuns = new Map<string, ActivityHandle>();
  const onProgress = (update: HarnessProgressUpdate): void => {
    const handle = openRuns.get(update.runId);
    if (update.settled) {
      if (handle) {
        openRuns.delete(update.runId);
        activity.end(handle, { worked: true, detail: update.detail });
      }
    } else if (handle) {
      activity.setDetail(handle, update.detail);
    } else {
      openRuns.set(
        update.runId,
        activity.begin('harness.run', `Coding agent (${update.agent})`, { detail: update.detail })
      );
    }
    deps.onProgress?.(update);
  };
  const service = new HarnessService({
    settings: async () => {
      const harness = (await readSettings()).harness;
      // Latched for the lazy host construction below; the acpx registry is
      // built once per process.
      overrides = Object.fromEntries(Object.entries(harness.agents).map(([name, a]) => [name, a.command]));
      return harness;
    },
    localHost: (): HarnessHost => {
      if (!localHost) {
        localHost = new LocalHarnessHost(
          Object.keys(overrides).length ? { agentCommands: overrides } : {}
        );
      }
      return localHost;
    },
    emitApprovalRequest: deps.emitApprovalRequest,
    emitApprovalResolved: deps.emitApprovalResolved,
    emitApprovalArmed: deps.emitApprovalArmed,
    onProgress
  });
  deps.runtime.setHarnessBridge(service);
  return {
    service,
    close: async () => {
      service.settleAll();
      await localHost?.close();
    }
  };
}
