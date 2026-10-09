import { useEffect, useState } from 'react';
import type { FactRerankStatus, LocalEmbedStatus, LocalRerankStatus } from '../../shared/types';

/** The optional installed facts model. Older servers do not expose this API. */
export function useFactRerankStatus(): FactRerankStatus | null {
  const [status, setStatus] = useState<FactRerankStatus | null>(null);
  useEffect(() => {
    // During a development renderer reload the preload can still be older.
    if (!window.stem.onFactRerankStatus || !window.stem.getFactRerankStatus) {
      setStatus({ installed: false, status: { model: 'gte-memory-20260905-epoch2', state: 'idle' } });
      return;
    }
    let active = true;
    let receivedEvent = false;
    const off = window.stem.onFactRerankStatus((next) => {
      receivedEvent = true;
      if (active) setStatus(next);
    });
    window.stem.getFactRerankStatus().then((next) => {
      if (active && !receivedEvent) setStatus(next);
    }).catch(() => {
      if (active && !receivedEvent) setStatus({
        installed: false,
        status: { model: 'gte-memory-20260905-epoch2', state: 'idle' }
      });
    });
    return () => {
      active = false;
      off();
    };
  }, []);
  return status;
}

/** One broken retrieval stage: what failed. */
export interface StageFailure {
  error: string;
}

export interface RetrievalHealth {
  /** The embeddings stage failure, else null. */
  embed: StageFailure | null;
  /** The reranker stage failure, else null. */
  rerank: StageFailure | null;
  /** Either stage is down — drives the red alert dots on the Memory tab. */
  broken: boolean;
}

/**
 * Live health of the retrieval stages (embedder + reranker), for the red
 * "something is broken" markers on the Memory tab and inside it, read from the
 * built-in models' status streams. An error always means a stage the user has
 * switched ON is down and recall is silently degraded (selection falls back to
 * lexical/recency) — the server reports 'idle' for stages left off and goes
 * back to 'loading' the moment a retry starts — so the marker never outlives
 * the problem it points at.
 */
export function useRetrievalHealth(): RetrievalHealth {
  const facts = useFactRerankStatus();
  const [embed, setEmbed] = useState<LocalEmbedStatus | null>(null);
  const [rerank, setRerank] = useState<LocalRerankStatus | null>(null);
  useEffect(() => {
    window.stem.getLocalEmbedStatus().then(setEmbed);
    window.stem.getLocalRerankStatus().then(setRerank);
    const offEmbed = window.stem.onLocalEmbedStatus(setEmbed);
    const offRerank = window.stem.onLocalRerankStatus(setRerank);
    return () => {
      offEmbed();
      offRerank();
    };
  }, []);
  const failure = (local: { state: string; error?: string } | null): StageFailure | null =>
    local?.state === 'error' ? { error: local.error ?? 'model failed to load' } : null;
  const embedFailure = failure(embed);
  const rerankFailure = failure(facts?.status ?? null) ?? failure(rerank);
  return { embed: embedFailure, rerank: rerankFailure, broken: embedFailure !== null || rerankFailure !== null };
}
