# Coding harness control

An implementation record, not user documentation. It is deliberately not linked
from [the Stem guide](README.md). Shipped 2026-08-21 across eight commits; the
planning interview and spike that shaped it ran 2026-08-20/21.

## The problem

Stem's assistant could schedule tasks, run commands, and manage MCP servers,
but it could not delegate real coding work. When the user says "build this
feature in my project", the honest options were pasting file contents through
`run_command` or refusing. Meanwhile a coding harness (Claude Code, OpenCode)
is already installed on the user's machines and already good at exactly this.

## The shape of the answer

Stem drives an external coding harness as an ACP client, through the embedded
`acpx/runtime` (`acpx@0.13.1`, exact pin; OpenClaw's ACP layer over
`@agentclientprotocol/sdk`). The ACP route was chosen over per-harness
stream-json drivers so users who do not run Claude Code are covered by the same
code: any agent acpx's registry can spawn works, and claude + opencode are the
tested pair.

One blocking tool, `coding_agent`: one call is one harness turn, prompt in to
end-turn out. Multi-step work means the assistant calls it repeatedly, staying
in the loop between exchanges. There is no background run manager in v1, on
purpose: the assistant relaying questions and steering between turns IS the
product, and a run panel can come later without changing the wire.

## Decisions

| # | Decision |
|---|---|
| 1 | Both run hosts in v1: the server machine (acpx embedded in the stem-server process) and any paired desktop (the client hosts acpx, driven from the server over the device wire). One `HarnessHost` contract serves both; policy lives once, in `HarnessService`. |
| 2 | Blocking tool call. pi holds the `ctx.ui.input` elicitation open for the whole turn; `tests/unit/pi-elicitation-hold.test.ts` proves pi never times a held elicitation out (behaviorally, with pi-side timers compressed to nothing, plus a source drift guard on the pinned version). |
| 3 | Claude sessions run in `acceptEdits`, not the adapter default. The plan assumed `auto` mode escalates risky commands; live probes (2026-08-21) showed auto self-approves EVERYTHING through ACP, including `rm -rf` outside the project, and never raises `session/request_permission`. `acceptEdits` keeps file edits silent and surfaces every non-preapproved command as an ask. Set via `setMode` after ensure, fail-closed: a claude session that cannot be switched is refused rather than run in auto behind the cards' back (`local-host.ts`). Non-claude agents run under acpx `permissionMode: 'approve-reads'` with the same card callback. |
| 4 | Escalations become the fifth approval card (`HarnessApprovalCard`), with the harness's own options passed through verbatim and diff content rendered when the ask carries one. Exec's two invariants copied: the 10 minute clock arms only when the card is visible, and expiry is reported as "nobody answered", never as a refusal. Cards replay on the connect snapshot and push to the phone (`ApprovalPushKind` 'harness'). |
| 5 | Sessions persist per (thread, host, agent, cwd); repeated calls continue one conversation, `fresh_session` starts over. The server-side mapping (`harness-sessions.json`) is a CACHE of each host's own acpx session store: a host that lost or refuses the remembered id gets one fresh retry, and the fresh answer overwrites the record. The host's sessionId doubles as its acpx session key, so resume is key reuse. |
| 6 | The settings switch is OFF by default (`Settings -> Chat -> Coding agents`), read fresh per request. Device runs are additionally gated by a client-local consent switch ("Run coding agents on this computer", `harness-host.json`, 0600, never on the wire), read fresh on every request by the machine that would run the agent. |
| 7 | Scheduled/autonomous runs REFUSE `coding_agent` with an explanatory sentence (exec precedent): the tool asks questions and raises cards, and nobody is present to answer. |
| 8 | Recall in: `previewFacts()` prepends fact texts to the harness prompt as an escaped, fenced, explicitly-untrusted block. Recall out: nothing custom in v1; the result text returns into the pi turn and the existing distiller captures outcomes. |
| 9 | Live view is one activity row, not a panel: the `coding_agent` tool call's own turn-strip row updates live from throttled `harness:progress` broadcasts ("claude: editing src/foo.ts · 3 tool calls · $0.40"), and each run is one `harness.run` entry in background activity. Missing a frame is harmless; the final state rides the tool result. |
| 10 | cwd mirrors `run_command`: default is the chat's scratch folder, relative paths resolve inside it, device runs take absolute paths only, and the protected-roots scan blocks a cwd inside a read-only folder before anything spawns (fail closed). |

