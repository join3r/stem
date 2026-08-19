// Generic embeddings seam for Stem Recall. Backend-agnostic: talks to any
// OpenAI-compatible /v1/embeddings endpoint (Ollama, vLLM, LM Studio, TEI-openai,
// hosted). Deliberately tiny — global fetch only, no SDK — so the same client can
// back durable-fact ranking today and episodic semantic search (or anything else)
// later. Config is read fresh on every call via the injected getter, mirroring the
// LlmClient pattern, so a settings change takes effect on the next turn with no
// restart.

export interface EmbeddingsConfig {
  baseUrl: string;
  model: string;
  apiKey?: string | null;
}

/**
 * Whether the texts are search queries or the documents being searched. Some
 * models (e.g. the e5 family) were trained with distinct query/passage prefixes;
 * the local backend applies them per its catalog spec. The HTTP client ignores
 * this — remote servers run arbitrary models and blind prefixing would corrupt
 * ones that don't expect it.
 */
export type EmbedKind = 'query' | 'passage';

export interface EmbeddingsClient {
  /** Whether a usable (enabled + configured) endpoint is present right now. */
  available(): Promise<boolean>;
  /** The configured model id, used to key the vector cache; null when unavailable. */
  modelId(): Promise<string | null>;
  /**
   * Embed `texts` → one Float32Array per input, in input order. Throws
   * {@link EmbeddingsUnavailableError} when no config is present, or a plain Error
   * on any transport/timeout/shape failure — callers fall back rather than break.
   */
  embed(texts: string[], kind?: EmbedKind): Promise<Float32Array[]>;
}

/** Thrown when the endpoint is disabled/unconfigured — callers fall back to recency. */
export class EmbeddingsUnavailableError extends Error {
  constructor(message = 'embeddings endpoint not configured') {
    super(message);
    this.name = 'EmbeddingsUnavailableError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
// Passage batches get a separate, much longer budget. They are backfill work
// nobody is waiting on, and on a CPU endpoint a full batch routinely runs
// 12–20s — a 30s ceiling sits inside normal variance there and cuts off work
// that was seconds from finishing. Queries stay on the short budget: a chat
// turn is waiting, and lexical fallback beats a stalled turn.
const DEFAULT_PASSAGE_TIMEOUT_MS = 120_000;
// Bound payloads on the CPU-endpoint case; vectors come back the same either
// way. 32 rather than 64 because a 64-passage batch alone can eat a whole
// timeout budget on CPU, and a timed-out batch that retries redoes half as much.
const MAX_BATCH = 32;
// A count cap alone is not enough: the budget is spent per token, not per text
// (measured 2026-08-19 on the VPS: qwen3-4b embeds ~95 tok/s on CPU, so 120s
// covers ~11k tokens — a batch of 9 long memories blew it twice, and the retry
// was doomed to the same overrun). Cap each request by estimated tokens so it
// fits the budget with retry headroom; a single oversized text still ships
// alone rather than never. chars/4 is the usual rough tokens estimate.
const MAX_BATCH_EST_TOKENS = 8_000;

function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Greedy packing under both caps; every text lands in exactly one batch. */
function packBatches(texts: string[]): string[][] {
  const out: string[][] = [];
  let batch: string[] = [];
  let tokens = 0;
  for (const text of texts) {
    const t = estTokens(text);
    if (batch.length > 0 && (batch.length >= MAX_BATCH || tokens + t > MAX_BATCH_EST_TOKENS)) {
      out.push(batch);
      batch = [];
      tokens = 0;
    }
    batch.push(text);
    tokens += t;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

/** A request cut off by our own timeout — the one failure worth retrying. */
class EmbeddingsTimeoutError extends Error {}

function trimUrl(base: string): string {
  return base.replace(/\/+$/, '');
}

export function createHttpEmbeddingsClient(
  getConfig: () => Promise<EmbeddingsConfig | null>,
  opts: { timeoutMs?: number; passageTimeoutMs?: number } = {}
): EmbeddingsClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const passageTimeoutMs = opts.passageTimeoutMs ?? DEFAULT_PASSAGE_TIMEOUT_MS;

  async function embedBatch(cfg: EmbeddingsConfig, texts: string[], budgetMs: number): Promise<Float32Array[]> {
    const url = `${trimUrl(cfg.baseUrl)}/v1/embeddings`;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, budgetMs);
    let json: { data?: Array<{ index?: number; embedding?: number[] }> };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
        },
        body: JSON.stringify({ model: cfg.model, input: texts }),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error(`embeddings: ${url} → HTTP ${res.status}`);
      json = (await res.json()) as typeof json;
    } catch (err) {
      // The abort's own message ("This operation was aborted") reaches the
      // Memory-tab banner verbatim and reads like a crash. Name what happened:
      // the endpoint was up but didn't answer inside our budget.
      if (timedOut) {
        throw new EmbeddingsTimeoutError(
          `embeddings: ${url} → no response within ${Math.round(budgetMs / 1000)}s (endpoint reachable but slow)`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const data = json?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error(`embeddings: expected ${texts.length} vectors, got ${Array.isArray(data) ? data.length : 'none'}`);
    }
    // Don't trust array order — place each row by its declared `index`.
    const out = new Array<Float32Array | undefined>(texts.length);
    data.forEach((row, i) => {
      const idx = typeof row.index === 'number' ? row.index : i;
      if (!Array.isArray(row.embedding)) throw new Error('embeddings: missing embedding vector');
      out[idx] = Float32Array.from(row.embedding);
    });
    if (out.some((v) => !v)) throw new Error('embeddings: gap in returned vectors');
    return out as Float32Array[];
  }

  return {
    async available() {
      return (await getConfig()) !== null;
    },
    async modelId() {
      return (await getConfig())?.model ?? null;
    },
    async embed(texts, kind) {
      const cfg = await getConfig();
      if (!cfg) throw new EmbeddingsUnavailableError();
      if (texts.length === 0) return [];
      const budgetMs = kind === 'passage' ? passageTimeoutMs : timeoutMs;
      const out: Float32Array[] = [];
      for (const batch of packBatches(texts)) {
        try {
          out.push(...(await embedBatch(cfg, batch, budgetMs)));
        } catch (err) {
          // A timeout is the one failure a second attempt tends to fix — the
          // endpoint is up, just momentarily over budget behind another request
          // — and only passage work retries: it's background, so the extra wait
          // costs nobody, whereas a query retry would double a turn's stall
          // when lexical fallback is standing right there. Anything else (HTTP
          // status, response shape) fails the same way twice; rethrow.
          if (kind !== 'passage' || !(err instanceof EmbeddingsTimeoutError)) throw err;
          out.push(...(await embedBatch(cfg, batch, budgetMs)));
        }
      }
      return out;
    }
  };
}
