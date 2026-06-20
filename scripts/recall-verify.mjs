// Verification probe for Stem Recall. Exercises the REAL compiled modules
// (store/search/inject) against a throwaway DB and asserts the cross-chat recall
// regression case (the health / "UZ Gent" failure that motivated this feature).
//
// Run (from repo root):
//   rm -rf .recall-build
//   npx tsc src/main/recall/store.ts src/main/recall/search.ts src/main/recall/inject.ts \
//     src/main/recall/capture.ts src/main/recall/distill.ts --outDir .recall-build \
//     --module commonjs --moduleResolution node --target es2022 --skipLibCheck \
//     --esModuleInterop --rootDir src
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
const BUILD = fileURLToPath(new URL('../.recall-build/main/recall/', import.meta.url));
const store = require(`${BUILD}/store.js`);
const search = require(`${BUILD}/search.js`);
const inject = require(`${BUILD}/inject.js`);
const distill = require(`${BUILD}/distill.js`);

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
store.recordMessage({ threadId: 'B', turnId: 't9', role: 'user', text: 'how do decoder-only LLMs differ from BERT' });

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
const ctx = inject.buildRecallContext('what is my UZ Gent cardiology appointment', { currentThreadId: 'B' });
check('inject includes durable facts', /durable facts/i.test(ctx ?? ''));
check('inject includes the recalled health snippet', /UZ Gent/.test(ctx ?? ''));
check('inject mentions the search tool', /search_past_chats/.test(ctx ?? ''));

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

store.closeForTest();
console.log(failures === 0 ? '\nALL_PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
