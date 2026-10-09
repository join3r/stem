# Settings

← [Stem guide](../README.md)

Maya uses ChatGPT for everyday consulting, adds a local Ollama model for sensitive
drafts, keeps command approval on **Assisted**, and gives Quick Chat short-answer
instructions.

<!-- TODO(screenshot): Recapture with the canonical Maya demo profile. -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../screenshots/settings-providers-dark.png">
    <img alt="Stem Settings with the model picker and AI providers" src="../screenshots/settings-providers-light.png" width="320">
  </picture>
</p>

Settings has four tabs: **App** (the conversation, Quick Chat, appearance, the Escape
key, notifications, About), **Features** (mail among personas, image generation, commands,
coding agents, computer control), **Server** and **Models**.

## Providers and models

Add a provider with:

- **Account**: ChatGPT, Claude, or Grok sign-in. Grok signs in with a code you
  confirm in the browser (SuperGrok or X Premium).
- **API key**: Anthropic, OpenAI, OpenRouter, or xAI.
- **Local server**: Ollama or LM Studio. Stem hides Ollama models without tool
  support; they cannot complete Stem turns.
- **Custom endpoint**: any other OpenAI- or Anthropic-compatible server, named by
  you. This is also how you add a second Ollama — one on your laptop as the local
  server, one on the office PC as a Custom endpoint with its address and a name.
  Leave **Model IDs** empty and Stem uses whatever the endpoint lists, re-checked
  every half minute, so a model pulled there later shows up by itself. Type IDs
  to pin a fixed set, which an endpoint that lists no models needs.

The selected model receives the prompt, attachments, and context Stem adds to that
turn. A cloud model receives that data on its provider’s service. A local model
sends it to the server address you configured.

### When your endpoint doesn’t describe itself

Stem shows the thinking-effort control — Off, Low, Medium, High, X-High — only for
a model that says it can think. Most servers say so; some don’t. A Qwen3 behind
your own endpoint often arrives looking like a model that cannot reason at all, so
it answers with thinking switched off and there is no control to switch it on.

Select the connected **Custom** server to get **Per-model overrides**, and tell
Stem what the endpoint didn’t:

```json
{
  "qwen3-32b": {
    "reasoning": true,
    "thinkingLevelMap": { "off": "off", "low": "low", "medium": "medium", "high": "high" },
    "compat": { "thinkingFormat": "qwen-chat-template" }
  }
}
```

Each key is a model id your endpoint serves. `reasoning` is what makes the control
appear; `thinkingLevelMap` says what to send for each level, and a level your
server can’t do goes in as `null` so Stem stops offering it. `thinkingFormat`
names how the request carries the thinking flag — which format yours wants is
something your server’s own documentation will tell you.

If you already run this endpoint under pi, you don’t have to type any of that
again. Open **Import from a models.json**, paste the file in, and pick the
provider — Stem pulls out what each model needs, folds the provider-wide settings
into every model, and fills the box in. Nothing is saved yet: read what it wrote,
change what you like, then Save.

Save re-checks what you typed and refuses anything that would leave Stem unable to
talk to any of your servers, so a wrong guess costs you a message under the box and
nothing else. Overrides stay put — Stem re-applies them every time it refreshes the
model list, and keeps them if you disconnect the endpoint, filling them back in
when you add one again.

This box is for the **Custom** server. If you need it for LM Studio, add LM Studio
as a Custom endpoint instead, with the URL `http://localhost:1234`.

**Web search** works with every model, not only cloud ones, and returns cited
sources. Under **Web search** you choose the backend that runs the search:
**Automatic** ends at one that needs no key, or pick a named one and paste its key.

Two backends need no key of their own because a connected account pays for them:
**ChatGPT / OpenAI** with a ChatGPT sign-in, and **Grok / xAI** with a SuperGrok or
X Premium sign-in. Grok runs the search inside Grok itself, so each search draws on
the same allowance as your Grok chats — one question can use a dozen searches. It is
never picked automatically; select it yourself if you want it.

## Command approvals

Turn **Run commands** off to disable shell commands. With **Assisted**, the selected
safety-check model receives the command and working folder. A cloud model processes
that text on its provider.

Commands run on the machine Stem itself runs on: your own computer normally, or your
server if you [moved Stem to one](../running-on-a-server.md) — so they see the programs
installed there, not the ones on the computer you happen to be typing on. On macOS and
Linux they run under `zsh`, or `bash`/`sh` on a machine without it; on Windows under
Git Bash when it is installed, otherwise `cmd.exe`.

- **Manual**: known-safe and always-allowed commands run; everything else asks first.
- **Assisted**: an AI safety check passes routine commands and asks about uncertain
  ones. A convenience, not a security boundary.
