# Stem guide

Pick the feature you see in Stem.

| Feature | Use it for |
| --- | --- |
| [Chats](user/chats.md) | Ask, attach files, organize conversations |
| [Quick Chat](user/quick-chat.md) | Ask from any app |
| [Memory](user/memory/README.md) | Learn useful context and recall earlier chats |
| └ [Facts](user/memory/facts.md) | Durable details: preferences, people, projects |
| └ [Recall](user/memory/recall.md) | Find relevant parts of past conversations |
| [Tools](user/tools/README.md) | Give Stem more capabilities |
| └ [MCP servers](user/tools/mcp-servers.md) | Connect services and tools, on this Stem or on your own computer |
| └ [Skills](user/tools/skills.md) | Reuse procedures that work |
| [Connected folders](user/connected-folders.md) | Use folders where they already live |
| [Scheduled tasks](user/scheduled-tasks.md) | Run a prompt later or repeatedly |
| [Settings](user/settings.md) | Choose providers, permissions, and defaults |
| [Shortcuts & tricks](user/shortcuts.md) | Keyboard shortcuts and composer tricks |
| [Moving and backups](user/moving-and-backups.md) | Take your Stem to another computer, or keep a copy |

## Demo profile

Maya, a fictional independent developer and consultant. Recurring connected folders:

- `Personal Obsidian`
- `Work Obsidian`
- `Argo CD — Kubernetes Code`
- `My App Source`
- `Invoices`

Realistic setup. No real personal or company data.

## Running from source

Not a feature you see in Stem — notes for building it and for running it somewhere else.

- [Windows development](windows-dev.md) — portable Node, no admin rights, `npm run dev`. Experimental.
- [Running on a server](running-on-a-server.md) — Docker and Caddy on your own domain, with
  the Mac as a client. The move itself, backups, upgrades, and what to do when it will not start.
- [Running on a LAN or Tailscale](running-on-tailscale.md) — the same containers, no public
  hostname: Caddy stays HTTP, Tailscale Serve is HTTPS, Funnel is optional and public.
