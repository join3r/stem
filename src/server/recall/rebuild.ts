import type { MemoryRebuildStatus } from '../../shared/types';

import { degrade } from '../degrade';
import {
  buildDistillBatch,
  DISTILL_INSTRUCTIONS,
  knownFactsBlock,
  parseClaims,
  type DistillCursor
} from './distill';
import { classifyRelation, evidenceDateOf } from './reconcile';
import type { LlmClient } from './llm';
import { recallStore, V1_FACTS_MIGRATED_KEY, type StoredMessage } from './store';
const {
  countFactsBySource,
  createFactConflict,
  getEpisodicGeneration,
  getFactDetails,
  getFactsGeneration,
  getMeta,
  messageCount,
  setMeta,
  supersedeFact,
  upsertFact
} = recallStore;

const REBUILD_KEY = 'memory_rebuild_v2';

/**
 * Is there anything to upgrade? Only a store that distilled facts under v1 has
 * provenance-less memories, and only it should ever see the rebuild offer — a
 * new install records evidence from its first message, so offering to "upgrade"
 * its memory is nonsense (and would spend model calls re-mining transcripts it
 * already mined). Two signals, either of which is enough: the flag the v1→v2
 * migration stamps, and the 'legacy' source that migration puts on every
 * pre-v2 fact (which also recognizes stores migrated before the flag existed).
 */
function provenanceGap(): boolean {
  return getMeta(V1_FACTS_MIGRATED_KEY) === '1' || countFactsBySource('legacy') > 0;
}

function initialStatus(): MemoryRebuildStatus {
  const total = messageCount();
  return {
    state: total > 0 && provenanceGap() ? 'available' : 'complete',
    processedMessages: 0,
    totalMessages: total,
    cursorMessageId: 1,
    cursorOffset: 0
  };
}

function save(status: MemoryRebuildStatus): MemoryRebuildStatus {
  setMeta(REBUILD_KEY, JSON.stringify(status));
  return status;
}

export function getMemoryRebuildStatus(): MemoryRebuildStatus {
  // Re-checked on every read, not just before the first offer: a build that
  // shipped without the gate could have persisted progress on a store that never
  // had anything to upgrade, and that stale row must stop advertising itself.
  if (!provenanceGap()) return initialStatus();
  const raw = getMeta(REBUILD_KEY);
  if (!raw) return initialStatus();
  try {
    const parsed = JSON.parse(raw) as MemoryRebuildStatus;
    if (parsed && typeof parsed.cursorMessageId === 'number') {
      return { ...parsed, totalMessages: Math.max(parsed.totalMessages, messageCount()) };
    }
  } catch (error) {
    // Reset corrupt progress without touching memories — which means the offer
    // reappears at zero and the rebuild re-mines transcripts it already paid a
    // model call for, with the status object showing an ordinary fresh start.
    degrade('recall.rebuild', 'restarted the rebuild from the first message', error);
  }
  return initialStatus();
}

export function startMemoryRebuild(): MemoryRebuildStatus {
  const current = getMemoryRebuildStatus();
  if (current.state === 'paused' || current.state === 'failed') return save({ ...current, state: 'running', lastError: undefined });
  if (current.state === 'complete') return current;
  return save({ ...initialStatus(), state: 'running' });
}

export function pauseMemoryRebuild(): MemoryRebuildStatus {
  const current = getMemoryRebuildStatus();
  return current.state === 'running' ? save({ ...current, state: 'paused' }) : current;
}

export function resumeMemoryRebuild(): MemoryRebuildStatus {
  const current = getMemoryRebuildStatus();
  return current.state === 'paused' || current.state === 'failed'
    ? save({ ...current, state: 'running', lastError: undefined })
    : current;
}

function evidenceFor(ids: number[], messages: Map<number, StoredMessage>) {
  return ids.map((id) => messages.get(id)).filter((m): m is StoredMessage => !!m);
}

