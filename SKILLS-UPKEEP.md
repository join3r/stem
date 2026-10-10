# Skills upkeep

Design record and implementation plan for the *upkeep* half of the skill system:
what happens to a skill after it is written. Written 2026-08-11 after tracing a
duplicate that appeared in the live library that morning, and re-reading Hermes
Agent (`.external/hermes-agent`) against what we actually built.

`SKILLS-REBUILD.md` covers authoring and retrieval, and those work. This document
covers the three mechanisms that were supposed to keep the library healthy over
time — patch-on-use, the curator, and lifecycle — and finds that the first has
never run, the second is calibrated to the opposite posture from the one we took
it from, and the third does not exist.

Revised the same day after an adversarial source-check of the first draft found
two high-severity flaws in its plan: the routing fallback mis-targeted patches
(step 1), and the grading and lifecycle steps interacted into library-wide
auto-archival (steps 2 and 4). What follows is the corrected design; where a
flaw changed a decision, the flaw is recorded in place.

## Why

### The turn that started this

2026-08-11 07:40, Stem thread *"Check this video …gaDdrDdczO4"*. The user asked
for a video summary. The turn:

1. Called `fetch_content`, which failed with the Google/`GEMINI_API_KEY` error.
2. Rebuilt a yt-dlp caption pipeline from scratch, hitting the relative-path
   `ENOENT` trap on the way.
3. At 09:42:27 saved a **new** skill, `extract-youtube-video-details`, with the
   video id `gaDdrDdczO4` hardcoded into steps 1 and 2.

The procedure it rebuilt was already on disk as `extract-youtube-transcript`,
including the `ENOENT` trap as its step 2. That skill was in the library, was
ranked, and lost — it appears in the turn's `<stem_skills>` block under *"Other
saved skills (names only, steps not loaded)"*.

Every stage behaved as written. That is what makes it worth a design record.

### Four mechanisms, measured against that turn

| mechanism | what it did | verdict |
| --- | --- | --- |
| retrieval | inlined `analyze-youtube-without-transcript` + `identify-youtube-trailer-music`; demoted the right one to a name | working as specified, wrong answer |
| write-time dedup | ran, scored **0.824** against `SKILL_DUP_COSINE = 0.94`, passed the draft | working as specified |
| patch-on-use routing | did not run | **never runs — see below** |
| curator | had not run since 08:03, ~99 min before the duplicate existed | cadence |

Pressing **Tidy up** manually at 10:30 merged the pair correctly: the winner went
to v3, absorbed the duplicate's metadata/chapters steps, and the hardcoded video
id became `VIDEO_URL`. It left `analyze-youtube-without-transcript` and
`identify-youtube-trailer-music` alone, which is right — those are genuinely
different procedures. So the curator's *judgment* on a clear pair is fine. Its
reach is the problem.

### Defect 1 — `turn.skillsUsed` is dead

`SKILLS-REBUILD.md` specifies: *"Routing | `turn.skillsUsed.size > 0` → patch
that skill; otherwise create."* `settle.ts:57` implements exactly that.

Nothing in `src/` ever writes `skillsUsed`:

| site | operation |
| --- | --- |
| `pi/normalize.ts:83` | declares `skillsUsed?: Set<string>` on `TurnContext` |
| `pi/normalize.ts:170` | copies it into the snapshot, `?? []` |
| `skills/settle.ts:57` | reads it to route create-vs-patch |
| `startup/skills.ts:129` | reads it for the `/learn` path |

The only assignments in the repository are in `tests/unit/skills-settle.test.ts`
and `tests/unit/turn-trace.test.ts`, which set the field by hand. The tests pass
against a field the pipeline never fills.

The cause is in our own change log. `skillsUsed` was fed by watching for a read
inside a skill's folder, and the rebuild removed that: *"`skillSlugForPath` and
`SKILL_CONSULT_TOOLS` are deleted… the signal is gone by construction, not by
choice."* `skillsInjected` was introduced to replace it — its doc comment at
`normalize.ts:85-89` says it is *"what routes authoring to PATCH the skill that
was already loaded rather than adding a near-duplicate beside it"* — but
`settle.ts` was never repointed at it.