- **Yolo**: commands run without asking. Read-only connected folders remain
  protected.

On an approval card, **Always allow** saves a command prefix for future turns.
Keep prefixes narrow; `git status` grants less access than `git`. Approval cards
never create regex rules.

The Always-allowed commands editor also accepts manually defined **Regex** rules.
Stem matches one rule against each complete command segment, exactly as written,
including quotes and repeated whitespace. Matching is case-sensitive and implicitly
anchored at both ends, so explicit `^` and `$` anchors are unnecessary. For
example, this permits `kubectl get` with an optional kubeconfig before the verb
while leaving `kubectl delete` unmatched:

```text
kubectl(?:\s+--kubeconfig(?:=\S*|\s+"[^"]*"|\s+\S+))?\s+get(?:\s+.*)?
```

Every segment in a chain must match a Prefix or Regex rule independently. Regex does
not bypass protected-folder checks, unsafe command flags, or other command guards.
These expressions use JavaScript regex: overly broad rules grant broad authority,
and pathological expressions can make command approval unresponsive despite Stem's
length limits. Regex rules currently cover commands run by Stem's server only;
paired computers keep their separate prefix-only lists.

A card waits ten minutes for an answer. Only the card on screen counts down; when
several commands are waiting, each one's ten minutes starts when it becomes the card
in front of you. If nobody answers in time the command is dropped, and the assistant
is told that nobody answered — never that you refused. Any surface can answer: a card
raised while your phone was asleep is waiting for it when it reconnects.

On Windows, **Windows shell** defaults to Git Bash when Git for Windows is installed,
and falls back to Command Prompt if it is not. Stem looks for it without using
PowerShell, and only Git for Windows counts: WSL ships a `bash.exe` of its own, but
it runs in a Linux VM whose paths the read-only folder guard cannot check. If Git is
not in a usual place, paste the path to its `bash.exe`. Commands
then run in that one shell — quoting and the always-allowed list follow it (`dir`
vs `ls`). Pick Command Prompt yourself if you want cmd.exe even though Git is
installed.

<!-- TODO(screenshot): Command approval card with Allow once, Always allow, and Deny. -->

### Commands on your own computer

With Stem on a server, the assistant can also run a command on one of your own
paired computers — "download this video on my Mac" — but only after that computer
says yes: **Run commands on this computer**, at the bottom of this section *on that
machine*, is off until you switch it on there, and there is no way to switch it on
from anywhere else. Withdrawing consent is the same switch; commands stop
immediately.

