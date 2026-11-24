// Verification probe for Stem Recall. Exercises the REAL compiled modules
// (store/search/inject) against a throwaway DB and asserts the cross-chat recall
// regression case (the health / "UZ Gent" failure that motivated this feature).
//
// Run (from repo root):
//   rm -rf .recall-build
//   npx tsc src/server/recall/store.ts src/server/recall/search.ts src/server/recall/inject.ts \
//     src/server/recall/embeddings.ts src/server/recall/rerank.ts src/server/recall/retrieval.ts \
//     src/server/recall/vector.ts \
//     src/server/recall/capture.ts src/server/recall/distill.ts src/server/recall/consolidate.ts \
//     --outDir .recall-build \
//     --module commonjs --moduleResolution node --ignoreConfig --ignoreDeprecations 6.0 --target es2022 --skipLibCheck \
//     --esModuleInterop --rootDir src --noCheck
//   printf '{"type":"commonjs"}' > .recall-build/package.json
//   STEM_RECALL_DB="$PWD/.recall-build/verify.sqlite" ELECTRON_RUN_AS_NODE=1 \
//     ./node_modules/.bin/electron scripts/recall-verify.mjs
// (.recall-build must live inside the repo so Node resolves `electron`; it's gitignored.)
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Compiled output must live inside the repo so Node resolves `electron` from the
// project's node_modules (a /tmp build can't). See header for the tsc command.
const BUILD = fileURLToPath(new URL('../.recall-build/server/recall/', import.meta.url));
// The store module exports the RecallStore instance as `recallStore`
// (module-global functions went away in the class refactor).
const storeModule = require(`${BUILD}/store.js`);
const store = storeModule.recallStore;
const search = require(`${BUILD}/search.js`);
const inject = require(`${BUILD}/inject.js`);
const distill = require(`${BUILD}/distill.js`);
const consolidate = require(`${BUILD}/consolidate.js`);

const dbPath = process.env.STEM_RECALL_DB;
if (!dbPath) {
  console.log('FAIL: set STEM_RECALL_DB to a throwaway path');
  process.exit(1);
}
try {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
} catch {}

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures += 1;
}

// --- seed: thread A discusses health pulled from email; thread B is separate ---
store.recordMessage({ threadId: 'A', turnId: 't1', role: 'user', text: 'Nájdi informácie o mojom zdravotnom stave v emailoch' });
store.recordMessage({
  threadId: 'A',
  turnId: 't1',
  role: 'assistant',
  text: 'Your UZ Gent cardiology appointment is on June 30; Dr. Janssens noted slightly elevated cholesterol and asked for a follow-up blood test.'
});
// The same appointment in the user's own words. buildRecallContext filters its
// episodic leg to roles: ['user'] before top-k, so an assistant-only thread is
// structurally uninjectable and check 7's snippet assertion would match nothing
// but the durable fact — restating the line above it.
store.recordMessage({
  threadId: 'A',
  turnId: 't2',
  role: 'user',
  text: 'Remind me when my UZ Gent cardiology appointment is, I want to book the day off'
});
store.recordMessage({ threadId: 'B', turnId: 't9', role: 'user', text: 'how do decoder-only LLMs differ from BERT' });

// Unrelated filler, so check 7 stands on its own. The hybrid episodic leg gates
// its FTS side on bm25 (FTS_SCORE_CEILING = -0.1) and bm25 scales with IDF, so in
// a corpus this small the gate — not relevance — is the binding constraint: with
// only the four messages above, "uz"/"gent"/"cardiology" sit in half the corpus,
// every score rounds to -0.0000, nothing clears the gate, and check 7 goes back
// to passing vacuously on the durable fact alone. Measured: these threads take
// the query to bm25 -5.3. Without them it still clears, but only at -1.2 and only
// because check 5 happens to seed thread C before check 7 reads — the kind of
// accidental coupling that let this assertion rot in the first place.
for (const [threadId, role, text] of [
  ['D', 'user', 'Which gravel tyres roll fastest on wet limestone?'],
  ['D', 'assistant', 'A 42 mm file tread with a reinforced casing is the usual compromise there.'],
  ['E', 'user', 'My sourdough starter smells like acetone this week.'],
  ['E', 'assistant', 'That is a hungry starter — feed it twice daily at a warmer room temperature.'],
  ['F', 'user', 'Any recommendations for a slow sci-fi novel about archives?'],
  ['F', 'assistant', 'Try the one about a generation ship losing its library; reviewers liked its pacing.'],
  ['G', 'user', 'The invoice service keeps timing out under load.'],
  ['G', 'assistant', 'Profile the serialization path first; it is usually the CPU-bound step.']
]) {
  store.recordMessage({ threadId, turnId: `${threadId}1`, role, text });
}

