import type { EmbeddingsClient } from './embeddings';
import type { RerankClient } from './rerank';
import type { FactRerankStatus } from '../../shared/types';

/** Facts may add context and a cap; skill selection uses the same model with its own floor. */
export interface FactRerankClient extends RerankClient {
  readonly modelId?: string;
  readonly factQuery?: (current: string, previous: readonly string[]) => string;
  readonly maxFacts?: number;
}

// App-global registry for the retrieval clients (embeddings + reranker). Set once
// from main after the runtime is up; read by both the fact-ranking path (inject)
// and the consolidation-clustering path. Null = not configured, so callers degrade
// gracefully — recency injection / naive size-chunking — rather than failing.

let embeddingsClient: EmbeddingsClient | null = null;
let rerankClient: RerankClient | null = null;
let factRerankResolver: (() => Promise<FactRerankClient | null>) | null = null;
let factStatusResolver: (() => Promise<FactRerankStatus>) | null = null;
let factRetry: (() => void) | null = null;

export function setRetrievalClients(clients: {
  embeddings?: EmbeddingsClient | null;
  rerank?: RerankClient | null;
  factRerank?: () => Promise<FactRerankClient | null>;
  factStatus?: () => Promise<FactRerankStatus>;
  retryFactRerank?: () => void;
}): void {
  embeddingsClient = clients.embeddings ?? null;
  rerankClient = clients.rerank ?? null;
  factRerankResolver = clients.factRerank ?? null;
  factStatusResolver = clients.factStatus ?? null;
  factRetry = clients.retryFactRerank ?? null;
}

export function retryFactRerank(): void { factRetry?.(); }

export function getEmbeddingsClient(): EmbeddingsClient | null {
  return embeddingsClient;
}

export function getRerankClient(): RerankClient | null {
  return rerankClient;
}

/** Resolve once per recall build. A warming/disabled pilot uses the normal backend. */
export async function getFactRerankClient(): Promise<FactRerankClient | null> {
  return (await factRerankResolver?.()) ?? rerankClient;
}

/** Snapshot the selected model for a skill pass; leave its query and skill floor intact. */
export async function getSkillRerankClient(): Promise<FactRerankClient | null> {
  return getFactRerankClient();
}

export async function getFactRerankStatus(): Promise<FactRerankStatus> {
  return await factStatusResolver?.() ?? {
    installed: false,
    status: { model: 'gte-memory-20260905-epoch2', state: 'idle' }
  };
}
