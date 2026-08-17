# Stem release notes

What's changed in each version, in plain language. Stem shows the new entries once, the first
time you open it after an update — you can turn that off in Settings → About.

<!--
Maintainer notes:
- One `## <version> — <date>` section per release, newest first. The version is the first token
  after `##`; everything after the dash is free text ("Unreleased" while a release is in flight).
- Stem hides any section newer than the running app version, so notes can land here before the
  release is cut. Cutting a release = bump `version` in package.json, swap "Unreleased" for the
  date, tag.
-->

## 0.5.0 — Unreleased

### Changed

- **Memory recall.** A small local relevance model — on by default now, downloaded once in the
  background — judges every remembered fact against your message before Stem shows it to the
  assistant. This replaces keyword matching that padded chats with unrelated, occasionally
  sensitive, memories. Expect a few well-chosen facts per chat and often none at all; the model
  can be switched off in Manage → Memory.
- **Skills say which computer they need.** A procedure that only works on one machine — a
  program only your Mac has, a site that turns a server away — now gets written down that way,
  with the reason and the way in, instead of as steps that quietly assume whichever computer
  Stem happened to be on that day. This matters after moving Stem to a server: your skills come
  across intact and are then followed somewhere else entirely. Skills already saved are
  unchanged; this applies to ones written from now on.

### Added

- **Fast for Grok.** The Standard/Fast speed switch now appears for Grok models too — Fast asks
  xAI to schedule your request with higher priority. Until now the switch only existed for
  ChatGPT models, which is why it seemed to vanish when you picked Grok.
- **Web search switch in the composer.** A **Web** button now sits next to MDX and Note, so
  turning search off for a question no longer means a trip to Settings. It stays where you leave
  it, and it is the same switch as Settings → Chat → Web search — so you can still set it once
  and forget it. Quick Chat has its own, set separately in Settings → Quick Chat, for anyone who
  wants search on at the desk but off in the overlay.

- **MCP servers can run on the computer that has the tools.** With Stem on a server, a tool that
  only means something on your own Mac — a command it has installed, a URL on your home network —
  can be pinned to that Mac and runs there, while everything else still runs on the server and
  answers from your phone. Tools → MCP servers lists your servers under the machine that runs
  each one, and asks you to approve a server the first time it is set to run on the computer
  you are at.
- **The server image comes with tools.** Running Stem on a server used to mean a machine
  with nothing on it: no `uvx` or `npx` to start an MCP server with, no `git`, no `rg`,
  not even `curl` — so commands the assistant considers routine failed on sight. The
  image now carries those, keeps what they download between upgrades, and reads your
  scheduled tasks in your own timezone (set `TZ` in `.env`). A program the image lacks is
  usually still no obstacle: the assistant knows to run anything from PyPI or npm on
  demand (`uvx yt-dlp` and the like), and a tool it installs for keeps lands in a folder
  that survives upgrades. Adding a system package of your own is a few lines;
  [Running on a server](docs/running-on-a-server.md) shows the whole ladder.
- **Ollama can live on the server.** Memory search can be pointed at your own embedding model
  again after the move: one line in `.env` (`COMPOSE_PROFILES=ollama`) starts Ollama beside Stem
  in its own container, and Settings → Memory points at `http://ollama:11434`. Before this the
  only endpoint a server Stem could reach was one you exposed to the internet, or the laptop that
  used to be the server. It stays off unless you ask for it — nothing is pulled, nothing runs —
  and the embedder built into Stem still needs none of it.
- **The assistant knows which computer it is on.** Ask it why a tool is failing and it now says
  which machine is missing the program, instead of assuming everything runs on the computer in
  front of you. It can list your MCP servers with where each one runs; moving one between
  machines is still yours to do.
- **Commands on your own computer.** With Stem on a server, ask from your phone and the
  assistant can run a command on your Mac — "download this video on my Mac" now means your
  Mac, not the server. Nothing changes until you allow it: each computer has its own **Run
  commands on this computer** switch (Settings → Chat → Command execution, on that machine),
  off until you turn it on there. Commands then face the same approvals as always, except
  stricter — nothing is pre-approved on a computer, and an "Always allow" you grant applies
  to that computer alone. Every approval card says which machine it is for.

- **You can see when a skill was used.** The "Used N tools" line above a reply now counts skills
  too, and expanding it names each one Stem loaded for that answer. A skill was invisible before:
  it is not a tool call, so an answer built on a procedure saved weeks ago looked exactly like one
  Stem worked out on the spot.
- **Delete a skill from the app.** Click a skill in Tools → Skills to select it, then delete it
  with the button under the list — the same way servers are removed one tab over. Until now the
  switch could only silence a skill: the file stayed, and with Stem on a server it sat in a
  folder on the server that nobody could reach.

### Fixed

- **Chats you moved to a server can be opened again.** After moving Stem to a server, every chat
  that came over listed normally and failed the moment anything opened it: the backend records
  the folder a chat ran in, and that folder was on the Mac the export came from. Scheduled tasks
  were where it showed — a watch task in one of those chats just said "failed" every morning, and
  said it nowhere else. Moved chats are now pointed at the new machine's own workspace, both
  during the move and on any chat that already came across, and a run that fails now says why in
  the Tasks tab and the log.
