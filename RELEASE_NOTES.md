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

## 0.6.0 — Unreleased

### Added

- **Rich answers, for real.** In an MDX chat Stem now answers with a chart, table, comparison,
  step list, diagram or form whenever the question calls for one; before, it almost never did.
  Short and conversational replies stay plain.
- **Charts, redrawn.** Charts fit the window at any size, show several series with a legend, and
  come as line, area, bar (turned on their side when labels are long), stacked, donut or scatter.
  Hover for exact values, or click **Table** to see the numbers.
- **Stats, comparisons, diagrams and suggested replies.** Headline numbers come as tiles with the
  change since last time; a choice between options is laid out side by side with the recommended
  one marked; flows and architectures come as diagrams. A longer answer can end with a few
  follow-ups you click to send.
- **Rich answers on the phone.** The iPhone app draws charts, tables, tiles, comparisons, steps,
  tabs, quizzes, forms and suggested replies itself instead of saying "Open on the desktop".
  Diagrams still show their source there.
- **Pinboard.** Keep what matters from a chat at the top of it: hover a message and click the
  pin, select a few words of a reply and click **Pin**, or type `/pin` and a note of your own. A
  strip under the chat title shows how many things are pinned and a short name for each, written
  for you in the chat's language (click **Rename** to choose your own). Open it to see them all,
  jump back to where each came from, or drag them into order; it closes when you click back into
  the chat, or stays put with **Keep open**. Stem also keeps everything on the board in mind for
  the rest of that chat, so a measurement or setting you pinned early on isn't forgotten once the
  conversation gets long. Chat search finds pinned notes too.
- **Stem in your browser.** With the new Stem extension in Arc, Chrome, Dia or Brave, Stem can
  work in your own browser, signed in as you: open pages in background tabs, read them, click,
  fill in forms, upload files you gave it, download, and look at a page's console and network
  requests. The tab it works in shows a border and a Stop button, and your view never switches.
  Give it to a persona with its new browser pin, or to plain chats under Settings → Features →
  Browser control, where **Set up** also installs the extension. No special browser launch, and
  no open debugging port.
- **Computer control without a server.** "Let Stem control this Mac" now shows when Stem runs
  entirely on your Mac too, not only when its server is elsewhere.
- **Commands at a slash.** Type `/` at the start of a message to see what the box can do —
  `/pin`, `/note` and `/learn` — narrow it by typing, and pick one with Enter, Tab or a click.

### Changed

- **Each chat has its own format.** MDX or Markdown is now chosen per chat: the composer toggle
  sets it for new chats and switches the chat you have open. Markdown chats no longer carry the
  instructions for rich answers, so they send the model less. An iPhone app older than this
  version can only set the format of new chats.
- **Sources as cards.** Under a web answer, the cited sites' icons show at a glance; open the
  list for a card per source.
- **Folders file chats only when you ask them to.** Making a folder now asks for a name, an
  optional description, and whether matching chats should move there automatically; the same
  dialog opens again from the folder's **Settings…**. Switching auto-filing on asks whether chats
  you already have should be looked at too. The old all-folders switch in Settings → App is gone,
  so existing folders stay as they are until you switch them on.

### Fixed

- **MDX answers render while they stream.** An MDX answer used to show as raw text, tags and all,
  until it finished. It now renders as it arrives, with a short placeholder where a chart or
  table is still being written.
- **Chat previews no longer show chart data.** A reply that opened with a chart or table showed
  up in the chat list as a line of raw data; it now shows the chart's title.

## 0.5.6 — 2026-10-02

### Added

- **Choose which MCP servers each persona may use.** Settings → Personas → a persona → turn off
  **Uses every MCP server** and tick the ones it gets, grouped by the machine they run on like the
  MCP tab. The rest are hidden from that persona entirely — not in its tool list, not searchable,
  refused if it guesses a name — in chats, mail and scheduled runs alike. Personas you have not
  touched keep every server, as before, and so do chats without a persona. A helper persona that
  an Orchestrator creates inherits the Orchestrator’s list, so a restriction cannot be sidestepped
  by delegating. Stem’s own memory tools are separate: that is still **Sees your memory**.
