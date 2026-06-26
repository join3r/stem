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
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Thrown when the endpoint is disabled/unconfigured — callers fall back to recency. */
export class EmbeddingsUnavailableError extends Error {
  constructor(message = 'embeddings endpoint not configured') {
    super(message);
    this.name = 'EmbeddingsUnavailableError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
// Bound payloads on the 8b-on-CPU case; vectors come back the same either way.
const MAX_BATCH = 64;

function trimUrl(base: string): string {
  return base.replace(/\/+$/, '');
}

export function createHttpEmbeddingsClient(
  getConfig: () => Promise<EmbeddingsConfig | null>,
  opts: { timeoutMs?: number } = {}
): EmbeddingsClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function embedBatch(cfg: EmbeddingsConfig, texts: string[]): Promise<Float32Array[]> {
    const url = `${trimUrl(cfg.baseUrl)}/v1/embeddings`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
    async embed(texts) {
      const cfg = await getConfig();
      if (!cfg) throw new EmbeddingsUnavailableError();
      if (texts.length === 0) return [];
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += MAX_BATCH) {
        out.push(...(await embedBatch(cfg, texts.slice(i, i + MAX_BATCH))));
      }
      return out;
    }
  };
}