- **Commands work when Stem runs on a server.** Every shell command the assistant tried on a
  server install failed instantly with `spawn /bin/zsh ENOENT`, because Stem asked for a shell
  that Linux servers do not have — including the commands it runs to work out why something
  else is broken. It now uses the shell the machine actually has.
- **Right-click works on search results.** A chat you found by searching can now be archived,
  snoozed, renamed, filed or deleted straight from the result row, like any other row in the list.
  Until now the menu simply didn't open there, so the one chat you had just gone looking for was
  the one chat you had to close the search and hunt down in the tree to act on.
- **⌘W no longer closes Stem.** Stem is not a browser, and the window it has is the app: a ⌘W
  (Ctrl+W) meant for the tab next door used to make Stem disappear mid-thought, taking the open
  chat and whatever was half-typed in the composer with it. The shortcut is gone from the menu,
  on every platform. Pressed while Quick Chat had focus it was worse — the overlay is built once
  when Stem starts, so closing it left the shortcut summoning nothing until a restart. Quitting
  (⌘Q) and the window's own close button are unchanged.
- **MCP tools no longer pose as web searches.** Any tool with "search" in its name — Home
  Assistant lookups included — used to appear in the activity feed as "Searched the web" with a
  globe icon, even though no web search happened. Tool calls are now labeled by what they
  actually are.

## 0.4.0 — 2026-08-12

### Removed

- **Phone client removed.** Settings → Mobile, the pairing QR and the phone web app
  are removed, and a paired phone stops working. Stem's brain is moving to a server you can reach
  from anywhere, and the phone app that talks to it is being rebuilt properly rather than kept
  limping — nothing about Stem at the desk changes.

### Added

- **Stem server.** Stem still runs entirely on this computer by default,
  but Settings → Server can now aim the app at a Stem running elsewhere — same chats, same memory,
  same skills, from any machine you sit at. [Running on a server](docs/running-on-a-server.md)
  walks the whole move.
- **Inbox.** The chat list now has two tabs, and the Inbox works like mail:
  every thread waits there until you archive or snooze it, and anything new — a scheduled task
  that ran overnight, a reply you never came back to — shows up bold and unread. It's also the
  start of something bigger: one day Stems will be able to send each other messages, and this is
  where they'll arrive.
- **Updates.** A quiet strip at the top of the window says when a
  new release is out — on Linux it downloads in the background and installs on the next restart,
  on a Mac it points you at the download. "Check now" and a switch for the automatic check are in
  Settings → App → About.
- **Model roles.** Settings → Models now shows everything
  Stem runs a model for — your chat, Quick Chat, memory, skills, chat subjects, the command safety
  check — in one place, each with its own model and its own thinking effort. Left alone, the quick
  tasks follow a cheap default and the rest follow the model you chat with.
- **Chat subjects.** Stem writes each new chat a short subject from your opening message
  instead of quoting its first line; a name you type yourself is never overwritten. Settings →
  Chats picks the model, or turns it off.
- **Devices.** Settings → Devices lists everything signed in to your Stem and can withdraw any of
  them, effective immediately. Adding one works like a door code: an eight-character code, valid
  for ten minutes and one device.
- **Backup and move.** "Move or back up this Stem" in
  Settings → Server writes your chats, memory, skills, Files, settings and connected tools into
  one passphrase-protected file; `stem-server import` on another machine makes it the same Stem,
  and the same file is your backup. Paired devices, this computer's own settings and the
  downloaded models deliberately stay behind — the import says what came along and what needs you.

### Fixed

- **A scheduled run that asks for your attention now shows you its reply.** The answer used to
  hide inside the collapsed "Scheduled run" row — the notification pointed at a fold you had to
  open. The reply now appears as a normal message; the run's inner steps stay tucked away.

## 0.3.0 — 2026-08-04

### Added

- **Sign in with xAI (Grok).** Grok joins ChatGPT, Claude, OpenRouter and the local servers in the
  provider list, with the same in-app sign-in.
- **Faster web search.** Several queries now run at once, pages are fetched in batches, and the
  model that runs the search itself was swapped for a quicker one — the answers and sources held
  up in benchmarking, because the thinking happens in your chat model afterwards either way.
- **Grok web search.** Grok can now be picked as the backend Stem searches the web with.
- **Clearer search picker.** The backend list is grouped by what's actually ready to use (works
  on your sign-in / needs a key / not configured), and the assistant is told which backend it is
  searching with, so citations name the right source.
- **Custom OpenAI-compatible endpoint.** Point Stem at any server that speaks the OpenAI API —
  your own proxy, a hosted gateway, a colleague's box — and pick which models it offers. Endpoints
  that speak the Anthropic Messages API work too; Stem detects which one yours is.
