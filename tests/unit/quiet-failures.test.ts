import { describe, expect, it } from 'vitest';
import { scanCatches, unexplained } from '../quiet-scan';

/**
 * The rule: an inline failure handler in `src/server` — a `catch { … }` block or a
 * `.catch(… => …)` arrow — must either say something (throw, log, `degrade()`, hand
 * the error back to whoever asked) or carry a `// quiet: …` line saying why its
 * silence is the right answer.
 *
 * This is here because the expensive bugs of 0.4.x were not wrong values, they
 * were missing sentences. Recall search catches everything and returns `[]`, which
 * is also what a healthy store says when nothing matched; an approval card that
 * timed out was reported to the assistant as a refusal and "left no trace
 * anywhere". A test that asserts a value cannot separate those cases, because both
 * paths produce the same value. Only the saying separates them.
 *
 * A `// quiet:` note is not a suppression. It is the claim that nothing observable
 * changed, written down where the next person will read it — and it is a claim the
 * mutation probe (`npm run probe:quiet`) checks, by breaking each swallowed `try`
 * and reporting the ones no test notices.
 */
const ROOTS = ['src/server'];

describe('silence is a defect', () => {
  it('every failure handler in src/server either signals or says why it does not', () => {
    const silent = unexplained(ROOTS);
    const listing = silent.map((s) => `  ${s.file}:${s.line} (${s.kind})`).join('\n');
    expect(
      silent.length,
      `${silent.length} failure handler(s) swallow without a word.\n\n` +
        'Each one either changed what the app does — call degrade(scope, what, err) ' +
        'from src/server/degrade.ts so the log and the ledger record it — or it did ' +
        'not, in which case add a "// quiet: <reason>" line saying so.\n\n' +
        listing
    ).toBe(0);
  });

  it('finds handlers of both forms (guards the scanner itself)', () => {
    // A scanner that silently matched nothing would make the rule above vacuous:
    // the suite would stay green because it had stopped looking. Both forms are
    // asserted because the first version of this scanner saw only `catch` blocks,
    // and three separate sweeps of src/server found real degradations hiding in
    // the arrows it could not see.
    const sites = scanCatches(ROOTS);
    expect(sites.filter((s) => s.kind === 'catch').length).toBeGreaterThan(50);
    expect(sites.filter((s) => s.kind === 'arrow').length).toBeGreaterThan(20);
  });
});
