// The repo-lock registry: two deliveries must never run a harness inside the
// same working tree at once. Conflict = same device AND either resolved path
// contains the other; grants are FIFO per conflict so a broad claim can't be
// starved by later narrow ones.
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepoLocks } from '../../src/server/mail/repo-lock';

/**
 * Whether the promise settles within a short real-time window — acquire does
 * async fs work (realpath), so a bare microtask drain is not enough.
 */
async function settled<T>(p: Promise<T>): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  return done;
}

/**
 * Let an acquire finish its async realpath and register (as a holder or a
 * waiter). Two acquires started back to back resolve their paths on the fs
 * thread pool, which does not promise call order — on the macOS runners the
 * later one has registered first and taken a lock the test meant the earlier
 * one to be owed (flaky 2026-09-03). Arrival order is what the queue promises,
 * so the tests have to make the arrivals arrive in order.
 */
const registered = <T>(p: Promise<T>): Promise<T | undefined> => settled(p).then(() => undefined);

// Paths that don't exist: realpath falls back to the lexical name, which is
// exactly what these tests exercise.
const repo = '/nonexistent/stem-repo-lock-test/repo';

describe('conflicts', () => {
  it('no cwd (or no harness) never blocks anything', async () => {
    const locks = new RepoLocks();
    const holdRepo = await locks.acquire({ cwd: repo });
    expect(await settled(locks.acquire(undefined))).toBe(true);
    expect(await settled(locks.acquire({ cwd: '   ' }))).toBe(true);
    holdRepo();
  });

  it('the same tree blocks: equal paths, and a subdirectory in either direction', async () => {
    for (const [first, second] of [
      [repo, repo],
      [repo, join(repo, 'packages/x')],
      [join(repo, 'packages/x'), repo]
    ]) {
      const locks = new RepoLocks();
      const release = await locks.acquire({ cwd: first });
      const waiting = locks.acquire({ cwd: second });
      expect(await settled(waiting)).toBe(false);
      release();
      expect(await settled(waiting)).toBe(true);
      (await waiting)();
    }
  });

  it('a sibling directory sharing a name prefix is NOT the same tree', async () => {
    const locks = new RepoLocks();
    const release = await locks.acquire({ cwd: repo });
    expect(await settled(locks.acquire({ cwd: `${repo}-docs` }))).toBe(true);
    expect(await settled(locks.acquire({ cwd: '/nonexistent/other' }))).toBe(true);
    release();
  });

  it('the same path on different devices is two different directories', async () => {
    const locks = new RepoLocks();
    const release = await locks.acquire({ cwd: repo, device: 'mac' });
    expect(await settled(locks.acquire({ cwd: repo, device: 'vps' }))).toBe(true);
    expect(await settled(locks.acquire({ cwd: repo }))).toBe(true);
    const sameDevice = locks.acquire({ cwd: repo, device: 'mac' });
    expect(await settled(sameDevice)).toBe(false);
    release();
    (await sameDevice)();
  });

  it('trailing slashes and dot segments normalize away', async () => {
    const locks = new RepoLocks();
    const release = await locks.acquire({ cwd: `${repo}/` });
    expect(await settled(locks.acquire({ cwd: `${repo}/packages/../packages/x` }))).toBe(false);
    release();
  });

  it('a symlinked checkout resolves to the same local tree', async () => {
    const base = mkdtempSync(join(tmpdir(), 'repo-lock-'));
    try {
      mkdirSync(join(base, 'real/sub'), { recursive: true });
      symlinkSync(join(base, 'real'), join(base, 'link'));
      const locks = new RepoLocks();
      const release = await locks.acquire({ cwd: join(base, 'real') });
      expect(await settled(locks.acquire({ cwd: join(base, 'link/sub') }))).toBe(false);
      release();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('queueing', () => {
  it('waiters are granted in arrival order, one at a time for one tree', async () => {
    const locks = new RepoLocks();
    const releaseA = await locks.acquire({ cwd: repo });
    const b = locks.acquire({ cwd: repo });
    await registered(b);
    const c = locks.acquire({ cwd: repo });
    releaseA();
    expect(await settled(b)).toBe(true);
    expect(await settled(c)).toBe(false);
    (await b)();
    expect(await settled(c)).toBe(true);
    (await c)();
  });

  it('a later disjoint claim cannot barge past an earlier waiter it overlaps', async () => {
    const locks = new RepoLocks();
    // A holds a subtree; B waits on the whole repo; C wants a DIFFERENT
    // subtree — free as far as held locks go, but inside what B is owed.
    const releaseA = await locks.acquire({ cwd: join(repo, 'x') });
    const b = locks.acquire({ cwd: repo });
    await registered(b);
    const c = locks.acquire({ cwd: join(repo, 'y') });
    expect(await settled(c)).toBe(false);
    releaseA();
    expect(await settled(b)).toBe(true);
    expect(await settled(c)).toBe(false);
    (await b)();
    expect(await settled(c)).toBe(true);
    (await c)();
  });

  it('release is idempotent: a double release never frees someone else’s claim', async () => {
    const locks = new RepoLocks();
    const releaseA = await locks.acquire({ cwd: repo });
    releaseA();
    const releaseB = await locks.acquire({ cwd: repo });
    releaseA(); // stale double release — must not unlock B's claim
    expect(await settled(locks.acquire({ cwd: repo }))).toBe(false);
    releaseB();
  });
});
