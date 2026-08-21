import { registerServer, type CallerContext } from '../ipc/guard';
import { harnessDeviceRouter } from './device-host';
import type { DeviceHarnessEventAck, DeviceHarnessPermissionDecision } from '../../shared/types';

// The channels a machine that runs coding agents speaks on. Device-scoped in
// the same narrow sense as the execHost channels: the caller IS the device,
// the transport resolved that from the bearer token, and a device id in the
// arguments would let one paired machine claim another's turns.

export function registerHarnessIpc(): void {
  registerServer('harnessHost:announce', (caller: CallerContext, report: unknown): Promise<void> => {
    if (!caller) {
      throw new Error('harnessHost:announce needs a paired device — it answers for the CALLER’s machine.');
    }
    return harnessDeviceRouter().announce(caller.deviceId, report);
  });
  // One held ensure/run's answer. An unknown id is not an error — it already
  // timed out, was already answered, or belonged to a server that restarted.
  registerServer('harnessHost:result', (caller: CallerContext, requestId: string, result: unknown): void => {
    if (!caller) {
      throw new Error('harnessHost:result needs a paired device — it answers for the CALLER’s machine.');
    }
    harnessDeviceRouter().settle(caller.deviceId, requestId, result);
  });
  // A flushed event batch (or an empty heartbeat). The ack is load-bearing:
  // every POST is a cancellation delivery opportunity, and an unknown turnId is
  // answered 'cancel' — which is how a client outlives a server restart.
  registerServer('harnessHost:event', (caller: CallerContext, batch: unknown): DeviceHarnessEventAck => {
    if (!caller) {
      throw new Error('harnessHost:event needs a paired device — it answers for the CALLER’s machine.');
    }
    return harnessDeviceRouter().onEvent(caller.deviceId, batch);
  });
  // BLOCKING: held open until the card settles (or the visible clock runs out).
  registerServer(
    'harnessHost:permission',
    (caller: CallerContext, ask: unknown): Promise<DeviceHarnessPermissionDecision> => {
      if (!caller) {
        throw new Error('harnessHost:permission needs a paired device — it answers for the CALLER’s machine.');
      }
      return harnessDeviceRouter().onPermission(caller.deviceId, ask);
    }
  );
}
