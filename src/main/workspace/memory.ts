import type { MemoryContents, MemorySettings } from '../../shared/types';
import { deleteFact, getFacts, getMeta, setMeta, upsertFact } from '../recall/store';
import { recallDbPath } from './paths';

// Stem's memory control surface, backed entirely by Stem Recall (recall.sqlite) —
// codex native memory is no longer used (see bootstrap.disableNativeMemory).
//
// This module owns:
//  - the explicit "remember that …" fast-path (writes a durable Level-1 fact),
//  - the on/off toggle + the Manage-panel "Stored memory" view.
// Episodic capture/search/injection live in src/main/recall/.

const RECALL_ENABLED_KEY = 'recall_enabled';

export function isRecallEnabled(): boolean {
  return getMeta(RECALL_ENABLED_KEY) !== 'false';
}

export async function getMemorySettings(): Promise<MemorySettings> {
  const enabled = isRecallEnabled();
  // The legacy three-flag shape is kept for the IPC/UI contract; for Stem Recall
  // the single enabled flag governs both capture (generate) and injection (use).
  return { enabled, useMemories: enabled, generateMemories: enabled };
}

export async function setMemoryEnabled(enabled: boolean): Promise<MemorySettings> {
  setMeta(RECALL_ENABLED_KEY, enabled ? 'true' : 'false');
  return getMemorySettings();
}

// ---- explicit "remember that …" capture ----

interface MemoryCaptureResult {
  captured: boolean;
  shouldAcknowledge: boolean;
  path?: string;
}

function isSensitiveMemoryText(text: string): boolean {
  return /\b(?:password|passcode|pin|api[_ -]?key|token|secret|private key|seed phrase|recovery phrase|credit card|card number|ssn|social security)\b/i.test(
    text
  );
}

function hasExplicitRememberIntent(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (/\b(?:do|did)\s+you\s+remember\b/i.test(normalized)) return false;
  if (/\bwhat\s+.*\bremember\b/i.test(normalized)) return false;
  if (/\b(?:don't|do not|can't|cannot)\s+remember\b/i.test(normalized)) return false;
  return (
    /\bplease\s+remember(?:\s+that)?\b/i.test(normalized) ||
    /\bremember\s+that\b/i.test(normalized) ||
    /^remember[:,]?\s+/i.test(normalized) ||
    /\bcan\s+you\s+remember(?:\s+that)?\b/i.test(normalized) ||
    /\bkeep\s+in\s+mind\b/i.test(normalized)
  );
}

function memoryStatement(text: string): string {
  return text
    .trim()
    .replace(/\bplease\s+remember(?:\s+that)?\b/gi, '')
    .replace(/\bcan\s+you\s+remember(?:\s+that)?\b/gi, '')
    .replace(/^remember[:,]?\s+/i, '')
    .replace(/\bremember\s+that\b/gi, '')
    .replace(/\bkeep\s+in\s+mind\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[,.:;\s]+|[,.:;\s]+$/g, '')
    .trim();
}

/**
 * Handle an "I want you to remember X" user message by storing X as a durable
 * fact. Returns shouldAcknowledge so the runtime can short-circuit the turn with
 * a confirmation instead of sending it to the model.
 */
export async function captureMemoryFromUserInput(text: string): Promise<MemoryCaptureResult> {
  if (!isRecallEnabled()) return { captured: false, shouldAcknowledge: false };
  if (!hasExplicitRememberIntent(text)) return { captured: false, shouldAcknowledge: false };

  const statement = memoryStatement(text);
  if (!statement || statement.length > 500 || isSensitiveMemoryText(statement)) {
    return { captured: false, shouldAcknowledge: false };
  }

  upsertFact(statement, 'explicit');
  return { captured: true, shouldAcknowledge: true };
}

// ---- Manage panel "Stored memory" view ----

function sourceLabel(source: string): string {
  return source === 'explicit' ? 'On request' : 'Learned';
}

/**
 * Surface durable facts (Level 1) for the Manage panel. Each fact is rendered as
 * a "note". The deeper episodic store (Level 2) isn't listed here — it's searched,
 * not browsed.
 */
export async function readMemoryFiles(): Promise<MemoryContents> {
  const facts = getFacts();
  const files = facts.map((f) => ({
    name: `fact-${f.id}`,
    label: 'Fact',
    content: f.text,
    exists: true,
    kind: 'note' as const,
    statement: f.text,
    source: sourceLabel(f.source)
  }));
  return {
    dir: recallDbPath(),
    files,
    isEmpty: files.length === 0
  };
}

/** Exposed for a future "forget this" affordance in the UI. */
export async function forgetFact(id: number): Promise<void> {
  deleteFact(id);
}
