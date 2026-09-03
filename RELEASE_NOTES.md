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

## 0.5.0 — 2026-09-03

### Added

- **An iPhone app.** Stem has a real phone app again, on TestFlight: pair it from
  **Settings → Server → Pair a phone** by scanning a QR, and your chats are on your phone — the full
  list, replies streaming in with the same rich formatting as the desk, a new chat from the +
  button, and the same approval cards for commands and coding agents. It reads what it cached when
  there is no signal, and its Settings are your Stem's settings.
- **Notifications that know where you are.** The phone is pushed for an approval, a finished long
  turn or a scheduled task with something for you — but only while nobody has touched a desktop
  Stem in the last five minutes. Pushes carry no content, only a tap that opens the right thread.
- **Personas.** A persona is a named way of running the assistant — its own instructions, its own
  model if you like, and for coding work an agent and a folder. Five come built in: Normal,
  Verifier, Secretary, Orchestrator and Critic. They are rows in the new **Personas** tab, edited
  as a draft with a Save button; the built-ins cannot be deleted.
- **Mail.** Write to a persona the way you would email a colleague: **New mail** in the titlebar
  (⌘⇧N), pick who it is for, give it a subject, attach files, send. The reply lands in your Inbox
  when it is done; your own sends wait under Sent until then. Conversations are threads of mails
  with a reply box, and a **Stop** button ends a persona that is still working.
- **Personas work together.** Address a mail to several personas and the first one drives: it hands
  the others their parts, they run at the same time, and it answers you once, as one mail. A
  persona can pull in a colleague, and so can you from the + on the To: line. Settings → App → Mail
  caps how many mails a wave may send before it has to come back to you.
- **Personas keep their own notes.** A persona writes down what it learned doing its job and reads
  it before its next mail. Notes are about the work, never about you; browse or edit them in the
  editor's Memory section, or turn them off. Critic has none on purpose and does not see your
  memory either — and every persona has a **Sees your memory** switch of its own.
- **Scheduled tasks run as a persona.** A task's row in the Tasks tab is now an editor — prompt,
  schedule, the persona it runs as, the model it runs on — and a run that reports back does so as
  mail from that persona. Before this a task ran on whatever model its chat happened to use.
- **Personas from your phone.** A persona marked **Usable in chats from other devices** appears as
  a chip in the phone's composer, so a Verifier pass is one tap from wherever you are.
- **Coding agents.** Settings → App → Coding agents turns on a tool that lets the assistant hand a
  job to Claude Code (or any agent speaking the same protocol) in a folder you name, watch it work
  and report back. Every ask the agent escalates comes to you as an approval card, on the desk, in
  Quick Chat and on the phone, with the diff when there is one; your command approval mode applies
  to the agent's commands too. It runs where Stem runs, or on a paired computer that has switched
  on **Run coding agents on this computer**.
- **Code personas.** Pin a persona to an agent and a folder and it becomes a colleague who works in
  that repo — mail it a task from the Inbox or your phone. Only a pinned persona may use a coding
  agent, and two mails aimed at the same repo take turns.
- **Private chats and private mail.** A chat started with the Private toggle, or a mail with its
  Private box ticked, teaches Stem nothing and is answered without your memory: no facts learned,
  nothing recalled, no persona notes. The chat itself is still saved and searchable. Rows carry a
  lock.
- **Folders on your other computers.** A connected folder can live on your Mac while Stem runs on a
  server: the Mac mirrors it to the server, keeps the copy fresh, and Stem indexes it there. The
  Folders tab groups folders by machine and shows sync state and what was left out (Git internals,
  packages, anything over 25 MB). Read-only stays read-only on both machines, and a folder that
  vanishes freezes its mirror instead of ever reading as "delete everything".
- **Commands and MCP servers on your own computer.** With Stem on a server, "download this video on
  my Mac" now means your Mac: each computer has its own **Run commands on this computer** switch
  (Settings → App → Command execution), off until you turn it on there, and nothing is
  pre-approved on a computer. An MCP server that only means something on your Mac can be pinned
  to it in Tools → MCP servers and runs there. Every approval card says which machine it is for.
- **Ollama can live on the server.** One line in `.env` (`COMPOSE_PROFILES=ollama`) starts Ollama
  beside Stem, and Settings → Memory points at `http://ollama:11434`. It stays off unless you ask
  for it — and, measured, the embedder built into Stem is just as good, so this is for people who
  already run Ollama, not a step up.