Consequences, both of which the user reported independently before this was
found:

- **Every end-of-turn authoring is a create.** The mechanism specified to prevent
  near-duplicates has never executed.
- **Skills are never improved after they are written.** Patch-on-use is the owner
  of body edits — the curator gave up rewriting precisely because patch-on-use
  had it (*"Body edits belong to patch-on-use, which knows what actually
  failed"*). Neither one is doing it.

The live `manage_skill` tool can still patch when the model names a target with
`expect_existing`. That is how `extract-youtube-transcript` reached v2 on 08-10.
It is the model volunteering, which is the behaviour class the rebuild was
designed not to depend on.

### Defect 2 — the curator is calibrated against Hermes' posture, inverted

Both systems run a periodic LLM curator over agent-authored skills. The prompts
are opposites.

Hermes, `agent/curator.py:365`:

> "This is an **UMBRELLA-BUILDING consolidation pass**, not a passive audit and
> **not a duplicate-finder**. … A collection of hundreds of narrow skills where
> each one captures one session's specific bug is a **FAILURE** of the library —
> not a feature."
>
> "DO NOT reject consolidation on the grounds that 'each skill has a distinct
> trigger'. **Pairwise distinctness is the wrong bar.** The right bar is: 'would a
> human maintainer write this as N separate skills, or as one skill with N
> labeled subsections?'"
>
> "**Iterate.** After one consolidation round, scan the remaining set and look for
> the NEXT umbrella opportunity. **Don't stop after 3 merges.**"

Stem, `skills/curate.ts:70-71`:

> "**DEFAULT TO KEEP.** Only act on skills you are confident are duplicates or
> superseded. If unsure, leave a skill out of both lists."
>
> "merge: combine skills that cover the **SAME task**."

They also disagree on usage counters. Hermes: *"DO NOT use usage counters as a
reason to skip consolidation. … 'use=0' is not evidence a skill is valuable; it's
absence of evidence either way."* Stem: *"Usage counts are advisory, never
decisive on their own."*

We took the shape — periodic pass, merge + archive, no blind rewrites, KEEP by
default, a drop-fraction guard — and inverted the bar. "Same task" is a much
higher bar than "would a maintainer write one skill with subsections", and it is
why the library needed four YouTube skills before two of them merged.

One asymmetry worth naming: in Hermes the LLM consolidation pass is **off by
default** (`DEFAULT_CONSOLIDATE = False`), because the deterministic prune carries
the routine load. In Stem the LLM pass is the only mechanism there is.

### Defect 3 — nothing retires a one-time skill

Some procedures are worth keeping (`extract-youtube-transcript` — every video
from now on). Some are a transcript of one afternoon
(`add-hydrawise-dashboard-view`, `identify-personal-dev-host-from-loki`). Nothing
in Stem distinguishes them, at authoring time or afterwards.

Hermes has three defences and Stem has none of them:

1. **A deterministic clock.** `apply_automatic_transitions()`: unused >
   `stale_after_days` (default **30**) → `stale`; unused > `archive_after_days`
   (default **90**) → moved to `.archive/`. No model call. Runs whenever the
   curator is enabled, independent of the opt-in consolidation pass. A one-time
   skill retires itself by doing nothing.
2. **The umbrella prompt**, which explicitly hunts *"skills whose NAME is too
   narrow (contains a PR number, a feature codename, a specific error string, an
   'audit' / 'diagnosis' / 'salvage' session artifact)"* — a precise description
   of `add-hydrawise-dashboard-view`.
3. **Demotion to `references/` / `templates/` / `scripts/`** — narrow-but-valuable
   content survives as a support file under a broader skill instead of as a
   top-level entry.

Stem's state today: no automatic transitions of any kind, and archiving happens
only if the KEEP-by-default model volunteers it. It never has. There is not one
`.disabled` marker in the skills directory since tracking began 2026-08-03.

Defence 3 is structurally unavailable to us: multi-file skills were ruled out
because pi runs with `--exclude-tools bash` and bodies are inlined under a 4 KB
cap. That call stands. It does mean session-specific detail has nowhere to live
except its own top-level skill, which raises the stakes on 1 and 2.

### Where Stem legitimately differs from Hermes

Not every divergence is a defect, and the plan below should not erase these.

| | Hermes | Stem |
| --- | --- | --- |
| automatic authoring | `spawn_background_review` forks a whole agent that replays the conversation with the skill + memory tools whitelisted | deterministic ≥5-tool-call gate, then a one-shot `authorSkill()` fed a serialized trace |
| create-vs-patch | the fork decides for itself, having browsed the library | decided by `decideSettle` *before* the model sees anything |
| delivery | system-prompt index; the model `read`s a SKILL.md when it matches | top-2 bodies inlined per turn, rest indexed by name |
| curator cadence | inactivity-triggered, 7 days, 2 h idle | 90 s after startup, then every 24 h |

Stem's shape is cheaper and does not depend on the model volunteering a tool
call, which the backtest showed happening twice in 225 sessions. Keep it. But it
means Stem's author cannot discover "this already exists" on its own — which is
why the dead routing field costs us far more than the same bug would cost Hermes.

## Current library

12 skills, all `source: agent`, ~30 KB total, tracking since 2026-08-03. Usage
sidecar holds entries for 5 of them; the rest have never been inlined, so they
have no record at all and therefore no clock to start from. The twelfth —
`selectively-install-skills-package`, created 2026-08-11 08:54 while this
document was being drafted — is itself a settle-pass create, one more data point
for defect 1.

| skill | injected | used | shape |
| --- | --- | --- | --- |
| extract-youtube-transcript | 2 | 1 | recurring |
| analyze-youtube-without-transcript | 4 | 0 | recurring |
| identify-youtube-trailer-music | 3 | 2 | recurring |
| selectively-install-skills-package | — | — | one-off |
| transcribe-media-with-superwhisper | 1 | 0 | recurring |
| identify-personal-dev-host-from-loki | 1 | 0 | one-off |
| extract-tiktok-transcript | — | — | recurring |
| extract-bistro-menu-data | — | — | recurring |
| fastmail-search-sender-by-domain | — | — | recurring |
| find-prior-request-email | — | — | one-off? |
| add-hydrawise-dashboard-view | — | — | one-off |
| slovak-disability-parking-and-pension | — | — | one-off |

`identify-youtube-trailer-music` shows used 2 / injected 3 — a Laplace-smoothed
rate of 0.6, a small standing boost on the blend — and one of its two credits is
false. It was credited on
the 08-11 video turn because `grade.ts` counts a skill as used when the turn calls
a tool its `## Steps` names, and its step 7 mentions `fetch_content`, which the
turn called for an unrelated reason. Nearly every skill names `run_command` or
`fetch_content`; nearly every gated turn calls one. The proxy degenerates toward
"did the turn use a tool at all".

## What we decided

| area | decision |
| --- | --- |
| Routing input | patch fires only on the **graded-used** set (affirmative evidence); with none, the author sees the inlined bodies plus the full name+description index and chooses create-vs-patch itself; `skillsUsed` is deleted, not repaired |
| Grading precision | generic tools (`run_command`, `fetch_content`, `web_search`, `get_search_content`) stop earning use credit; distinctive Steps tokens matched against tool *arguments* keep the library gradeable |
| Curator posture | rewrite `INSTRUCTIONS` toward the umbrella bar; keep KEEP-by-default for *archive*, drop it for *merge* |
| Curator reach | keep merge + archive; still no blind body rewrites |
| Lifecycle | a deterministic archive clock, no model call, anchored on `max(created, updated, lastUsedAt)` and run outside the curator's own gates |
| Archive mechanism | the existing `.disabled` marker + `syncSkillsIgnore()`; reversible, already wired to the UI toggle |
| Curator trigger | add a debounced run after a skill is created; keep the 24 h interval |
| Create dedup | keep the 0.94 name+description gate; add a body-similarity check for creates as the routing backstop |
| Silent failures | `applyCurate` logs a skipped merge; the manual button already reports counts (`fb1b193`) |
| Not doing | multi-file skills, `references/`/`scripts/` demotion, raising the 4 KB body cap, an LLM judge per turn |

### Rationale for the less obvious ones

**Patch only on graded-used; the author chooses everything else.** Two signals
exist at settle time. `skillsInjected` is what we put in front of the model; the
graded set is the subset the turn showed evidence of following. Grading already
runs before the snapshot is taken (`runtime.ts:2131`, snapshot at `:2143`), so
both are available at no extra cost. Only the graded set is an *affirmative*
signal — injection is the top-2 of a cosine ranking, not a consult. The first
draft of this plan fell back to the inlined set, and the 08-11 turn is the
counterexample: the inlined pair was `analyze-youtube-without-transcript` and
`identify-youtube-trailer-music`, the right target was name-only, and
`authorSkill` force-renames a draft to its routed target (`author.ts:180`) — so
the fallback would have either suppressed the write or patched an unrelated
skill. Instead, when nothing was graded used, the author is shown the inlined
bodies *and the full name+description index* and decides for itself: create, or
name an existing target. A target it knows only from the index triggers one
second authoring shot with that skill's body loaded — the existing patch path,
entered late. That is the path that actually resolves 08-11:
`extract-youtube-transcript` was in the index.

**Delete `skillsUsed` rather than fix it.** Its doc comment describes a detection
mechanism that no longer exists. Repairing the field means re-inventing a
consult signal that inlining removed by construction. Two fields for one concept,
one of them permanently empty, is how this bug survived a test suite.

**KEEP-by-default splits.** The two operations have opposite costs. A wrong merge
is recoverable — content is preserved in the winner, and the loser's steps are in
git-less but versioned SKILL.md history via `version`/`updated`. A wrong archive
is a skill that silently stops being retrievable. So merge gets the aggressive
Hermes bar; archive keeps the cautious posture, and the deterministic clock takes
over the routine retirements the LLM was never going to volunteer.

**The clock anchors on `lastUsedAt ?? created`.** `SkillRecord` already carries
`created` and `updated` (`store.ts:45-46`), so a skill with no usage entry still
has an anchor and we avoid a migration that seeds records for the six skills that
have none. This mirrors Hermes' "derived activity timestamp" without needing
Hermes' `seed_record_if_missing`.

**Curate after a create, debounced.** The 08-11 duplicate lived for 49 minutes
before the user noticed and pressed the button, and would have lived ~22 hours
otherwise. A duplicate is only ever introduced by a write, so that is the event
worth reacting to. Debounced and idle-gated so a burst of writes costs one pass.

**Not raising the 4 KB cap.** See "Open questions" — this is the one decision in
the table that has a real argument against it.

## Plan — ordered by dependency

### 1. Routing (`skills/settle.ts`, `skills/author.ts`, `pi/normalize.ts`, `pi/runtime.ts`, `startup/skills.ts`)

- `TurnContext`: drop `skillsUsed`. Add `skillsGradedUsed?: string[]`, written
  where grading already runs (`runtime.ts:2131`) from the `gradeSkillUse` result.
- `SettledTurnTrace`: replace `skillsUsed: string[]` with `skillsInjected:
  string[]` (slugs) and `skillsGradedUsed: string[]`, both populated by
  `snapshotTurnTrace`.
- `decideSettle`: `existing` comes from `skillsGradedUsed` only — the first slug
  that still resolves via `readSkillRecord`. No fallback to the inlined set (see
  the rationale above; the first draft's fallback mis-targeted).
- `authorSkill`, create path: alongside the trace it now receives the inlined
  skills (name, description, body) and the whole library's name+description
  index. Its contract gains a third outcome besides draft-and-decline: *target
  an existing skill by slug*. A target whose body the author already saw is
  authored as a patch in the same shot; a target it knows only from the index
  triggers one second shot with that body loaded — the existing patch path,
  entered late. The force-rename stays, but only on the patch path where it is
  correct by construction.
- `settleSkills` and `learnFromLastTurn` (`startup/skills.ts:129`) both route
  through the same resolution; bridge writes for targets use `expect_existing`
  so a skill that vanished mid-flight degrades to a refusal, not a create.
- Tests: `skills-settle.test.ts` **and `turn-trace.test.ts`** both hand-set
  `skillsUsed` today and will break; update them to the new fields. Add an
  integration-level test that drives a real `TurnContext` through
  `snapshotTurnTrace` and asserts the routing fields carry through. **The
  absence of that test is why defect 1 shipped**; a unit test over a pure
  function cannot catch a field nobody fills. Author tests cover: picks an
  inlined target, picks an index target (second shot), declines, creates fresh.

### 2. Grading precision (`skills/grade.ts`)

- Add a `GENERIC_TOOLS` set: `run_command`, `fetch_content`, `web_search`,
  `get_search_content`. `toolsNamedIn` excludes them. (`read` and `write` are
  not in the set: the token regex requires a separator and ≥5 chars, so they can
  never match — the first draft listed them, a dead letter.)
- Excluding generic tools alone would make the *entire current library*
  ungradeable — a source-check found `fetch_content` and `get_search_content`
  are the only real tool names any live skill's Steps mention. So grading gains
  a second signal with actual precision: distinctive Steps tokens (same regex,
  minus the generic set) matched against the *arguments* of the turn's tool
  calls. A skill that says `yt-dlp --skip-download` is credited when a
  `run_command` this turn actually ran `yt-dlp` — that is following the skill,
  and it is not satisfiable by calling any tool for any reason.
- A skill whose Steps yield no distinctive tokens at all stays ungradeable and
  ranks neutral. Correct: there is no evidence to be had.
- Tests: the 08-11 case — the trailer-music body against a trace that called
  `fetch_content` and `run_command` for unrelated reasons must grade unused; a
  trace whose `run_command` args contain `yt-dlp` must credit the transcript
  skill.

### 3. Curator posture (`skills/curate.ts`)

Rewrite `INSTRUCTIONS`, keeping the JSON contract, the slug whitelist, and
`clampCurate` untouched:

- Merge bar becomes: *would a maintainer write these as N skills, or one skill
  with N labeled subsections?* Explicitly reject pairwise-distinctness as the
  test. Explicitly instruct it to look for clusters by domain keyword, and to
  iterate rather than stopping at the first merge.
- Keep "do not improve or reword a body you are keeping" — that boundary is ours
  and it is right; patch-on-use owns body edits and, after step 1, will actually
  be running.
- Keep DEFAULT TO KEEP for `archive` only, and say so explicitly rather than
  leaving one posture governing both lists.
- Usage counts: adopt Hermes' framing — absence of evidence, not evidence of
  absence — since after step 2 more skills will be legitimately ungradeable.
- `applyCurate`: `console.warn` the slug and violations when `saveSkill` rejects a
  merged body, instead of `continue`. Today a rejected merge is indistinguishable
  from "nothing to merge", and after `fb1b193` it reports the more confident lie
  *"No duplicate or stale skills found"*.

### 4. Lifecycle clock (new `skills/lifecycle.ts`)

- `deriveActivity(record, usage)` → `max(created, updated, lastUsedAt)`,
  treating the sidecar's `''` placeholder as missing. `updated` counts because a
  patch is evidence of live use — Hermes agrees: its anchor is
  max(last_used_at, last_viewed_at, last_patched_at) (`skill_usage.py:146-163`).
  The first draft's `lastUsedAt ?? created` would have put the whole library on
  a fixed fuse once step 2 landed: grading credits get rarer, `lastUsedAt`
  freezes, and everything ages out at once — while actively followed.
- `applyAutomaticTransitions()`: agent-authored, non-disabled skills only. Past
  `ARCHIVE_AFTER_DAYS = 90` → write `.disabled` + one `syncSkillsIgnore()` for
  the batch. Pure decision function over `(records, usage, now)`, thin IO
  around it.
- Runs in the curator *wrapper* (`startup/recall-tasks.ts` and the manual
  handler in `ipc/workspace.ts`), **before and outside** `curateSkills`' own
  gates — `isRecallEnabled`, `MIN_SKILLS`, the prompt budget. Hermes runs its
  transitions unconditionally whenever the curator feature is on; a lifecycle
  that dies with recall-off or a small library is not a lifecycle.
- Report the count through `CurateResult` (a new `expired` field) so the Manage
  panel and the activity row say what happened. An auto-archived skill shows as
  disabled in Manage, where the existing toggle un-archives it — but note there
  is no *automatic* reactivation: disabled skills are excluded from retrieval
  entirely, so unlike Hermes (which reactivates on renewed activity) an archive
  here is permanent until a human notices. One more reason the cutoff stays
  long.
- No `stale` state in v1 — see "Open questions".

### 5. Curate-on-create (`skills/bridge.ts`'s caller)

- After a successful create (not an update), schedule a debounced curator pass,
  ~10 min, coalescing repeats, skipped if one is already running or the app is
  busy. Guard on **both** the `curating` flag in `startup/recall-tasks.ts` and
  the settle pass in `startup/skills.ts`: a curator merge can delete the very
  skill a concurrent settle pass is about to patch — the write fails cleanly
  (`expectExisting` on a missing slug refuses) but silently, and after step 1
  patches are the primary write path.

### 6. Body-aware create dedup (`skills/dedup.ts`)

- The routing fix resolves 08-11 only when the author recognizes the index
  entry. When it doesn't, the last line of defence is the write-time check, and
  the 08-11 pair scored 0.824 against a 0.94 gate computed over
  name+description — two framings of the same procedure sail through. For
  creates only, add a second check over the two bodies' `## Steps` text: same
  embedder, separate threshold (`SKILL_BODY_DUP_COSINE`, initial 0.93),
  computed on the fly — creates are rare enough that skipping the sidecar cache
  is fine.
- On a hit the bridge answers exactly as today: name the existing slug,
  instruct `expect_existing`. `console.warn` near-misses (within 0.03 below the
  gate) so the threshold gets calibrated on evidence rather than argument.
- Best-effort like the existing check: no embeddings → no block.

## Open questions

**1. The 4 KB body cap versus umbrella skills.** Hermes' umbrellas are ~200 lines
with `references/` beneath them. Ours are capped at 4,096 bytes — roughly 60
lines — with no support files, because pi has no shell and bodies are inlined.
Push the curator toward umbrellas and it will hit that ceiling on the third
merge; `saveSkill` will reject the body and (until step 3's `console.warn`) the
merge will vanish silently. Options: (a) accept narrower umbrellas and let the
cap be the real bar, (b) raise the cap for curator-written merges only, (c) raise
it generally and cut `MAX_INLINED_SKILLS` from 2 to 1 to hold the token budget
flat. **Recommendation: (a) for this release, and instrument it** — step 3's
warning tells us empirically how often the cap is what stops a merge, which is a
better basis for changing an inlining budget than an argument.

**2. Stale-before-archive, or straight to archive?** Hermes has three states;
`stale` mainly drives reporting. Stem has one boolean the UI already renders.
**Recommendation: skip `stale` in v1.** Add it only if the archive cutoff turns
out to need a warning shot.

**3. The cutoffs.** Hermes ships 30/90 days. Our library is 8 days old and the
oldest skill is from 2026-08-03, so 90 days means nothing archives until
November. **Recommendation: ship 90 anyway.** A cutoff that fires before we have
enough usage history is a cutoff that archives skills for having been unlucky. If
that feels too slow, the honest lever is the curator's judgment (step 3), not a
shorter clock.

**4. Should authoring judge reusability at all?** Everything above retires a
one-time skill *after* the fact. The alternative is asking `authorSkill()` to
refuse — "would this recur for this user?" — at write time. Hermes does not do
this; `/learn` writes what the user pointed at. **Recommendation: no.** The model
cannot know whether the user will buy a second irrigation controller, the gate is
already deterministic and cheap, and a false refusal is invisible while a false
save is visible in Manage and retires itself on the clock.

**5. Does `SKILL_DUP_COSINE = 0.94` survive step 1?** The first draft said
"change nothing until a duplicate survives step 1", resting on the claim that
the 08-11 draft would have been a patch. The source-check broke that premise:
with routing on evidence only, the 08-11 turn still authors a create unless the
model recognizes the index entry. So the name+description gate keeps its 0.94,
and step 6 adds the body check as the actual backstop. **Recommendation: revisit
both thresholds when the near-miss log has data, not before.**

## Not in scope

- Retrieval ranking. `MAX_INLINED_SKILLS = 2` put the wrong two skills in front
  of the model on 08-11, and a bare URL is a weak query. Real, but separate: a
  fixed router changes what gets *loaded*, and this document is about what
  happens to what gets *written*. Worth its own pass with
  `scripts/skill-retrieval-eval.mjs` as the gate.
- The authoring prompt and the 4 KB contract.
- Anything touching `source: user` skills.

## Reference

Hermes Agent, `.external/hermes-agent` (gitignored, sparse):

- `agent/curator.py` — `CURATOR_REVIEW_PROMPT` at :365 (the umbrella prompt),
  `apply_automatic_transitions()` at :276, defaults at :56-64.
- `tools/skill_usage.py` — the active/stale/archived lifecycle and its sidecar.
- `agent/background_review.py` — the post-turn fork, for contrast with
  `skills/settle.ts`.
- `agent/learn_prompt.py` — `_AUTHORING_STANDARDS`.

Stem, this repo:

- `SKILLS-REBUILD.md` — the authoring/retrieval design this one extends.
- Commit `fb1b193` — "Tidy up" now reports its counts and appears in background
  activity; a prerequisite for trusting anything measured below.

## Addendum 2026-09-14 — the deviation report is read back

Every mechanism above grades a skill by proxy: tool overlap for use, a clock for
retirement. The one outcome signal that costs nothing was already being produced
and thrown away. `formatSkillsBlock` tells the model to *say so plainly* when a
loaded step is wrong, so a bad auto-saved skill becomes visible to the user, and
the rebuild record says that report "is also what routes the skill into
patch-on-use." It never did — nothing parsed the reply.

Now the block asks for that sentence on its own line, `Skill issue [<name>]:
<why>`, and `reportedSkillIssues` (grade.ts) reads it off `assistantText` at
settle. Only inlined slugs are accepted, so a name-only or invented skill cannot
be reported. What a report does:

- **Grading.** A reported skill is removed from the graded-used set before
  `recordGrades`, so the ranking rate sees the turn as injected-not-used. The
  rate formula is unchanged; a failure is a miss the model vouched for.
- **Ledger.** `failed` and `lastFailure {at, reason}` on the usage entry, summed
  through merges like the other counters. The Manage panel shows "reported wrong
  N×" with the last reason as a tooltip; the curator prompt sees the same line,
  the one piece of usage data that is evidence about content.
- **Routing.** `routeReported` (settle.ts) patches the reported skill ahead of
  the graded-used route and below the tool-call gate — a skill that misled the
  model is something that happened, however few tools it took. Restraint reasons
  (`tainted`, `scheduled`, `mode-off`) still win. The reason reaches
  `authorSkill` as `issue`, so the patch is told what was wrong instead of
  inferring it from the trace. `/learn` resolves through the same helper.

Not done: a second model call to judge outcome, and the counterfactual ("would
the turn have been shorter without the skill"), which cannot be known from one
run. `scripts/skill-author-eval.mjs` is where a with/without replay would live if
the shipped mechanism needs validating against real replies.

## Addendum 2026-10-10 — one skill, one job (Defect 2 reversed)

The umbrella posture above was wrong for Stem, and the "Where Stem legitimately
differs" table already held the reason: Hermes lets the model read an index and
open the file it wants, while Stem ranks the user's message against each skill's
one-sentence description and inlines only the winners. An umbrella has to describe
four jobs in 160 characters, so it matches each of them weakly and unrelated
messages strongly. The 2026-10 selection audits (wrong skills loaded, right
skills missed) traced back to four umbrellas on the server:
`trace-podcast-study-methodology` ("trace claims, provenance, earliest evidence,
or audience membership across studies, images, Slack, and authenticated
applications"), `agent-browser-vercel`, `upgrade-unraid-container-with-pinned-image`,
`assess-postgresql-primary-headroom-grafana`. The cost of a wrong merge is not
"recoverable, the content is still there": the content is there, but nothing
retrieves it. Hermes' own umbrella pass is off by default, and its practitioners
report the same blurring. Published results agree on the mechanism: selection
accuracy falls with confusability between skills rather than with library size
(arXiv 2601.04748), and focused skills beat comprehensive ones (arXiv 2602.12670).
Mem0 v3 dropped write-time UPDATE/DELETE merging altogether.

What changed (`skills/curate.ts`, `skills/contract.ts`):

- **Split.** A changed skill with two or more `###` parts under Steps, or a
  description not opening "Use when", gets a one-skill review: one job, or
  several filed together? A split moves steps verbatim into 2–4 standalone
  skills; the first keeps the slug and the usage history, the rest carry the
  original `origin`. One retry with the rejection reason, then left whole.
- **Merge only duplicates.** The bar is "would someone in one skill's situation
  follow the other's steps from start to finish", never shared tool or domain.
- **Small groups, changed skills only.** Each changed skill is reviewed with its
  ≤3 nearest neighbours above cosine 0.7 (name+description vectors; on the
  server's library the median pair is 0.64 and the closest 0.755). The whole-
  library prompt timed out every run from 2026-10-08. `.skills-curated.json`
  holds the hash each skill was last reviewed at, so a quiet library costs no
  model call; Tidy up (`force`) reviews everything.
- **Provenance.** Only Stem's own ideas are reshaped: `assistant`/`turn` (Auto
  mode) and the new `approved` (Stem proposed it on a card, the user accepted).
  The user's own — `user-requested` (asked in chat), the new `imported`
  (`manage_skill` with `initiated_by: "import"`: an existing skill installed as
  it is), `learn`, `recorded` — are never split, merged, archived or
  re-described, and appear READ-ONLY in merge groups so a Stem-written duplicate
  can be archived in their favour (Hermes likewise curates only agent-created
  skills). Card approvals used to be stored as `user-requested`, which hid 20 of
  the server's 22 "user-requested" skills from this rule; a one-time relabel
  fixed the server (session history: only `query-cloudfarms-postgres` was asked
  for, and `agent-browser-vercel` was an import the umbrella curator had merged
  three Stem skills into, split back out by hand). The review hash covers the
  origin, so a relabel is reviewed on the next pass.
- **Backups.** Every skill a pass rewrites or deletes is copied first to
  `.curator-history/<run>/<slug>.md`; ten runs are kept.
- **Description rule.** Model-written descriptions must open "Use when" and name
  one situation (`validateSkill(draft, { authored: true })`): five of the six
  multi-job skills opened "Use to …"/"Use for …", no single-job one did. Text a
  person typed (approval card, recording card) is not held to it.

Not done, from the same research: synthetic queries per skill as extra index
text and as a confusability regression test after each split/merge (Re-Invoke,
arXiv 2408.01875); admission by verified re-run (ASI).

### Imports and older libraries (same day)

- **Imports are never edited automatically.** The end-of-turn pass skips a turn
  that followed or reported an `imported` skill (no patch, no near-duplicate
  beside it), and an auto-mode edit to one becomes an approval card. A wrong
  step in an import is for its upstream to fix, or for the user to ask about.
- **Provenance migration** (`skills/provenance.ts`, once per install, before the
  curator). Older Stems stored card approvals as `user-requested` and could not
  tell an import from an ask, and the old curator merged Stem skills into the
  user's own. The sessions' `manage_skill` saves are the evidence: only Stem
  saved it (or no save at all, where the sessions reach back past its creation)
  → `approved`; the user saved text that was pasted or fetched, or a skill file
  arrived that turn → `imported`; no evidence → the label stays. A locked skill
  that drifted from the user's last save gets one model call that moves other
  jobs out as `approved` skills; an import is restored to what was installed.
  Backups in `.curator-history/<run>-relabel`; marker `.skills-provenance.json`.
