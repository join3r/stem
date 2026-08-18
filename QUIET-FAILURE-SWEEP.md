# Quiet failures

Design record and work list for making a swallowed failure say something. Written
2026-08-18 after three bugs reached 0.4.x releases with one shape between them, and
after measuring how much of `src/server` can be broken with the test suite still
green.

## Why

None of the three was a wrong value. Each was a missing sentence.

| bug | what happened | why no test caught it |
| --- | --- | --- |
| Inbox (`afff1c4`) | Repairing a chat moved from another machine rewrote its session file, and that file's mtime is the only record of when something last happened in a chat. Opening an old chat from search brought it out of the archive, unread, top of the Inbox. | Two correct modules, one unwritten contract between them. Every test of either passed. |
| Approvals (`97b9732`) | A card nobody answered was settled as `deny`, and the tool call was answered "The user declined to run this command." The commit's own words: expiry "used to leave no trace anywhere". | Tests covered approve and deny. Nothing covered *nobody answered*, *queued behind another card*, or *the client was away*. |
| Recall | Every leg of search is `try { … } catch { return [] }`. A malformed FTS query, a schema drift or a corrupt vector blob reaches the caller as "nothing matched" — which is also what a healthy store says about a question with no answer. | The broken path and the working path return the same value. A test asserting the value cannot separate them. |

### Measured, not asserted

The suite is not thin: 137 unit files, 1952 tests in 10.6s, 21 E2E specs, evals,
perf budgets, CI on three OSes, and a test in nearly every one of the last thirty
commits. Adding more of the same finds less each time.

So the sweep was sized by mutation rather than by intuition. `scripts/quiet-mutants.mjs`
takes each catch block in `src/server` that says nothing, forces the `try` it guards
to throw, and runs the whole suite. A mutant that **survives** is a failure path the
app can take with nothing to show for it and nothing that notices.

First run, 2026-08-18, 26 sites sampled across `src/server`: **10 survived**.
Among them `recall/capture.ts:42` — episodic-store pruning can stop being requested
entirely, so the store grows without bound, with the suite green and nothing said.

Separately: breaking *every* leg of `recall/search-core.ts` at once still left
139 of 154 recall tests passing.

## The rule

A catch block in `src/server` must either **say something** — throw, log,
`degrade()`, hand the error back to whoever asked — or carry a **`// quiet: <reason>`**
line saying why its silence is correct.

A `// quiet:` note is not a suppression. It is the claim that nothing observable
changed, written down at the site where the next person will read it, and it is a
claim `npm run probe:quiet` can go and check.

## Machinery

| piece | what it is |
| --- | --- |
| `src/server/degrade.ts` | `degrade(scope, what, error, opts?)` — logs, counts per scope, keeps a bounded ledger, and optionally raises the existing activity failure marker. Never throws. |
| `tests/quiet-scan.ts` | The shared scanner. A brace-matcher, not a parser: the guard runs inside the unit suite, where an AST dependency would cost more than the rest of the file. |
| `tests/unit/quiet-failures.test.ts` | The guard. Cheap, static, runs in `npm test`. New silence is a test failure, not a review someone might skip. |
| `scripts/quiet-mutants.mjs` | The probe (`npm run probe:quiet`). One mutant costs a full suite run, so a sweep of ~300 sites is about an hour — not part of `npm test`. `--list` gives the census without the hour. |

## Work list

- [x] `degrade()`, its ledger, its activity escalation, and `tests/unit/degrade.test.ts`
- [x] The shared scanner and the guard test
- [x] The mutation probe, `--list` census and `npm run probe:quiet`
- [x] **Round 1** — all 288 `catch { … }` blocks in `src/server`: 118 became
      `degrade()` calls, 161 got a `// quiet:` note, across 64 scopes
- [x] **Round 2** — the 119 arrow-form `.catch(… => …)` handlers the first scanner
      could not see: 52 became `degrade()`, 67 got a `// quiet:` note
- [x] Re-run the probe over the swept tree — 159 sites, result below
- [ ] Re-read the 70 `// quiet:` notes no test would contradict (list below)
- [ ] Decide whether the ledger earns a diagnostics surface, or whether the log
      plus the activity marker is enough

Deliberately out of scope for now: `src/renderer` and `src/desktop`. All three bugs
lived behind the headless boundary, and the guard is cheaper to keep honest over one
tree than three. Widening it is its own pass.