- **Bring your own model files.** On a locked-down laptop the model download for memory search is
  blocked, so the feature never starts. Memory → Facts → Relevance ranking now offers **Import
  model files**: point Stem at a folder that already holds the model and it copies it into place.
  Any ONNX embedder or reranker works too, and joins the list alongside the built-in ones.
- **Your own look.** Settings → App → Appearance follows the system, forces light or dark, or loads
  a theme of your own — a small JSON file of color overrides in the themes folder. One choice
  paints every window, including Quick Chat.
- **Web search switch in the composer.** A **Web** button sits next to MDX and Note, so turning
  search off for one question no longer means a trip to Settings. Quick Chat has its own.
- **Fast for Grok.** The Standard/Fast speed switch now appears for Grok models too. It only
  existed for ChatGPT models before, which is why it seemed to vanish when you picked Grok.
- **Your own endpoint's models can think.** Selecting a Custom endpoint in Settings → Models shows
  a per-model overrides box in pi's own format, so a Qwen3 behind your proxy can answer with
  thinking on. A working models.json can be imported.
- **More attachments understood.** A PDF dropped into a chat goes to the model as its text, iPhone
  photos in HEIC are converted on the way in, and Word documents in connected folders are indexed
  like text and PDF.
- **Delete a skill from the app.** Select a skill in Tools → Skills and delete it with the button
  under the list. Until now the switch only silenced one.
- **Windows commands run in Git Bash.** With Git for Windows installed, `ls`, `cat` and `grep`
  mean what you expect and quoting works as everywhere else; without Git they run in Command
  Prompt as before. Settings → App → Command execution switches between the two.

### Changed

- **Memory search runs on Qwen3 — and this popup offers the switch.** New installs get the Qwen3
  Embedding 0.6B embedder and the Qwen3 Reranker 0.6B as their defaults. Measured twice on real
  conversations with hand-labeled relevance (60 turns over 369 facts, then 77 over 915), the pair
  chose the right facts best — ahead of the E5 and Gemma models that were the defaults, and level
  with a 4B Qwen3 served from Ollama, so there is no larger or external model worth running. An
  update never changes a setting you made: if your Stem is on anything else, the note under these
  notes shows what you run and offers **Switch** or **Keep**. The download is about 1.8 GB, in the
  background, and recall keeps working on the old models until the new ones are ready. The **Recall
  quality** row on Manage → Memory says at any time whether you are on the measured best.
- **Memory recall is stricter.** A small local relevance model — on by default, downloaded once —
  judges every remembered fact against your message before Stem shows it to the assistant,
  replacing keyword matching that padded chats with unrelated, occasionally sensitive, memories.
  Expect a few well-chosen facts per chat and often none; it can be switched off in Manage → Memory.
- **A broken memory model is no longer a silent one.** When the embedder or reranker cannot load,
  the Memory tab gets a red dot, a banner names the stage, the error and what recall is degrading
  to, and the same line lands in the log. A download that broke halfway repairs itself.
- **Harder to plant a false memory.** Anything learned from a turn that searched the web is marked
  unverified in the Facts tab, scheduled tasks can no longer say "remember that…" with the weight
  of your own words, and a learning pass lists the facts it wrote instead of a bare count.
- **How you want a task done is remembered.** "Next time, check the war-room channel first" used to
  be dropped. Preferences about how a kind of task should be done are ordinary memories now,
  brought up when that task comes around again; custom instructions keep only response style.
- **Several chats at once.** Stem runs conversations on a small pool of workers, so a scheduled
  task, a persona's mail and your own chat proceed in parallel. Stopping one leaves the others
  alone.
- **The server image comes with tools.** `uvx`, `npx`, `git`, `rg` and `curl` are in the image,
  what they download survives upgrades, and scheduled tasks run in your own timezone (`TZ` in
  `.env`). [Running on a server](docs/running-on-a-server.md) shows how to add more.
- **The assistant knows which computer it is on.** Ask why a tool is failing and it says which
  machine is missing the program, and it can list your MCP servers with where each runs and
  whether it is actually connected. Skills written from now on say which computer they need.
- **Every mail and chat turn records the Stem that made it,** so when personas improve you can
  tell which of their earlier mails came from the older version; the Inbox marks those.
- **Skills and instructions by reply.** When a persona wants to save a skill or change your
  standing instructions, it proposes it in the reply and your answer by mail is the approval —
  instead of a card that expired to "no" before anyone saw it.
- **A slimmer composer.** Effort is a slider whose stops are the model's own levels, beside a label
  like "High · Claude Opus" that opens the model picker in place. Speed and Format are single
  toggles. Quick Chat has the same row.
