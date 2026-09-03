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

A big one. Stem grew a phone app, personas you write to like colleagues, coding agents it can
hand work to, folders that follow you from your other computers, and a memory that is far
choosier about what it brings up. The first thing you will see is this popup; if your memory
search still runs on the old models, it offers the switch right here.

### Memory

- **Memory search runs on Qwen3 now — and this popup offers the switch.** New installs get the
  Qwen3 Embedding 0.6B embedder and the Qwen3 Reranker 0.6B as their defaults. We measured them
  twice on real conversations with hand-labeled relevance — 60 turns over 369 facts, then 77 turns
  over 915 — and the pair picked the right facts best, ahead of the E5 and Gemma models that were
  the defaults before, ahead of similarity thresholds and wider candidate pools, and level with a
  4B Qwen3 model served from Ollama. There is no larger model worth running for this, which is why
  the Memory tab stopped recommending one. An update never changes a setting you made, so an
  existing Stem keeps the models it has; the note under these release notes tells you what you
  are on and switches both with one click. The download is about 1.8 GB the first time, in the
  background, and memory search keeps working on the old models until the new ones are ready.
  The **Recall quality** row on Manage → Memory says at any time whether you are on the measured
  best.
- **Memory recall.** A small local relevance model — on by default now, downloaded once in the
  background — judges every remembered fact against your message before Stem shows it to the
  assistant. This replaces keyword matching that padded chats with unrelated, occasionally
  sensitive, memories. Expect a few well-chosen facts per chat and often none at all; the model
  can be switched off in Manage → Memory.
- **Private chats and private mail.** A chat started with the Private toggle, or a mail composed
  with its Private box ticked, teaches Stem nothing and is answered without your memory: no facts
  learned, nothing recalled, no persona takes notes. The chat itself is still saved and searchable
  — private means not learned from, not gone. Rows carry a lock so you can tell them apart.
- **A broken memory model is no longer a silent one.** When the embedder or reranker cannot load
  — a blocked download, a corrupt file, a dead endpoint you pointed Stem at — memory quietly fell
  back to keyword matching and the only trace was a grey line in a collapsed section. Now the
  Memory tab gets a red dot in the rail, a banner names the stage, the error and what recall is
  degrading to, and the same line lands in the log so there is something to send when asking for
  help. A download that broke halfway repairs itself instead of failing forever.
- **Harder to plant a false memory.** A web page the assistant read cannot become a durable fact
  on its own: anything learned from a turn that searched the web is marked unverified in the Facts
  tab, scheduled tasks can no longer say "remember that…" with the weight of your own words, and
  the background-activity row for a learning pass lists the facts it wrote instead of a bare
  count — so a fact that should not be there is visible the moment it lands.
- **How you want a task done is remembered.** "Next time, check the war-room channel first" used
  to be dropped as a standing instruction you had not put in your custom instructions. Preferences
  about how a kind of task should be done are ordinary memories now, brought up when that task
  comes around again; custom instructions keep only response style.
- **Bring your own model files.** Memory search needs a small model, downloaded once from
  Hugging Face — and on a locked-down work laptop that download is blocked, so the feature never
  starts. Memory → Facts → Relevance ranking now offers **Import model files**: point Stem at a
  folder that already holds the model — Stem's own model folder copied from another computer, or
  a download you made somewhere with an open network — and it copies it into place and loads it.
  If the folder is missing a piece, Stem says which one instead of failing later. With Stem on a
  server, you pick the folder on the server. A model Stem has never heard of works too — point it
  at any ONNX embedder or reranker, answer the two or three things the folder can't say, and it
  joins the list alongside the built-in ones.

### Personas and mail

- **Personas.** A persona is a named way of running the assistant — its own instructions, its own
  model if you like, and for coding work an agent and a folder it works in. Five come built in:
  Normal, Verifier, Secretary, Orchestrator and Critic. They are rows in the new **Personas** tab,
  editable like anything else (a draft with a Save button, so a half-typed name is never saved),
  and the built-ins cannot be deleted because they would only come back blank.