/** Process exactly one bounded rebuild batch; caller schedules subsequent idle steps. */
export async function runMemoryRebuildStep(llm: LlmClient): Promise<MemoryRebuildStatus> {
  const status = getMemoryRebuildStatus();
  if (status.state !== 'running') return status;
  const factsGeneration = getFactsGeneration();
  // Reset recall mid-batch reuses message rowids (VACUUM) — a cursor persisted
  // for this batch would point into the erased store. Same barrier as facts.
  const episodicGeneration = getEpisodicGeneration();
  const cursor: DistillCursor = { messageId: status.cursorMessageId, offset: status.cursorOffset };
  const batch = buildDistillBatch(cursor);
  if (!batch) return save({ ...status, state: 'complete', processedMessages: status.totalMessages });

  try {
    const reply = await llm.complete(
      `${DISTILL_INSTRUCTIONS}\n\nToday's date: ${new Date().toISOString().slice(0, 10)}.` +
      `${knownFactsBlock(batch.messages.map((m) => m.text).join('\n'))}\n\nTranscript:\n${batch.transcript}`
    );
    if (getFactsGeneration() !== factsGeneration) return getMemoryRebuildStatus();
    const claims = parseClaims(reply);
    const messages = new Map(batch.messages.map((m) => [m.id, m]));
    for (const claim of claims) {
      if (getFactsGeneration() !== factsGeneration) return getMemoryRebuildStatus();
      if (getEpisodicGeneration() !== episodicGeneration) return getMemoryRebuildStatus();
      const validIds = claim.evidenceMessageIds.filter((id) => messages.has(id));
      // Backfilled evidence is provenance, not authority (see distill.ts): only a
      // claim whose own citations resolved gets 0.9 confidence and supersede power.
      const cited = validIds.length > 0;
      const fallback = batch.messages.filter((m) => m.role === 'user').map((m) => m.id);
      const evidenceMessages = evidenceFor(cited ? validIds : fallback, messages);
      const directUser = cited && evidenceMessages.some((m) => m.role === 'user');
      const factId = upsertFact(claim.text, {
        source: 'distilled',
        category: claim.category,
        sensitivity: claim.sensitivity,
        confidence: directUser ? 0.9 : 0.55,
        validUntil: claim.validUntil,
        evidence: evidenceMessages.map((m) => ({
          messageId: m.id,
          threadId: m.threadId,
          role: m.role,
          timestamp: m.ts,
          excerpt: m.text,
          origin: directUser && m.role === 'user'
            ? 'user_message'
            : m.role === 'assistant' && m.web ? 'assistant_claim_web' : 'assistant_claim'
        }))
      });
      if (factId == null) continue;
      // The rebuild re-reads transcripts that distillation already mined, so its
      // "supersedes"/"conflicts" links land overwhelmingly on restatements of the
      // same fact. Only a classified disagreement is worth a user-facing conflict.
      const incomingDate = evidenceDateOf(getFactDetails(factId));
      const raiseVerified = async (targetId: number, reason: string): Promise<boolean> => {
        const target = getFactDetails(targetId);
        if (!target || target.id === factId || target.status !== 'active') return true;
        const verdict = await classifyRelation(
          { text: target.text, evidenceDate: evidenceDateOf(target) },
          { text: claim.text, evidenceDate: incomingDate },
          llm
        );
        if (getFactsGeneration() !== factsGeneration) return false;
        // Nothing is memoized here, so an unclassified pair costs only this pass:
        // raise no conflict on a verdict the model never gave.
        if (verdict === null || verdict === 'compatible') return true;
        const current = getFactDetails(targetId);
        if (current && current.status === 'active' && current.text === target.text) {
          createFactConflict(targetId, factId, reason);
        }
        return true;
      };
      for (const targetId of claim.supersedesFactIds) {
        const target = getFactDetails(targetId);
        if (!target || target.id === factId) continue;
        if (directUser && target.source !== 'explicit') {
          supersedeFact(targetId, factId);
        } else if (!(await raiseVerified(targetId, 'Rebuilt evidence may contradict this fact.'))) {
          return getMemoryRebuildStatus();
        }
      }
      for (const targetId of claim.conflictsWithFactIds) {
        if (claim.supersedesFactIds.includes(targetId)) continue;
        if (!(await raiseVerified(targetId, 'Rebuilt evidence is ambiguous.'))) {
          return getMemoryRebuildStatus();
        }
      }
    }
    if (getFactsGeneration() !== factsGeneration) return getMemoryRebuildStatus();
    if (getEpisodicGeneration() !== episodicGeneration) return getMemoryRebuildStatus();
    const completedMessages = batch.messages.filter((m) => m.id < batch.nextCursor.messageId).length;
    // Re-read: the model call above takes seconds, and the user may have paused
    // meanwhile. Persist this batch's progress, but never resurrect 'running' over
    // a pause the user asked for while we were in flight.
    const latest = getMemoryRebuildStatus();
    return save({
      ...latest,
      processedMessages: Math.min(latest.totalMessages, status.processedMessages + completedMessages),
      cursorMessageId: batch.nextCursor.messageId,
      cursorOffset: batch.nextCursor.offset,
      lastError: undefined
    });
  } catch (error) {
    // quiet: the failure is the return value — it is persisted on the status row
    // as lastError, and recall-tasks.ts turns that into activity.fail so the
    // popover says "Memory rebuild failed" with this message.
    //
    // Either reset — facts or episodic — invalidates the in-flight model call
    // and clears rebuild progress; resetEpisodic deletes the progress row
    // outright. Its rejection must not recreate that progress as a stale failed
    // run, which a legacy-fact store would then show as "Memory rebuild failed"
    // right after a clean reset.
    if (getFactsGeneration() !== factsGeneration) return getMemoryRebuildStatus();
    if (getEpisodicGeneration() !== episodicGeneration) return getMemoryRebuildStatus();
    const latest = getMemoryRebuildStatus();
    return save({
      ...latest,
      state: 'failed',
      lastError: error instanceof Error ? error.message : 'Memory rebuild failed'
    });
  }
}