- **Open files the assistant links.** When a persona writes a file on your Mac, a CSV in
  Downloads for instance, and links it in the chat, clicking the link now opens it in its default
  app. Only documents open this way. Anything that could run when opened, like an app, a script,
  an installer or a folder, is shown in Finder instead.

### Changed

- **A second Ollama, on another machine.** Settings → Models → Add server only knows one Ollama
  and one LM Studio, so adding a second overwrote the first. Add the other one as a **Custom
  endpoint** instead, with its address and a name of your own — and now you can leave the model
  IDs empty: Stem keeps asking that server what models it has, every half minute, exactly as it
  does for the local Ollama, so a model you pull there later appears on its own. Typing IDs still
  pins a fixed list, which a server that lists no models needs; **Pin these** next to a green
  Test connection copies the found IDs in when that is what you want.
- **Message times.** Hover a message to see when it was sent, to the left of its avatar, with the
  day under it when it wasn't today. Times follow your computer's region and its 12/24-hour
  setting, so English on a Slovak Mac no longer shows 09:50 PM.
- **Honest tok/s.** An answer's speed is now measured per model call, with time spent running tools
  left out, so replies that used tools get a number too. Models that think silently, like GPT,
  are timed with that thinking included and no longer look several times faster than they are.
- **Read-only commands stay in your folders.** The assistant runs commands like `cat`, `ls` and
  `grep` without asking only while they read inside the folders its file tools can already reach.
  Reading anywhere else on the computer now asks first, and `find` always does.

### Fixed

- **Save Image on large pictures.** Right-click → Save Image to Downloads silently did nothing on
  a full-size generated picture.
- **A stuck Linux update says so.** When the AppImage found a new Stem but couldn't download it,
  nothing told you, and the old version kept running for weeks. The update dialog and banner now
  say what went wrong and offer the release page.

## 0.5.5 — 2026-09-30

### Added

- **Pictures.** Ask for a picture and the assistant makes it, through your ChatGPT sign-in rather
  than an API key, so it costs nothing beyond your subscription. The picture shows in the chat
  on the desktop and the phone. Click it to enlarge, and ask for changes to it in the same chat.
  **Download** saves it straight to your Downloads folder, and right-clicking offers the same. A
  persona's mail and a scheduled run's report carry the pictures they made. Settings →
  Features → Image generation turns it off.
- **Chats file themselves.** A chat that has sat untouched for a day is moved into whichever of
  your folders fits it, or left where it is when none does. Stem only uses folders you made and
  never creates one. A chat you already filed or moved yourself, even back out of a folder, is
  never touched again. Each chat is looked at once. Existing chats from the last 30 days get sorted
  too. Settings → App turns it off.
- **Forward a mail.** Any mail in a conversation can now be forwarded to other personas as a new
  conversation, with the original quoted under a note of your own. Pictures travel with it. Attached
  files are listed by name only, because Stem doesn't keep a file's contents after delivering it.
  Desktop only for now.
- **Coding agents and computer control in plain chats.** A chat that runs as no persona, Quick
  Chat included, can now hand work to a coding agent or drive your Mac, once you allow it under
  Settings → Features. It is off by default and never applies to mail or scheduled runs.
- **Computer control.** A persona pinned to your Mac can now see its screen and drive the mouse
  and keyboard, so it can work in apps that offer no other way in. It stays off until you turn it
  on — **Let Stem control this Mac**, in Settings → App on that Mac, and only offered when your
  Stem server runs somewhere else. macOS asks for Screen Recording, Accessibility and Input
  Monitoring the first time. A banner says so while the persona is working, and any key you press
  or mouse you move stops the run at once. There are no per-action approvals: the switch, the pin
  in Manage → Personas, and your own hand are the controls. Mac only, macOS 14 or newer.
- **Computer control reaches windows that aren't in front.** The persona no longer needs the app on
  your screen: it can list the open windows, pick one — on another Space, behind other windows,
  minimized — and work on it there, seeing that window alone and pressing its buttons and filling
  its fields through macOS Accessibility instead of moving your mouse. You keep typing in whatever
  you were doing; your keystrokes don't stop it, the banner's Stop button (now naming the app it is
  working in) does. Apps that draw their own controls — games, canvases — still need the persona to
  come to the screen.
