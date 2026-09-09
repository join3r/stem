// Waking a phone: who we are allowed to wake, when we refuse to, and what a
// notification is allowed to say.
//
// Three properties are load-bearing here and each has its own describe:
//
//   1. Unconfigured is OFF. Every install that is not the author's phone sets no
//      APNs key, and on that path nothing must happen at all — no registry read,
//      no label resolved, and above all no request. This is the default, so it is
//      tested as the default.
//   2. A push carries ids, not content. The payload builder is the only thing
//      that decides what leaves this machine, and what leaves is a fixed phrase,
//      a short label, and ids that mean nothing without a token for this server.
//   3. The refusals hold: somebody at a desk, a turn that took four seconds, an
//      `inbox`-mode task notification. Each of those is a notification the user
//      would come to resent, and each is refused for its own reason.
//
// The HTTP/2 layer is replaced wholesale (setApnsPost). Everything above the
// wire is worth exercising and none of it should need Apple; the one thing that
// cannot be faked without losing its meaning is the provider token, so that is
// signed for real and verified with a real public key.

import { createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const TASKS_STORE = join(tmpdir(), `stem-push-tasks-${process.pid}.json`);
process.env.STEM_TASKS_STORE = TASKS_STORE;

import { closeApns, sendApns, setApnsPost, type ApnsRequest } from '../../src/server/push/apns';
import {
  MIN_TURN_PUSH_MS,
  pushApprovalRequest,
  pushTaskAlert,
  pushMailReceived,
  pushTurnFinished,
  wakeUpPayload
} from '../../src/server/push';
import { forgetPresence, isAnyDesktopPresent, reportPresence } from '../../src/server/push/presence';
import { dispatchLocal } from '../../src/server/ipc/guard';
import { registerDevicesIpc } from '../../src/server/ipc/devices';
import { initTaskScheduler } from '../../src/server/startup/scheduler';
import { forgetCachedDevices, mintDevice, readDevices } from '../../src/server/transport/auth';
import { devicesStorePath, settingsStorePath } from '../../src/server/workspace/paths';
import { updateTasksSettings } from '../../src/server/workspace/settings';
import type { ChatBackend } from '../../src/server/backend';
import type { TaskBridge } from '../../src/server/backend/types';
import type { ExecApprovalRequest, TaskNotifyMode } from '../../src/shared/types';
import { EventEmitter } from 'node:events';

/** A device token as APNs mints them: 32 bytes, hex. */
const PHONE_TOKEN = 'a'.repeat(64);
const KEY_PATH = join(tmpdir(), `stem-apns-key-${process.pid}.p8`);
const devicesPath = devicesStorePath();

/** Every request the sender made since the last reset. */
let sent: ApnsRequest[] = [];
/** What the fake APNs answers next — one entry per request, 200 when exhausted. */
let answers: { status: number; body: string }[] = [];

function apnsEnv(): void {
  process.env.STEM_APNS_KEY_PATH = KEY_PATH;
  process.env.STEM_APNS_KEY_ID = 'KEYID12345';
  process.env.STEM_APNS_TEAM_ID = 'TEAM123456';
  process.env.STEM_APNS_BUNDLE_ID = 'sk.awantech.stem';
}

function clearApnsEnv(): void {
  delete process.env.STEM_APNS_KEY_PATH;
  delete process.env.STEM_APNS_KEY_ID;
  delete process.env.STEM_APNS_TEAM_ID;
  delete process.env.STEM_APNS_BUNDLE_ID;
  delete process.env.STEM_APNS_ENV;
}

/** The `stem` routing block of the last request, parsed. */
function lastStem(): Record<string, unknown> {
  return (JSON.parse(sent.at(-1)!.body) as { stem: Record<string, unknown> }).stem;
}

/** The alert as iOS would show it. */
function lastAlert(): { title: string; body: string } {
  return (JSON.parse(sent.at(-1)!.body) as { aps: { alert: { title: string; body: string } } }).aps.alert;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for `n` requests. Every trigger is fire-and-forget — nothing hands back a
 * promise to await — so a test either waits for the send it expects or, for the
 * sends it expects NOT to happen, waits out `quiet()` below.
 */
async function waitForSends(n: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (sent.length < n && Date.now() < deadline) await sleep(5);
  expect(sent.length).toBe(n);
}

/** Long enough for a send that was going to happen to have happened. */
async function quiet(): Promise<number> {
  await sleep(120);
  return sent.length;
}

/** A device that has registered for push, as the phone would leave it. */
async function pairedPhone(): Promise<string> {
  const { device } = await mintDevice('A phone');
  await dispatchLocal('devices:registerPush', [PHONE_TOKEN, 'ios'], { deviceId: device.id });
  return device.id;
}

/** The other half of the key written to KEY_PATH — Apple's side of the JWT check. */
let applesKey: KeyObject;

beforeAll(() => {
  // A real P-256 key in the .p8 shape Apple hands out, so the JWT below is
  // signed and verified for real rather than around.
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'utf8');
  applesKey = publicKey;
  registerDevicesIpc();
});

beforeEach(async () => {
  // lastSeenAt is stamped behind the request; drain the registry's queue before
  // wiping the file so a previous test's write can't land on the next fixture.
  await readDevices().catch(() => undefined);
  mkdirSync(dirname(devicesPath), { recursive: true });
  mkdirSync(dirname(settingsStorePath()), { recursive: true });
  rmSync(devicesPath, { force: true });
  rmSync(settingsStorePath(), { force: true });
  rmSync(TASKS_STORE, { force: true });
  forgetCachedDevices();
  forgetPresence();
  closeApns();
  sent = [];
  answers = [];
  clearApnsEnv();
  setApnsPost(async (req) => {
    sent.push(req);
    return answers.shift() ?? { status: 200, body: '' };
  });
});

afterEach(async () => {
  // Let any delivery still in flight finish against THIS test's fake before the
  // next one resets the recorder — a fire-and-forget trigger outlives the `it`
  // that fired it, and a straggler landing in the next test's array would read
  // as a send that test never made.
  await sleep(60);
  setApnsPost(null);
  clearApnsEnv();
  rmSync(devicesPath, { force: true });
  rmSync(settingsStorePath(), { force: true });
  rmSync(TASKS_STORE, { force: true });
});

describe('registering for push', () => {
  it('stores the token on the CALLING device, not on one it names', async () => {
    const { device: phone } = await mintDevice('A phone');
    const { device: laptop } = await mintDevice('A laptop');

    await dispatchLocal('devices:registerPush', [PHONE_TOKEN, 'ios'], { deviceId: phone.id });

    const devices = await readDevices();
    expect(devices.find((d) => d.id === phone.id)).toMatchObject({ apnsToken: PHONE_TOKEN, platform: 'ios' });
    // The channel takes no device id at all, so there is no argument with which
    // one paired device could aim another device's notifications at itself.
    expect(devices.find((d) => d.id === laptop.id)?.apnsToken).toBeUndefined();
  });

  it('defaults the platform, and survives a round trip through the file', async () => {
    const id = await pairedPhone();
    forgetCachedDevices();
    const reread = (await readDevices()).find((d) => d.id === id);
    expect(reread).toMatchObject({ apnsToken: PHONE_TOKEN, platform: 'ios' });
  });

  it('refuses a call with no device behind it', async () => {
    // dispatchLocal with no caller is an in-process call (a desktop window over
    // ipcMain). There is no record such a call could mean.
    await expect(dispatchLocal('devices:registerPush', [PHONE_TOKEN])).rejects.toThrow(/paired device/);
  });

  it('refuses anything that is not an APNs device token', async () => {
    const { device } = await mintDevice('A phone');
    for (const bad of ['', 'not-a-token', 'zz'.repeat(32), 'a'.repeat(30)]) {
      await expect(
        dispatchLocal('devices:registerPush', [bad, 'ios'], { deviceId: device.id })
      ).rejects.toThrow();
    }
    expect((await readDevices())[0].apnsToken).toBeUndefined();
  });

  it('rejects a platform it has no way to reach', async () => {
    const { device } = await mintDevice('A phone');
    await expect(
      dispatchLocal('devices:registerPush', [PHONE_TOKEN, 'android'], { deviceId: device.id })
    ).rejects.toThrow(/one of ios/);
  });

  it('takes the token off the row a re-paired phone left behind', async () => {
    // Unpairing withdraws a credential; it does not uninstall the app, and iOS
    // hands the same native token back to the same install. So a phone paired
    // twice arrives as a new record carrying the old record's address. Both rows
    // are then the same phone, APNs answers 200 to both, and nothing downstream
    // could ever notice — the user just gets everything twice, forever.
    const stale = await pairedPhone();
    const { device: fresh } = await mintDevice('The same phone, paired again');

    await dispatchLocal('devices:registerPush', [PHONE_TOKEN, 'ios'], { deviceId: fresh.id });

    const devices = await readDevices();
    expect(devices.find((d) => d.id === fresh.id)).toMatchObject({ apnsToken: PHONE_TOKEN, platform: 'ios' });
    // The old row survives — it is somebody's device history, and the label in
    // Settings → Server → Devices is how they recognize what to revoke. It is
    // just no longer an address.
    const before = devices.find((d) => d.id === stale);
    expect(before).toBeTruthy();
    expect(before?.apnsToken).toBeUndefined();
    expect(before?.platform).toBeUndefined();
  });

  it('takes the token away with the device when it is revoked', async () => {
    const id = await pairedPhone();
    reportPresence(id);

    await dispatchLocal('devices:revoke', [id]);

    // The record went, and the token with it — a revoked phone must not keep
    // being woken by a server it can no longer read.
    expect((await readDevices()).some((d) => d.id === id)).toBe(false);
    apnsEnv();
    pushApprovalRequest('exec', { id: 'x1', threadId: 't1' });
    expect(await quiet()).toBe(0);
    // And its presence report went too, so it cannot go on silencing anyone.
    expect(isAnyDesktopPresent()).toBe(false);
  });
});

describe('the off switch', () => {
  it('sends nothing when APNs is not configured — the default everywhere', async () => {
    await pairedPhone();

    pushApprovalRequest('exec', { id: 'x1', threadId: 't1' });
    pushTurnFinished({ threadId: 't1', failed: false, ranForMs: 10 * 60_000 });
    pushTaskAlert({ threadId: 't1', taskId: 'task-1', label: 'Morning news' });

    expect(await quiet()).toBe(0);
  });

  it('treats a half-configured sender as off rather than as an error', async () => {
    await pairedPhone();
    apnsEnv();
    delete process.env.STEM_APNS_TEAM_ID;

    pushApprovalRequest('exec', { id: 'x1', threadId: 't1' });

    expect(await quiet()).toBe(0);
  });

  it('never resolves a label on the off path', async () => {
    await pairedPhone();
    let resolved = 0;
    // The thunk is the whole reason a label may be expensive: with no APNs
    // configuration, looking up a thread title would be work done for nobody.
    pushTaskAlert({
      threadId: 't1',
      label: () => {
        resolved++;
        return 'Morning news';
      }
    });
    await quiet();
    expect(resolved).toBe(0);
  });

  it('sends nothing when no device has registered', async () => {
    await mintDevice('A laptop that never asked to be woken');
    apnsEnv();

    pushApprovalRequest('exec', { id: 'x1', threadId: 't1' });

    expect(await quiet()).toBe(0);
  });
});

describe('what a push is allowed to say', () => {
  it('carries ids and a fixed phrase, and nothing from the conversation', async () => {
    // A realistic approval card, with the things a notification must never
    // repeat: the command, where it would run, and the judge's reasoning.
    const card: ExecApprovalRequest = {
      id: 'exec-42',
      threadId: 'thread-7',
      command: 'curl https://example.com/secret-report | mail -s "Q3 layoffs" board@example.com',
      cwd: '/Users/someone/Private/Board',
      prefixes: ['curl'],
      judgeVerdict: 'unsure',
      judgeReason: 'sends the contents of a private folder to an external address'
    };
    await pairedPhone();
    apnsEnv();

    // Exactly what the server hands the trigger (see pushApproval in server/index.ts):
    // an id and a thread id, chosen there so the rest cannot travel even by accident.
    pushApprovalRequest('exec', { id: card.id, threadId: card.threadId });
    await waitForSends(1);

    const body = sent[0].body;
    for (const secret of [card.command, card.cwd, card.judgeReason!, 'layoffs', 'board@example.com']) {
      expect(body).not.toContain(secret);
    }
    expect(lastAlert()).toEqual({ title: 'Approval needed', body: 'A command is waiting for your decision.' });
    expect(lastStem()).toEqual({
      kind: 'approval',
      approvalKind: 'exec',
      threadId: 'thread-7',
      approvalId: 'exec-42'
    });
  });

  it('puts nothing but ids, a kind and a flag in the routing block', () => {
    // The keys are the deep-link contract with the app, and the list is closed:
    // anything else added here is content until proven otherwise.
    const allowed = new Set(['kind', 'approvalKind', 'threadId', 'approvalId', 'taskId', 'conversationId', 'failed']);
    const payloads = [
      wakeUpPayload({ kind: 'approval', approvalKind: 'skill', approvalId: '3', threadId: 't' }, 'A title'),
      wakeUpPayload({ kind: 'turn', threadId: 't', failed: true }, 'A title'),
      wakeUpPayload({ kind: 'task', threadId: 't', taskId: 'k' }, 'A title'),
      wakeUpPayload({ kind: 'mail', conversationId: 'mail-1' })
    ] as { stem: Record<string, unknown> }[];
    for (const payload of payloads) {
      for (const key of Object.keys(payload.stem)) expect(allowed).toContain(key);
      for (const value of Object.values(payload.stem)) expect(typeof value).not.toBe('object');
    }
  });

  it('shows the label it was given, on one line and bounded', () => {
    const long = `A thread title that ${'goes on and on '.repeat(20)}forever`;
    const alert = (wakeUpPayload({ kind: 'turn', threadId: 't' }, long) as {
      aps: { alert: { body: string } };
    }).aps.alert;
    expect(alert.body.length).toBeLessThanOrEqual(80);
    expect(alert.body).not.toContain('\n');
  });

  it('falls back to a fixed sentence per kind when there is no label', () => {
    const bodyOf = (payload: unknown): string =>
      (payload as { aps: { alert: { title: string; body: string } } }).aps.alert.body;
    expect(bodyOf(wakeUpPayload({ kind: 'turn', threadId: 't' }))).toBe('A turn you started has finished.');
    expect(bodyOf(wakeUpPayload({ kind: 'turn', threadId: 't', failed: true }))).toBe(
      'A turn you started did not finish.'
    );
    expect(bodyOf(wakeUpPayload({ kind: 'task', threadId: 't' }))).toBe(
      'A scheduled task has something for you.'
    );
    expect(bodyOf(wakeUpPayload({ kind: 'approval', approvalKind: 'mcp' }))).toBe(
      'An MCP change is waiting for your decision.'
    );
  });
});

describe('what is worth a notification', () => {
  beforeEach(async () => {
    await pairedPhone();
    apnsEnv();
  });

  it('wakes the phone for every kind of approval card', async () => {
    for (const kind of ['exec', 'mcp', 'instructions', 'skill'] as const) {
      pushApprovalRequest(kind, { id: `${kind}-1`, threadId: 't1' });
      await waitForSends(sent.length + 1);
      expect(lastStem()).toMatchObject({ kind: 'approval', approvalKind: kind });
    }
  });

  it('says nothing about a turn the user was plainly still watching', async () => {
    pushTurnFinished({ threadId: 't1', failed: false, ranForMs: MIN_TURN_PUSH_MS - 1 });
    expect(await quiet()).toBe(0);
  });

  it('reports a turn that ran long enough for the user to have walked away', async () => {
    pushTurnFinished({ threadId: 't1', failed: false, ranForMs: MIN_TURN_PUSH_MS });
    await waitForSends(1);
    expect(lastStem()).toEqual({ kind: 'turn', threadId: 't1', failed: false });
  });

  it('distinguishes a turn that failed from one that landed', async () => {
    pushTurnFinished({ threadId: 't1', failed: true, ranForMs: 5 * 60_000, label: 'Quarterly numbers' });
    await waitForSends(1);
    expect(lastStem()).toMatchObject({ kind: 'turn', failed: true });
    expect(lastAlert()).toEqual({ title: 'A turn stopped', body: 'Quarterly numbers' });
  });

  it('resolves a label thunk only once it is really sending', async () => {
    let resolved = 0;
    pushTurnFinished({
      threadId: 't1',
      failed: false,
      ranForMs: 5 * 60_000,
      label: async () => {
        resolved++;
        return 'Quarterly numbers';
      }
    });
    await waitForSends(1);
    expect(resolved).toBe(1);
    expect(lastAlert().body).toBe('Quarterly numbers');
  });

  it('survives a label that cannot be resolved', async () => {
    pushTurnFinished({
      threadId: 't1',
      failed: false,
      ranForMs: 5 * 60_000,
      label: () => {
        throw new Error('the thread list is unreadable');
      }
    });
    await waitForSends(1);
    // A label is decoration; the notification still goes.
    expect(lastAlert().body).toBe('A turn you started has finished.');
  });
});

describe('somebody is at a machine', () => {
  beforeEach(async () => {
    await pairedPhone();
    apnsEnv();
  });

  it('suppresses the push while a desktop reports real input', async () => {
    reportPresence('desktop-1');

    pushApprovalRequest('exec', { id: 'x1', threadId: 't1' });

    expect(await quiet()).toBe(0);
  });

  it('sends again once that report has aged out of the window', async () => {
    reportPresence('desktop-1');
    // Presence is a claim about the last few minutes, not a latch: a report that
    // has fallen out of the window stops suppressing anything.
    await sleep(10);
    expect(isAnyDesktopPresent(5)).toBe(false);
    forgetPresence('desktop-1');

    pushApprovalRequest('exec', { id: 'x1', threadId: 't1' });

    await waitForSends(1);
  });

  it('says nothing about presence when nobody has ever reported', () => {
    // Fail-open: an unknown answer must send the notification, not swallow it.
    expect(isAnyDesktopPresent()).toBe(false);
  });
});

describe('talking to Apple', () => {
  beforeEach(() => apnsEnv());

  it('addresses the device and the app, and signs with a verifiable ES256 token', async () => {
    await pairedPhone();

    pushApprovalRequest('exec', { id: 'x1', threadId: 't1' });
    await waitForSends(1);

    const req = sent[0];
    expect(req.host).toBe('api.sandbox.push.apple.com');
    expect(req.path).toBe(`/3/device/${PHONE_TOKEN}`);
    expect(req.headers['apns-topic']).toBe('sk.awantech.stem');
    expect(req.headers['apns-push-type']).toBe('alert');

    const jwt = req.headers.authorization.replace(/^bearer /, '');
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEYID12345' });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({ iss: 'TEAM123456' });
    // Verified exactly as Apple would: the public half of the key on disk, over
    // the signing input, in the encoding JWS specifies. That last part is the
    // subtle one — Node signs ECDSA as DER unless told otherwise, and a DER
    // signature comes back from APNs as a flat 403 that reads like a wrong key.
    const verifier = createVerify('SHA256');
    verifier.update(`${header}.${claims}`);
    verifier.end();
    const raw = Buffer.from(signature, 'base64url');
    expect(verifier.verify({ key: applesKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(true);
    // 64 bytes is r‖s for P-256; a DER-encoded one is longer and starts 0x30.
    expect(raw.length).toBe(64);
  });

  it('reuses one provider token across sends rather than minting per push', async () => {
    await pairedPhone();
    pushApprovalRequest('exec', { id: 'x1', threadId: 't1' });
    await waitForSends(1);
    pushApprovalRequest('exec', { id: 'x2', threadId: 't1' });
    await waitForSends(2);
    expect(sent[0].headers.authorization).toBe(sent[1].headers.authorization);
  });

  it('addresses production only when the deployment says so', async () => {
    process.env.STEM_APNS_ENV = 'production';
    await pairedPhone();
    pushApprovalRequest('exec', { id: 'x1', threadId: 't1' });
    await waitForSends(1);
    expect(sent[0].host).toBe('api.push.apple.com');
  });

  it('forgets a token APNs reports as gone', async () => {
    const id = await pairedPhone();
    answers = [{ status: 410, body: '{"reason":"Unregistered"}' }];

    pushApprovalRequest('exec', { id: 'x1', threadId: 't1' });
    await waitForSends(1);
    // The clear is behind the send; wait for the registry write to land.
    await sleep(50);

    expect((await readDevices()).find((d) => d.id === id)?.apnsToken).toBeUndefined();
    // And nothing tries that token again.
    pushApprovalRequest('exec', { id: 'x2', threadId: 't1' });
    expect(await quiet()).toBe(1);
  });

  it('keeps the token when Apple refuses for any other reason', async () => {
    const id = await pairedPhone();
    answers = [{ status: 400, body: '{"reason":"BadDeviceToken"}' }];

    pushApprovalRequest('exec', { id: 'x1', threadId: 't1' });
    await waitForSends(1);
    await sleep(50);

    // Only 410 means "this address is dead". Everything else is this attempt's
    // problem, and dropping the token would silence the phone for good.
    expect((await readDevices()).find((d) => d.id === id)?.apnsToken).toBe(PHONE_TOKEN);
  });

  it('never lets a broken transport reach the caller', async () => {
    await pairedPhone();
    setApnsPost(() => Promise.reject(new Error('connection reset')));
    // The callers are event handlers in the middle of a turn: a failed
    // notification must not become the turn's failure.
    expect(() => pushApprovalRequest('exec', { id: 'x1', threadId: 't1' })).not.toThrow();
    await expect(sendApns(PHONE_TOKEN, { aps: {} })).resolves.toBe('failed');
  });
});

describe('two records naming one phone', () => {
  /**
   * devices.json holding what the write path now prevents: one APNs token on two
   * rows. A restored backup, a hand-edit, a bug on either side of that write —
   * the sender is the last place this can be caught, and it is worth catching
   * there too because the symptom (everything twice) never heals by itself:
   * Apple answers 200 to both, so no 410 ever arrives to clean one up.
   */
  beforeEach(() => {
    const row = (id: string, hash: string) => ({
      id,
      tokenHash: hash.repeat(64),
      role: 'device',
      label: 'A phone',
      createdAt: '2026-08-01T00:00:00.000Z',
      lastSeenAt: null,
      apnsToken: PHONE_TOKEN,
      platform: 'ios'
    });
    writeFileSync(
      devicesPath,
      JSON.stringify({ version: 2, devices: [row('older', '1'), row('newer', '2')] }),
      'utf8'
    );
    forgetCachedDevices();
    apnsEnv();
  });

  it('wakes it once, not once per record', async () => {
    pushApprovalRequest('exec', { id: 'x1', threadId: 't1' });

    await waitForSends(1);
    expect(sent[0].path).toBe(`/3/device/${PHONE_TOKEN}`);
    expect(await quiet()).toBe(1);
  });

  it('clears a dead token from every record that carried it', async () => {
    answers = [{ status: 410, body: '{"reason":"Unregistered"}' }];

    pushApprovalRequest('exec', { id: 'x1', threadId: 't1' });
    await waitForSends(1);
    await sleep(80);

    // One request learned the address was dead; leaving it on the other record
    // would spend a request per push proving it again.
    expect((await readDevices()).map((d) => d.apnsToken)).toEqual([undefined, undefined]);
  });
});

/**
 * Enough of a backend for the task bridge to be wired over, and for a scheduled
 * run to go all the way through: the scheduler needs the thread to still exist,
 * a turn to start, and a settle event to end it. `duringTurn` is the hook that
 * matters — notify_user reaches the bridge from INSIDE a running turn, which is
 * the only state in which the alert has a task to be about.
 */
class FakeRuntime extends EventEmitter {
  bridge: TaskBridge | null = null;
  duringTurn: ((threadId: string) => Promise<void>) | null = null;
  setTaskBridge(bridge: TaskBridge | null): void {
    this.bridge = bridge;
  }
  async listThreads(): Promise<{ threadId: string; title: string; updatedAt: number }[]> {
    return [{ threadId: 't1', title: 'The build', updatedAt: 0 }];
  }
  async startTurn(input: { threadId?: string }): Promise<{ threadId: string; turnId: string }> {
    const threadId = input.threadId!;
    const turnId = 'turn-1';
    await this.duringTurn?.(threadId);
    // Settle on the next tick, so the scheduler's listener is attached first.
    setTimeout(
      () => this.emit('event', { method: 'turn/completed', params: { threadId, turn: { id: turnId } } }),
      0
    );
    return { threadId, turnId };
  }
}

describe('task notifications', () => {
  function wire(runtime: FakeRuntime) {
    return initTaskScheduler({
      runtime: runtime as unknown as ChatBackend,
      emit: () => undefined,
      isUserActive: () => false,
      revealMainWindow: () => undefined,
      requestAttention: () => undefined,
      deliverTaskMail: async () => undefined
    });
  }

  /**
   * One notify_user under `mode`, raised from inside a real scheduled run —
   * created, dispatched and settled through the scheduler, because "is a task
   * actually running" is now part of what decides whether the phone hears it.
   */
  async function notifyUnder(mode: TaskNotifyMode): Promise<{ sends: number; taskTitle: string }> {
    await updateTasksSettings({ notify: mode });
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);
    // A schedule far enough away that only runNow() below fires it.
    const created = await scheduler.create({ prompt: 'Watch the build', cron: '0 4 * * *' }, 't1');
    if (!created.ok) throw new Error(created.error);
    let notified: () => void = () => undefined;
    const raised = new Promise<void>((resolve) => (notified = resolve));
    runtime.duringTurn = async (threadId) => {
      await runtime.bridge!.notify({ title: 'Build', message: 'main went red' }, threadId);
      notified();
    };
    scheduler.runNow(created.task.id);
    await raised;
    const sends = await quiet();
    scheduler.stop();
    return { sends, taskTitle: created.task.title };
  }

  beforeEach(async () => {
    await pairedPhone();
    apnsEnv();
  });

  it('wakes the phone in alert mode', async () => {
    expect((await notifyUnder('alert')).sends).toBe(1);
    expect(lastStem()).toMatchObject({ kind: 'task', threadId: 't1' });
  });

  it('wakes the phone in nudge mode too — the phone is not the machine being nudged', async () => {
    expect((await notifyUnder('nudge')).sends).toBe(1);
  });

  it('stays silent in inbox mode, which means do not interrupt me', async () => {
    expect((await notifyUnder('inbox')).sends).toBe(0);
  });

  it('says nothing about what the task found', async () => {
    const { taskTitle } = await notifyUnder('alert');
    // `title` and `message` are the model's words about what it saw. The phone
    // gets the fixed phrase and the task's OWN name; the Inbox has the rest.
    expect(sent[0].body).not.toContain('main went red');
    expect(sent[0].body).not.toContain('Build:');
    expect(lastAlert()).toEqual({ title: 'Task alert', body: taskTitle });
  });

  it('says nothing at all when no task is running', async () => {
    // notify_user is registered for EVERY turn — "scheduled tasks only" is
    // wording in a prompt, not a gate — so an ordinary chat can call it. There is
    // no task then, and "a scheduled task has something for you" would be about
    // nothing at all, arriving next to the push that turn's own ending sends.
    await updateTasksSettings({ notify: 'alert' });
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);

    await runtime.bridge!.notify({ title: 'Build', message: 'main went red' }, 't1');

    expect(await quiet()).toBe(0);
    scheduler.stop();
  });
});


describe('mail delivery notifications', () => {
  it('wakes only for new user-addressed mail, without forwarding the body', async () => {
    apnsEnv(); await pairedPhone();
    pushMailReceived({ conversationId: 'm', from: 'user', to: ['normal'] });
    pushMailReceived({ conversationId: 'm', from: 'normal', to: ['code'] });
    pushMailReceived({ conversationId: 'm', from: 'normal', to: ['user'], taskId: 'task' });
    expect(await quiet()).toBe(0);
    pushMailReceived({ conversationId: 'm', from: 'normal', to: ['user'] });
    await waitForSends(1);
    expect(JSON.parse(sent[0].body).stem).toEqual({ kind: 'mail', conversationId: 'm' });
  });
  it('uses the same desktop presence suppression as other notifications', async () => {
    apnsEnv(); const id = await pairedPhone(); reportPresence(id);
    pushMailReceived({ conversationId: 'm', from: 'normal', to: ['user'] });
    expect(await quiet()).toBe(0);
  });
  it('routes a task mail alert to its conversation', async () => {
    apnsEnv(); await pairedPhone();
    pushTaskAlert({ threadId: 'hidden', conversationId: 'm', taskId: 'task' });
    await waitForSends(1);
    expect(JSON.parse(sent[0].body).stem).toEqual({ kind: 'mail', conversationId: 'm', taskId: 'task' });
  });
});
