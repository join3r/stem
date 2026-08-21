import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { degrade } from '../degrade';
import { harnessRunsPath } from '../workspace/paths';

// The run log for coding_agent turns (harness-runs.json). Persistence layer
// only, shaped like workspace/tasks.ts: a corrupt or missing file degrades to
// "no runs" rather than breaking anything, and writes are serialized through a
// promise chain. Nothing reads this on a hot path — it exists so a person (or
// a later turn) can ask what ran, when, and what it cost.

export type HarnessRunStatus = 'running' | 'ok' | 'failed' | 'cancelled';

export interface HarnessRunUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface HarnessRunRecord {
  runId: string;
  threadId: string;
  agent: string;
  cwd: string;
  /** Device label when the run was hosted by a paired client; absent for server runs. */
  device?: string;
  sessionId: string;
  startedAt: string;
  settledAt?: string;
  status: HarnessRunStatus;
  usage?: HarnessRunUsage;
  /** Cumulative session cost in USD as the agent reported it. */
  costUsd?: number;
  error?: string;
}

interface RunsStore {
  version: 1;
  runs: HarnessRunRecord[];
}

/** Newest-first cap so the log never grows without bound. */
const MAX_RUNS = 500;

function coerceUsage(raw: unknown): HarnessRunUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const usage: HarnessRunUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    if (typeof r[key] === 'number' && Number.isFinite(r[key])) usage[key] = r[key] as number;
  }
  return Object.keys(usage).length ? usage : undefined;
}

/** Coerce one parsed entry into a valid record, or null to drop it. */
function coerce(raw: unknown): HarnessRunRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<HarnessRunRecord>;
  if (typeof r.threadId !== 'string' || !r.threadId) return null;
  if (typeof r.agent !== 'string' || !r.agent) return null;
  if (typeof r.cwd !== 'string' || !r.cwd) return null;
  if (typeof r.sessionId !== 'string' || !r.sessionId) return null;
  const status =
    r.status === 'running' || r.status === 'ok' || r.status === 'failed' || r.status === 'cancelled'
      ? r.status
      : null;
  if (!status) return null;
  const usage = coerceUsage(r.usage);
  return {
    runId: typeof r.runId === 'string' && r.runId ? r.runId : randomUUID(),
    threadId: r.threadId,
    agent: r.agent,
    cwd: r.cwd,
    sessionId: r.sessionId,
    startedAt: typeof r.startedAt === 'string' && r.startedAt ? r.startedAt : new Date().toISOString(),
    status,
    ...(typeof r.device === 'string' && r.device ? { device: r.device } : {}),
    ...(typeof r.settledAt === 'string' && r.settledAt ? { settledAt: r.settledAt } : {}),
    ...(usage ? { usage } : {}),
    ...(typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) ? { costUsd: r.costUsd } : {}),
    ...(typeof r.error === 'string' && r.error ? { error: r.error } : {})
  };
}

async function loadRuns(): Promise<HarnessRunRecord[]> {
  const parsed = JSON.parse(await readFile(harnessRunsPath(), 'utf8')) as Partial<RunsStore>;
  return Array.isArray(parsed.runs) ? parsed.runs.map(coerce).filter((r): r is HarnessRunRecord => !!r) : [];
}

export async function readHarnessRuns(): Promise<HarnessRunRecord[]> {
  try {
    return await loadRuns();
  } catch (error) {
    // A fresh install has no run log; anything else unreadable is worth a word.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('harness', 'reported no coding-agent runs', error);
    }
    return [];
  }
}

// Serialize writes through a promise chain so concurrent settles can't
// interleave a read-modify-write and lose records (mirrors workspace/tasks.ts).
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeRuns(runs: HarnessRunRecord[]): Promise<void> {
  const path = harnessRunsPath();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, runs: runs.slice(0, MAX_RUNS) } satisfies RunsStore, null, 2), 'utf8');
  await rename(tmp, path); // atomic on the same volume
}

/**
 * Update the run log: read (an unreadable log degrades to empty here, because
 * losing bookkeeping beats refusing to record the run that is happening now),
 * mutate, persist atomically.
 */
function updateRuns(mutate: (runs: HarnessRunRecord[]) => HarnessRunRecord[]): Promise<void> {
  return enqueue(async () => {
    const current = await readHarnessRuns();
    await writeRuns(mutate(current));
  });
}

/** Record a turn the moment it starts, newest first. */
export function recordRunStart(record: HarnessRunRecord): Promise<void> {
  return updateRuns((runs) => [record, ...runs.filter((r) => r.runId !== record.runId)]);
}

/** Settle a run with its outcome. A runId the log no longer holds is a no-op. */
export function settleRun(
  runId: string,
  outcome: Pick<HarnessRunRecord, 'status'> & Partial<Pick<HarnessRunRecord, 'usage' | 'costUsd' | 'error' | 'sessionId'>>
): Promise<void> {
  return updateRuns((runs) =>
    runs.map((r) => (r.runId === runId ? { ...r, ...outcome, settledAt: new Date().toISOString() } : r))
  );
}