## Round 1, and the hole it found in its own census

Three sweepers independently reported the same gap: the scanner saw `catch { … }`
blocks and nothing else, so `.catch(() => undefined)` — the most common way this
codebase drops something on the floor — was invisible to it. A guard that is green
while blind to half the swallow forms is worse than no guard, so the scanner grew a
`kind: 'catch' | 'arrow'` and the guard now covers both. Because an arrow body is
often a single word with nowhere to put a comment, a `// quiet:` note is also
accepted on the contiguous comment lines immediately above the statement.

The probe cannot follow it there. Breaking an arrow handler means making its promise
reject, which is per-call-site work a text mutation cannot do — so the probe skips
them and says how many it skipped, rather than reporting a smaller denominator.

### How to read the probe after a sweep

The probe breaks the guarded **work**, not the silence. Before the sweep that
distinction did not matter — an unexplained swallow nothing noticed was a finding
either way. Afterwards it does:

| site | probed? | what an outcome means |
| --- | --- | --- |
| calls `degrade()` | no — it signals | its *reporting* is unasserted here; assert it with a test that reads `degradations()`, as `tests/unit/quiet-signals.test.ts` does |
| carries `// quiet:` | yes | **killed** — some test watches this work, so if the note is wrong something would say so. **Survived** — nothing notices this failing at all, and the note is carrying its whole weight unaided |
| untriaged | yes | **survived** — a failure path nothing notices; the original finding |

A killed quiet mutant is therefore *not* proof the note is wrong, and an earlier
draft of this document said it was. `npm run probe:quiet` exits non-zero only on the
unambiguous case: an untriaged site nothing noticed.

### The run, 2026-08-18, after both rounds

159 sites, ~50 minutes, in a sandbox copy of the repo:

- **0 untriaged survivors.** There is no longer a swallow in `src/server` that says
  nothing, explains nothing, and that nothing notices. Before the sweep that was 10
  of 26 sampled.
- **89 `// quiet:` claims killed** — a test watches the work they guard.
- **70 `// quiet:` claims survived** — nothing in the suite notices them failing, so
  those notes are unverified by anything but the reasoning written beside them.
  Concentrated in `pi` (18), `recall` (16), `exec` (8), `startup` and `folder-index`
  (5 each). That list is the honest remaining exposure, and it is the successor to
  the burn-down: not work that was skipped, but claims worth re-reading, and the
  natural place to aim a test at next.

<details>
<summary>The 70 unwatched <code>// quiet:</code> claims, 2026-08-18</summary>

```
    src/server/chatsearch/expand.ts:37
    src/server/exec/executor.ts:246
    src/server/exec/executor.ts:252
    src/server/exec/executor.ts:260
    src/server/exec/executor.ts:265
    src/server/exec/git-bash.ts:127
    src/server/exec/git-bash.ts:198
    src/server/exec/git-bash.ts:204
    src/server/exec/service.ts:542
    src/server/files/store.ts:53
    src/server/folder-index/index.ts:110
    src/server/folder-index/index.ts:298
    src/server/folder-index/scan.ts:150
    src/server/folder-index/store.ts:127
    src/server/folder-index/store.ts:378
    src/server/host/index.ts:198
    src/server/host/index.ts:232
    src/server/index.ts:549
    src/server/index.ts:574
    src/server/index.ts:595
    src/server/ipc/auth.ts:61
    src/server/ipc/auth.ts:79
    src/server/ipc/auth.ts:120
    src/server/mcp-device/catalog.ts:209
    src/server/pi/attachments.ts:125
    src/server/pi/locate.ts:100
    src/server/pi/locate.ts:132
    src/server/pi/locate.ts:177
    src/server/pi/mcp-config.ts:428
    src/server/pi/mcp-config.ts:478
    src/server/pi/runtime.ts:1582
    src/server/pi/runtime.ts:1608
    src/server/pi/runtime.ts:1743
    src/server/pi/runtime.ts:2571
    src/server/pi/runtime.ts:3019
    src/server/pi/runtime.ts:3151
    src/server/pi/runtime.ts:3176
    src/server/pi/runtime.ts:3459
    src/server/pi/runtime.ts:3497
    src/server/pi/secrets.ts:53
    src/server/pi/web-search.ts:113
    src/server/pi/web-search.ts:127
    src/server/recall/embed-endpoint.ts:125
    src/server/recall/embed-endpoint.ts:181
    src/server/recall/embed-worker.ts:209
    src/server/recall/embed-worker.ts:229
    src/server/recall/embed-worker.ts:268
    src/server/recall/embed-worker.ts:368
    src/server/recall/inject.ts:295
    src/server/recall/mcp-server-main.ts:67
    src/server/recall/mcp-server-main.ts:99
    src/server/recall/mcp-server-main.ts:142
    src/server/recall/mcp-server-main.ts:257
    src/server/recall/mcp-server-main.ts:563
    src/server/recall/scan-worker.ts:129
    src/server/recall/search-core.ts:191
    src/server/recall/store.ts:1038
    src/server/recall/summarize.ts:166
    src/server/skills/reset.ts:52
    src/server/skills/reset.ts:64
    src/server/skills/reset.ts:145
    src/server/skills/reset.ts:154
    src/server/startup/exec.ts:46
    src/server/startup/recall-tasks.ts:172
    src/server/startup/recall-tasks.ts:231
    src/server/startup/recall-tasks.ts:282
    src/server/startup/recall-tasks.ts:304
    src/server/transport/server.ts:1066
    src/server/workspace/connected-folders.ts:111
    src/server/workspace/state-transfer.ts:654
```