- **Standing answers.** A persona that relays to a coding agent used to hand you the same question
  every time the agent asked it — "should I deploy this?" on every single change. It now keeps
  standing answers: you write them in the persona editor, and it also keeps your reply when you
  answer a relayed question by mail, so the next time the agent asks, the persona answers from what
  you said instead of asking you again.
- **The coding agent's own reply.** When a coding persona mails you an answer, the agent's own
  words now ride along beneath it in a collapsed **Coding agent's reply** block, on the desktop and
  the phone, so you can check the relay against its source.
- **Edit an MCP server.** Changing a server's address or its token no longer means adding it again
  from scratch. **Edit** opens the stored definition with its name and transport fixed, shows
  stored credentials as a mask you can leave untouched, and keeps the computer it runs on — where
  re-adding used to quietly move a server pinned to your Mac back onto the Stem server.
- **Notes with pictures.** A memory note (`//`, `/note`, or the Note button) can now carry an
  image: paste a screenshot or attach a photo, with or without text, and it is saved with the
  fact. Stem describes what the picture shows into the fact in the background, so a photo of a
  router label, a receipt, or a menu can be recalled later like any other memory. The picture
  itself stays yours: it shows in the fact's details under Manage → Memory and is never sent
  to the assistant again. Desktop only for now.

### Changed

- **Mail subjects name the topic.** A mail you sent without a subject used to be titled with the
  first sixty characters of your message, cut off mid-sentence. Stem now writes a short subject
  once the first reply arrives, the way it names chats. A subject you typed is left alone. On
  the first start of this version it also renames up to 100 of your recent conversations
  that still carry a cut-off subject.
- **Settings: App, Features, Models.** The Chat tab is now App, and mail, commands, coding agents,
  computer control and image generation sit together under Features. The phone follows the same
  layout. Models are picked only under Models: the duplicate pickers under Conversation and Quick
  Chat are gone.
- **Mail reads newest first.** On the desktop, a mail conversation opens at the top with the
  latest mail first.
- **Mac permissions at a glance.** Each macOS permission that computer control needs is now its own
  line in Settings, with a check or a cross and what a missing one is for. The list refreshes when
  you come back from System Settings.
- **Scripting your Mac goes through its persona.** When a persona is pinned to a computer, other
  personas can no longer script that computer's apps with shell commands. They are told to hand the
  job to the pinned persona instead, so the consent switch and the banner can't be bypassed.
- **Scheduled runs start fresh.** Every firing of a scheduled task now runs in a thread of its
  own, with nothing but the task's prompt, its persona and your memory — instead of appending
  to the chat it was scheduled from, run after run, until the context filled up and a morning
  task burned a fortune re-reading its own history. Nothing lands in that chat any more: a run
  that has something for you sends mail, and the mail keeps the run's work beneath it; a run
  that finds nothing leaves no trace. The one thing a run does carry over is what the task's
  earlier runs already mailed you — their headlines and reports — so a watch task reports each
  finding once instead of every morning. Because a run knows nothing of the conversation that
  created it, Stem now writes task prompts to stand on their own — and, once, on the first start
  after this update, rewrites the prompts of your existing tasks the same way, reading the chat
  each was scheduled from. One mail lists what was rewritten; each rewritten task keeps its old
  prompt in the Tasks tab with a **Revert**. Deleting the originating chat leaves its tasks in
  place.
- **A task starts failing: one mail.** The first failed run after a good one (or after none)
  sends a mail with the reason; repeated failures stay on the task's row in the Tasks tab, and
  a recovery sends nothing.
- **Runs as: one choice.** A task runs as a persona, or on a model of its own, or on the app
  default — never a persona and a model at once with the model silently ignored, which is what
  the two separate pickers allowed. "Chat model" is gone with the chat: the default is the app
  default.
- **Coding personas stay out of the way.** A persona that delegates to a coding agent used to
  check the agent's work itself — re-reading the diff after every exchange, sending it back for
  another round of review, once committing the change on its own, at a dozen agent runs for a
  single feature. It now passes your brief in and hands the reply back as it came, and calls the
  agent again only when you say something new.
