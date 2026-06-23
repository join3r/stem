import { describe, expect, it } from 'vitest';
import { ForegroundSessionGate } from '../../src/main/pi/session-gate';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ForegroundSessionGate', () => {
  it('runs foreground operations FIFO', async () => {
    const gate = new ForegroundSessionGate();
    const first = deferred();
    const seen: string[] = [];

    const a = gate.run(async () => {
      seen.push('a:start');
      await first.promise;
      seen.push('a:end');
      return 'a';
    });
    const b = gate.run(async () => {
      seen.push('b');
      return 'b';
    });

    await tick();
    expect(seen).toEqual(['a:start']);
    first.resolve();
    await expect(a).resolves.toBe('a');
    await expect(b).resolves.toBe('b');
    expect(seen).toEqual(['a:start', 'a:end', 'b']);
  });

  it('waits for an active turn before running queued operations', async () => {
    const gate = new ForegroundSessionGate();
    const seen: string[] = [];

    await gate.run(async () => {
      seen.push('turn-claimed');
      gate.claimTurn();
    });

    const queued = gate.run(async () => {
      seen.push('after-turn');
    });

    await tick();
    expect(seen).toEqual(['turn-claimed']);
    gate.finishTurn();
    await queued;
    expect(seen).toEqual(['turn-claimed', 'after-turn']);
  });

  it('continues after a failed operation', async () => {
    const gate = new ForegroundSessionGate();
    const seen: string[] = [];

    const failed = gate.run(async () => {
      seen.push('fail');
      throw new Error('boom');
    });
    const next = gate.run(async () => {
      seen.push('next');
      return 2;
    });

    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe(2);
    expect(seen).toEqual(['fail', 'next']);
  });

  it('releases queued operations after a claimed turn is cleared', async () => {
    const gate = new ForegroundSessionGate();
    const seen: string[] = [];

    await gate.run(async () => {
      gate.claimTurn();
      seen.push('claimed');
      gate.finishTurn();
    });

    await gate.run(async () => {
      seen.push('next');
    });

    expect(seen).toEqual(['claimed', 'next']);
  });
});