</details>

### Two ways the probe was wrong before it was right

Worth recording, because both failed in this project's own signature way.

It used to mutate the working tree and restore each file in a `finally` — which a
kill signal skips, so stopping a run left a `throw new Error('MUTANT')` behind in
`exec/git-bash.ts`. It now works on a copy under the temp dir with `node_modules`
symlinked, and the tree is never written to.

The first version of that copy took a hand-picked file list, and 14 test files read
`docs/`, `RELEASE_NOTES.md` and `.external/`. They failed for want of a file, so
every mutant came back "killed" and the run read as excellent news — a broken tool
reporting success, silently. It now runs the unmutated suite in the sandbox first and
refuses to probe unless it is green.

### A known sharp edge

The scanner reads a `// quiet:` preamble from the comment run directly above the
`.catch` **line**, not above the statement it belongs to. A multi-line statement
therefore needs the note adjacent to the `.catch` itself, or the value lifted into a
local first. Left as-is deliberately: a fuzzy statement-start heuristic could attach
a note to the wrong site, which is worse than an occasional small refactor.

## What the sweep found

Nine defects, none fixed: the sweep's rule was to add reporting and report bugs, not
to change behaviour. In rough order of what they cost.

**Read-fallback-then-write, which loses user data.** Five stores fall back to an empty
value when a read fails, and the same function then writes that value back. Corruption
is not the only trigger — atomic temp+rename makes torn files unlikely, but EACCES
after a permission change, EMFILE under fd pressure or EIO on a failing disk all land
in the same catch.

- `workspace/settings.ts:602` — `readSettings` returns all defaults, and every mutator
  writes it back: custom instructions, model overrides, retrieval and memory config,
  and local-provider API keys, replaced by defaults on the next settings change.
- `workspace/tasks.ts:71` — every scheduled task deleted on the next edit. Independently,
  a scheduler booting off an empty read schedules nothing and says nothing.
- `workspace/chats.ts:75` — folder tree, assignments, model-written subjects, naming
  schedules.
- `workspace/inbox.ts:112` — the read inside `update()` writes a store with
  `baseline: Date.now()`, wiping archived/snoozed/read for every thread.
- `workspace/connected-folders.ts:57` — an empty registry, then protected-roots
  republished from it.

**Two branches disagreeing about the same file.**

- `pi/mcp-config.ts:706` — `readMcpConfig` treats any read failure as "genuinely
  missing → fresh". Its own doc comment says the corrupt case must not read as empty,
  because `ensureMcpConfig` read-modify-writes and would persist that emptiness over
  every user-added server. An EACCES/EIO/EBUSY on a file that *is* there lands on
  exactly that path, with no `.corrupt` sibling written. `pi/models-config.ts:265` has
  the identical shape for local providers.