- **Personas remember less, and better.** Left alone, a persona filled its note quota on nearly
  every turn with reworded versions of its own instructions. Reflection is now biased toward
  writing nothing at all, overlapping notes are merged from time to time and on demand with a
  **Tidy up** button in the editor, and a persona that delegates to a coding agent keeps no notes
  at all — the agent has its own memory. The first time you open this version, the notes a persona
  wrote about itself are cleared; the ones you wrote, and the ones it saved on purpose, stay.
- **MCP servers, rearranged.** Tools → MCP servers now reads like the Personas tab: a server's
  name opens an editor in place that you edit and Save, where it runs is a choice inside that
  editor, and each row carries its status dot, its switch and a delete button instead of a strip
  of text links underneath.
- **Skills hear when they were wrong.** When the assistant says that a skill it loaded was wrong
  for the step it was on, that report now counts: the skill is marked as having failed in
  Tools → Skills, and it goes to the front of the queue to be rewritten, with the assistant's
  reason handed over as evidence. Until now nothing read those reports.
- **The Mac download is signed and notarized — and Apple Silicon only.** macOS no longer warns
  about an unidentified developer, and permissions you grant the app now survive an update, which
  is what computer control needs. Intel Macs are no longer built.
- **A smaller Mac app.** It now unpacks to 560MB instead of 724MB: a machine-learning runtime and
  an icon set that the app never loaded were being packaged with it.

### Fixed

- **New chats on a ChatGPT login.** Every chat started on the built-in default model failed,
  because OpenAI stopped accepting that model on ChatGPT accounts. The default is now GPT-6.1 Sol.
  If you picked the old model yourself, pick another under Models.
- **A new chat on the phone opens.** Starting a chat on the phone showed "Could not read this chat"
  until the first reply arrived.
- **Web search on a ChatGPT login.** For five days, every web search from a Stem signed in with a
  ChatGPT account failed. Stem was asking for one particular search model, and OpenAI stopped
  accepting that name on that kind of login; Stem no longer names one.
- **Chat keeps your place.** Switching back to Stem's window while you were reading an older part
  of a long chat threw you to the newest message. Scrolling up now holds your place; scrolling back
  down, or sending a message, follows new messages again.
- **Photos from the iPhone camera roll.** Pictures the camera saves as HEIC could not be read by
  the server or the models. The phone now converts them before sending.
- **Repeated date headers in the chats list.** After a night of scheduled runs the sidebar could
  show "Previous 7 Days", then "Previous 30 Days", then "Previous 7 Days" again. Rows are now
  ordered by the date shown on them.
- **Tool details for an MCP server on another computer.** The assistant's request for a tool's full
  description never reached a server pinned to one of your computers: it timed out after five
  seconds and fell back to argument names with no types and no documentation.
- **Scheduled runs no longer move their chat.** A task that found something and sent you mail
  still dragged the chat it ran in to the top of the Chats list, bold, as if you had a new
  message there. The mail is the message; the chat now stays where your last message left it.

## 0.5.2 — 2026-09-09

### Added

- **Stem GTE Memory.** A new memory model, trained for Czech, Slovak, German and English. It is
  smaller and faster than the Qwen3 reranker and picks the right memories more often in Stem's
  benchmarks. It also reads the last two things you said, so a follow-up question finds the memories
  the earlier one was about. Manage → Memory → Reranker is where you switch, either way.
- **Switch chats from the keyboard.** ⌘1 to ⌘9 (Ctrl on Windows and Linux) open the first nine
  chats in the Chats list, counted from the top. Hold ⌘ for a moment and each chat shows its number.
- **Update dialog.** A newer Stem now announces itself in a dialog once per launch instead of a
  strip under the title bar that was easy to sit under for weeks. "Later" keeps the strip and the
  Settings → App row as the quieter reminders.

### Changed

- **Progressive disclosure v2.** The assistant used to be handed the full description of every tool
  from every connected integration, and every procedure, at the start of each reply. It now gets a
  short summary per integration and looks up the tools and procedures it needs. Replies start faster
  and cost less with many integrations connected, and adding one more no longer slows everything
  else down.

### Fixed

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
