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

## 0.5.2 — Unreleased

### Added

- **Stem GTE Memory.** A new memory model, trained for Czech, Slovak, German and English, that
  scored the best recall and the fastest reranking in Stem's benchmarks. It is opt-in and
  experimental: in Manage → Memory, under Reranker, pick **Stem GTE Memory** and Stem downloads
  and verifies the model (about 340 MB) in the background, then uses it for picking memories and
  skills from the next reply on. Pick the Qwen3 reranker to switch back; your memories are never
  re-indexed or changed by trying it. It needs the built-in Qwen3 embeddings, and it also reads
  the last two things you said in the chat, so a follow-up question finds the memories the
  earlier one was about. Phones and desktops connected to one server share the choice.
- **See the work behind mail.** Expand **Work** below a mail to follow its personas and coding
  agents, with actions, progress, timings, and expandable inputs and results. The history updates
  quietly while work runs and keeps partial results after failure or Stop. Desktop and iOS show
  the same records. Scheduled notifications include their run history; older mails show what can
  be recovered, with missing details marked.
- **Multiple custom model endpoints.** Add separately named OpenAI-compatible and
  Anthropic-compatible endpoints and keep all of their models available at once. Existing single
  Custom endpoint settings continue to work.
- **Update dialog.** A newer Stem now announces itself in a dialog once per launch instead of a
  strip under the title bar that was easy to sit under for weeks. "Later" keeps the strip and the
  Settings → App row as the quieter reminders.

### Changed

- **Integrations no longer weigh on every reply.** The assistant used to be handed the full
  description of every tool from every connected integration, and every procedure, at the start
  of each reply. It now gets a short summary per integration and looks up the tools and procedures
  it needs. Replies start faster and cost less with many integrations connected, and adding one
  more no longer slows everything else down.
- **Recall quality row only when there is something to review.** The Memory tab no longer shows a
  row confirming the default recall setup. It appears only when your models differ from the
  recommendation, with the same "Review setup" link.

### Fixed

- **Downloads carry only the app.** Every installer so far also packed Stem's own source tree,
  tests and mobile project inside the app folder, none of which the app reads. They are gone, and
  building the macOS app from a checkout with the phone project set up no longer fails partway.
- **Unsent text survives switching chats.** Opening another chat threw away whatever you had
  typed but not yet sent, usually a follow-up written while the previous reply was still
  streaming. Each chat now keeps its draft and attachments until you send them or close Stem.
- **Scheduled mail says what happened this time.** All firings of a scheduled task share one mail
  conversation, and its subject stayed the first firing's headline for good, so a daily watch kept
  an old title on the morning it was about something else. Each firing now carries its own
  headline, the Inbox row shows the newest one, and the run's actual report or drafts arrive in the
  mail itself instead of a one-line pointer to a chat you were not looking at.
- **Tasks scheduled from mail get a chat you can open.** Asking a persona by mail to check
  something every morning produced a task whose runs, and whatever they drafted, landed in a hidden
  thread that no screen showed. Such a task now gets its own chat, named after the task, and
  existing ones move there on the next start.
- **Chats stay where they were.** A scheduled run that found nothing, or opening Rename and
  clicking away, moved the chat to the top of the list in bold as if someone had written to it. A
  quiet write now leaves the chat where the last real message put it.
- **"Restart now" after an update does something.** When the downloaded Linux update could not
  replace the running AppImage, usually because it sits in a folder you cannot write to, the button
  did nothing. The failure now shows in Settings and the button opens the release page instead.

## 0.5.1 — 2026-09-05

### Fixed

- **Linux builds can sign in.** Every AppImage and deb so far, and the macOS disk image, failed
  the provider sign-in with "Cannot find package '@earendil-works/pi-ai'": packaging dropped part
  of the assistant engine. If you installed Stem from a download and never got past sign-in, this
  is the release that works.
- **Stopped and failed replies look the same everywhere.** A reply you stopped, or one the
  provider rejected, showed its notice only in the window where it happened; other devices and a
  reopened chat showed a blank turn or one still "thinking". The notice now sits in the transcript
  itself, and the phone offers to resend the last message that did not get through.
- **Chats stay current across devices.** Opening a chat you had continued on another device
  showed the old copy until you left and came back. Open chats now refresh in the background, and
  again when the connection returns.
- **The phone wakes up cleanly.** Coming back from a locked phone left the connection looking open
  while nothing arrived, a reply that finished while you were away stayed "Thinking…" forever, and
  a single missed request in the first second after unlock painted every screen red. Waking now
  reconnects, settles finished turns, and stays quiet about a hiccup that fixes itself.
