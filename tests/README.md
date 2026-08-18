# Tests

Two layers, isolated from your real workspace/recall DB via the `STEM_RECALL_DB`
and `STEM_FILES_DIR` env seams (and, for E2E, a throwaway `--user-data-dir`).

## Unit / integration — Vitest (`npm test`)

Runs the **real** main-process modules under Node, with a tiny `electron` stub
(`tests/electron-stub.ts`) so they import cleanly outside Electron. Fast (~250ms),
no build step. These supersede the old `scripts/*-verify.mjs` probes.

- `tests/unit/recall.test.ts` — Stem Recall: episodic FTS5 recall, fact upsert/
  dedup, distillation, consolidation, pruning, resets (ported from
  `scripts/recall-verify.mjs`).
- `tests/unit/files.test.ts` — Files place: add/collision/subdir, context builder,
  traversal guard (ported from `scripts/files-verify.mjs`).
- `tests/unit/mdx.test.ts` — MDX parse-level security gate + component coverage
  (ported from `scripts/probe-mdx.mjs`).

`npm run test:watch` for watch mode.

## End-to-end — Playwright + Electron (`npm run test:e2e`)

Launches the **built** app (`globalSetup` runs `electron-vite build` first) with a
throwaway userData dir and drives it through Playwright.

- `tests/e2e/electron.ts` — fixtures: `electronApp` (isolated launch) and
  `mainWindow` (the main window, distinguished from the Quick Chat overlay / HUD).
- `tests/e2e/smoke.spec.ts` — app boots, renderer paints, preload bridge is wired.
- `tests/e2e/memory.spec.ts` — memory stack through the real preload→IPC→store
  path, driven via `window.stem`.
- `tests/e2e/manage-panel.spec.ts` — real UI clicks: open the Memory tab, assert
  the empty state, click a tidy-up preset and confirm it persists to the store.
- `tests/e2e/tasks.spec.ts` — scheduled-tasks subsystem through the real store →
  IPC → renderer path: seeds tasks via `launchApp({ seedTasks })` (which writes the
  isolated `STEM_TASKS_STORE` before launch), then asserts the Tasks tab renders
  them and that pause/delete persist through real IPC. Hermetic — it seeds only
  non-due tasks so no (faked) turns are dispatched. The flood regression itself
  (a once-due run re-enqueued every ~250ms while in-flight) is guarded
  deterministically at the unit layer by `tests/unit/scheduler.test.ts`; the e2e
  proves the surrounding wiring. Note: under `STEM_E2E` the scheduler is started on
  did-finish-load (the only thing the seam adds beyond a healthy `runtime:status`)
  so the subsystem is reachable without a live backend.

### The `STEM_E2E` seam

The main UI sits behind a pi sign-in gate, and a couple of IPC handlers
(`memory:setEnabled` → `runtime.restart()`) spawn pi. The fixture launches with
`STEM_E2E=1`, which makes `runtime:status` report a healthy backend and skips the
restart (see the seam in `src/server/index.ts`). Only the backend handshake is
faked — every store (recall, files, settings) still runs for real against the
isolated workspace, so the UI is reachable and assertions are genuine.

### Real backend (`STEM_E2E_REAL=1 npm run test:e2e:real`)

No separate login is needed. pi is authenticated globally at `~/.pi/agent/auth.json`,
and Stem's `ensurePiHome()` auto-seeds that into the (throwaway) pi-home the first
time it starts — so the real backend works with your existing auth while the stores
stay isolated. `tests/e2e/real-backend.spec.ts` exercises this — real auth status,
a live `listModels` RPC, and a full turn (type → send → streamed reply renders).
`tests/e2e/message-actions.spec.ts` covers the per-message operations — copy,
edit (cancel + save & run), retry, fork, and delete-from-here (arm + confirm) —
since each needs a real turn to produce a message with a backend `turnId` and to
exercise the real `rollbackToTurn`/`forkThread` thread ops. Both files are skipped
unless `STEM_E2E_REAL` is set.

Use real mode for local verification of pi-dependent flows. Keep it OUT of CI: real
turns hit the network, consume Claude Max / ChatGPT quota, and are non-deterministic.

Implementation note: the fixture launches Electron via the project ROOT (so
`app.getAppPath()` is the repo, and the runtime's source-relative paths — e.g. the
pi extension under `src/server/pi` — resolve), not `dist/main/index.js` directly.

## Silence — the guard, and the probe that checks it

Three of the bugs that reached a 0.4.x release were not wrong values, they were
missing sentences: a repair that rewrote a chat's mtime so the Inbox read it as
activity, an approval card whose expiry "left no trace anywhere" and was reported to
the assistant as a refusal, and recall search — every leg of which is
`try { … } catch { return [] }`, so a malformed query, a schema drift or a corrupt
vector blob all arrive as "nothing matched", which is what a healthy store says too.

A test that asserts a value cannot separate a broken path from a working one when
both return the same value. What separates them is whether anything was *said*. So
the rule: an inline failure handler in `src/server` — a `catch { … }` block or a
`.catch(… => …)` arrow — either says something (throws, logs, `degrade()`s, hands the
error back to whoever asked) or carries a `// quiet: <reason>` line saying why its
silence is correct.