## The device wire

Same rails as exec-device: addressed control frames out (never the replay
ring), authenticated RPCs back, 128-bit single-use requestIds, wrong-device
answers refused, duplicate frames deduped client-side.

Ownership: the client owns the acpx runtime (the same `LocalHarnessHost` class
the server embeds), the session store under its own state root, the child
processes, and the only overall turn bound (maxTurnMs, ~2h). The server owns
the session mapping and an in-memory pending map per turn. A server restart
mid-turn is a graceful kill, not a recovery: the client's next event POST names
an unknown turnId and is answered `{action: 'cancel'}`; the session survives,
so retrying the tool call continues the conversation.

Frames and channels:

- `HARNESS_REQUEST_FRAME` carries ensure/run; `HARNESS_CANCEL_FRAME` asks for a
  graceful cancel (no reply expected).
- `harnessHost:announce` on connect and on switch flips; `harnessHost:result`
  terminates a held ensure/run; `harnessHost:event` flushes live events every
  250ms/64 (an empty batch every 15s is the heartbeat) and its ack is the
  lost-cancel fallback; `harnessHost:permission` is a BLOCKING RPC retried with
  a client-minted idempotency key, made safe by an in-flight join plus a
  decided-replay map on the server.

Cancellation is a deliberate reversal of exec-device's no-cancel rule
(`exec-device/router.ts`): a harness turn has no self-bound, so absent-cancel
is the bigger hazard. The frame maps to ACP's graceful turn cancel, never a
process signal, can only name a turnId the server itself minted, and is honored
even if the consent switch flipped off mid-turn (cancelling reduces activity).

Timeout ladder (no fixed overall turn timeout; a turn fails only when the
client goes silent): pushTo reaching zero streams is an immediate honest error
naming the machine; ensure 30s; first sign of life after run 30s; rolling 90s
idle against the 15s heartbeat; cancel wind-down 15s; permission cards on the
exec 10 minute visible clock. `connectedDevices()` is deliberately not a
liveness input mid-turn; the heartbeat is the sole authority.

Failure modes, each unit-tested (`harness-device.test.ts`,
`harness-host.test.ts`): device offline = immediate error; client silent
mid-turn = idle timeout, turn lost, next POST gets cancel, session survives;
SSE drop = turn unaffected (POST legs), cancel falls back to the event ack;
server restart mid-turn = unknown-turn cancel; server restart with a card up =
permission retry gets `{expired: true}`; late/duplicate results = forget-first
and stale-seq drop; forged results = refused on deviceId mismatch; reconnect
stream overlap = requestId dedupe.

## Spike facts baked into the code

- Harness questions arrive as end-turn TEXT, not ACP elicitation. The ask-user
  loop is: end turn, assistant relays or answers, next `coding_agent` call.
- Terminal state comes only from `await turn.result`, never the event stream.
- `usage.cost` is cumulative for the session; `usage.cumulative` tokens are the
  latest context size, not a sum.
- acpx must stay external in the build (it spawns adapter CLIs and resolves
  package-relative paths) and loads lazily, so the boot tripwire stays
  electron-free; verified by `npm run test:server` with acpx installed.
- Known upstream acpx bug, not patched (correctness unaffected): reconnect
  "session resumed" status events are dropped by `parsePromptEventLine`.

## Verification tiers

Everything runs against fakes except one gated test:
`STEM_HARNESS_E2E=1 npx vitest run tests/unit/harness-e2e.test.ts` runs a real
claude turn through the real acpx runtime and proves session continuity (the
second turn recalls the first's reply). Green against the real adapter
2026-08-21.

## Deliberately out of scope in v1

Background run manager and run panel, per-run cost rollup UI, harness-specific
recall evidence (`harness:<runId>` fact source), ACP elicitation handling (the
adapters do not emit it), exposing Stem itself as an ACP agent, phone-side run
UI beyond the approval push, and rebroadcasting raw device events on the ring
(the formatted progress updates already ride it and nothing consumes raw events
client-side).
