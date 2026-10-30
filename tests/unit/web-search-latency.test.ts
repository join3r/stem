// The latency CONTRACT of a multi-query web search, asserted on shape rather than
// on a stopwatch.
//
// History: search used to be an openai-codex-only trick — the provider's own
// server-side web_search tool injected into the chat model's request, so searching
// cost zero extra round trips and barely registered as tool time. Moving to the
// vendored pi-web-access extension bought search on every provider, and quietly
// changed the cost model: each query became a separate full inference against a
// Responses endpoint, and the package ran them in an indexed `for` loop with an
// `await` inside. Stem's own turn_timings tell the story — median web-search turn
// 39.6s before the switch, 99.8s after, with average tool time up ~10x.
//
// Nobody noticed because nothing measured it. A wall-clock threshold would not
// have caught it either: on a live network it flakes, and under pressure the
// threshold is what gets raised. What actually regressed is the SHAPE of the work
// (one inference -> N sequential inferences), and shape is testable offline and
// deterministically. That is what this file pins:
//
//   1. N queries issue N upstream calls — no hidden fan-out.
//   2. They overlap. A serial regression fails here, with no timing assertion.
//   3. Each query has a deadline, so a call as a whole is bounded too.
//   4. `auto` reaches a plain index before any backend that runs an inference.
//   5. The model behind the search is discovered, never pinned.
//
// 1-2 were Stem's own patch up to pi-web-access 0.18.0; 0.46.0 runs a call's
// queries concurrently itself (runSearchQueries), so they now pin the vendored
// runner. 3-4 are Stem's `searchRouting`, written by writeWebSearchConfig.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSearchSettings } from '../../src/shared/types';

/**
 * A vendored module, imported by a specifier tsc does not follow: the package's
 * TypeScript sources do not typecheck under Stem's config (extract.ts's turndown
 * types), and they are not Stem's to fix. The few exports used here are typed below.
 */
const vendored = (file: string): Promise<unknown> => import(/* @vite-ignore */ `pi-web-access/${file}`);

type RunSearchQueries = <T>(queries: string[], run: (query: string, index: number) => Promise<T>) => Promise<T[]>;
type Search = (query: string, options: object) => Promise<{ provider: string }>;

let runSearchQueries: RunSearchQueries;
beforeAll(async () => {
  ({ runSearchQueries } = (await vendored('web-tool-core.ts')) as { runSearchQueries: RunSearchQueries });
});

/** The vendored runner's cap (SEARCH_QUERY_CONCURRENCY, not exported). */
const CAP = 3;

const QUERIES = ['alpha', 'beta', 'gamma', 'delta'];

/** A search stub that never settles on its own — the test decides when each one does. */
function gatedSearch() {
  const gates: { query: string; resolve: (v: string) => void; reject: (e: unknown) => void }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const search = (query: string): Promise<string> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<string>((resolve, reject) => {
      gates.push({
        query,
        resolve: (v) => {
          inFlight--;
          resolve(v);
        },
        reject: (e) => {
          inFlight--;
          reject(e);
        }
      });
    });
  };
  return {
    search,
    gates,
    get maxInFlight() {
      return maxInFlight;
    }
  };
}