- **The Qwen3 reranker loads.** Picking the Qwen3 reranker in Memory crashed the model worker
  three times and settled on "worker keeps crashing", however much RAM the Mac had. It loads now,
  at no cost in speed.
- **Coding agents start in seconds.** Launching Claude Code through Stem could take over a minute
  per start, and the model list in the persona editor timed out, because npm ran a network check
  on every launch. Stem now launches it without the check.
- **Long coding runs finish.** A persona's coding-agent run used to be stopped at 30 minutes, mid
  task if need be. It now runs until it is done. When Stem itself stops a run (a schedule timed out,
  the chat was deleted, the server restarted), the result now says so instead of "cancelled by the
  user".
- **Memory → Review setup lands on the ranking controls.** The link expanded the collapsed
  section but left you looking at the fact list above it.

### Changed

- **Coding agents belong to code personas.** The Stem-wide "Delegate coding work" switch is gone.
  A plain chat no longer has a coding agent; only a persona with a pinned coding agent can launch
  one, and the same rule holds in chats, mail and schedules. The pin now also chooses the model the
  agent runs, picked in the persona editor from what the agent offers on that computer, so the
  short-lived model picker in Settings → App is gone too.

- **Permission cards live in the chat that asked.** When a command or a coding agent needs your
  go-ahead, the card now appears above the message box of that conversation instead of as a
  dialog over whatever chat you happened to have open — which made it look like a question about
  the wrong chat. If you are elsewhere, a bar at the top of the window names the chat and opens
  it, and its row in the sidebar gets an amber dot. A coding agent's buttons now just say Reject,
  Always allow and Allow; the rule "Always allow" would teach the agent is spelled out beside them
  instead of stretched across a button.
- **Themes ship with Stem.** The theme picker now lists themes bundled with the app (TokyoNight
  Storm to start) alongside any in your own themes folder; a file of yours with the same name wins.
  Saving a theme file applies it at once, in every window — the Reload button is gone. A theme can
  carry both a `light` and a `dark` palette and then follows the OS appearance, and the example file
  in the themes folder now does. A few surfaces that ignored the theme (the memory-note card, your
  own mail bubbles, scrollbar thumbs) follow it now.
- **Themes reach past color.** A theme's `style` block can set the interface and code fonts, scale
  all text or all spacing at once (a compact or a comfortable Stem), turn shadows down or off, and
  change corner radii. Motion is not a theme's to change: Stem now follows the OS "reduce motion"
  setting everywhere.

## 0.5.0 — 2026-09-03

### Added

