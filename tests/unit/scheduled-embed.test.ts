// The shared embed traffic rules (scheduledEmbed) over a bare sender, pinned
// against the CPU-server incidents they were written for: 2026-08-18/19, when a
// batch of long memories blew its token-blind budget and the identical retry
// blew it again, and 2026-08-21, when folder indexing held the endpoint for
// minutes per batch and every recall query behind it timed out. Budget and
// bisection behaviour through the local worker is covered in embed-local.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_EMBED_BUDGETS, scheduledEmbed, type EmbedSender } from '../../src/server/recall/embeddings';
import { createEmbedSchedule } from '../../src/server/recall/embed-schedule';

function vectors(n: number): Float32Array[] {
  return Array.from({ length: n }, (_, i) => Float32Array.from([i]));
}

describe('scheduledEmbed batching', () => {
  it('splits input into batches of at most 32', async () => {
    const send = vi.fn<EmbedSender>(async (texts) => vectors(texts.length));
    const schedule = createEmbedSchedule({ lullMs: 0 });
    const vecs = await scheduledEmbed(send, Array.from({ length: 33 }, (_, i) => `t${i}`), 'passage', DEFAULT_EMBED_BUDGETS, schedule);
    expect(vecs).toHaveLength(33);
    expect(send.mock.calls.map((c) => c[0].length)).toEqual([32, 1]);
  });

  it('splits long texts by estimated tokens, not just count', async () => {
    const send = vi.fn<EmbedSender>(async (texts) => vectors(texts.length));
    const schedule = createEmbedSchedule({ lullMs: 0 });
    // 9 texts of ~1500 est. tokens each (6000 chars / 4) — the 2026-08-18
    // incident shape. Under the 4k-token cap they must pack in pairs, never 9 at once.
    const vecs = await scheduledEmbed(send, Array.from({ length: 9 }, () => 'x'.repeat(6000)), 'passage', DEFAULT_EMBED_BUDGETS, schedule);
    expect(vecs).toHaveLength(9);
    expect(send.mock.calls.map((c) => c[0].length)).toEqual([2, 2, 2, 2, 1]);
  });

  it('a single text over the token cap still ships, alone', async () => {
    const send = vi.fn<EmbedSender>(async (texts) => vectors(texts.length));
    const schedule = createEmbedSchedule({ lullMs: 0 });
    const vecs = await scheduledEmbed(send, ['x'.repeat(40_000), 'short'], 'passage', DEFAULT_EMBED_BUDGETS, schedule);
    expect(vecs).toHaveLength(2);
    expect(send.mock.calls.map((c) => c[0].length)).toEqual([1, 1]);
  });
});

describe('scheduledEmbed query/passage priority', () => {
  it('a passage request started during a query waits for the query to finish', async () => {
    let releaseQuery!: () => void;
    const send = vi.fn<EmbedSender>(async (texts) => {
      if (send.mock.calls.length === 1) await new Promise<void>((resolve) => (releaseQuery = resolve));
      return vectors(texts.length);
    });
    const schedule = createEmbedSchedule({ lullMs: 0 });
    const query = scheduledEmbed(send, ['q'], 'query', DEFAULT_EMBED_BUDGETS, schedule); // in flight, held open
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    const passage = scheduledEmbed(send, ['p'], 'passage', DEFAULT_EMBED_BUDGETS, schedule);
    // Give the passage every chance to (wrongly) send while the query holds.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(send).toHaveBeenCalledTimes(1);

    releaseQuery();
    await expect(query).resolves.toHaveLength(1);
    await expect(passage).resolves.toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a query behind an in-flight passage takes the busy budget', async () => {
    let releasePassage!: () => void;
    const send = vi.fn<EmbedSender>(async (texts, kind) => {
      if (kind === 'passage') await new Promise<void>((resolve) => (releasePassage = resolve));
      return vectors(texts.length);
    });
    const schedule = createEmbedSchedule({ lullMs: 0 });
    const budgets = { timeoutMs: 5, busyQueryTimeoutMs: 5_000, passageTimeoutMs: 60_000 };
    const passage = scheduledEmbed(send, ['p'], 'passage', budgets, schedule);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    await expect(scheduledEmbed(send, ['q'], 'query', budgets, schedule)).resolves.toHaveLength(1);
    expect(send.mock.calls[1][2]).toBe(5_000);
    releasePassage();
    await expect(passage).resolves.toHaveLength(1);
    expect(send.mock.calls[0][2]).toBe(60_000);
  });
});