- **The Inbox is mail.** Write to a persona the way you would email a colleague: **New mail** in
  the titlebar (⌘⇧N), pick who it is for, give it a subject, attach files, send. The reply lands
  in your Inbox when it is done; your own sends wait under Sent until then, exactly like email.
  Conversations are threads of discrete mails with a reply box, not chats — the chat tree keeps
  the tree, folders, unread bolding and search, and loses the archive/snooze it never needed.
  While a persona works, the conversation shows it, and a **Stop** button ends it; the
  background-activity popover names the persona, the turn, and opens the conversation on click.
- **Personas work together.** Address a mail to several personas and the first one you picked
  drives: it hands the others their parts, they run at the same time, and it answers you once,
  as one mail — no three separate apologies for one mistake. A persona can pull in a colleague
  (Secretary and Orchestrator may), and so can you, from the + on the conversation's To: line.
  An exchange cap (Settings → App → Mail) bounds how many mails a wave may send before it has to
  come back to you. A reply to a mail you have since superseded is delivered but labeled
  "answers your earlier mail", and a delivery that failed says **failed**, not "needs you".
- **Personas keep their own notes.** A persona writes down what it learned doing its job — how
  your repo is laid out, what you asked for last time — and reads those notes before its next
  mail. Notes are about the work, never about you, and each persona's are its own; you can browse
  and edit them in the editor's Memory section or turn them off. Critic has none on purpose, and
  also does not see your memory — a reviewer who knows who wrote the draft grades the author, not
  the draft — and every persona has a **Sees your memory** switch of its own.
- **Scheduled tasks can run as a persona.** A task's row in the Tasks tab is now an editor —
  prompt, schedule, the persona it runs as, the model it runs on — and a run that reports back
  does so as mail from that persona, grouped per task. Before this a task ran on whatever model
  its chat happened to be using, forever.
- **Personas from your phone.** A persona you mark **Usable in chats from other devices** appears
  as a chip in the phone's composer, so a Verifier pass is one tap from wherever you are.
- **Mail survives a restart.** A mail whose persona was cut off by a server restart or crash is
  redelivered when Stem comes back up, continuing where it was. A mail for a persona pinned to a
  computer that is asleep waits for that computer and says so, instead of failing.
- **Skills and instructions by reply.** When a persona working on a mail wants to save a skill or
  change your standing instructions, it proposes it in the reply and your answer by mail is the
  approval — instead of raising a card that expired to "no" before anyone saw it.
- **Every mail and chat turn records the Stem that made it.** So when personas improve, you can
  tell which of their earlier mails came from the older version; the Inbox marks those.

### Stem on your phone

- **An iPhone app.** Stem has a real phone app again, on TestFlight: pair it from
  **Settings → Server → Pair a phone** by scanning a QR (or opening the link it encodes), and your
  chats are on your phone — the full list, replies streaming in as they are written with the same
  rich formatting as the desk (tabs, tables, checklists, quizzes and forms you can answer), a new
  chat from the + button, and the same approval cards for commands and coding agents, so a
  question the assistant has for you no longer waits for you to get back to your desk. It reads
  what it cached when there is no signal. Settings on the phone are your Stem's settings — models
  included — in the chat list's clothes.
- **Notifications that know where you are.** The phone is pushed when the assistant needs an
  approval, when a long turn finishes, and when a scheduled task has something for you — but only
  while nobody has touched a desktop Stem in the last five minutes. At your desk, the desk shows
  it and the phone stays quiet. Pushes carry no content, only a tap that opens the right thread.
- **Chats on a slow link.** Against a far-away server, marking read, archiving and snoozing
  apply the instant you act, and the chat list and settings paint from the local copy while the
  fresh answer crosses the wire — no more settings panes flashing defaults.

### Coding agents