/** Let the microtask queue drain so started-but-unsettled workers are observable. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('multi-query search fans out instead of queueing', () => {
  it('issues exactly one upstream call per query', async () => {
    const calls: string[] = [];
    const results = await runSearchQueries(QUERIES, async (q) => (calls.push(q), `answer:${q}`));
    expect([...calls].sort()).toEqual([...QUERIES].sort());
    expect(results).toEqual(QUERIES.map((q) => `answer:${q}`));
  });

  // THE regression test. Before Stem's fan-out, four queries meant four round
  // trips end to end: ~53s of a 132s turn for one call, twice over. Nothing here
  // measures duration — a serial implementation simply never gets past the first gate.
  it('starts several queries before any of them has answered', async () => {
    const stub = gatedSearch();
    const batch = runSearchQueries(QUERIES, stub.search);

    await settle();
    expect(stub.gates.map((g) => g.query)).toEqual(QUERIES.slice(0, CAP));
    expect(stub.maxInFlight).toBe(CAP);

    for (let next = 0; next < QUERIES.length; ) {
      for (; next < stub.gates.length; next++) stub.gates[next].resolve('ok');
      await settle();
    }
    await batch;
  });

  it('honours the concurrency cap so a 20-query call cannot stampede a provider', async () => {
    const stub = gatedSearch();
    const many = Array.from({ length: 20 }, (_, i) => `q${i}`);
    const batch = runSearchQueries(many, stub.search);

    await settle();
    expect(stub.gates).toHaveLength(CAP);

    // Draining one slot starts exactly one more.
    stub.gates[0].resolve('ok');
    await settle();
    expect(stub.gates).toHaveLength(CAP + 1);

    for (let next = 1; next < many.length; ) {
      for (; next < stub.gates.length; next++) stub.gates[next].resolve('ok');
      await settle();
    }
    await batch;
    expect(stub.maxInFlight).toBeLessThanOrEqual(CAP);
  });

  it('returns results in query order, not completion order', async () => {
    const stub = gatedSearch();
    const batch = runSearchQueries(QUERIES.slice(0, CAP), stub.search);
    await settle();

    for (const gate of [...stub.gates].reverse()) gate.resolve(`answer:${gate.query}`);

    expect(await batch).toEqual(QUERIES.slice(0, CAP).map((q) => `answer:${q}`));
  });
});

/** Stem's web-search.json for these settings, read back as the extension sees it. */
async function writtenConfig(settings: Partial<WebSearchSettings> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'stem-websearch-perf-'));
  vi.resetModules();
  vi.doMock('../../src/server/workspace/paths', () => ({ piHome: () => home }));
  const { writeWebSearchConfig, webSearchConfigPath } = await import('../../src/server/pi/web-search');
  await writeWebSearchConfig({ main: true, quickChat: true, provider: 'auto', credentials: {}, ...settings });
  const file = JSON.parse(readFileSync(webSearchConfigPath(), 'utf8')) as Record<string, unknown>;
  vi.doUnmock('../../src/server/workspace/paths');
  return { home, file };
}

