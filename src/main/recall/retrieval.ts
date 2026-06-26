import type { EmbeddingsClient } from './embeddings';
import type { RerankClient } from './rerank';

// App-global registry for the retrieval clients (embeddings + reranker). Set once
// from main after the runtime is up; read by both the fact-ranking path (inject)
// and the consolidation-clustering path. Null = not configured, so callers degrade
// gracefully — recency injection / naive size-chunking — rather than failing.

let embeddingsClient: EmbeddingsClient | null = null;
let rerankClient: RerankClient | null = null;

export function setRetrievalClients(clients: {
  embeddings?: EmbeddingsClient | null;
  rerank?: RerankClient | null;
}): void {
  embeddingsClient = clients.embeddings ?? null;
  rerankClient = clients.rerank ?? null;
}

export function getEmbeddingsClient(): EmbeddingsClient | null {
  return embeddingsClient;
}

export function getRerankClient(): RerankClient | null {
  return rerankClient;
}
