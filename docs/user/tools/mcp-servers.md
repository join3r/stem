# MCP servers

← [Stem guide](../../README.md) · [Tools](README.md)

Examples only. Stem does not bundle these. Add a compatible MCP server from a
provider you trust.

| Example | Possible use |
| --- | --- |
| **Gmail** | Find client email; draft a reply |
| **Calendar** | Check availability; prepare for a meeting |
| **Todoist** | Capture tasks; review work due today |
| **Slack** | Find a project decision; summarize a thread |
| **Jira** | Find or update project issues |
| **Grafana** | Inspect dashboards; investigate an alert |
| **Home Assistant** | Check home status; run a chosen automation |
| **Chrome DevTools** | Inspect a web app; diagnose console and network errors |

MCP servers give Stem tools from another service or program. No protocol knowledge
needed. Exact actions depend on the server and its account permissions.

Open **Tools → MCP servers**. Each server is one row with a status on the right: its
tool count when it runs, or **Sign in**, **Approve**, **Failed**, **Starting** or
**Off**. A bar above the list says when a server needs you.

<!-- TODO(screenshot): MCP servers list showing the eight demo servers, including URL and command examples. -->

## Add a server reached by URL

1. Select **New**, then **From a URL**.
2. Enter a name and the URL supplied by the service. Select **Add server**.
3. If it needs a sign-in, its page opens with a **Sign in** card; Stem opens the
   provider’s sign-in page in your browser. Review the account and permissions there.

Most of these need their MCP URL and, where supported, sign-in. Use the **Headers**
box only for a token the service supplied, and **OAuth client** only for sign-in
details it supplied. Put tokens there, not in chat.

Secrets are encrypted when the operating system’s secure storage is available. On
Linux without a keyring, they use an owner-only plaintext file.

## Add a server started by a command

1. Select **New**, then **From a command**.
2. Enter its trusted command and arguments.
3. Add required environment variables in the **Environment** box, then select
   **Add server**.

That command runs wherever your Stem runs, and starts only if the command exists on
that machine — see [Where a server runs](#where-a-server-runs). Check its publisher,
source, requested folders, and exact package version first.

## Paste a server from a README

Many servers' READMEs give a JSON block for Claude Desktop, Cursor or VS Code. Select
**New**, then **Paste JSON**, and paste it. Stem reads each server in it into a draft,
listed under **Not saved yet**. Nothing is saved until you open a draft and select
**Add server**.

## Change a server

Click a server to open it. The header holds its on/off switch and **Remove server**,
which asks once. A server waiting for a sign-in or an approval shows that card on top.
Below are tabs: **Connection** (the command or URL, arguments, environment variables
or headers, and the OAuth client), **Runs on** (when you have computers to choose
from), and **Status**. Stored secrets show as dots; leave them to keep them, or type a
new value. **Save** writes everything at once; **Cancel** throws the edit away.

## Works with apps

On a Mac, [**Ask about this window**](../quick-chat.md#ask-about-this-window-mac)
uses the server that covers the window's app. The model is told to prefer it
for reading and acting in that app, and to show you what it will send before
sending.

By default a server covers apps named like it: `slack` covers Slack,
`linear-mcp` covers Linear. To choose the apps yourself, open the server and
fill in **Works with apps** with app names or bundle ids, separated by
commas. Clear the field to go back to matching by name.

## Where a server runs

**Command** and **URL** say how Stem talks to a server, not where it runs. A server
runs on the machine Stem itself runs on unless you pin it to one of your computers,
and that machine is the one that has to have its command installed and be able to
reach its URL. If Stem runs on the computer you are sitting at, there is only one
machine and nothing to choose.

If Stem runs on a server elsewhere, a server's page gets a **Runs on** tab, and the list
splits into a section per machine — *On your Stem server*, *On this computer*, and one
for each of your other computers. Pick one of your own computers for a server that only
means anything there: its files, its applications, or a URL on its own network. To move
a server, open it, change **Runs on**, then **Save**. It starts only after you approve
it on that machine (**Approve and start**), and its tools then work from anywhere, including your phone, whenever
that computer is awake with Stem running.

A server pinned to the computer you are sitting at says how it is doing on its
**Status** tab, with **Test connection** and **Stop trusting it** beside it.

You can also just ask the assistant. It can list your servers and say where each one
runs, which is usually the fastest way to find out why one of them is failing — but
moving a server between machines is yours to do, not something it can do for you.

Phones are not offered as a place to run a server: they sleep, and the server would be
unreachable half the time.

A server pinned to a computer you later unpair moves to a section called **Nowhere —
that computer is gone**, and does nothing until you fix it. Pick another computer under
**Runs on**, pair that one again, or remove it. Pairing a computer again gives it a new
identity, so the same machine paired a second time is a different computer to Stem — the
row remembers the computer it used to mean, and offers that name first.

**Sign in is not available for a URL server pinned to one of your computers.** Signing
in happens where your Stem server runs, and that machine cannot reach an address on your
home network to do it. Use a static token instead: add an `Authorization: Bearer …`
header in its **Headers** box. That travels with the server's configuration and
works. A URL server that runs on your Stem server signs in as it always has.

## Before you connect

- A server reached by URL may send requests and relevant data to another service. Check
  its scopes, privacy policy, and retention.
- A server started by a command runs as you on whichever machine runs it, inherits
  Stem’s environment, and can reach the files, apps, and network allowed to that
  account.
- Assume Stem can use every tool an enabled server exposes; later calls may not ask
  again.
- Use the least-privileged account or token. Rotate a token pasted into chat.
- When Stem proposes a server, verify the URL or command in the approval card.
  Reject anything unexpected.

Stem can also change a server you already have, when you ask it to fix or update one.
The card, **Change MCP server**, shows only what changes, old next to new: the
command, the URL, environment variables and headers set or removed. Values of
secrets stay hidden. Everything not listed, stored tokens and sign-ins included,
stays as it is. When the change points the server at a new URL or command, **Goes
along** names the stored secrets the new one will get; approve only if you trust it
with them.

A server Stem builds or downloads for you is kept in a folder of its own inside
Stem's tools folder, never in a chat's scratch folder or in your Files, so deleting a
chat or tidying your Files cannot break it.

The switch in a server's header stops connecting but keeps the configuration and
sign-in. **Remove server** removes both.

**Connection failed** can mean expired sign-in, a bad or unreachable URL, or a server
error. Inspect the error, then reconnect or verify the URL and network.

**Failed to start: spawn … ENOENT** names a command the machine that runs the server
does not have — `spawn uvx ENOENT` means no `uvx` there. Install it on that machine,
or move the server to a computer that already has it. When Stem runs on a server, that
machine is the server, not the computer you are reading this on: a tool installed on
your Mac is not installed for Stem.
