import type { EmbedKind } from './embeddings';

// The local worker's run queue. One ONNX run at a time, in steps of a few
// texts, and between steps the queue re-decides what to run next: a query (a
// chat turn is waiting on it) goes before any passage work, passages go in
// arrival order, and a request the manager has given up on is dropped at the
// next step boundary instead of finishing for nobody.
//
// Before this the worker started every request the moment it arrived, so a
// backfill of 1,580 facts and a chat turn's one-text query ran as interleaved
// ONNX sessions on the same cores — the query took minutes, timed out, and the
// abandoned backfill kept computing (observed 2026-09-03 on a 16-core server,
// load average 15 for a quarter of an hour after every request had timed out).

export interface EmbedJobInput {
  id: number;
  kind: EmbedKind;
  /** Already prefixed for `kind`; the queue never looks at the text. */
  texts: string[];
}

export interface EmbedQueueDeps {
  /** Embed one step's worth of texts, in order. */
  run: (texts: string[]) => Promise<Float32Array[]>;
  /** Texts per step for the loaded model: 1 for an `unbatched` model, RUN_BATCH otherwise. */
  stepSize: () => number;
  done: (id: number, vectors: Float32Array[]) => void;
  fail: (id: number, err: unknown) => void;
}

export interface EmbedQueue {
  push(job: EmbedJobInput): void;
  /** The manager timed this request out: stop working on it. Unknown ids are ignored. */
  cancel(id: number): void;
  /** Drop everything (dispose). Nothing is reported for the dropped jobs. */
  clear(): void;
  /** Jobs waiting or mid-run. */
  size(): number;
}

interface Job extends EmbedJobInput {
  cursor: number;
  vectors: Float32Array[];
  cancelled: boolean;
}

export function createEmbedQueue(deps: EmbedQueueDeps): EmbedQueue {
  const jobs: Job[] = [];
  let pumping = false;

  function remove(job: Job): void {
    const i = jobs.indexOf(job);
    if (i !== -1) jobs.splice(i, 1);
  }

  /** Queries first, then arrival order. */
  function pick(): Job | undefined {
    return jobs.find((j) => j.kind === 'query') ?? jobs[0];
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const job = pick();
        if (!job) return;
        const step = Math.max(1, deps.stepSize());
        const slice = job.texts.slice(job.cursor, job.cursor + step);
        let out: Float32Array[];
        try {
          out = await deps.run(slice);
        } catch (err) {
          // A cancelled job was removed when the cancel arrived; its failure is
          // nobody's news.
          if (!job.cancelled) {
            remove(job);
            deps.fail(job.id, err);
          }
          continue;
        }
        if (job.cancelled) continue;
        job.vectors.push(...out);
        job.cursor += slice.length;
        if (job.cursor >= job.texts.length) {
          remove(job);
          deps.done(job.id, job.vectors);
        }
      }
    } finally {
      pumping = false;
    }
  }

  return {
    push(input) {
      if (input.texts.length === 0) {
        deps.done(input.id, []);
        return;
      }
      jobs.push({ ...input, cursor: 0, vectors: [], cancelled: false });
      void pump();
    },
    cancel(id) {
      const job = jobs.find((j) => j.id === id);
      if (!job) return;
      job.cancelled = true;
      remove(job);
    },
    clear() {
      for (const job of jobs) job.cancelled = true;
      jobs.length = 0;
    },
    size: () => jobs.length
  };
}