- **Skills rebuilt.** Skills are rebuilt around what the assistant actually did —
  the real tool trace of a turn, not its narration of one — and are checked against a contract
  before they are saved. Stem now picks the few skills relevant to your message instead of
  broadcasting every description at every turn.
- **Self-correcting memory.** A new fact is checked against what Stem already knows, so an
  outdated one is retired even when it is worded nothing like its replacement. Merging facts keeps
  the dates they were asserted on, and disagreements Stem can settle on its own are settled.
- **This popup.** Stem shows what changed once, the first time you open it after an update.
  Settings → About turns it off and keeps the full history.

### Fixed

- **Memory no longer argues with itself.** Conflicting facts are raised and resolved at rates that
  actually match, a fact retired by mistake can't quietly come back, and "Reset recall" is now a
  hard stop — a background pass that was already running can't resurrect anything after it.
- **Memory works without embeddings.** When the local embedding model is off or still loading, the
  keyword-only fallback keeps its promises instead of silently dropping results or ranking your
  documents backwards.
- **"Memory used in this chat" tells the truth about the past.** A conflict raised (or resolved)
  after a turn no longer rewrites what that turn is shown to have been told.
- **A reply that arrives in several pieces stays whole** instead of losing everything but the last
  piece.
- **Running commands is steadier.** The safety check no longer times out or runs on the expensive
  model, it says why it refused without pasting an exception at you, and it reads Windows paths
  and PowerShell quoting correctly.
- **Stem now starts properly on Linux.** First run off macOS could fail outright; the installer
  also now fetches the Electron runtime it needs. The Linux x64 download is roughly half the size
  it was.
- **Quick Chat opens on the Space you're actually on**, instead of pulling you back to the one it
  was last summoned from.
- **Your phone can no longer read files or API keys off your Mac.** The phone bridge was exposing
  more of Stem's internals than it should; it is now limited to the chat surface it needs.
- **A web-search key you edit takes effect immediately** rather than only being saved.
- **Disconnecting a provider sticks.** Two provider changes at once could resurrect a
  just-disconnected one.
- **A slow connection test can't overwrite a newer one's result** in Settings, so the ✓/✗ you see
  belongs to the endpoint you're looking at.
- **A phone reply that finishes very fast no longer stalls scheduled tasks** for the rest of the
  session.
- **One misconfigured provider no longer breaks every chat** — Stem starts without it instead of
  refusing to start at all.

## 0.2.0 — 2026-07-29

### Added

- **Stem on your phone.** An opt-in bridge (Settings → Mobile) serves a small Stem client to your
  phone over your tailnet, so you can carry on a conversation away from the desk.
- **Web search on every provider.** Search no longer depends on which model you signed in with —
  it works out of the box on a fresh install, with citations, and you can point it at your own
  backend or key.
- **An activity surface.** Stem shows what it's doing while it works — which tool is running, when
  context is being compacted — instead of a silent spinner.
- **Run commands.** The assistant can run shell commands for you, behind a tiered approval system:
  a learned allowlist, then a judge model, then an approval card for anything it isn't sure about.
  Off-limits paths are always protected, and you can set the mode (assisted / manual / yolo) in
  Settings.
- **Connected folders feed memory.** Folders you connect are indexed and Stem learns durable facts
  from them, so it can answer from your own documents.
- **Files gets its own tab**, separate from connected folders.
- **Fact conflicts resolve themselves.** When two remembered facts disagree, Stem classifies the
  conflict and picks a resolution instead of quietly keeping both.
- **Checklists you can tick.** Task lists in a reply are interactive.
- **Skills track their own usage**, so the ones that actually get consulted are visible.
- **An end-user guide** covering chats, memory, folders and tools (`docs/user`).

### Fixed

- Scheduled runs keep the model the thread was using, and recover instead of failing when a run
  overflows its context.
- Typing in the composer no longer re-renders the whole conversation on long threads.
- Reopened chats show the model and effort each reply was produced with again.

## 0.1.0 — 2026-07-20

The first release. Stem is a private, local-first assistant that runs on your own AI sign-in:

- **Chats** with nested folders, search across every conversation, per-message retry / edit /
  fork, attachments and image paste, and several chats answering at once.
- **Quick Chat**, a global-shortcut overlay for a question you don't want to open a window for,
  plus a status pill that follows you across Spaces.
- **Stem Recall**, a memory system that is yours rather than the model vendor's: durable facts,
  episodic recall, relevance ranking with local embeddings, and full control to inspect, pin,
  correct or erase anything it has remembered.
- **Rich replies.** Answers render as MDX — tabs, tables, charts, quizzes and forms, not just a
  wall of text — with a plain-Markdown mode when you want one.
- **Your tools.** MCP servers (local and remote, with in-app OAuth), read/write file access to a
  Files place you control, and self-improving skills the assistant curates in the background.
- **Scheduled tasks** that run on their own and notify you.
- **Your choice of model** — ChatGPT, Claude, OpenRouter, Ollama or LM Studio — with per-turn
  control over reasoning effort and speed.
- **macOS and Linux** builds.