describe('the call as a whole is bounded', () => {
  // Per-query timeouts are 30-60s each depending on backend and a routed query
  // may try several, so without a ceiling a slow provider could hold a turn for
  // minutes with the user watching a spinner.
  it('gives every auto query a deadline that keeps a 4-query call within two minutes', async () => {
    const { home, file } = await writtenConfig();
    try {
      const routing = file.searchRouting as { timeoutMs?: number };
      expect(routing.timeoutMs).toBeGreaterThan(0);
      // Four queries at CAP a time is two waves.
      expect(Math.ceil(QUERIES.length / CAP) * routing.timeoutMs!).toBeLessThanOrEqual(120_000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// The second half of the same regression, and the bigger half. Concurrency fixed
// "four queries take four times as long"; it did nothing about "one query costs a
// whole model inference".
//
// pi-web-access's `auto` chain tries the OpenAI backend early — right after a
// self-hosted SearXNG whenever the chat model is a ChatGPT one — so on any machine
// signed into a ChatGPT subscription, every search spins up a SECOND model (not the
// one in the picker) whose entire job is to run the query and quote back what came
// out. Measured against the same queries: 4-12s for that, versus ~0.4s for Exa's
// keyless index lookup, which needs no subscription and no API key and therefore
// works identically for Claude, OpenRouter, Ollama and LM Studio users.
//
// The rule this pins: in Stem's `auto`, no backend that runs an inference may be
// reached before one that just queries an index. It runs the vendored router on
// the config Stem writes, so either side drifting fails here.
describe('auto never pays for an inference it does not need', () => {
  const stubbed = {
    searxng: ['searxng', 'isSearXNGAvailable', 'searchWithSearXNG'],
    brave: ['brave', 'isBraveAvailable', 'searchWithBrave'],
    parallel: ['parallel', 'isParallelAvailable', 'searchWithParallel'],
    tinyfish: ['tinyfish', 'isTinyFishAvailable', 'searchWithTinyFish'],
    tavily: ['tavily', 'isTavilyAvailable', 'searchWithTavily'],
    serpdive: ['serpdive', 'isSerpdiveAvailable', 'searchWithSerpdive'],
    perplexity: ['perplexity', 'isPerplexityAvailable', 'searchWithPerplexity'],
    exa: ['exa', 'isExaAvailable', 'searchWithExa'],
    openai: ['openai-search', 'isOpenAISearchAvailable', 'searchWithOpenAI']
  } as const;
  type Backend = keyof typeof stubbed;
  const LLM = new Set<Backend>(['openai']);

  let home = '';
  beforeEach(async () => {
    vi.resetModules();
    ({ home } = await writtenConfig());
    // The router reads web-search.json from here at module load.
    process.env.PI_CODING_AGENT_DIR = home;
  });
  afterEach(() => {
    for (const [file] of Object.values(stubbed)) vi.doUnmock(`pi-web-access/${file}.ts`);
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(home, { recursive: true, force: true });
  });

  /** Run one auto search with every listed backend stubbed; returns who answered. */
  async function pickedBackend(available: Partial<Record<Backend, boolean>>) {
    const called: string[] = [];
    for (const [id, [file, availableName, searchName]] of Object.entries(stubbed)) {
      vi.doMock(`pi-web-access/${file}.ts`, async (importOriginal) => ({
        ...(await importOriginal<Record<string, unknown>>()),
        [availableName]: () => available[id as Backend] ?? false,
        [searchName]: async () => {
          called.push(id);
          return { answer: id, results: [{ title: id, url: `https://${id}.example`, snippet: id }] };
        }
      }));
    }
    const { search } = (await vendored('gemini-search.ts')) as { search: Search };
    const result = await search('anything', {});
    return { provider: result.provider, called };
  }

  it('reaches the keyless index instead of a model, on a subscription machine', async () => {
    // The exact shipped situation: signed into ChatGPT, no search keys configured.
    const { provider, called } = await pickedBackend({ openai: true, exa: true });
    expect(provider).toBe('exa');
    expect(called).not.toContain('openai');
  });

  it('prefers a backend the user configured over the keyless default', async () => {
    const { provider } = await pickedBackend({ brave: true, openai: true, exa: true });
    expect(provider).toBe('brave');
  });

  it('still falls back to a model when every index is unreachable', async () => {
    const { provider } = await pickedBackend({ openai: true, exa: false });
    expect(provider).toBe('openai');
  });

  it('orders every no-LLM backend ahead of every LLM-mediated one', async () => {
    for (const candidate of (Object.keys(stubbed) as Backend[]).filter((c) => !LLM.has(c))) {
      vi.resetModules();
      const { provider } = await pickedBackend({ [candidate]: true, openai: true });
      expect(provider, `${candidate} lost to an LLM-mediated backend`).toBe(candidate);
    }
  });

  it('only routes to Gemini with an API key, so a search never scans browser cookies', async () => {
    const without = await writtenConfig();
    const withKey = await writtenConfig({ credentials: { geminiApiKey: 'k' } });
    try {
      expect((without.file.searchRouting as { providers: string[] }).providers).not.toContain('gemini');
      expect((withKey.file.searchRouting as { providers: string[] }).providers.at(-1)).toBe('gemini');
    } finally {
      rmSync(without.home, { recursive: true, force: true });
      rmSync(withKey.home, { recursive: true, force: true });
    }
  });

  it('leaves a picked backend to the package', async () => {
    const { home: picked, file } = await writtenConfig({ provider: 'brave' });
    try {
      expect(file.provider).toBe('brave');
      expect(file).not.toHaveProperty('searchRouting');
    } finally {
      rmSync(picked, { recursive: true, force: true });
    }
  });
});

describe('the search model is discovered, not pinned', () => {
  // `openaiSearchModel` in web-search.json is a verbatim override with no fallback.
  // Stem once pinned gpt-5.4-mini there; the Codex endpoint (ChatGPT logins) stopped
  // accepting it on 2026-09-09 and every search on that account failed for days.
  // Leaving the field out lets pi-web-access pick a model the signed-in credential
  // can run, from pi's registry.
  it('writes no model override into the file the extension reads', async () => {
    const { home, file } = await writtenConfig();
    try {
      expect(file).not.toHaveProperty('openaiSearchModel');
      expect(file.workflow).toBe('none');
      // Stem gates the tools by name per turn; a web_enable loader would hide them.
      expect(file.toolActivation).toBe('eager');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
