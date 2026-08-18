// The approval-card state machine, enumerated as the matrix it actually is.
//
// The 0.4.x approval bug ("the assistant said I declined a command I approved")
// was not one bug: it was four — timeout × queued-behind × late answer ×
// client-away — and each had been reachable for months because every test poked
// one dimension at a time. This file walks the cells where two dimensions meet.
//
// The machine under test (exec/service.ts): every card is in exactly one of
//   queued   — behind an older card; invisible; NO clock
//   armed    — the visible head; its 10-minute clock is running
// and leaves by exactly one of
//   answered — allow / always-allow / deny, from any connected client, by id
//   timeout  — the armed clock ran out ("nobody answered", never "declined")
//   abort    — its thread's turn was aborted (deny on its behalf)
//   settleAll— the pi child died; every card of every thread is void
// while clients can be
//   connected — they got the request frame when the card was raised
//   away      — they reconnect later and replay pendingApprovals()

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecService } from '../../src/server/exec/service';
import type { ChatBackend, ExecBridgeResult } from '../../src/server/backend/types';
import type { AppSettings, ExecApprovalRequest } from '../../src/shared/types';

const TIMEOUT_MS = 600_000;

function baseSettings(): AppSettings {
  return {
    exec: {
      enabled: true,
      // Manual: straight to the card, so no cell here waits on a judge.
      approvalMode: 'manual',
      judgeModel: null,
      judgeEffort: null,
      allowlist: [],
      deviceAllowlists: {},
      windowsShell: 'cmd',
      gitBashPath: null
    },
    defaults: { model: null, backgroundModel: null, backgroundEffort: 'low' }
  } as unknown as AppSettings;
}

