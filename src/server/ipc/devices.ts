import { registerServer, type CallerContext } from './guard';
import { deviceKind, readDevices, revokeDevice, setDevicePushToken } from '../transport/auth';
import { forgetPresence, reportPresence } from '../push/presence';
import { createPairingCode, pendingPairings } from '../transport/pairing';
import { dropDeviceStreams } from '../startup/transport';
import { deviceMcpRouter } from '../mcp-device/router';
import { execDeviceRouter } from '../exec-device/router';
import { harnessDeviceRouter } from '../harness/device-host';
import { log } from '../log';
import type { DeviceInfo, DevicesSnapshot, PairingCodeInfo } from '../../shared/types';

/**
 * The device registry, as Settings → Server → Devices sees it: which clients can reach
 * this server, which pairings are still outstanding, and how to end either.
 *
 * Note what is NOT here: nothing returns a token. The registry holds hashes, so
 * there is no "show me this device's credential" to expose even by accident; the
 * only value that ever leaves is a fresh pairing code, and that one is minted
 * expressly to be read out loud.
 *
 * Almost nothing here has a notion of "the device asking", and that is still the
 * rule: every call arrives having already proved itself at the transport, and no
 * handler re-derives who it was to decide what it may do. A client that wants to
 * point at its own row in the list knows its own id (client.json) and says so
 * locally; see `client:info` in src/desktop/local.
 *
 * The two push channels are the exception, and both for the same narrow reason:
 * what they carry is a fact ABOUT the caller — "wake me here", "somebody is at
 * me" — so it has to land on the caller's own record, and taking a device id as
 * an argument would let any paired device redirect another's notifications to
 * itself or silence them by claiming to be sitting at it. So they read the
 * identity the transport already resolved from the bearer token (see
 * ipc/guard.ts), which is the one input a client cannot write.
 */