- `pi/runtime.ts:3338` — `ensurePiSettingsDefaults` sets `raw = null` for any read
  failure, so on EACCES it starts from `{}` and writes a fresh `settings.json`,
  destroying the hand-authored content the malformed-JSON branch six lines below
  exists to protect.

**A flag set outside the try it guards.**

- `recall/store.ts:1014` — the one-time `facts_fts` rebuild writes
  `facts_index_built = '1'` outside the try, so a rebuild that throws still marks the
  index built. Every fact predating the index stays unsearchable for the life of the
  store, and nothing retries. The trigram backfill directly below writes its flag
  inside the try; the two were plainly meant to match.

**A failure-derived verdict, memoized.**

- `recall/reconcile.ts:79` — `classifyRelation` returns `'compatible'` on any failure,
  and callers memoize it (`reconcile.ts:263`, `distill.ts:871`, `reconcile.ts:337`). A
  model outage writes "these two facts agree" into `fact_relation_checks`, and
  `isRelationChecked` then blocks the pair from ever being classified again once the
  model recovers.
- `recall/adjudicate.ts:103` — attempts are counted before the model call, so a model
  that is merely down burns all three on every conflict and drops them permanently to
  manual-only.

**A read failure that deletes the thing it failed to read.**

- `skills/ignore.ts:38` — `disabledSlugs()` returns `[]` on any readdir failure, and
  `syncSkillsIgnore` reads an empty list as "nothing to hide" and `rmSync`s the ignore
  file. One transient EACCES puts every disabled and curator-archived skill back in
  the backend's prompt, and nothing rebuilds the file until the next toggle.
- `skills/usage.ts:80` — a corrupt sidecar is not just lost history: `readUsage`
  returns a fresh value and the next tick writes it over the file, destroying every
  skill's counters and flattening the ranking blend across the library.

**Success reported for work that did not happen.**

- `recall/embed-import.ts:114` — `filesUnder` skipping a directory it cannot enumerate
  makes `copyModelFiles` copy a subset, and `importLocalModels` still returns
  `{ ok: true }` with a copied count. `missingModelFiles` validates the source before
  the copy; nothing re-checks the destination after. The model then dies at ONNX load
  time on the machine that had no way to fetch it.
- `workspace/state-transfer.ts:489` — `stateRootObstruction` treats a `recall.sqlite`
  it cannot open as "no evidence of use", so `importState` unpacks a second Stem over
  memory it merely failed to read — the merge the doc comment above it says there is
  deliberately no `--force` for.
- `pi/mcp-config.ts:684` — in `decryptServerSecrets` an `oauthClientSecret` that will
  not decrypt is deleted but never pushed onto `lost`, so the MCP tab's "lost a saved
  credential" line never appears for it. `headers` and `env` do it correctly two lines
  above.

## Two places the rule had to bend

Worth recording, because both are load-bearing and neither was in the plan.

`recall/search-core.ts` cannot call `degrade()` at all: its header forbids imports
past `node:sqlite` types, because it is bundled into `dist/main/recall-mcp-server.js`
and shared with the scan worker. It gained a sink instead — `setCoreDegradeSink`,
defaulting to silence, i.e. today's behaviour. `store.ts` installs `degrade` at import
(and every consumer imports `./store` before any leg can run); `mcp-server-main.ts`
installs its own. The scan worker installs nothing and keeps its silence.

`recall/mcp-server-main.ts` runs as a separate process. `degrade()` is importable
there, but `log.ts` rotates with stat+rename and two processes racing that is a real
hazard — so it reports to **stderr**, the only channel in that process that cannot
corrupt the JSON-RPC frame stream on stdout. `log.ts` and `host/index.ts` cannot use
`degrade()` either, for a plainer reason: `degrade` imports `log`, so it would be a
cycle. `host` uses `console.warn`, which is already its channel.

## What this does not fix

Silence is one of the three failure shapes behind the 0.4.x bugs, and the one that
mechanises best. The other two are still open:

- **Cross-module contracts on shared mutable state.** Nobody owned "a session file's
  mtime means the user did something". Wants an "this operation touched only what it
  claimed" snapshot helper, not a rule about catches.
- **Unexercised edge states in state machines.** The approval bug was four bugs —
  timeout × queued-behind × late answer × client-away — each one cell of a matrix
  nobody enumerated. Fake timers are already used in 13 test files; the seam exists,
  the enumeration does not.
