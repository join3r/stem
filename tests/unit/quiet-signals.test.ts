import { mkdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { degradations, resetDegradations } from '../../src/server/degrade';
import { settingsStorePath } from '../../src/server/workspace/paths';
import { readSettings } from '../../src/server/workspace/settings';
// Importing the store is what installs degrade() as search-core's sink (store.ts
// calls setCoreDegradeSink at module scope) — the same wiring every real consumer
// gets by importing ./store. Nothing here calls it directly.
import '../../src/server/recall/store';
import { ftsSearchFacts, ftsSearchMessages } from '../../src/server/recall/search-core';

/**
 * The guard in `quiet-failures.test.ts` proves a sentence exists at every swallow.
 * These prove the sentence is actually said when the failure happens — which is the
 * half a static check cannot reach, and the half that separates "recall found
 * nothing" from "recall is broken".
 *
 * Deliberately a handful, not one per site. 118 assertions mirroring 118 call sites
 * would be a second copy of the source that fails whenever anyone rewords a message.
 * These cover the two shapes that motivated the whole change: a search leg whose
 * empty result is indistinguishable from a real answer, and a store whose read
 * fallback is what the next write persists.
 */
describe('degradations are actually reported when a swallow fires', () => {
  beforeEach(() => {
    resetDegradations();
  });

  it('names the search leg that died instead of returning a plain empty result', () => {
    // A database with none of recall's tables stands in for the real causes —
    // schema drift, a failed migration, a corrupt index. Every leg catches and
    // returns [], so the return value alone says "nothing matched".
    const empty = new DatabaseSync(':memory:');

    expect(ftsSearchMessages(empty, 'anything')).toEqual([]);
    expect(ftsSearchFacts(empty, 'anything')).toEqual([]);

    expect(degradations().map((d) => `${d.scope}: ${d.what}`)).toEqual([
      'recall.search: returned no episodic hits from the FTS leg',
      'recall.facts: returned no fact hits from the FTS leg'
    ]);
    expect(degradations()[0].error).toBeTruthy();
  });

  it('says so when settings fall back to defaults, but not on a first launch', async () => {
    const path = settingsStorePath();

    // Absent is the ordinary fresh install: defaults are the right answer and
    // there is nothing to report. Reporting here would fire on every clean start,
    // which is the noise that trains people to stop reading the log.
    await rm(path, { force: true, recursive: true });
    await readSettings();
    expect(degradations()).toEqual([]);

    // Present and unreadable is the failure. A directory where the file should be
    // gives a deterministic non-ENOENT error on every platform.
    await mkdir(path, { recursive: true });
    try {
      await readSettings();
      expect(degradations()).toHaveLength(1);
      expect(degradations()[0]).toMatchObject({
        scope: 'settings',
        what: 'fell back to default settings'
      });
    } finally {
      await rm(path, { force: true, recursive: true });
    }
  });

  it('leaves a real settings file alone and says nothing about it', async () => {
    const path = settingsStorePath();
    await rm(path, { force: true, recursive: true });
    await writeFile(
      path,
      JSON.stringify({ customInstructions: { main: 'be brief', quickChat: '' } }),
      'utf8'
    );
    try {
      expect((await readSettings()).customInstructions.main).toBe('be brief');
      expect(degradations()).toEqual([]);
    } finally {
      await rm(path, { force: true });
    }
  });
});
