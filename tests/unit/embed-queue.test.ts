// The local worker's run queue: one ONNX run at a time, queries ahead of
// passage work between steps, cancelled requests dropped at the next boundary.
import { describe, expect, it } from 'vitest';
import { createEmbedQueue } from '../../src/server/recall/embed-queue';

interface Step {
  texts: string[];
  resolve: (v: Float32Array[]) => void;
  reject: (e: unknown) => void;
}

/** A queue whose every run is held until the test releases it. */
function harness(stepSize = 2) {
  const steps: Step[] = [];
  const done: Array<{ id: number; n: number }> = [];
  const failed: Array<{ id: number; message: string }> = [];
  const queue = createEmbedQueue({
    run: (texts) =>
      new Promise<Float32Array[]>((resolve, reject) => {
        steps.push({ texts, resolve, reject });
      }),
    stepSize: () => stepSize,
    done: (id, vectors) => done.push({ id, n: vectors.length }),
    fail: (id, err) => failed.push({ id, message: err instanceof Error ? err.message : String(err) })
  });
  const release = async (i = steps.length - 1) => {
    const s = steps[i];
    s.resolve(s.texts.map((t) => new Float32Array([t.length])));
    await new Promise((r) => setTimeout(r, 0));
  };
  return { queue, steps, done, failed, release };
}

describe('embed queue', () => {
  it('runs one step at a time and finishes a job across steps', async () => {
    const h = harness(2);
    h.queue.push({ id: 1, kind: 'passage', texts: ['a', 'b', 'c'] });
    h.queue.push({ id: 2, kind: 'passage', texts: ['d'] });
    expect(h.steps).toHaveLength(1); // nothing else starts while a run is out
    expect(h.steps[0].texts).toEqual(['a', 'b']);
    await h.release();
    expect(h.steps[1].texts).toEqual(['c']);
    await h.release();
    expect(h.done).toEqual([{ id: 1, n: 3 }]);
    expect(h.steps[2].texts).toEqual(['d']);
    await h.release();
    expect(h.done).toEqual([{ id: 1, n: 3 }, { id: 2, n: 1 }]);
  });

  it('a query arriving mid-passage runs at the next step boundary, before the passage continues', async () => {
    const h = harness(2);
    h.queue.push({ id: 1, kind: 'passage', texts: ['a', 'b', 'c', 'd'] });
    h.queue.push({ id: 2, kind: 'passage', texts: ['e'] });
    h.queue.push({ id: 3, kind: 'query', texts: ['q'] });
    await h.release(); // step ['a','b'] lands
    expect(h.steps[1].texts).toEqual(['q']);
    await h.release();
    expect(h.done).toEqual([{ id: 3, n: 1 }]);
    expect(h.steps[2].texts).toEqual(['c', 'd']); // then back to the passage, in arrival order
    await h.release();
    expect(h.steps[3].texts).toEqual(['e']);
  });

  it('a cancelled job is dropped: its in-flight step is discarded and nothing is reported', async () => {
    const h = harness(1);
    h.queue.push({ id: 1, kind: 'passage', texts: ['a', 'b', 'c'] });
    h.queue.push({ id: 2, kind: 'passage', texts: ['d'] });
    h.queue.cancel(1);
    expect(h.queue.size()).toBe(1);
    await h.release(); // the step for 'a' that was already running
    expect(h.steps).toHaveLength(2);
    expect(h.steps[1].texts).toEqual(['d']); // no 'b' — the cancelled job did not continue
    await h.release();
    expect(h.done).toEqual([{ id: 2, n: 1 }]);
    expect(h.failed).toEqual([]);
  });

  it('cancelling an unknown id is a no-op', () => {
    const h = harness();
    h.queue.cancel(42);
    expect(h.queue.size()).toBe(0);
  });

  it('a failing step fails only its own job', async () => {
    const h = harness(1);
    h.queue.push({ id: 1, kind: 'passage', texts: ['a', 'b'] });
    h.queue.push({ id: 2, kind: 'passage', texts: ['c'] });
    h.steps[0].reject(new Error('boom'));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.failed).toEqual([{ id: 1, message: 'boom' }]);
    expect(h.steps[1].texts).toEqual(['c']);
    await h.release();
    expect(h.done).toEqual([{ id: 2, n: 1 }]);
  });

  it('an empty request completes immediately', () => {
    const h = harness();
    h.queue.push({ id: 7, kind: 'query', texts: [] });
    expect(h.done).toEqual([{ id: 7, n: 0 }]);
    expect(h.steps).toHaveLength(0);
  });

  it('clear drops everything without reporting', async () => {
    const h = harness(1);
    h.queue.push({ id: 1, kind: 'passage', texts: ['a', 'b'] });
    h.queue.push({ id: 2, kind: 'passage', texts: ['c'] });
    h.queue.clear();
    await h.release();
    expect(h.steps).toHaveLength(1);
    expect(h.done).toEqual([]);
    expect(h.failed).toEqual([]);
  });
});