describe('the approval matrix', () => {
  let approvals: ExecApprovalRequest[];
  let armed: Array<{ id: string; expiresAt: number }>;
  let resolved: string[];
  let ran: string[];
  let service: ExecService;

  beforeEach(() => {
    vi.useFakeTimers();
    approvals = [];
    armed = [];
    resolved = [];
    ran = [];
    service = new ExecService({
      runtime: () => ({ listModels: async () => [], complete: async () => 'unsure' }) as unknown as ChatBackend,
      readSettings: async () => baseSettings(),
      updateExecSettings: async () => baseSettings(),
      emitApprovalRequest: (request) => approvals.push(request),
      emitApprovalResolved: (id) => resolved.push(id),
      emitApprovalArmed: (a) => armed.push(a),
      resolveDevice: async () => ({ ok: true, deviceId: 'mac-1', label: "Vlado's MacBook" }),
      deviceRouter: () =>
        ({
          announce: async () => undefined,
          hosts: async () => ({}),
          hostFor: async () => ({
            deviceId: 'mac-1',
            announcedAt: new Date().toISOString(),
            enabled: true,
            platform: 'darwin'
          }),
          isAvailable: () => true,
          run: async (_device: string, req: { command: string }) => {
            ran.push(req.command);
            return { ok: true as const, text: 'Exit code: 0' };
          },
          settle: () => false,
          abortThread: () => undefined,
          forget: async () => undefined,
          close: () => undefined
        }) as never
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Raise a card from `threadId`. Device-targeted so no local cwd/scratch is touched. */
  const ask = (command: string, threadId = 'chat-a'): Promise<ExecBridgeResult> =>
    service.handleExecRequest({ command, device: 'mac-1', threadId, isScheduled: false } as never);

  const untilCards = async (n: number): Promise<void> => {
    for (let i = 0; i < 20 && approvals.length < n; i++) await vi.advanceTimersByTimeAsync(1);
  };

  const errorOf = (result: ExecBridgeResult): string => (result as { error: string }).error;

  // ---- timeout × queued-behind ----
  // The deny→promotion handoff has a test; the timeout→promotion handoff did not,
  // and it is the likelier one — a queue only forms when nobody is answering.

  it('a head that expires promotes the card behind it, with a full fresh window', async () => {
    const first = ask('ls -la');
    const second = ask('df -h');
    await untilCards(2);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(errorOf(await first)).toContain('Nobody answered');

    // The survivor was promoted by the expiry itself: armed, with ten NEW minutes.
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({ id: approvals[1].id });
    // Stamped the instant the expiry promoted it; the fake clock has moved a few
    // ticks since, so "full window" is asserted with that slack.
    expect(armed[0].expiresAt).toBeGreaterThan(Date.now() + TIMEOUT_MS - 100);

    // And it is a live card, not a leftover: answering it runs the command.
    expect(service.resolveApproval(approvals[1].id, 'allowOnce')).toBe(true);
    expect(((await second) as { ok: boolean }).ok).toBe(true);
    expect(ran).toEqual(['df -h']);
  });

  // ---- late answer × promotion ----
  // The user's click lands after the card it aimed at expired. The click must be
  // refused — and it must not leak onto the card that now occupies the screen.

  it('an answer to an expired card is refused and does not touch the promoted one', async () => {
    void ask('rm -rf ./build');
    const second = ask('df -h');
    await untilCards(2);
    const expiredId = approvals[0].id;

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const promotedDeadline = armed[0].expiresAt;

    // The late click: same id the user was looking at when they pressed it.
    expect(service.resolveApproval(expiredId, 'allowOnce')).toBe(false);
    // Nothing ran, nothing settled, and the promoted card's clock did not move.
    expect(ran).toEqual([]);
    expect(service.pendingApprovals().map((r) => r.command)).toEqual(['df -h']);
    expect(service.pendingApprovals()[0].expiresAt).toBe(promotedDeadline);

    // The promoted card still answers normally afterwards.
    expect(service.resolveApproval(approvals[1].id, 'deny')).toBe(true);
    expect(errorOf(await second)).toContain('declined');
  });

  // ---- abort × queued-behind, mixed threads ----
  // Stopping one chat's turn must void exactly that chat's cards — head and
  // queued alike — and hand the screen to the other chat's card.

  it('aborting a thread voids its cards on both queue positions and promotes the bystander', async () => {
    const a1 = ask('ls -la', 'chat-a');
    const b1 = ask('df -h', 'chat-b');
    const a2 = ask('uname -a', 'chat-a');
    await untilCards(3);

    service.abortThread('chat-a');
    expect(errorOf(await a1)).toContain('declined');
    expect(errorOf(await a2)).toContain('declined');

    // The bystander survived, was promoted, and got a full window of its own.
    expect(service.pendingApprovals().map((r) => r.command)).toEqual(['df -h']);
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({ id: approvals[1].id, expiresAt: Date.now() + TIMEOUT_MS });

    expect(service.resolveApproval(approvals[1].id, 'allowOnce')).toBe(true);
    expect(((await b1) as { ok: boolean }).ok).toBe(true);
  });

  it('aborting the QUEUED card’s thread leaves the visible card’s clock alone', async () => {
    const a1 = ask('ls -la', 'chat-a');
    const b1 = ask('df -h', 'chat-b');
    await untilCards(2);
    const headDeadline = approvals[0].expiresAt!;

    await vi.advanceTimersByTimeAsync(120_000);
    service.abortThread('chat-b');
    expect(errorOf(await b1)).toContain('declined');

    // The head was never settled, never re-armed, never re-announced: same card,
    // same deadline. A restarted clock here would quietly grant the head extra
    // time that pendingApprovals() replay would then contradict.
    expect(armed).toEqual([]);
    expect(service.pendingApprovals().map((r) => r.command)).toEqual(['ls -la']);
    expect(service.pendingApprovals()[0].expiresAt).toBe(headDeadline);

    // And it still expires exactly when the original deadline said.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 120_000);
    expect(errorOf(await a1)).toContain('Nobody answered');
  });

  // ---- answered × queued-behind ----
  // A phone can answer a card it is not displaying first (its sheet may order
  // differently, or the user tapped a stale notification). Answering the queued
  // card must settle only it.

  it('answering the queued card directly settles it without disturbing the head', async () => {
    const first = ask('ls -la');
    const second = ask('df -h');
    await untilCards(2);
    const headDeadline = approvals[0].expiresAt!;

    expect(service.resolveApproval(approvals[1].id, 'allowOnce')).toBe(true);
    expect(((await second) as { ok: boolean }).ok).toBe(true);
    expect(ran).toEqual(['df -h']);

    // The head is untouched: still the visible card, same deadline, no re-arm.
    expect(armed).toEqual([]);
    expect(service.pendingApprovals().map((r) => r.command)).toEqual(['ls -la']);
    expect(service.pendingApprovals()[0].expiresAt).toBe(headDeadline);

    expect(service.resolveApproval(approvals[0].id, 'deny')).toBe(true);
    expect(errorOf(await first)).toContain('declined');
  });

  // ---- client-away × queue ----
  // A client that reconnects replays pendingApprovals(). What it must see is the
  // truth about the clock: a deadline on the visible card, none on the queued one
  // — and after a promotion, the promoted card's NEW deadline, not a stale one.

  it('a reconnecting client sees the deadline only where a clock is actually running', async () => {
    void ask('ls -la');
    const second = ask('df -h');
    await untilCards(2);

    const replay = service.pendingApprovals();
    expect(replay[0].expiresAt).toBeGreaterThan(Date.now());
    expect(replay[1].expiresAt).toBeUndefined();

    // Head answered while this client was away; on the next replay the promoted
    // card carries the deadline the promotion stamped.
    expect(service.resolveApproval(replay[0].id, 'deny')).toBe(true);
    const after = service.pendingApprovals();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(replay[1].id);
    expect(after[0].expiresAt).toBe(armed[0].expiresAt);
    expect(service.resolveApproval(after[0].id, 'deny')).toBe(true);
    await second;
  });

  // ---- settleAll × queue ----
  // The pi child died with cards on both queue positions. Every held tool call
  // must be released (a promise left pending here wedges the old turn's stack
  // forever) and every client told each card is gone.

  it('settleAll releases every waiter, visible and queued alike', async () => {
    const first = ask('ls -la', 'chat-a');
    const second = ask('df -h', 'chat-b');
    await untilCards(2);

    service.settleAll();
    // Both promises settle — the queued one too, though no client ever saw it.
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(false);
    expect(resolved.sort()).toEqual(approvals.map((r) => r.id).sort());
    expect(service.pendingApprovals()).toEqual([]);

    // And the machine is reusable: the next card arms normally.
    void ask('uname -a');
    await untilCards(3);
    expect(approvals[2].expiresAt).toBeGreaterThan(Date.now());
  });
});