// --- 1. cross-chat recall: querying in B finds A's health content ---
const hits = search.searchMemory('what is my UZ Gent cardiology appointment', { excludeThreadId: 'B', limit: 5 });
check('cross-chat recall finds thread A health content', hits.some((h) => h.threadId === 'A' && /UZ Gent/.test(h.text)));

// --- 2. current-thread exclusion ---
const hitsExclA = search.searchMemory('UZ Gent cardiology', { excludeThreadId: 'A', limit: 5 });
check('excludeThreadId removes the current thread', !hitsExclA.some((h) => h.threadId === 'A'));

// --- 3. unrelated query does not surface health ---
const unrelated = search.searchMemory('decoder-only BERT architecture', { excludeThreadId: 'A', limit: 5 });
check('unrelated query does not return health content', !unrelated.some((h) => /UZ Gent/.test(h.text)));

// --- 4. dedup idempotency ---
const before = store.messageCount();
store.recordMessage({ threadId: 'A', turnId: 't1', role: 'user', text: 'Nájdi informácie o mojom zdravotnom stave v emailoch' });
check('re-recording the same message is a no-op (dedup)', store.messageCount() === before);

// --- 5. Slovak tokenization recall ---
store.recordMessage({ threadId: 'C', turnId: 'c1', role: 'user', text: 'Mám kardiologické vyšetrenie v Gente budúci týždeň' });
const sk = search.searchMemory('kardiologické vyšetrenie', { excludeThreadId: 'B', limit: 5 });
check('Slovak query recalls Slovak content', sk.some((h) => h.threadId === 'C'));

// --- 6. facts: upsert + correction-aware dedup ---
store.upsertFact('User has a cardiology follow-up at UZ Gent', 'distilled');
store.upsertFact('user has a cardiology follow-up at uz gent.', 'explicit'); // same norm → updates, not duplicates
const facts = store.getFacts();
check('fact upsert dedups by normalized text', facts.filter((f) => /cardiology follow-up at UZ Gent/i.test(f.text)).length === 1);
check('fact correction updates source', facts.find((f) => /cardiology follow-up/i.test(f.text))?.source === 'explicit');

