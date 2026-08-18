import * as activity from './activity';
import { log } from './log';
import type { ActivityKind } from '../shared/types';

/**
 * The record of a failure the app decided to survive.
 *
 * Three of the bugs that reached a release in 0.4.x had the same shape: the app
 * did the wrong thing and said nothing. A chat's mtime was rewritten by a repair
 * and the Inbox read the repair as activity. An approval card nobody answered was
 * settled as a refusal, and the expiry "left no trace anywhere". Every leg of
 * recall search is `try { … } catch { return [] }`, so a malformed query, a schema
 * drift or a corrupt vector blob all arrive at the caller as "nothing matched" —
 * which is also what a healthy store says about a question with no answer.
 *
 * None of those is catchable by a test that asserts a value, because the broken
 * path and the working path return the same value. What separates them is whether
 * anything was *said*. So: a catch that changes what the app does has to say so,
 * here, and then a test can assert the saying.
 *
 * `degrade()` is deliberately cheap — a log line and a bounded in-memory ring. It
 * is not an error channel and it never throws: the caller has already decided to
 * carry on, and this must not be the thing that stops it. Pass `activity` when the
 * degradation is one a person should be told about rather than one a maintainer
 * reads out of the log afterwards; that routes it to the existing failure marker
 * on the activity popover.
 *
 * The other half of the rule lives in `tests/unit/quiet-failures.test.ts`: every
 * catch block in `src/server` must either signal — throw, log, `degrade()` — or
 * carry a `// quiet: <reason>` comment saying why its silence is correct. New
 * silence is a test failure, not a code review that someone might skip.
 */
export interface Degradation {
  /** Where it happened, in the same dotted form the log uses ('recall.search'). */
  scope: string;
  /** What the app did instead, in plain words ('returned no episodic hits'). */
  what: string;
  /** The error that caused it, flattened to a message. */
  error: string;
  at: number;
}

/** Enough to see a pattern in a support log; small enough to never matter. */
const LEDGER_LIMIT = 100;

const ledger: Degradation[] = [];
const counts = new Map<string, number>();

function message(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (error === undefined || error === null) return 'no error given';
  return String(error);
}

/**
 * Record that something failed and the app carried on without it.
 *
 * Always logs and always counts. `opts.activity` additionally raises the sticky
 * failure marker on the activity popover — use it when the user's next action
 * depends on knowing (memory stopped being written), not for a fallback they
 * would never notice (a cached lookup missed and was recomputed).
 */
export function degrade(
  scope: string,
  what: string,
  error: unknown,
  opts: { activity?: ActivityKind } = {}
): void {
  try {
    const entry: Degradation = { scope, what, error: message(error), at: Date.now() };
    ledger.push(entry);
    if (ledger.length > LEDGER_LIMIT) ledger.shift();
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
    log(scope, `degraded: ${what}`, { error: entry.error });
    if (opts.activity) activity.fail(opts.activity, error, what);
  } catch {
    // quiet: reporting a degradation must never become one. The caller already
    // chose to survive its own failure; this is diagnostics on top of that.
  }
}

/** Everything recorded this run, oldest first. Bounded at LEDGER_LIMIT. */
export function degradations(): Degradation[] {
  return [...ledger];
}

/** How many times each scope degraded — the shape a diagnostics view wants. */
export function degradationCounts(): Record<string, number> {
  return Object.fromEntries(counts);
}

/** Test seam: the ledger is module-level and outlives an individual test. */
export function resetDegradations(): void {
  ledger.length = 0;
  counts.clear();
}
