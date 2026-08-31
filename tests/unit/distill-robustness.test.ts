// Two ways the distill pass mishandles a bad run: a model that REJECTS the
// prompt instead of answering it (the oversized-prompt case the block shrink
// exists for), and the segment-context backfill an uncited claim gets when the
// batch spans several conversations. Fake LLMs; shared per-process store like
// the sibling suites.
import { afterAll, describe, expect, it } from 'vitest';
import { recallStore as store } from '../../src/server/recall/store';
import {
  COMPLETION_ERRORS_KEY,
  CURSOR_KEY,
  MAX_PARSE_STRIKES,
  PARSE_STRIKES_KEY,
  distillNewMessages
} from '../../src/server/recall/distill';

afterAll(() => store.close());

const cursor = () => JSON.parse(store.getMeta(CURSOR_KEY) ?? 'null');
const counter = (key: string): number => {
  const raw = store.getMeta(key);
  return raw ? (JSON.parse(raw) as { count: number }).count : 0;
};
const strikes = () => counter(PARSE_STRIKES_KEY);
const errors = () => counter(COMPLETION_ERRORS_KEY);

/** A model that refuses every prompt with `message`. */
const throwingLlm = (message: string) => ({
  complete: async (): Promise<string> => {
    throw new Error(message);
  }
});

describe('distill: a model that rejects the prompt', () => {
  it('strikes an oversized-prompt rejection so the shrink and the escape both engage', async () => {
    store.resetFacts();
    store.resetEpisodic();
    store.setMeta(PARSE_STRIKES_KEY, '');
    store.recordMessage({ threadId: 'ov-1', role: 'user', text: 'I moved to Ghent and my landlord is called Peeters.' });

    // A local server refusing the prompt for its size — the stated motivation
    // for the shrink. Without a strike the identical prompt retries forever.
    const oversize = throwingLlm('pi said: {"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 8192 tokens"}}');
    const stuck = cursor();
    for (let strike = 1; strike < MAX_PARSE_STRIKES; strike++) {
      expect(await distillNewMessages(oversize)).toBe(0);
      expect(strikes()).toBe(strike); // shrink budget for the next attempt
      expect(cursor()).toEqual(stuck); // segment retried, not consumed
    }
    // The cap gives the segment up rather than wedging distillation forever.
    expect(await distillNewMessages(oversize)).toBe(0);
    expect(cursor()).not.toEqual(stuck);
    expect(strikes()).toBe(0);
  });

  it('never spends a strike on a transient failure', async () => {
    store.resetFacts();
    store.resetEpisodic();
    store.setMeta(PARSE_STRIKES_KEY, '');
    store.setMeta(COMPLETION_ERRORS_KEY, '');
    store.recordMessage({ threadId: 'ov-2', role: 'user', text: 'My cat is called Miso and she is fourteen.' });

    // An offline stretch must not chew through the backlog three strikes at a
    // time: the segment waits, unmoved and unpenalized, for the server to return.
    const offline = throwingLlm('connect ECONNREFUSED 127.0.0.1:11434');
    const stuck = cursor();
    for (let i = 0; i < MAX_PARSE_STRIKES + 1; i++) {
      expect(await distillNewMessages(offline)).toBe(0);
      expect(strikes()).toBe(0);
      // The error counter climbs past the strike cap without ever abandoning it.
      expect(errors()).toBe(i + 1);
      expect(cursor()).toEqual(stuck);
    }
    // And the segment is still there to distill once the model answers.
    expect(
      await distillNewMessages({
        complete: async () => JSON.stringify({ claims: [{ text: 'The user has a cat called Miso', category: 'relationship', evidenceMessageIds: [] }] })
      })
    ).toBe(1);
    expect(errors()).toBe(0); // a reply of any kind ends the run
  });

  it('shrinks the next prompt after a rejection worded outside the oversize pattern', async () => {
    store.resetFacts();
    store.resetEpisodic();
    store.setMeta(PARSE_STRIKES_KEY, '');
    store.setMeta(COMPLETION_ERRORS_KEY, '');
    // Enough known facts that the halved budget has to drop some of them —
    // two short facts fit either way and would hide the middle rung entirely.
    for (let i = 0; i < 60; i++) {
      store.upsertFact(
        `The user keeps beehive number ${i} on the rooftop in Petrzalka and inspects it every other weekend for brood pattern and varroa load`,
        'distilled',
        { confidence: 0.9 }
      );
    }
    store.recordMessage({ threadId: 'ov-3', role: 'user', text: 'The new hive arrived, so that is four colonies now.' });

    // A real local-server way of saying "too big" that names neither a context
    // length nor a token count — the wording a regex was never going to catch.
    const prompts: string[] = [];
    let failures = 2;
    const cryptic = {
      complete: async (prompt: string): Promise<string> => {
        prompts.push(prompt);
        if (failures-- > 0) throw new Error('llama_decode failed: the KV cache is full (n_ctx exceeded)');
        return '{"claims":[]}';
      }
    };

    const stuck = cursor();
    await distillNewMessages(cryptic);
    await distillNewMessages(cryptic);
    // Unstruck and unabandoned — only the prompt got smaller.
    expect(strikes()).toBe(0);
    expect(cursor()).toEqual(stuck);
    await distillNewMessages(cryptic);

    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('Known facts (do not restate these)');
    expect(prompts[1].length).toBeLessThan(prompts[0].length); // half budgets
    expect(prompts[2]).not.toContain('Known facts (do not restate these)'); // transcript only
    expect(prompts[2]).toContain('The new hive arrived'); // the segment itself is never dropped
    // The reply landed, so the segment is consumed and the run is over.
    expect(cursor()).not.toEqual(stuck);
    expect(errors()).toBe(0);
  });
});