- **Hand coding work to a coding agent.** Settings → App → Coding agents turns on a tool that lets
  the assistant delegate a job to Claude Code (or any agent speaking the same protocol) in a folder
  you name: it briefs the agent, watches it work and reports back with what changed. You see a
  live row in the activity strip — "claude: editing src/foo.ts · 3 tool calls" — and every ask
  the agent escalates comes to you as an approval card, on the desk, in Quick Chat and on the
  phone, with the file diff when there is one. Your command approval mode applies to the agent's
  commands too: what you would let the assistant run itself, the agent may run; anything else,
  and anything touching a read-only folder, is a card. The agent runs where Stem runs, or on one
  of your paired computers if that computer has switched on **Run coding agents on this
  computer**, and you can pin which model it uses.
- **Code personas.** Pin a persona to an agent and a folder and it becomes a colleague who works
  in that repo — mail it a task from the Inbox or your phone. Only a persona with such a pin may
  use a coding agent, and two mails aimed at the same repo take turns rather than editing over
  each other.

### Stem on a server, and your other computers

- **Folders on your other computers.** A connected folder can now live on your Mac while Stem
  runs on a server: this Mac mirrors it to the server, keeps the copy fresh (on change, on
  reconnect and every fifteen minutes), and Stem indexes and reads it there. The Folders tab
  groups folders by the machine they live on and shows sync state, the last sync and what was
  left out and why (Git internals, packages, OS junk, anything over 25 MB); a first sync of a big
  folder shows its progress in the toolbar rather than reading as stuck. Read-only stays read-only
  on both machines: a command aimed at your Mac that would touch such a folder is refused there
  too. A folder that vanishes freezes its mirror instead of ever reading as "delete everything".
- **Several chats at once.** A long turn in one chat no longer holds up your question in
  another: Stem runs conversations on a small pool of workers, so a scheduled task, a persona's
  mail and your own chat proceed in parallel. Stopping one leaves the others alone.
- **MCP servers can run on the computer that has the tools.** With Stem on a server, a tool that
  only means something on your own Mac — a command it has installed, a URL on your home network —
  can be pinned to that Mac and runs there, while everything else still runs on the server and
  answers from your phone. Tools → MCP servers lists your servers under the machine that runs
  each one, and asks you to approve a server the first time it is set to run on the computer
  you are at.
- **Commands on your own computer.** With Stem on a server, ask from your phone and the
  assistant can run a command on your Mac — "download this video on my Mac" now means your
  Mac, not the server. Nothing changes until you allow it: each computer has its own **Run
  commands on this computer** switch (Settings → App → Command execution, on that machine),
  off until you turn it on there. Commands then face the same approvals as always, except
  stricter — nothing is pre-approved on a computer, and an "Always allow" you grant applies
  to that computer alone. Every approval card says which machine it is for.
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
  in its own container, and Settings → Memory points at `http://ollama:11434`. It stays off
  unless you ask for it — nothing is pulled, nothing runs — and, measured, the embedder built
  into Stem is just as good, so this is for people who already run Ollama, not a step up.
- **The assistant knows which computer it is on.** Ask it why a tool is failing and it now says
  which machine is missing the program, instead of assuming everything runs on the computer in
  front of you. It can list your MCP servers with where each one runs and whether each one is
  actually connected — an expired sign-in is named, with directions to reconnect, instead of
  guessed at.
- **Pick the server's folders from afar.** Adding a connected folder from a remote client used
  to open the picker for the disk in front of you — the wrong disk. It now browses the server's
  folders, with a path field for anything you would rather type.
- **Skills say which computer they need.** A procedure that only works on one machine — a
  program only your Mac has, a site that turns a server away — now gets written down that way,
  with the reason and the way in, instead of as steps that quietly assume whichever computer
  Stem happened to be on that day. This matters after moving Stem to a server: your skills come
  across intact and are then followed somewhere else entirely. Skills already saved are
  unchanged; this applies to ones written from now on.

### Chats and the app

- **Your own look.** Settings → App → Appearance follows the system, forces light or dark, or
  loads a theme of your own — a small JSON file of color overrides in the themes folder
  ("Open themes folder" drops an example in). One choice paints every window, including Quick
  Chat.
- **A slimmer composer.** Effort is a slider whose stops are the model's own levels, beside a
  label like "High · Claude Opus" — click it and the same searchable picker as Settings opens, so
  the model changes without leaving the chat. Speed and Format are single toggles. Quick Chat has
  the same row.
