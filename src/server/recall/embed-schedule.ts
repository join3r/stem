// Traffic control for one shared embeddings endpoint. Interactive query embeds
// (a chat turn or a search tool is waiting) and background passage embeds
// (folder indexing, episodic/summary backfill) hit the same server, and a CPU
// endpoint runs requests essentially one at a time — so a minutes-long indexing
// batch in front of a query is a turn that times out and a Memory tab that
// claims the endpoint failed. Observed live 2026-08-21: indexing a 738-doc
// folder held Ollama for 1–2 minutes per batch and every recall query died on
// its 30s budget for the whole backlog. Two rules restore interactivity without
// pausing indexing outright:
//
//   1. Background work never STARTS a request while a query is in flight or
//      finished moments ago — it waits for a lull (this module).
//   2. A query that arrives while a background request is already at the
//      endpoint gets a longer budget instead of a doomed short one — the
//      endpoint is busy, not broken (embeddings.ts reads passageBusy()).
//
// A singleton, like the retrieval-client registry it serves: everything in one
// server process shares one endpoint, so they must share one schedule.

export interface EmbedSchedule {
  /** An interactive query embed is starting; call the returned fn when it ends. */
  beginQuery(): () => void;
  /** A background passage request is going to the endpoint; call the fn when it returns. */
  beginPassage(): () => void;
  /** Whether a background passage request is at the endpoint right now. */
  passageBusy(): boolean;
  /** Resolves once no query is in flight and none ended within the lull window. */
  waitForQueryLull(): Promise<void>;
}

// After a query embed returns, the rest of its turn (rerank, think) runs on the
// same box — a background batch launched the moment the query resolves steals
// those cores mid-turn. Sized to cover a typical turn's remainder; consecutive
// chat turns keep extending it, which is the point: indexing is idle-time work.
const DEFAULT_LULL_MS = 10_000;

// Waiting on an in-flight query is bounded by that query's own timeout, so a
// poll is at worst a few dozen wakeups — not worth a waiter registry.
const POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createEmbedSchedule(opts: { lullMs?: number } = {}): EmbedSchedule {
  const lullMs = opts.lullMs ?? DEFAULT_LULL_MS;
  let queries = 0;
  let passages = 0;
  // 0 = no query yet, so startup backfills run immediately instead of waiting
  // out a lull that nothing began.
  let lastQueryEndAt = 0;

  function begin(dec: () => void): () => void {
    let ended = false;
    return () => {
      if (ended) return; // idempotent: a double-call must not free someone else's slot
      ended = true;
      dec();
    };
  }

  return {
    beginQuery() {
      queries += 1;
      return begin(() => {
        queries -= 1;
        lastQueryEndAt = Date.now();
      });
    },
    beginPassage() {
      passages += 1;
      return begin(() => {
        passages -= 1;
      });
    },
    passageBusy: () => passages > 0,
    async waitForQueryLull() {
      for (;;) {
        if (queries > 0) {
          await sleep(POLL_MS);
          continue;
        }
        const since = Date.now() - lastQueryEndAt;
        if (lastQueryEndAt === 0 || since >= lullMs) return;
        await sleep(lullMs - since);
      }
    }
  };
}

/** The app-wide schedule; tests build their own via {@link createEmbedSchedule}. */
export const embedSchedule = createEmbedSchedule();