describe('distill: uncited-claim backfill across threads', () => {
  it('backfills from the claim\'s own conversation, not whatever chat ended the batch', async () => {
    store.resetFacts();
    store.resetEpisodic();
    store.setMeta(PARSE_STRIKES_KEY, '');
    // The claim's source conversation…
    store.recordMessage({ threadId: 'src', role: 'user', text: 'I bought a sailboat called Albatros and I keep it in Senec.' });
    store.recordMessage({ threadId: 'src', role: 'assistant', text: 'A sailboat in Senec sounds like a fine way to spend the summer.' });
    // …followed by an unrelated chat that merely happens to end the batch.
    store.recordMessage({ threadId: 'other', role: 'user', text: 'How do I convert a PDF to grayscale on macOS?' });
    store.recordMessage({ threadId: 'other', role: 'user', text: 'And can I do that for a whole folder at once?' });
    store.recordMessage({ threadId: 'other', role: 'user', text: 'Thanks, the preview trick worked.' });

    // A claim with no usable citation — the legacy string-array shape.
    const wrote = await distillNewMessages({
      complete: async () => JSON.stringify(['The user owns a sailboat called Albatros kept in Senec'])
    });
    expect(wrote).toBe(1);

    const fact = store.getAllFacts().find((f) => /Albatros/.test(f.text))!;
    const evidence = store.getFactDetails(fact.id)!.evidence;
    expect(evidence.length).toBeGreaterThan(0);
    // Every backfilled row belongs to the conversation the claim came from.
    expect(evidence.every((e) => e.threadId === 'src')).toBe(true);
    expect(evidence.every((e) => e.origin === 'segment_context')).toBe(true);
    expect(evidence.some((e) => /Albatros/.test(e.excerpt))).toBe(true);
    expect(evidence.some((e) => /grayscale|preview trick/.test(e.excerpt))).toBe(false);
  });

  it('falls back to the batch when the claim shares nothing with any thread', async () => {
    store.resetFacts();
    store.resetEpisodic();
    store.recordMessage({ threadId: 'f-1', role: 'user', text: 'Remind me to water the ferns on Tuesday.' });

    expect(await distillNewMessages({ complete: async () => JSON.stringify(['The user zzz qqq wwww']) })).toBe(1);
    const fact = store.getAllFacts().find((f) => /zzz/.test(f.text))!;
    const evidence = store.getFactDetails(fact.id)!.evidence;
    expect(evidence.map((e) => e.threadId)).toEqual(['f-1']);
  });
});

describe('distill prompt scope', () => {
  it('keeps task-procedure preferences in scope while excluding only response style', async () => {
    // The Vacation-thread regression: "you didn't check #war-room; I want to be
    // informed in the future" was processed and dropped, because the old rule
    // excluded ALL standing directives as custom-instructions material. Only
    // response-STYLE rules belong there; how a task should be done for the user
    // is a durable preference fact.
    const { DISTILL_INSTRUCTIONS } = await import('../../src/server/recall/distill');
    expect(DISTILL_INSTRUCTIONS).toMatch(/DO record the user's standing preferences about how a kind of TASK/);
    expect(DISTILL_INSTRUCTIONS).toMatch(/response-STYLE directives/);
    expect(DISTILL_INSTRUCTIONS).not.toMatch(/standing behavioral directives/);
  });
});