- **Settings, rearranged.** Models leads with status — a dead sign-in is a banner, providers are
  tiles with a status dot — and the role pickers fold into "You chat with these", "Judgment work"
  and "Quick tasks". App is the shell (keyboard, notifications, commands, coding agents, about);
  Chat is the conversation (model, subjects, previews, instructions, and Quick Chat, which moved
  in from App). Bulky editors sit behind disclosure rows.
- **Stop works the moment you press it.** Stop was dead for the whole "Working…" phase and could
  look like it failed after; now it cancels a turn at any stage, the button reads "Stopping…"
  until it has, and a stopped turn cannot flicker back to life.
- **Fast for Grok.** The Standard/Fast speed switch now appears for Grok models too — Fast asks
  xAI to schedule your request with higher priority. Until now the switch only existed for
  ChatGPT models, which is why it seemed to vanish when you picked Grok.
- **Web search switch in the composer.** A **Web** button now sits next to MDX and Note, so
  turning search off for a question no longer means a trip to Settings. It stays where you leave
  it, and it is the same switch as Settings → Chat → Web search — so you can still set it once
  and forget it. Quick Chat has its own, set separately, for anyone who wants search on at the
  desk but off in the overlay.
- **Your own endpoint's models can think.** A Qwen3 or similar behind a custom OpenAI-compatible
  endpoint used to answer with thinking off and no way to turn it on. Selecting a Custom endpoint
  in Settings → Models now shows a per-model overrides box — pi's own format, and if you already
  have a working models.json, **Import** reshapes it for you.
