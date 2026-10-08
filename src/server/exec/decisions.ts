import { appendFile, chmod, rename, stat } from 'node:fs/promises';
import { judgeDecisionsPath } from '../workspace/paths';

// The safety judge's decision log: one JSON line per command or coding-agent
// ask that reached a decision, with what the judge saw, what it said, and what
// happened next. It exists to measure the judge against real traffic (the
// judge-eval harness mines it): before it, a verdict and the user's answer on
// the card it raised were never written anywhere.
//
// Local only: it holds the user's words and the commands as typed, which can
// carry secrets. It lives at the state root, outside the state export, and is
// never synced. Best-effort and serialized like log.ts — a decision that could
// not be recorded must never hold up the command.

const MAX_BYTES = 20 * 1024 * 1024;

export type DecisionOutcome =
  | 'ran-allowlist'
  | 'ran-judge'
  | 'ran-yolo'
  | 'ran-granted'
  | 'user-allow'
  | 'user-always'
  | 'user-deny'
  | 'aborted'
  | 'timeout'
  | 'blocked'
  | 'parked'
  | 'park-allow'
  | 'park-deny';

export interface StageRecord {
  verdict: 'safe' | 'unsafe' | 'unsure' | 'failed';
  reason?: string;
  ms: number;
}

export interface DecisionRecord {
  kind: 'exec' | 'harness';
  threadId: string | null;
  conversationId?: string;
  device?: string;
  command: string;
  cwd?: string;
  /** The stage-1 prompt exactly as the judge read it (absent when no judge ran). */
  prompt?: string;
  stage1?: StageRecord;
  stage2?: StageRecord;
  outcome: DecisionOutcome;
  /** Links the card's later answer (a second line) to the judged line. */
  approvalId?: string;
}

let chain: Promise<void> = Promise.resolve();

/** Append one decision (fire-and-forget; never throws). */
export function recordDecision(record: DecisionRecord): void {
  let line: string;
  try {
    line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
  } catch {
    // quiet: a record that cannot be serialized carries nothing the eval could use.
    return;
  }
  chain = chain.then(async () => {
    try {
      const path = judgeDecisionsPath();
      // quiet: no file yet is the first decision; appendFile creates it.
      const s = await stat(path).catch(() => null);
      // quiet: a failed rotation is retried on the next record, since the size that triggered it does not shrink.
      if (s && s.size > MAX_BYTES) await rename(path, `${path}.1`).catch(() => undefined);
      // Owner-only: the records carry the user's words and commands as typed.
      // mode applies only when the file is created, so a file left with wider
      // permissions (an older build, a restore) is narrowed on every write.
      await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
      // quiet: a filesystem without POSIX modes (Windows) leaves the default ACL; the record is written either way.
      await chmod(path, 0o600).catch(() => undefined);
    } catch {
      // quiet: losing an eval record must not surface as a failed command.
    }
  });
}

/** Settles when every record so far has been written (for tests). */
export function decisionsFlushed(): Promise<void> {
  return chain;
}