- **Settings, rearranged.** Models leads with status — a dead sign-in is a banner, providers are
  tiles — and the role pickers fold into "You chat with these", "Judgment work" and "Quick tasks".
  App is the shell; Chat is the conversation, and Quick Chat moved in from App.
- **You can see when a skill was used.** The "Used N tools" line above a reply counts skills too,
  and expanding it names each one — an answer built on a saved procedure used to look exactly like
  one worked out on the spot.
- **Tighter walls around the assistant.** Its file tools read only your connected folders and its
  own scratch space, and write only where you allowed writing. A paired device can hand the server
  a file, never a path on its disk. Browser automation lost its blanket pass, and pairing refuses
  plain `http://` to anything but this machine.
- **Small things.** Collapsed chat folders show how many unread chats they hide. A new chat puts
  the caret in the composer. Right-click offers copy, paste, open link and spelling suggestions.
  Search results open the same context menu as any chat row. Adding a connected folder from a
  remote client browses the server's folders, not the disk in front of you.

### Fixed

- **A command you allowed is no longer reported as one you refused.** An approval card gave you two
  minutes and then answered "the user declined" for you, and when a turn asked for two commands
  at once only the first card was ever shown. Cards now wait ten minutes, only the card in front of
  you counts down, and running out of time tells the assistant that nobody answered. A card raised
  while your phone was asleep is waiting for it when it reconnects.
- **Stop works the moment you press it.** Stop was dead for the whole "Working…" phase; now it
  cancels a turn at any stage, reads "Stopping…" until it has, and a stopped turn cannot flicker
  back to life.
- **Mail survives a restart.** A mail whose persona was cut off by a server restart is redelivered
  when Stem comes back up. A mail for a persona pinned to a sleeping computer waits and says so
  instead of failing, and a delivery that failed says **failed**, not "needs you".
- **Chats on a slow link.** Against a far-away server, marking read, archiving and snoozing apply
  the instant you act, and the chat list and settings paint from the local copy while the fresh
  answer crosses the wire — no more settings panes flashing defaults.
- **Chats you moved to a server can be opened again.** Every chat that came over in a move listed
  normally and failed the moment anything opened it, because it remembered a folder on the old
  Mac; scheduled tasks in those chats just said "failed" every morning. Moved chats now point at
  the new machine's workspace, and a run that fails says why in the Tasks tab and the log.
- **Commands work when Stem runs on a server.** Every command on a server install failed with
  `spawn /bin/zsh ENOENT`. Stem now uses the shell the machine actually has.
- **A signed-in MCP server stays signed in.** Services that rotate their tokens on every refresh
  (Fastmail, for one) decayed into "token has expired" hours after you reconnected, because
  parallel workers each refreshed on their own. Refreshes are coordinated now.
- **One huge tool result no longer wrecks the chat.** A two-megabyte MCP result made a chat
  unrecoverable. Tool results are capped, with a note telling the assistant to narrow the call.
- **A file Stem cannot read is no longer a file with nothing in it.** An unreadable settings, tasks
  or chat store used to be read as empty and then overwritten empty on the next save. Unreadable
  and absent are different facts now, and the first never triggers a write.
- **A chat driven from elsewhere opens whole.** A thread touched only from the phone, over MCP or
  by a scheduled task opened as just its last exchange until a restart. It loads from disk first.
- **Read means read.** A chat you are looking at is read, whichever device or task wrote into it;
  a chat still generating no longer goes bold early; a chat you marked unread stays so.
- **The app never forgets its server.** A paired Mac could lose its server address and silently
  boot an empty built-in server. The address is kept through everything but an explicit "use
  built-in server", and a crash mid-write cannot leave it looking like a fresh install.
- **Memory search stays up while folders index.** Indexing a big folder saturated the embedding
  endpoint and every memory lookup timed out. Background indexing yields to live queries, and a
  long pass shows its progress instead of reading as hung.
- **⌘W no longer closes Stem.** A ⌘W meant for the tab next door used to make Stem disappear
  mid-thought. The shortcut is gone from the menu on every platform; ⌘Q and the close button are
  unchanged.
- **MCP tools no longer pose as web searches.** Any tool with "search" in its name appeared in the
  activity feed as "Searched the web". Tool calls are labeled by what they actually are.
- **A remote client over HTTPS starts.** The event stream ignored the `https://` in a server
  address, and the app refused to launch against a TLS server.

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