- **More attachments understood.** A PDF dropped into a chat now goes to the model as its text
  (scans without a text layer still don't); iPhone photos in HEIC are converted on the way in
  instead of being skipped as unsupported; and Word documents in connected folders are indexed
  like text and PDF.
- **You can see when a skill was used.** The "Used N tools" line above a reply now counts skills
  too, and expanding it names each one Stem loaded for that answer. A skill was invisible before:
  it is not a tool call, so an answer built on a procedure saved weeks ago looked exactly like one
  Stem worked out on the spot.
- **Delete a skill from the app.** Click a skill in Tools → Skills to select it, then delete it
  with the button under the list — the same way servers are removed one tab over. Until now the
  switch only silenced one, and with Stem on a server the folder was out of reach.
- **Small things.** Collapsed chat folders show how many unread chats they hide. A new chat puts
  the caret in the composer. Right-click works on page content — copy, paste, open link, spelling
  suggestions — where Electron offered no menu at all. Search results open the same context menu
  as any chat row, so the chat you just found can be archived, renamed or deleted there.
- **Windows commands run in Git Bash.** On Windows the assistant's commands now run in Git Bash
  when Git for Windows is installed, so `ls`, `cat` and `grep` mean what you expect and quoting
  works the way it does everywhere else; without Git they run in Command Prompt as before.
  Settings → App → Command execution switches between the two. WSL's `bash` is deliberately not
  used: it runs inside a Linux virtual machine, where Stem cannot tell which of your folders you
  marked read-only.

### Security

- **Tighter walls around the assistant.** Its built-in file tools can now read only your
  connected folders and its own scratch space, and write only where you allowed writing — a
  prompt hidden in a web page can no longer point them at the rest of your disk. A paired
  device can hand the server a file, never a path on the server's own disk. The browser
  automation command lost its blanket pass: only its read-only subcommands run without asking.
  And pairing refuses plain `http://` to anything but this machine, so a pairing code and the
  credential it mints never cross a network in the clear.

### Fixed

- **A command you allowed is no longer reported as one you refused.** An approval card gave you
  two minutes and then quietly answered for you — with "the user declined", which the assistant
  then repeated back as if you had said it. Worse, when a turn asked to run two commands at once
  both cards were raised together while only the first was ever shown, so the second could run out
  of time behind it. Cards now wait ten minutes, only the card actually in front of you counts
  down, and running out of time tells the assistant that nobody answered — not that you said no.
  The last two minutes show a countdown, an answer that arrives too late says so instead of
  closing as though it worked, and a card raised while your phone was asleep is waiting for it
  when it reconnects rather than being answerable only at the desk.
- **Chats you moved to a server can be opened again.** After moving Stem to a server, every chat
  that came over listed normally and failed the moment anything opened it: the backend records
  the folder a chat ran in, and that folder was on the Mac the export came from. Scheduled tasks
  were where it showed — a watch task in one of those chats just said "failed" every morning, and
  said it nowhere else. Moved chats are now pointed at the new machine's own workspace, both
  during the move and on any chat that already came across, and a run that fails now says why in
  the Tasks tab and the log. Repointing a chat leaves its last-activity time alone, so opening an
  old chat — from search, usually, which is how you reach one — no longer reads as something
  having just happened in it and pulls it back out of the archive unread.
- **Commands work when Stem runs on a server.** Every shell command the assistant tried on a
  server install failed instantly with `spawn /bin/zsh ENOENT`, because Stem asked for a shell
  that Linux servers do not have — including the commands it runs to work out why something
  else is broken. It now uses the shell the machine actually has.
- **A signed-in MCP server stays signed in.** Services that rotate their tokens on every refresh
  (Fastmail, for one) decayed into "token has expired" hours after you reconnected, because the
  workers Stem now runs in parallel each refreshed on their own and the loser burned the token.
  Refreshes are coordinated, and a reconnect in Settings reaches every running worker.
- **One huge tool result no longer wrecks the chat.** A broad log query through an MCP server
  answered with two megabytes — several times a model's whole context — and the chat was
  unrecoverable. Tool results are capped, with a note telling the assistant to narrow the call.
- **A file Stem cannot read is no longer a file with nothing in it.** An unreadable settings,
  tasks or chat store — a permissions hiccup, a disk mid-write — used to be read as empty and then
  overwritten empty on the next save, taking custom instructions, schedules or the folder tree
  with it. Unreadable and absent are different facts now, and the first one never triggers a
  write. Failures the app survives are written to the log as what failed and what Stem did instead.
- **A chat driven from elsewhere opens whole.** A thread that had only been touched from the
  phone, over MCP or by a scheduled task opened as just its last exchange until a restart. It
  loads from disk first now.
- **Read means read.** A chat you are looking at in a focused window is read, whichever device
  or task wrote into it; a chat whose turn is still generating no longer goes bold before there
  is anything to read; and a chat you deliberately marked unread stays so.
- **The app never forgets its server.** A paired Mac could lose its server address and silently
  boot an empty built-in server — "my Stem is gone" — instead of failing visibly. The address
  is kept through everything but an explicit "use built-in server", and the file that holds it
  is written so a crash mid-write cannot leave it looking like a fresh install.
- **Memory search stays up while folders index.** Indexing a big folder saturated the shared
  embedding endpoint, every memory lookup timed out and the Memory tab called the endpoint dead.
  Background indexing now yields to live queries, and a long embedding pass shows its progress
  ("Embedding messages 312/2,290") instead of an hour-long row that reads as hung.
- **Right-click works on search results.** A chat you found by searching can now be archived,
  snoozed, renamed, filed or deleted straight from the result row, like any other row in the list.
- **⌘W no longer closes Stem.** Stem is not a browser, and the window it has is the app: a ⌘W
  (Ctrl+W) meant for the tab next door used to make Stem disappear mid-thought, taking the open
  chat and whatever was half-typed in the composer with it. The shortcut is gone from the menu,
  on every platform. Quitting (⌘Q) and the window's own close button are unchanged.
- **MCP tools no longer pose as web searches.** Any tool with "search" in its name — Home
  Assistant lookups included — used to appear in the activity feed as "Searched the web" with a
  globe icon, even though no web search happened. Tool calls are now labeled by what they
  actually are.
- **A remote client over HTTPS starts.** The event stream was the one connection that ignored
  the `https://` in a server address, and the app refused to launch against a TLS server.

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
