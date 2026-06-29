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
restart (see the seam in `src/main/index.ts`). Only the backend handshake is
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
pi extension under `src/main/pi` — resolve), not `dist/main/index.js` directly.