export function registerDevicesIpc(): void {
  registerServer('devices:list', () => snapshot());
  registerServer('devices:revoke', async (_e, id: string): Promise<DevicesSnapshot> => {
    const removed = await revokeDevice(id);
    // The credential is gone, which decides the device's NEXT request. Its event
    // stream is a socket that is already open, and would otherwise keep
    // delivering every push for as long as it stayed up.
    const dropped = removed ? dropDeviceStreams(id) : 0;
    // The record went with the revoke, and the APNs token with it — a revoked
    // phone must not keep being woken by a server it can no longer read. What
    // does NOT live in that file is the presence report, so drop it here: a
    // desktop revoked while "recently active" would otherwise go on suppressing
    // everyone's notifications until the window ran out.
    if (removed) forgetPresence(id);
    // What that machine said it was hosting goes too. The PIN does not — an MCP
    // server pinned to a device that was unpaired stays in mcp.json, shows as
    // orphaned in the panel and waits for a person (docs/mcp-device-pinning.md,
    // ⑩) — but the catalog is a different thing: it is what the assistant is
    // told it can do, and tools on a machine that can no longer reach this Stem
    // are not capabilities it has. Leaving them there would put a promise in
    // every prompt that every call would then refuse.
    if (removed) await deviceMcpRouter().forget(id);
    // Same reasoning for what it said about running commands: an unpaired
    // machine is not a place commands can go, and its in-flight ones are
    // answered now rather than left to time out against cut streams.
    if (removed) await execDeviceRouter().forget(id);
    // And what it said about running coding agents, for the same reason — its
    // in-flight turns are failed now rather than left to the idle timeout.
    if (removed) await harnessDeviceRouter().forget(id);
    if (removed) log('devices', 'revoked a device', { id, streamsDropped: dropped });
    return snapshot();
  });
  // Called by the phone on launch and whenever iOS rotates its token. Idempotent
  // by construction — it stores what it is given for whoever is calling — so a
  // client that cannot tell a rotation from a relaunch can simply always call it.
  registerServer(
    'devices:registerPush',
    async (caller: CallerContext, token: string, platform: 'ios' = 'ios'): Promise<void> => {
      if (!caller) {
        // A local caller (an Electron window over ipcMain) has no device record to
        // put this on. Nothing does this; refusing loudly is better than writing
        // the token onto some arbitrary row.
        throw new Error('devices:registerPush needs a paired device — it registers the CALLER for push.');
      }
      // Shape-checked here rather than in the arg spec: the guard's specs are
      // structural (is it a string), and "looks like an APNs device token" is a
      // domain rule. A malformed one would be stored, sent, and rejected by Apple
      // on every notification from now until somebody read the log.
      if (!/^[0-9a-f]{64,200}$/i.test(token)) {
        throw new Error('that is not an APNs device token');
      }
      const stored = await setDevicePushToken(caller.deviceId, token.toLowerCase(), platform);
      log('devices', stored ? 'registered a device for push' : 'ignored push registration for an unknown device', {
        id: caller.deviceId,
        platform
      });
    }
  );
  // Somebody is at that machine right now. The desktop calls this about once a
  // minute while its OS idle timer is under a few minutes, and stops calling the
  // moment it is not — which is the whole protocol: the CLIENT decides whether it
  // is present, and a report arriving is the answer.
  //
  // So `idleSeconds` is not consulted, deliberately. Reading it here would make
  // the server the second place that decides what "at the machine" means, and the
  // two would drift; worse, it would put the decision in a number the caller
  // writes, when the useful signal — a heartbeat that simply stops — is one it
  // cannot fake by lying about. It rides along because it is worth having in a
  // log the day this behaves oddly.
  //
  // Caller-less dispatch is ignored rather than refused, unlike registerPush.
  // There the call is meaningless without a device (a token has to land on a
  // record); here it is merely uninformative, and the honest answer to "somebody
  // used a machine we cannot name" is to learn nothing and say nothing.
  registerServer('devices:presence', (caller: CallerContext, _idleSeconds: number): void => {
    if (caller) reportPresence(caller.deviceId);
  });
  registerServer(
    'devices:createPairingCode',
    (_e, label: string): Promise<PairingCodeInfo> => createPairingCode(label)
  );
  // The two channels a machine that runs commands speaks on. Device-scoped in
  // the same narrow sense as the mcpHost channels beside them: the caller IS
  // the device, the transport resolved that from the bearer token, and a device
  // id in the arguments would let one paired machine claim another's answers.
  registerServer('execHost:announce', (caller: CallerContext, report: unknown): Promise<void> => {
    if (!caller) {
      throw new Error('execHost:announce needs a paired device — it answers for the CALLER’s machine.');
    }
    return execDeviceRouter().announce(caller.deviceId, report);
  });
  // One held command's answer. An unknown id is not an error — it already timed
  // out, was already answered, or never existed; the boolean is for the log.
  registerServer('execHost:result', (caller: CallerContext, requestId: string, result: unknown): void => {
    if (!caller) {
      throw new Error('execHost:result needs a paired device — it answers for the CALLER’s machine.');
    }
    execDeviceRouter().settle(caller.deviceId, requestId, result);
  });
}

async function snapshot(): Promise<DevicesSnapshot> {
  const [devices, pending, execHosts] = await Promise.all([
    readDevices(),
    pendingPairings(),
    execDeviceRouter().hosts()
  ]);
  return {
    devices: devices.map(
      (d): DeviceInfo => ({
        id: d.id,
        label: d.label,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        // Resolved here rather than passed through raw: every consumer wants the
        // answer, not the absence, and the default belongs in one place.
        kind: deviceKind(d),
        // Only when it said yes: "announced enabled: false" and "never
        // announced" are the same fact to the list — this machine does not run
        // commands — and neither earns a tag.
        ...(execHosts[d.id]?.enabled ? { runsCommands: true } : {})
      })
    ),
    pending: pending.map((p) => ({ label: p.label, expiresAt: p.expiresAt }))
  };
}