- **Personas (beta).** A persona is a saved configuration of the assistant: its own instructions,
  optionally its own model, and for coding work a coding agent and a folder. Five are built in:
  Normal, Verifier, Secretary, Orchestrator and Critic. They are edited in the new **Personas**
  tab; the built-ins cannot be deleted. A persona can be sent mail (below), can run a scheduled
  task (the task's row in the Tasks tab picks the persona and the model), and can be offered in
  chats from other paired devices with **Usable in chats from other devices**. Each persona
  keeps notes about its work and reads them before its next mail; they are in the editor's
  Memory section, and can be turned off. Each has a **Sees your memory** switch. Critic has neither notes nor
  access to your memory, so it reviews a draft without knowing who wrote it. A persona pinned to
  a coding agent and a folder works in that repo; only pinned personas may use a coding agent,
  and two mails aimed at the same repo run one after the other.
- **Mail (beta).** A message to a persona, sent from **New mail** in the titlebar (⌘⇧N) with a
  recipient, a subject and attachments. The reply arrives in your Inbox when the persona is done;
  until then the send sits under Sent. A conversation is a thread of mails with a reply box, and
  **Stop** ends a persona that is still working. A mail addressed to several personas is run by
  the first one: it splits the work, the others run in parallel, and it replies once. A persona
  can add a colleague to a thread, and so can you from the + on the To: line. Settings → App →
  Mail caps how many mails one exchange may send before coming back to you. When a persona wants
  to save a skill or change your instructions, it asks in its reply and your reply is the
  approval.
- **Private chats and private mail.** A chat started with the Private toggle, or a mail with its
  Private box ticked, is answered without your memory and teaches Stem nothing: no facts learned,
  nothing recalled, no persona notes. The chat itself is still saved and searchable. Private rows
  show a lock.
- **Folders on your other computers.** A connected folder can be on your Mac while Stem runs on a
  server. The Mac mirrors it to the server on change, on reconnect and every fifteen minutes, and
  Stem indexes it there. The Folders tab groups folders by machine and shows sync state and what
  was skipped (Git internals, packages, files over 25 MB). Read-only applies on both machines. A
  folder that disappears freezes its mirror instead of being treated as deleted.
- **MCP servers and commands on your other computers.** With Stem on a server, an MCP server can
  be pinned to one computer in Tools → MCP servers and runs there, for tools that only make sense
  on that machine. Commands work the same way: each computer has a **Run commands on this
  computer** switch (Settings → App → Command execution), off by default. Nothing is pre-approved
  on another computer, and every approval card names the machine.
- **More attachments.** A PDF dropped into a chat goes to the model as text (scans without a text
  layer do not). HEIC photos from an iPhone are converted on the way in. Word documents in
  connected folders are indexed like text and PDF.
- **Coding agents.** Settings → App → Coding agents lets the assistant hand a job to Claude Code,
  or another agent speaking the same protocol, in a folder you name. The agent's asks come to you
  as approval cards, with the diff when there is one, and your command approval mode applies to
  its commands. It runs where Stem runs, or on a paired computer with **Run coding agents on this
  computer** turned on. Its model can be pinned.
- **Ollama on the server.** `COMPOSE_PROFILES=ollama` in `.env` starts Ollama next to Stem, and
  Settings → Memory can then point at `http://ollama:11434`. Off by default. The built-in
  embedder measured the same, so this is for people who already run Ollama.
- **Import model files.** Memory → Facts → Relevance ranking → **Import model files** loads a
  memory-search model from a folder instead of downloading it, for machines where the download
  is blocked. Any ONNX embedder or reranker can be added the same way.
- **Appearance.** Settings → App → Appearance: system, light, dark, or a theme file of your own (a
  JSON of color overrides in the themes folder). Applies to every window, including Quick Chat.
- **Web search switch in the composer.** A **Web** button next to MDX and Note turns search on or
  off per question. Quick Chat has its own.
- **Fast mode for Grok.** The Standard/Fast switch appears for Grok models too; it was
  ChatGPT-only before.
- **Thinking on custom endpoints.** A Custom endpoint in Settings → Models has a per-model
  overrides box in pi's format, so a model behind your own endpoint can run with thinking on. An
  existing models.json can be imported.
- **Delete skills in the app.** Select a skill in Tools → Skills and use the delete button under
  the list.
- **Git Bash on Windows.** Commands run in Git Bash when Git for Windows is installed, otherwise
  in Command Prompt. Settings → App → Command execution switches between them.

### Changed

- **Memory search runs on Qwen3 — and this popup offers the switch.** New installs use Qwen3
  Embedding 0.6B and Qwen3 Reranker 0.6B. Measured on real conversations with hand-labeled
  relevance (60 turns over 369 facts, then 77 over 915), this pair picked the right facts best;
  the E5 and Gemma models were behind, and a 4B Qwen3 on Ollama was level, so there is no larger
  or external model to recommend. An update does not change a setting you made: if your Stem is
  on anything else, the note under these notes shows what you run and offers **Switch** or
  **Keep**. The download is about 1.8 GB, in the background; recall keeps working on the old
  models until the new ones are ready. The **Recall quality** row on Manage → Memory shows
  whether you are on this setup.
- **Memory recall is stricter.** A local relevance model, on by default and downloaded once,
  checks each remembered fact against your message before it goes to the assistant. This
  replaces keyword matching, which put unrelated memories into chats. Expect a few facts per chat
  and often none. It can be turned off in Manage → Memory.
- **A memory model that fails to load is reported.** The Memory tab shows a red dot and a banner
  naming the stage, the error and what recall falls back to; the same line goes to the log. A
  half-finished download repairs itself.
- **Facts from web pages are marked unverified.** Anything learned in a turn that searched the
  web shows as unverified in the Facts tab. Scheduled tasks can no longer store "remember that…"
  as your own words. A learning pass lists the facts it wrote.
- **Task preferences are remembered.** "Next time, check the war-room channel first" is stored as
  a memory and brought up when that kind of task comes around again. Custom instructions keep
  only response style.
- **Several chats at once.** Conversations run on a small pool of workers, so a scheduled task, a
  persona's mail and your own chat proceed in parallel. Stopping one leaves the others alone.
- **The server image includes tools.** `uvx`, `npx`, `git`, `rg` and `curl` are in the image,
  what they download survives upgrades, and scheduled tasks use the timezone set as `TZ` in
  `.env`. [Running on a server](docs/running-on-a-server.md) shows how to add more.
- **The assistant knows which computer it is on.** When a tool fails it says which machine is
  missing the program, and it can list MCP servers with where each runs and whether it is
  connected. Skills saved from now on record which computer they need.
- **Mails and turns record the Stem version that made them.** The Inbox marks mails from an
  older version.
- **Composer.** Effort is a slider with the model's own levels, next to a label like "High ·
  Claude Opus" that opens the model picker. Speed and Format are single toggles. Quick Chat has
  the same row.
- **Settings layout.** Models starts with status (sign-in problems as a banner, providers as
  tiles) and groups the role pickers into "You chat with these", "Judgment work" and "Quick
  tasks". App holds the shell settings; Chat holds the conversation settings, including Quick
  Chat, which moved from App.
- **Skills are listed with tools.** The "Used N tools" line above a reply counts skills and names
  them when expanded.
- **File access is narrower.** The assistant's file tools read only connected folders and their
  own scratch space, and write only where writing is allowed. A paired device can send the server
  a file, not a path on the server's disk. Browser automation runs only its read-only subcommands
  without asking. Pairing refuses plain `http://` except to this machine.
- **Small things.** Collapsed chat folders show their unread count. A new chat focuses the
  composer. Right-click offers copy, paste, open link and spelling suggestions. Search results
  have the same context menu as chat rows. Adding a connected folder from a remote client browses
  the server's disk.

### Fixed

- **An allowed command is no longer reported as refused.** Approval cards timed out after two
  minutes with "the user declined", and when a turn asked for two commands at once only the first
  card was shown. Cards now wait ten minutes, only the visible card counts down, a timeout tells
  the assistant that nobody answered, and a card raised for a device that is offline waits for it.
- **Stop works at any stage.** It was inactive during "Working…". It now cancels immediately,
  shows "Stopping…" until done, and a stopped turn cannot resume.
- **Mail survives a restart.** A mail cut off by a server restart is redelivered at startup. A
  mail for a persona pinned to a sleeping computer waits and says so. A failed delivery says
  **failed**.
- **Slow connections.** Marking read, archiving and snoozing apply immediately against a remote
  server, and the chat list and settings show the local copy while the fresh data loads.
- **Chats moved to a server open again.** Moved chats remembered a folder on the old machine and
  failed when opened; scheduled tasks in them failed every morning. They now point at the new
  machine's workspace, and a failing run says why in the Tasks tab and the log.
- **Commands work on a server.** Every command failed with `spawn /bin/zsh ENOENT`. Stem now uses
  the shell the machine has.
- **MCP sign-ins with rotating tokens stay valid.** Parallel workers each refreshed the token and
  invalidated each other's. Refreshes are coordinated.
- **Large tool results are capped.** A two-megabyte MCP result made a chat unusable. Results are
  truncated with a note to narrow the call.
- **Unreadable files are not treated as empty.** An unreadable settings, tasks or chat store was
  read as empty and overwritten on the next save. It is no longer written.
- **Chats driven from elsewhere load fully.** A thread touched only from another device, over MCP
  or by a scheduled task showed only its last exchange until a restart.
- **Read state.** A chat you are looking at is read whichever device wrote to it. A chat still
  generating does not go bold early. A chat you marked unread stays unread.
- **The server address is kept.** A paired Mac could lose its server address and start an empty
  built-in server. The address is kept unless you choose "use built-in server", and the file is
  written so a crash cannot leave it half-written.
- **Memory search during folder indexing.** Indexing a big folder saturated the embedding
  endpoint and memory lookups timed out. Indexing now yields to live queries and shows progress.
- **⌘W no longer closes the window.** Removed from the menu on every platform. ⌘Q and the close
  button are unchanged.
- **MCP tools are not labeled as web searches.** Tools with "search" in their name showed as
  "Searched the web".
- **Remote clients over HTTPS start.** The event stream ignored `https://` in the server address.
- **Switching memory search to the built-in Qwen3 no longer stalls chats.** On a server CPU the
  re-index sent every fact to the model as one request, each request timed out, the abandoned
  work kept the processor busy, and a chat waited a quarter of an hour for no answer. Re-indexing
  now runs in small batches that yield to chats, a chat's own lookup goes first, and a request
  that times out is dropped rather than finished for nobody.

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
