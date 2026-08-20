import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, QuickChatHandoff, TurnAttachment } from '../../src/shared/types';
import { optimisticMessageAttachments, resendAttachments } from '../../src/renderer/attachments';
import {
  EMPTY_STATE,
  mergeDraftIntoReal,
  mergeHydratedThread,
  mergeQuickChatHandoff,
  type ThreadState
} from '../../src/renderer/chatState';
import { localProbeTarget, probeStillDescribes } from '../../src/renderer/localProbe';
import { enqueueApproval, removeApproval } from '../../src/renderer/manage/approvalQueue';
import { Chart } from '../../src/renderer/mdx/components';
import {
  deletePendingIfCurrent,
  interruptibleTurnId,
  pendingStartBlocksSend,
  rekeyPendingIfCurrent
} from '../../src/renderer/pendingTurn';
import { RequestGate } from '../../src/renderer/requestGate';
import { dismissTaskAlert, enqueueTaskAlert } from '../../src/renderer/taskAlerts';
import {
  failQuickChatProcess,
  HudPill,
  OverlaySession,
  QuickChatHandoffBarrier,
  QuickChatResetBarrier,
  RendererPushQueue
} from '../../src/desktop/ui-lifecycle';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('renderer async race regressions', () => {
  it('waits for a pending start before deciding which turn Stop interrupts', async () => {
    const started = deferred<void>();
    const pending = { promise: started.promise, turnId: null as string | null };
    let settled = false;
    const result = interruptibleTurnId(null, pending).then((id) => {
      settled = true;
      return id;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    pending.turnId = 'turn-late';
    started.resolve();
    await expect(result).resolves.toBe('turn-late');
  });

  it('answers immediately when the pending start carries a client-minted id', async () => {
    // Sends mint their turn id up front now, so Stop must not park on a start
    // that may be queued behind another turn for minutes.
    const pending = { promise: new Promise<never>(() => {}), turnId: 'turn-preminted' };
    await expect(interruptibleTurnId(null, pending)).resolves.toBe('turn-preminted');
  });

  it('allows only the newest navigation or provider probe to commit', async () => {
    const gate = new RequestGate();
    const slow = deferred<string>();
    const fast = deferred<string>();
    const committed: string[] = [];

    const run = async (promise: Promise<string>) => {
      const token = gate.begin();
      const value = await promise;
      if (gate.isCurrent(token)) committed.push(value);
    };
    const slowRun = run(slow.promise);
    const fastRun = run(fast.promise);

    fast.resolve('new selection');
    await fastRun;
    slow.resolve('stale selection');
    await slowRun;

    expect(committed).toEqual(['new selection']);
  });

  it('refuses a local-provider probe whose endpoint the form has since edited', async () => {
    // The gate only turns over when the server choice changes; editing the URL
    // or key in place leaves the request outstanding, so the value snapshot is
    // what stops endpoint A's catalog from filling in endpoint B's form.
    const gate = new RequestGate();
    const form = { server: 'custom' as const, baseUrl: 'https://a.example.com ', apiKey: 'key-a' };
    const committed: string[][] = [];

    const run = async (probe: Promise<string[]>) => {
      const token = gate.begin();
      const sent = localProbeTarget(form.server, form.baseUrl, form.apiKey);
      const models = await probe;
      if (gate.isCurrent(token) && probeStillDescribes(sent, localProbeTarget(form.server, form.baseUrl, form.apiKey)))
        committed.push(models);
    };

    const edited = deferred<string[]>();
    const pendingEdited = run(edited.promise);
    form.baseUrl = 'https://b.example.com';
    edited.resolve(['a-only-model']);
    await pendingEdited;

    const rekeyed = deferred<string[]>();
    const pendingRekeyed = run(rekeyed.promise);
    form.apiKey = 'key-b';
    rekeyed.resolve(['reachable-with-key-a']);
    await pendingRekeyed;

    // Trailing whitespace is not an edit: the probe is sent the trimmed URL.
    const settled = deferred<string[]>();
    const pendingSettled = run(settled.promise);
    form.baseUrl = 'https://b.example.com  ';
    settled.resolve(['b-model']);
    await pendingSettled;

    expect(committed).toEqual([['b-model']]);
  });

  it('does not let an older DRAFT completion delete or rekey a newer pending start', () => {
    const first = { promise: Promise.resolve(), turnId: null };
    const second = { promise: Promise.resolve(), turnId: null };
    const pending = new Map<string, typeof first>([['DRAFT', first]]);
    pending.set('DRAFT', second);

    expect(deletePendingIfCurrent(pending, 'DRAFT', first)).toBe(false);
    expect(rekeyPendingIfCurrent(pending, 'DRAFT', 'real-first', first)).toBe(false);
    expect(pending.get('DRAFT')).toBe(second);

    expect(rekeyPendingIfCurrent(pending, 'DRAFT', 'real-second', second)).toBe(true);
    expect(pending.get('DRAFT')).toBeUndefined();
    expect(pending.get('real-second')).toBe(second);
  });

  it('allows a new DRAFT generation while still blocking duplicate starts in the same generation', () => {
    expect(pendingStartBlocksSend({ draftGeneration: 4 }, true, 4)).toBe(true);
    expect(pendingStartBlocksSend({ draftGeneration: 4 }, true, 5)).toBe(false);
    expect(pendingStartBlocksSend({ draftGeneration: 4 }, false, 5)).toBe(true);
  });

  it('builds attachment placeholders synchronously without waiting for disk previews', () => {
    expect(
      optimisticMessageAttachments([
        { path: '/tmp/slow.png', name: 'slow.png', mime: 'image/png' },
        { name: 'paste.png', mime: 'image/png', dataBase64: 'YWJj' }
      ])
    ).toEqual([
      { kind: 'file', name: 'slow.png' },
      { kind: 'image', name: 'paste.png', mime: 'image/png', dataUrl: 'data:image/png;base64,YWJj' }
    ]);
  });
});

describe('main-to-renderer lifecycle regressions', () => {
  it('buffers pushes until renderer listeners are ready and resets per window', () => {
    const queue = new RendererPushQueue();
    expect(queue.push({ channel: 'tasks:notify', payload: { id: 1 } })).toEqual([]);
    expect(queue.markReady()).toEqual([{ channel: 'tasks:notify', payload: { id: 1 } }]);
    expect(queue.push({ channel: 'tasks:notify', payload: { id: 2 } })).toEqual([
      { channel: 'tasks:notify', payload: { id: 2 } }
    ]);
    queue.reset();
    expect(queue.push({ channel: 'tasks:notify', payload: { id: 3 } })).toEqual([]);
  });

  it('holds a Quick Chat reset until the old terminal event and settles crashes without losing the thread', async () => {
    const barrier = new QuickChatResetBarrier();
    let released = false;
    const pending = barrier.wait().then(() => {
      released = true;
    });
    expect(barrier.pending).toBe(true);
    await Promise.resolve();
    expect(released).toBe(false);
    barrier.settle();
    await pending;
    expect(barrier.pending).toBe(false);

    expect(failQuickChatProcess(1234, 'thread-to-resume')).toEqual({
      threadId: 'thread-to-resume',
      handedOff: false,
      turnRunning: false,
      lastActivityAt: 1234,
      hudTextSeen: false
    });
  });

  it('buffers Quick Chat events across snapshot acknowledgement and atomic commit', async () => {
    const barrier = new QuickChatHandoffBarrier();
    const ticket = barrier.begin('quick-1');
    const before = {
      method: 'item/agentMessage/delta',
      params: { threadId: 'quick-1', turnId: 'turn-1', delta: 'before' },
      receivedAt: '2026-01-01T00:00:00Z'
    };
    const after = {
      method: 'item/agentMessage/delta',
      params: { threadId: 'quick-1', turnId: 'turn-1', delta: 'after' },
      receivedAt: '2026-01-01T00:00:01Z'
    };
    expect(barrier.buffer('quick-1', before)).toBe(true);

    const snapshot: QuickChatHandoff = {
      threadId: 'quick-1',
      messages: [{ id: 'u1', role: 'user', content: 'Question sent before a thread id existed' }],
      running: true,
      streamingId: null,
      activity: null,
      activities: [],
      activeTurnId: null,
      status: 'running',
      model: null,
      effort: null,
      serviceTier: null
    };
    expect(barrier.supply(ticket.id, snapshot)).toBe(true);
    await expect(ticket.promise).resolves.toBe(snapshot);
    // Events can land after the renderer answers but before the awaiting main
    // handler resumes and commits ownership.
    expect(barrier.buffer('quick-1', after)).toBe(true);
    expect(barrier.commit(ticket.id)).toEqual({ snapshot, events: [before, after] });
    expect(barrier.buffer('quick-1', after)).toBe(false);
  });

  it('walks the overlay session through summon → turn → handoff without desync', () => {
    const overlay = new OverlaySession();
    // Fresh install: nothing owned, first summon starts fresh.
    expect(overlay.shouldStartFresh(1_000, 300_000)).toBe(true);

    overlay.beginTurn(1_000);
    overlay.adoptThread('qc-1');
    expect(overlay.owns('qc-1')).toBe(true);
    expect(overlay.owns('other')).toBe(false);
    expect(overlay.turnRunning).toBe(true);

    // Mid-turn, an idle-timeout summon must NOT reset (never orphan a stream)…
    expect(overlay.shouldStartFresh(10_000_000, 300_000)).toBe(false);
    // …but once the turn settles and the timeout elapses, it does.
    overlay.settleTurn(10_000_000);
    expect(overlay.shouldStartFresh(10_000_000 + 300_001, 300_000)).toBe(true);
    // Timeout 0 disables the idle reset entirely.
    expect(overlay.shouldStartFresh(10_000_000 + 300_001, 0)).toBe(false);

    // Handoff claim/revert: only the caller that flipped the flag may revert it.
    expect(overlay.claimHandoff()).toBe(true);
    expect(overlay.claimHandoff()).toBe(false); // already handed off
    expect(overlay.owns('qc-1')).toBe(false);
    overlay.revertHandoff();
    expect(overlay.owns('qc-1')).toBe(true);

    // Manual reset keeps the thread until the barrier releases it.
    overlay.prepareManualReset();
    expect(overlay.threadId).toBe('qc-1');
    overlay.releaseThread();
    expect(overlay.threadId).toBeNull();

    // Crash restore keeps the thread for resume but settles the live-turn state.
    overlay.adoptThread('qc-2');
    overlay.beginTurn(5_000);
    overlay.restore(failQuickChatProcess(6_000, overlay.threadId));
    expect(overlay.threadId).toBe('qc-2');
    expect(overlay.turnRunning).toBe(false);
    expect(overlay.hudTextSeen).toBe(false);
  });

  it('chimes exactly once per entry into finished and tracks pill ownership', () => {
    const hud = new HudPill();
    expect(hud.owner).toBe('none');
    expect(hud.notePush('quickchat', 'working')).toBe(false);
    expect(hud.notePush('quickchat', 'answering')).toBe(false);
    expect(hud.owner).toBe('quickchat');
    expect(hud.notePush('quickchat', 'finished')).toBe(true); // the chime moment
    expect(hud.notePush('quickchat', 'finished')).toBe(false); // no repeat chime
    hud.noteHidden();
    expect(hud.owner).toBe('none');
    expect(hud.lastPhase).toBeNull();
    // After hiding, a fresh finish chimes again.
    expect(hud.notePush('main', 'finished')).toBe(true);
    expect(hud.owner).toBe('main');
  });

  it('keeps scheduled task alerts FIFO until each one is acknowledged', () => {
    const first = { threadId: 't1', message: 'first', at: '2026-01-01T00:00:00Z' };
    const second = { threadId: 't2', message: 'second', at: '2026-01-01T00:00:01Z' };
    let queue = enqueueTaskAlert([], first);
    queue = enqueueTaskAlert(queue, second);
    expect(queue).toEqual([first, second]);
    queue = dismissTaskAlert(queue);
    expect(queue).toEqual([second]);
  });
});

describe('approval queue regressions', () => {
  it('keeps concurrent approvals FIFO, dedupes pushes, and removes resolutions idempotently', () => {
    // Spelled out rather than inferred: the mixed id types are the point — real
    // proposals arrive with either, and enqueueApproval dedupes on String(id) —
    // but inference takes the first literal's `number` as the whole type and
    // turns the second one into an error instead of the case under test.
    const first: { id: number | string; label: string } = { id: 1, label: 'first' };
    const second: { id: number | string; label: string } = { id: '2', label: 'second' };
    let queue = enqueueApproval([], first);
    queue = enqueueApproval(queue, second);
    queue = enqueueApproval(queue, { ...first });
    expect(queue.map((p) => p.label)).toEqual(['first', 'second']);

    queue = removeApproval(queue, '1');
    expect(queue).toEqual([second]);
    expect(removeApproval(queue, 1)).toBe(queue);
  });
});

describe('conversation preservation regressions', () => {
  it('keeps a turn that starts and settles while a delayed history read is in flight', () => {
    const stateAtRequest = undefined;
    const settled: ThreadState = {
      ...EMPTY_STATE,
      messages: [
        {
          id: 'assistant-turn-1',
          role: 'assistant',
          content: 'Complete live answer',
          turnId: 'turn-1'
        }
      ],
      // The bug only appeared after the live turn settled: checking `running`
      // would no longer distinguish this slice from untouched hydrated state.
      running: false,
      status: 'done'
    };
    const merged = mergeHydratedThread(
      [
        { id: 'user-old', role: 'user', content: 'Earlier question' },
        {
          id: 'assistant-turn-1',
          role: 'assistant',
          content: 'Stale disk answer',
          turnId: 'turn-1'
        }
      ],
      settled,
      stateAtRequest
    );

    expect(merged.running).toBe(false);
    expect(merged.status).toBe('idle');
    expect(merged.messages).toMatchObject([
      { id: 'user-old', content: 'Earlier question' },
      { id: 'assistant-turn-1', content: 'Complete live answer' }
    ]);
  });

  it('dedupes the same raced turn when live and persisted message ids differ', () => {
    const live: ThreadState = {
      ...EMPTY_STATE,
      messages: [
        {
          id: 'assistant-runtime-turn-id',
          role: 'assistant',
          content: 'Same completed answer',
          turnId: 'runtime-turn-id'
        }
      ],
      status: 'done'
    };
    const merged = mergeHydratedThread(
      [
        { id: 'user-entry-1', role: 'user', content: 'Question', turnId: 'entry-1' },
        {
          id: 'assistant-session-entry-id',
          role: 'assistant',
          content: 'Same completed answer',
          turnId: 'entry-1'
        }
      ],
      live,
      undefined
    );

    expect(merged.messages.filter((message) => message.role === 'assistant')).toEqual([
      expect.objectContaining({ id: 'assistant-runtime-turn-id', content: 'Same completed answer' })
    ]);
  });

  it('does not collapse a new turn whose answer text repeats an older answer', () => {
    const live: ThreadState = {
      ...EMPTY_STATE,
      messages: [
        { id: 'user-live-2', role: 'user', content: 'Ask it again' },
        { id: 'assistant-live-2', role: 'assistant', content: 'Same answer', turnId: 'turn-2' }
      ],
      status: 'done'
    };
    const merged = mergeHydratedThread(
      [
        { id: 'user-entry-1', role: 'user', content: 'First question', turnId: 'entry-1' },
        { id: 'assistant-entry-1', role: 'assistant', content: 'Same answer', turnId: 'entry-1' }
      ],
      live,
      undefined
    );

    expect(merged.messages.map((message) => message.id)).toEqual([
      'user-entry-1',
      'assistant-entry-1',
      'user-live-2',
      'assistant-live-2'
    ]);
  });

  it('appends an assistant-only raced reply after an unmatched current user', () => {
    const live: ThreadState = {
      ...EMPTY_STATE,
      messages: [
        { id: 'assistant-live-2', role: 'assistant', content: 'Same answer', turnId: 'turn-2' }
      ],
      status: 'done'
    };
    const merged = mergeHydratedThread(
      [
        { id: 'user-entry-1', role: 'user', content: 'First question', turnId: 'entry-1' },
        { id: 'assistant-entry-1', role: 'assistant', content: 'Same answer', turnId: 'entry-1' },
        { id: 'user-entry-2', role: 'user', content: 'Ask it again', turnId: 'entry-2' }
      ],
      live,
      undefined
    );

    expect(merged.messages.map((message) => message.id)).toEqual([
      'user-entry-1',
      'assistant-entry-1',
      'user-entry-2',
      'assistant-live-2'
    ]);
  });

  it('keeps a navigated-away draft user bubble alongside early real-thread deltas', () => {
    const draft: ThreadState = {
      ...EMPTY_STATE,
      messages: [{ id: 'user-1', role: 'user', content: 'Do the work' }],
      running: true,
      status: 'running'
    };
    const live: ThreadState = {
      ...EMPTY_STATE,
      messages: [{ id: 'assistant-turn-1', role: 'assistant', content: 'Working', turnId: 'turn-1' }],
      running: true,
      streamingId: 'assistant-turn-1',
      activeTurnId: 'turn-1',
      status: 'running'
    };

    const merged = mergeDraftIntoReal(draft, live);
    expect(merged.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(merged.streamingId).toBe('assistant-turn-1');
  });

  it('transfers complete Quick Chat live state and lets newer main events win', () => {
    const payload: QuickChatHandoff = {
      threadId: 'thread-1',
      messages: [
        { id: 'user-1', role: 'user', content: 'Question', turnId: 'turn-1' },
        { id: 'assistant-turn-1', role: 'assistant', content: 'Par', turnId: 'turn-1' }
      ],
      running: true,
      streamingId: 'assistant-turn-1',
      activity: 'Answering…',
      activities: [{ id: 'tool-1', kind: 'tool', type: 'commandExecution', status: 'running' }],
      activeTurnId: 'turn-1',
      status: 'running',
      model: 'provider/model',
      effort: 'high',
      serviceTier: null
    };

    expect(mergeQuickChatHandoff(undefined, payload)).toMatchObject({
      running: true,
      streamingId: 'assistant-turn-1',
      activeTurnId: 'turn-1',
      status: 'running'
    });

    const settled: ThreadState = {
      ...EMPTY_STATE,
      messages: [{ id: 'assistant-turn-1', role: 'assistant', content: 'Complete', turnId: 'turn-1' }]
    };
    const raced = mergeQuickChatHandoff(settled, payload);
    expect(raced.running).toBe(false);
    expect(raced.messages).toMatchObject([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Complete' }
    ]);
  });

  it('retains original live attachments and reconstructs replayed inline images', () => {
    const original: TurnAttachment[] = [
      { path: '/tmp/report.pdf', name: 'report.pdf' },
      { name: 'paste.png', mime: 'image/png', dataBase64: 'YWJj' }
    ];
    const live: ChatMessage = { id: 'u1', role: 'user', content: 'Review', turnAttachments: original };
    const recoveredLive = resendAttachments(live);
    expect(recoveredLive).toEqual(original);
    expect(recoveredLive[0]).not.toBe(original[0]);

    const replayed: ChatMessage = {
      id: 'u2',
      role: 'user',
      content: 'Image',
      attachments: [
        { kind: 'image', name: 'history.png', mime: 'image/png', dataUrl: 'data:image/png;base64,eHl6' },
        { kind: 'file', name: 'already-inlined.txt' }
      ]
    };
    expect(resendAttachments(replayed)).toEqual([
      { name: 'history.png', mime: 'image/png', dataBase64: 'eHl6' }
    ]);
  });
});

describe('signed chart regression', () => {
  it('draws both positive and negative bars from the zero baseline', () => {
    const html = renderToStaticMarkup(
      createElement(Chart, {
        type: 'bar',
        data: JSON.stringify([
          { label: 'loss', value: -10 },
          { label: 'gain', value: 10 }
        ])
      })
    );
    const bars = html.match(/<rect[^>]*class="chart-bar"[^>]*>/g) ?? [];
    const heights = bars.map((bar) => Number(/height="([^"]+)"/.exec(bar)?.[1]));

    expect(heights).toHaveLength(2);
    expect(heights.every((height) => height > 0)).toBe(true);
  });
});