Commands on a paired computer are for shell work there: files, git, scripts, opening an
app. Driving its screen — System Settings, clicking, typing, AppleScript at its apps — is
what a persona with a computer pin (Manage → Personas → "Computer this persona controls"),
or a chat allowed to control that Mac (see [Coding agents and computer
control](#coding-agents-and-computer-control)), does with its `computer` tool, under your
consent switch and banner. Once a persona is pinned to a computer, a GUI-scripting command
from any conversation that may not drive it is refused and told to hand the task over;
with no persona pinned, the command runs under the usual policy.

Once a computer accepts commands, they face the same approval policy as everywhere
else, with one deliberate difference: nothing is pre-approved there. Even commands
Stem considers routine ask (or pass the safety check) until you choose **Always
allow** — and an Always allow given for that computer trusts the prefix on that
computer only. The per-machine lists appear under the shared one and are edited the
same way. The approval card always names the machine a command would run on.

What runs there stays there: the command's output lands on that computer (in a
per-chat scratch folder unless the assistant names a folder like Downloads), and
your Files place stays with the server.

### Scratch files

Commands run in a folder of their own per chat, so downloads, scripts and build
output stay with the conversation that made them. **Scratch files** lists those
folders biggest-first with the chat each belongs to; **Clear** empties one without
touching the conversation.

A folder goes when you delete its chat, and otherwise once nothing in it — and
nothing in the chat — has been touched for the period you choose (7, 30 or 90 days,
or **Never**). Treat scratch as working space: anything you want to keep belongs in
your Files, which the assistant can copy into and which is not swept. Scratch is
also left behind when you move Stem to another machine.

## Coding agents and computer control

A coding agent (Claude Code, Codex, OpenCode, …) takes programming work off Stem's
hands; computer control lets Stem see a Mac's screen and click and type there. Both
come from two places, and a conversation gets them from exactly one:

- **A persona** gets them from its own setup in Manage → Personas: a coding setup
  (agent, computer, folder) and a computer pin ("Computer this persona controls").
  A persona without one has no coding agent, or no computer control — whatever the
  switches below say. Chatting as your Secretary will not start Claude Code unless the
  Secretary has a coding setup.
- **A chat with no persona** (Quick Chat included) gets them from Settings → Features →
  Coding agents / Computer control → **Allow in chats**. Off by default. The switch
  belongs to your Stem server, so it covers chats from every device, the phone too.
  Scheduled tasks never use it: a task that needs a coding agent runs as a persona that
  has one.

When a chat is allowed, the row under the switch says where the work goes:

- **Let the model choose**: the chat is told which agents Stem knows and which
  computers have switched the feature on, and picks from them per request ("fix the
  build on the Linux box with Codex"). Suits strong models.
- **A fixed computer** (and, for coding, an agent): every chat's run goes there, and the
  model has nothing to decide. Suits small or local models. The agent has to be
  installed on that computer; if it is not, the run fails with the agent's own error.

A chat uses these only when you ask: it does not start a coding agent for an ordinary
question. It works in the folder you name ("fix the tests in ~/code/app"). Left
unnamed, a run on Stem's own machine uses the chat's scratch folder, and a run on
another computer stops to ask you which folder. A computer that is asleep or has
Stem closed fails right away with a message saying so; nothing is queued.

Each computer still has to agree for itself: **Run coding agents on this computer**
and **Let Stem control this Mac**, in the same section *on that machine*. Command
approvals apply to what a coding agent runs, the same as for personas.

If Stem says it cannot use a coding agent or control the computer, it names the
reason: the chat runs as a persona without that setup, or chats are switched off here.

## Image generation

Ask for a picture in plain words ("draw a sprout in a terracotta pot", "make a logo for
…", "make the sky darker") and Stem makes it and shows it in the reply. It can also
start from a photo you attach. Pictures come from your **ChatGPT subscription**, not an
API key, so this needs a ChatGPT sign-in under Models, and each picture uses your plan's
image allowance. One picture takes 20–60 seconds. While it's being made, the reply shows
a placeholder with a timer, and Stop cancels it.

Settings → Features → **Image generation** switches it on or off for every chat and
persona at once, mail and scheduled runs included. It is on by default whenever you're
signed in with ChatGPT. Code personas never make images: they only relay to their
coding agent.

The assistant sees the pictures it made, so you can ask for changes. Only the newest
three stay in its view as pictures. Older ones stay in the chat and can still be edited
when you ask. Pictures are kept with the chat and deleted with it. Your prompt, and any
image used as a starting point, go to OpenAI, even in a private chat.

## Escape key

- **Off** — does nothing while Stem is working.
- **Single** — stops the turn and retracts the sent message.
- **Two-stage** — first press stops; second press retracts.

## Notifications

How a [scheduled task](scheduled-tasks.md) reaches you on a run that found something.

- **Pop-up** — Stem comes to the front and shows the message in a dialog.
- **Nudge** — the dock bounces (the taskbar flashes); focus stays where it is.
- **Inbox only** — nothing interrupts you.

All three deliver the same mail to your Inbox, so nothing is missed either way.
Only how much it interrupts changes.

## Context used across chats

- **Files folder**: files Stem may read from any chat. They are not automatically
  attached to every prompt.
- **Standing instructions**: directions applied to the main app and Quick Chat.
- [**Memory**](memory/README.md) and
  [**Connected folders**](connected-folders.md) have their own controls. Their
  enabled, relevant content may be added to a turn.

When Stem proposes changing standing instructions, review the approval card before
accepting.

## Quick Chat defaults

Set a separate model, effort, speed, web-search choice, shortcut, finish sound,
idle reset, and extra instructions. Extra [Quick Chat](quick-chat.md) instructions
are added on top of the standing instructions.

**Show on all displays** lets the overlay follow Spaces and displays. **Show progress
on other Spaces** can also show progress for the main Stem window.

**Skip the Inbox** sends quick chats straight to **Archived** once answered, so a
throwaway question never waits in the Inbox. **Open in Stem** brings the
conversation back to the Inbox, as does continuing it from the main window.

On Linux with Wayland, set the command shown in Settings as a desktop keyboard
shortcut; the recorded global shortcut cannot fire there.

## About

Shows the version you're running — worth quoting when you report a problem.

**Updates** says whether a newer Stem exists and what to do about it. On Linux
(the AppImage) a new release downloads in the background and installs itself the
next time you start Stem — or right away with **Restart now**. On a Mac, **Get
the update** opens the release page and you install it the way you did the first
time. **Check now** asks immediately; **Check for updates automatically** turns
the periodic check off entirely. The check asks one question of GitHub, where
Stem's releases live, and sends nothing about you or your chats.

**Show what's new after an update** opens the release notes once, the first time you
run a new version; the popup has the same switch if you'd rather turn it off there.
**View release notes** opens the full history at any time.