// --- 7. inject: builds a context block with facts + relevant hits, excluding current thread ---
const ctx = await inject.buildRecallContext('what is my UZ Gent cardiology appointment', { currentThreadId: 'B' });
// v3 payload: facts ride in a JSON block, and the correction above made the
// stored text lowercase (latest write wins the text), so match case-blind.
// FTS snippets wrap matched terms in «», which would split "UZ Gent" — strip the
// markers so the assertions read on plain text.
const ctxPlain = (ctx ?? '').replace(/[«»]/g, '');
check('inject includes durable facts', /"facts":\[\{/.test(ctxPlain));
// Anchored inside pastUserMessages, not on the whole block: the durable fact
// asserted above also says "UZ Gent", so an unanchored match proves nothing
// about episodic recall.
check('inject includes the recalled health snippet as a past user message', /"pastUserMessages":\[[^\]]*uz gent/i.test(ctxPlain));
check('inject mentions the search tool', /search_past_chats/.test(ctxPlain));

// --- 8. distillation: parsing (JSON + bullets + secret filtering) ---
const pf = distill.parseFacts('Here you go:\n["The user lives in Slovakia", "The user prefers Slovak"]');
check('parseFacts reads a JSON array', pf.length === 2 && pf.includes('The user prefers Slovak'));
const pf2 = distill.parseFacts('- The user is a developer\n- their password is hunter2');
check('parseFacts reads bullets and drops secrets', pf2.includes('The user is a developer') && !pf2.some((f) => /password/i.test(f)));

// --- 9. distillation: writes facts + watermark prevents reprocessing ---
const stubLlm = { complete: async () => '["The user has an upcoming UZ Gent cardiology appointment"]' };
const wrote = await distill.distillNewMessages(stubLlm);
check('distill writes facts from new messages', wrote >= 1);
check('distilled fact is stored', store.getFacts().some((f) => /UZ Gent cardiology appointment/i.test(f.text)));
const wroteAgain = await distill.distillNewMessages(stubLlm);
check('distill watermark prevents reprocessing', wroteAgain === 0);

// --- 10. consolidation: pure parsing/clamp helpers ---
const pc = consolidate.parseConsolidation('sure:\n{"merge":[{"ids":[1,2],"text":"merged"}],"correct":[{"id":3,"text":"fixed"}],"drop":[4]}');
check('parseConsolidation reads merge/correct/drop', pc.merge.length === 1 && pc.correct.length === 1 && pc.drop[0] === 4);
const pcBad = consolidate.parseConsolidation('no json here at all');
check('parseConsolidation on garbage is a no-op', pcBad.merge.length === 0 && pcBad.correct.length === 0 && pcBad.drop.length === 0);
const clampProt = consolidate.clampOps({ merge: [{ ids: [10, 11], text: 'x' }], correct: [{ id: 11, text: 'y' }], drop: [11] }, new Set([11]), 8);
check('clampOps strips ops touching protected ids', clampProt.merge.length === 0 && clampProt.correct.length === 0 && clampProt.drop.length === 0);
const clampMass = consolidate.clampOps({ merge: [], correct: [], drop: [1, 2, 3] }, new Set(), 4);
check('clampOps rejects a batch that would delete >40% of the set', clampMass.drop.length === 0);

// --- 11. consolidation: applyConsolidation collapses duplicates, keeps protected ---
store.upsertFact('The user lives in Bratislava, Slovakia', 'distilled');
store.upsertFact('The user is based in Bratislava', 'distilled'); // reworded duplicate
store.upsertFact('The user has a dog named Rex', 'distilled');
store.upsertFact('The user works as a software engineer', 'distilled');
store.upsertFact('The user wants you to remember the WiFi name is HomeNet', 'explicit'); // protected

const all = store.getAllFacts();
const idA = all.find((f) => /lives in Bratislava, Slovakia/.test(f.text)).id;
const idB = all.find((f) => /based in Bratislava/.test(f.text)).id;
const idProt = all.find((f) => /HomeNet/.test(f.text)).id;

// Stub returns a merge of the two Bratislava facts plus an (illegal) drop of the protected fact.
const consolidateLlm = {
  complete: async () =>
    JSON.stringify({ merge: [{ ids: [idA, idB], text: 'The user lives in Bratislava, Slovakia' }], correct: [], drop: [idProt] })
};
const res = await consolidate.consolidateFacts(consolidateLlm);
const afterFacts = store.getAllFacts();
// Merge losers survive as superseded audit rows now — count only active facts.
check('consolidate merges reworded duplicates into one', afterFacts.filter((f) => f.status === 'active' && /Bratislava/.test(f.text)).length === 1 && res.merged === 1);
check('consolidate never drops a protected fact', afterFacts.some((f) => /HomeNet/.test(f.text)) && res.dropped === 0);

// --- 12. consolidation: a correction rewrites text in place ---
const engId = store.getAllFacts().find((f) => /software engineer/.test(f.text)).id;
const correctLlm = {
  complete: async () => JSON.stringify({ merge: [], correct: [{ id: engId, text: 'The user works as a data scientist' }], drop: [] })
};
// pending counter must clear so this pass is allowed to run again; force it via the threshold gate test below.
const corrRes = await consolidate.consolidateFacts(correctLlm);
check('consolidate applies a correction in place', store.getAllFacts().some((f) => /data scientist/.test(f.text)) && corrRes.corrected === 1);

// --- 13. gating: shouldConsolidate flips only past the threshold ---
store.setMeta('consolidate_pending', '0');
check('shouldConsolidate is false below threshold', distill.shouldConsolidate() === false);
store.setMeta('consolidate_pending', '5');
check('shouldConsolidate is true at/above threshold', distill.shouldConsolidate() === true);

// --- 14. configurable tidy-up threshold ---
check('tidy threshold defaults to 5', store.getTidyThreshold() === 5);
store.setTidyThreshold(10);
check('tidy threshold round-trips', store.getTidyThreshold() === 10);
check('shouldConsolidate respects a raised threshold', distill.shouldConsolidate() === false); // pending 5 < 10
store.setTidyThreshold(0);
store.setMeta('consolidate_pending', '999');
check('tidy threshold 0 disables auto tidy-up', distill.shouldConsolidate() === false);

// --- 15. episodic size limit + pruning ---
check('episodic limit defaults to 100 MB', store.getEpisodicLimitBytes() === 100 * 1024 * 1024);
store.setEpisodicLimitBytes(50 * 1024 * 1024);
check('episodic limit round-trips', store.getEpisodicLimitBytes() === 50 * 1024 * 1024);
store.setEpisodicLimitBytes(0);
check('episodic limit 0 means unlimited (no prune)', store.enforceEpisodicLimit() === 0);
const beforePrune = store.messageCount();
store.setEpisodicLimitBytes(1); // absurdly small → prune everything
const pruned = store.enforceEpisodicLimit();
check('enforceEpisodicLimit prunes when over the cap', pruned > 0 && pruned <= beforePrune);
check('pruning empties the episodic store under a tiny cap', store.messageCount() === 0);

// --- 16. split resets (facts vs episodic are independent) ---
store.upsertFact('The user keeps a fact for the reset test', 'distilled');
store.recordMessage({ threadId: 'R', turnId: 'r1', role: 'user', text: 'a message for the reset test' });
store.resetFacts();
check('resetFacts clears facts but keeps episodic', store.getFacts().length === 0 && store.messageCount() === 1);
store.upsertFact('The user keeps another fact', 'distilled');
store.resetEpisodic();
check('resetEpisodic clears messages but keeps facts', store.messageCount() === 0 && store.getFacts().length === 1);

storeModule.closeForTest();
console.log(failures === 0 ? '\nALL_PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
