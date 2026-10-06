import { beforeEach, describe, expect, it } from 'vitest';
import { dismissLearnNotice, readLearn, resetLearn, startLearn, subscribeLearn } from '../../src/renderer/chat/learn-store';
import type { SkillLearnResult } from '../../src/shared/types';

// `/learn` state parked per chat outside the Composer, which a chat switch
// remounts while the request is still running (2026-10-06).
describe('learn store', () => {
  beforeEach(() => resetLearn());

  const saved = (message: string): SkillLearnResult => ({ ok: true, slug: 'invoice', saved: true, message });

  function deferred() {
    let resolve!: (r: SkillLearnResult) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<SkillLearnResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('holds the pending state and then the outcome for the chat that asked', async () => {
    const call = deferred();
    const run = startLearn('t1', () => call.promise);
    expect(readLearn('t1')).toEqual({ learning: true, notice: null });
    expect(readLearn('t2')).toEqual({ learning: false, notice: null });

    call.resolve(saved('Saved the skill “invoice”.'));
    await run;
    expect(readLearn('t1')).toEqual({ learning: false, notice: { ok: true, text: 'Saved the skill “invoice”.' } });
  });

  it('runs one /learn per chat at a time', async () => {
    const call = deferred();
    let calls = 0;
    const first = startLearn('t1', () => {
      calls += 1;
      return call.promise;
    });
    await startLearn('t1', async () => {
      calls += 1;
      return saved('second');
    });
    expect(calls).toBe(1);
    call.resolve(saved('first'));
    await first;
    expect(readLearn('t1').notice?.text).toBe('first');
  });

  it('turns a failed call into an outcome the user can read', async () => {
    const call = deferred();
    const run = startLearn('t1', () => call.promise);
    call.reject(new Error('ipc gone'));
    await run;
    expect(readLearn('t1')).toEqual({ learning: false, notice: { ok: false, text: 'Couldn’t save a skill — try restarting Stem.' } });
  });

  it('tells subscribers, and gives the same snapshot until something changes', async () => {
    let calls = 0;
    const unsubscribe = subscribeLearn(() => (calls += 1));
    expect(readLearn('t1')).toBe(readLearn('t1'));
    await startLearn('t1', async () => ({ ok: false, message: 'Nothing reusable.' }));
    expect(calls).toBe(2);
    expect(readLearn('t1')).toBe(readLearn('t1'));
    unsubscribe();
  });

  it('dismisses only the notice it was shown', async () => {
    await startLearn('t1', async () => saved('old'));
    const shown = readLearn('t1').notice!;
    await startLearn('t1', async () => saved('new'));
    dismissLearnNotice('t1', shown);
    expect(readLearn('t1').notice?.text).toBe('new');
    dismissLearnNotice('t1', readLearn('t1').notice!);
    expect(readLearn('t1')).toEqual({ learning: false, notice: null });
  });
});
