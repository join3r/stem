# Agent swarm design

Status: decided 2026-10-08. Phases 1–3 built; phase 4 not started. Replaces the persona-to-persona model
from the August mail work (helpers made with `save_persona`, Orchestrator as a
separate coordinator, the own-helpers exception).

## Goal

Several agents with different responsibilities work on one request and the
user gets one better answer: evidence gathering, independent checking, a blind
contrarian, and Claude Code doing the coding with a second model reviewing it.

## What the field converged on

Claude Code sub-agents, Codex multi-agent v2 and Grok 4.20 / Heavy all use the
same shape:

1. One lead owns the user and the final answer.
2. Roles are reusable definitions (prompt, model, tools, sandbox). A job
   spawns named instances of a role; instances end with the job.
3. An instance starts from a brief, not the lead's history.
4. The lead coordinates. Peer messaging exists but is optional, and every
   system caps depth (3) and concurrency, and never lets a child escalate.
5. Checking works when the checker has something the author lacked: search
   results, code execution, no knowledge of who wrote it, or a different
   model. Same-model debate rounds add little over independent attempts.

Stem's mistake was using a persona as both the role and the instance, so a
second reviewer meant a second permanent persona. That produced the junk
personas, the "which reviewer am I" confusion and the exchange-cap pressure.

## Concepts

- **Role** = a persona row. User-curated in the Personas tab. Holds prompt,
  model, effort, capabilities (harness pin, MCP allowlist, recall, memory,
  clients). Agents can no longer create or edit roles.
- **Agent** = an instance of a role inside one conversation, with its own
  name and its own pi session. Id `<roleId>~<name>`, for example
  `critic~reviewer-a`. Stored on the conversation, never in personas.json.
  Resolved by the router to the role's fields plus the instance name. Ends
  when the conversation is deleted; it never appears in the persona list.
- **Lead** = the conversation's driver (participants[0]). It alone talks to
  the user, as today.

## Tools

- `spawn_agent({ role, name, brief, blind? })` — lead only (and agents whose
  role has `canSpawn`, one level down). Several calls in one turn form a join
  and the lead gets one assembly turn, reusing the existing join code.
  `blind: true` forces recall off and the blind preamble regardless of role.
- `send_mail` to an agent name continues it (same session, keeps its work).
- Agents report to whoever spawned them. No sibling messaging.
- Removed from agents: `save_persona`, `delete_persona`, `add_persona`.
  An agent that thinks a new role is worth keeping says so in its reply; the
  user creates it in the editor.

Limits: depth 2 (lead → agent → sub-agent), at most 6 live agents per
conversation, the exchange cap stays as the runaway valve and each spawn
counts once: an agent's report to its starter is free, because the brief or
follow-up that asked for it already paid.

A spawner's preamble lists the roles it may start (every persona not pinned
to the user's computer, plus pinned ones the user added), each with its model
and whether it runs without recall, so the lead never guesses names and can
pick roles on different models.

## Roles shipped

| Role | Job | Defaults |
| --- | --- | --- |
| Normal (lead) | Answers, decides whether to spawn, synthesizes | `canSpawn`, recall on |
| Verifier | Evidence: searches and checks factual claims | recall on, web tools |
| Critic | Blind contrarian: finds what is wrong or missing | recall off, memory off, blind; the user gives it a different model family from the lead (not auto-picked: the seed cannot know which sign-ins exist) |
| Code personas | Claude Code on a pinned device and folder, relay only | as today |
| Code reviewer | Codex (or Claude Code) harness pinned **Review only**, same folder as the code persona | the user makes it in the editor; no seed, since only the user knows the folder |

Orchestrator is retired: its fan-out knowledge moves into the lead's recipes.
Secretary keeps spawn rights: the junk it made came from permanent helper
personas, which conversation-scoped agents end, and its triage prompt
delegates with spawn_agent.

## Recipes (in the spawning instructions, chosen per request)

They ride the preamble of every persona that may start agents, not Normal's
prompt, so a user who rewrites Normal keeps them.

- **Direct** — answer alone. Default for chat-like asks.
- **Checked** — Verifier checks the claims before the lead replies.
- **Council** (Grok 4.20 shape) — in parallel: Verifier instances gather
  evidence, a blind Critic attacks the draft; lead synthesizes, at most one
  revision round.
- **Independent attempts** (Grok Heavy shape) — 2–3 agents on different
  models solve it separately; the lead compares and keeps the best reasoning,
  not the majority.
- **Code** — code persona implements; Code reviewer (Codex) reviews the diff
  blind; findings go back to the code persona once; one report to the user.

## Memory

Unchanged by this design: global recall for user facts, role notes for
editor-made roles, Claude Code's own repo memory. Agents never write memory
and never reflect. The lead puts relevant cross-project knowledge into
briefs; blind agents get none. Project-scoped memory is a separate track.

## Migration

- personas.json v5 (phase 1): `canManagePersonas` is renamed `canSpawn` (kept
  on Secretary and Orchestrator) and Normal gains it; Secretary/Orchestrator
  prompts still matching an old seed are refreshed to the spawn_agent text;
  rows with `createdBy` set are dropped (they kept no memory, and their work
  is in mail).
- personas.json v6 (phase 2) retires Orchestrator: removed if its prompt
  still matches a seed, otherwise kept as the user's own (no longer built in).
- The own-helpers exception and the staffers hint in the router and preamble
  are gone (phase 1).

## Phases

1. Agents: instance ids, resolver, `spawn_agent`, preamble identity, Work
   view shows agents, remove persona-management ops, v5 migration.
2. Lead + recipes: role list and recipes in the spawning preamble, agent
   reports free against the exchange cap, Orchestrator retired.
3. Code loop: `PersonaHarnessPin.reviewOnly` (Codex `read-only` mode,
   Claude Code `default` mode; Stem answers every ask itself: built-in
   read-only commands inside the folder run, everything else is refused, never
   a card; a device must ack the flag or the run is refused), Code recipe when
   both a writing and a reviewing role are startable, and no background facts
   for a recall-off persona's coding agent.
4. Measure: run real past requests (Gemma benchmark, CFK-1723, two research
   asks) Direct vs Council/Code, judged blind; tune recipes only on that.
