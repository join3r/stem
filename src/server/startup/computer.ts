import { closeComputerDeviceRouter, computerDeviceRouter } from '../computer-device/router';
import { resolveComputerTarget } from '../exec-device/router';
import type { ChatBackend, ComputerBridge } from '../backend/types';

/**
 * Computer control: the assistant's `computer` tool, routed from the backend
 * to the computer-device router (one screen action out to the turn's Mac, one
 * screenshot back). The bridge is thin on purpose: every decision that matters
 * — which Mac (the persona pin or a chat's Settings choice, read off the live
 * turn in pi/runtime.ts; a model-chooses chat's pick is checked here), whether that Mac lets Stem drive it at all (its own
 * switch), and when a run ends (the person's own input) — is made elsewhere.
 */
export function initComputerControl(deps: { runtime: ChatBackend }): ComputerBridge {
  const bridge: ComputerBridge = {
    handleComputerRequest: (req) =>
      computerDeviceRouter().send(req.threadId, req.device, req.action, req.shot === false ? { shot: false } : undefined),
    async resolveNamedMac(name) {
      const target = await resolveComputerTarget(name);
      if (!target.ok) return target;
      const host = await computerDeviceRouter().hostFor(target.deviceId);
      if (!host?.enabled) return { ok: false, error: `“${target.label}” does not let Stem control it.` };
      if (!computerDeviceRouter().isAvailable(target.deviceId)) {
        return {
          ok: false,
          error: `“${target.label}” is not connected right now — it may be asleep, or Stem there is closed.`
        };
      }
      return { ok: true, deviceId: target.deviceId };
    },
    endThread: (threadId, reason) => computerDeviceRouter().endThread(threadId, reason),
    settleAll: () => closeComputerDeviceRouter()
  };
  deps.runtime.setComputerBridge(bridge);
  return bridge;
}