**`tests/unit/quiet-failures.test.ts` (in `npm test`)** is the cheap half. It reads
the source through `tests/quiet-scan.ts` and fails on any handler that does neither,
naming the line. It covers both forms — `catch { … }` blocks and `.catch(… => …)`
arrows. The arrows were invisible to the first version of the scanner, and three
separate sweeps found real degradations hiding in them; because an arrow body is
often a single word, a `// quiet:` note is also accepted on the comment lines
directly above the `.catch` line. New silence is a test failure rather than a review someone might
skip. It is static — it proves a sentence exists, not that the sentence is true.

**`npm run probe:quiet`** is the expensive half that checks the claim. For each
swallowed `try` it inserts a throw and runs the whole unit suite, in a **copy** of the
repo under the temp dir — the working tree is never written to, so interrupt it
whenever you like. It proves the unmutated suite is green in that copy before
probing: a sandbox missing a file the tests read would make every mutant report as
killed, and the run would look like good news. One mutant costs a full run, so ~160
sites is about an hour — run it against a subsystem you touched, or nightly, not in
CI. `--list --roots <path>` gives the census without the hour, `--sample N` spreads a
smaller probe across an area.

It breaks the guarded WORK, not the silence, and that shapes how to read it. For an
untriaged site, SURVIVING is the finding — a failure path nothing notices. For a
`// quiet:` site, killed only means some test watches that work; SURVIVING is the
interesting one, because it means nothing would ever contradict the note. Sites that
call `degrade()` signal, so they are never probed; assert their reporting with a test
that reads `degradations()`.

Before the sweep: 10 of 26 sampled sites surviving, every one of them unexplained.
Among them, episodic-store pruning could stop being requested entirely — the store
grows without bound, nothing turns red, nothing is logged. After it: 159 sites
probed, **0 untriaged survivors**, 70 `// quiet:` claims that no test would
contradict — listed in `QUIET-FAILURE-SWEEP.md` as the remaining exposure.

`degrade(scope, what, error)` (`src/server/degrade.ts`) is what a site calls when its
fallback hides something. It logs, counts per scope and keeps a bounded ledger tests
can read; pass `{ activity }` to also raise the sticky failure marker on the activity
popover, for the few degradations a person needs to be told about rather than a
maintainer reading a log afterwards. `QUIET-FAILURE-SWEEP.md` carries the design
record and the remaining work.

## Latency — two layers, only one of which is a stopwatch

Web search once cost nothing extra: it was the provider's own server-side tool,
injected into the chat model's request, so it happened *inside* one inference.
Moving to the vendored pi-web-access extension made every query a separate full
inference, run one after another — median web-search turn went 39.6s → 99.8s and
average tool time up ~10x (Stem's own `turn_timings` rows say so). Nothing failed;
nothing measured it either.

Underneath that was a second, larger cost with the same cause: the extension's
`auto` chain tried an *LLM-mediated* backend second, so every query spent a whole
extra inference (4–12s, plus ChatGPT quota) on a model whose job was to run the
query and quote the results — while a plain index lookup one branch below did the
same work in ~0.4s with no credential at all. The old native path was fast because
there was no second model; being provider-agnostic never required adding one.

**`tests/unit/web-search-latency.test.ts` (hermetic, in `npm test`)** is the guard
that would have caught both. It asserts the *shape* of the work rather than a
duration: N queries issue N upstream calls, those calls overlap, the call as a
whole has a deadline that degrades to partial results, no backend that runs an
inference is reached before one that just queries an index, and the model behind
the fallback backend is pinned instead of discovered from the registry. A serial
implementation — or an upstream bump that reshuffles the chain — fails it
deterministically, offline, in milliseconds: no network, no flake, and no threshold
anyone can quietly raise.

**`tests/e2e/perf.spec.ts` (`npm run test:perf`)** is the backstop for what shape
cannot prove: real pi, real network, real quota, opt-in via `STEM_PERF=1`. It runs
each case in `tests/perf/budgets.json` a few times and asserts the **median** of
the app's own `turn_timings` rows against a budget, so a failure names a phase
(build / tool / answer) instead of "the test was slow". Budgets are loose on
purpose — they catch a 3x, not a 10% drift. Raise one only as a decision, and say
why in the commit. `STEM_PERF_UPDATE=1 npm run test:perf` refreshes the `measured`
notes without asserting.

Keep `test:perf` out of CI for the same reasons as real mode. Run it before a
release, and any time you touch the search path, the context builder, or anything
between send and first token.

One thing to know before you read a search number as a regression: with no search
credential configured, `web_search` lands on Exa's **free** MCP endpoint, which
rate-limits. A call it answers costs 0.35–1.4s; a call it 429s falls through the
chain to the OpenAI backend and costs 4–11s. Both modes show up inside a single
three-iteration run (8276 / 349 / 8183 ms), so the medians move with how much free
tier is left rather than with anything in this repo. Instrumented proof, if you
need to re-derive it: probe `search()` in the vendored `gemini-search.ts` and log
`errorMessage(err)` on the Exa branch. Configure `exaApiKey` — or any keyed backend
— in Settings to measure the path without that confound. The tool boundary itself
is not a suspect: the extension's own clock and Stem's `tool_ms` agree to within
5ms.
