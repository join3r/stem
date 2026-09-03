# Stem

**A personal AI assistant for your Mac — ask from anywhere, get rich interactive answers, and let it remember, organize, and automate for you.**

Stem is an Electron desktop app (React + TypeScript) powered by [pi](https://pi.dev) under the hood. Bring your own model — sign in with Claude or ChatGPT, paste an API key, or point it at a local server.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-mdx-dark.png">
  <img alt="Stem rendering a rich MDX answer with steps, a data table, and a chart" src="docs/screenshots/hero-mdx-light.png">
</picture>

## Ask and keep working

Summon **Quick Chat** from any app with a global shortcut, ask, and dismiss it — you don't wait for the AI. A small status pill tracks progress in the corner of your screen and tells you (with an optional chime) the moment the answer is ready. Hit the shortcut again to read it, or hand the thread off to the main window.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/quick-chat-dark.png">
    <img alt="The Quick Chat overlay answering a question" src="docs/screenshots/quick-chat-light.png" width="596">
  </picture>
</p>
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/status-hud-dark.png">
    <img alt="The status pill announcing the answer is ready" src="docs/screenshots/status-hud-light.png" width="216">
  </picture>
</p>

Quick Chat keeps its own thread, model, and settings — separate from whatever you're doing in the main window. The same pill can also follow long-running main-window turns across Spaces and displays, so you always know when Stem finishes.

## Rich, interactive answers

Responses render as **MDX**, not walls of text: callouts, step-by-step guides, collapsibles, tabs, data tables, charts — even quizzes and forms whose answers feed straight back into the conversation. Prefer plain text? Toggle between MDX and Markdown per turn.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/mdx-showcase-dark.png">
  <img alt="An interactive quiz rendered inside a Stem answer" src="docs/screenshots/mdx-showcase-light.png">
</picture>

While Stem works you see live **tool activity** — web searches, file reads, terminal commands — and web-searched answers come with a **cited sources** list. A context meter shows how full the model's context window is and what the session has cost.

## Memory that compounds

**Stem Recall** is a two-level memory. Every conversation is captured into a searchable episodic store, and the important parts are distilled into durable facts about you — with evidence, confidence, sensitivity, validity, and conflict history. You stay in control: preview which facts get injected, pin or confirm them, resolve contradictions, forget any of them permanently, cap the storage, or switch memory off entirely.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/memory-facts-dark.png">
    <img alt="The Memory tab showing distilled facts Stem has learned" src="docs/screenshots/memory-facts-light.png" width="320">
  </picture>
</p>

Each turn receives only positively relevant active facts, plus up to five facts you explicitly pin; sensitive facts use a stricter relevance gate, expired or unconfirmed assistant claims stay out, and while two facts conflict only one side goes — marked conflicting, so the model treats it as uncertain instead of forgetting both. Relevance ranking runs on **bundled local models** (Qwen3 Embedding 0.6B and the Qwen3 reranker by default, with Multilingual-E5 and EmbeddingGemma as smaller options — downloaded once, run on-device) — or an OpenAI-compatible endpoint, or plain keyword matching. Nothing leaves your machine by default and embedding never blocks a reply.

## Organized like you think

Chats live in **Spaces** — nestable folders with drag-and-drop — alongside a date-grouped list of recent conversations and **full-text search across every chat**. Each message carries actions: retry, edit-and-rerun, branch into a new chat, copy.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/sidebar-spaces-dark.png">
  <img alt="The sidebar with Spaces, recent chats, and search" src="docs/screenshots/sidebar-spaces-light.png">
</picture>

## Automate it

Ask Stem to check something every morning and it becomes a **scheduled task**: a prompt re-run on a cron or one-time schedule inside its own chat, autonomously. Tasks that miss their slot (laptop asleep) catch up on launch, and a task can raise an alert when it finds something you should see.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/tasks-dark.png">
    <img alt="The Tasks tab with scheduled recurring tasks" src="docs/screenshots/tasks-light.png" width="320">
  </picture>
</p>

## Extend it

- **MCP servers** — connect Model Context Protocol servers by command or URL (with sign-in where the service supports it) to give Stem new tools. Running Stem on a server? Pin the ones that only mean anything on your own computer to that computer, and use them from anywhere.
- **Skills** — self-improving, app-scoped procedures Stem writes and refines for itself; a curator keeps them tidy.
- **Connected folders** — let Stem read folders like an Obsidian vault *in place*, read-only by default, with per-folder write and memorize toggles.
- **Custom instructions** — standing directives for how Stem should behave, with a separate layer just for Quick Chat. Stem can even propose edits to its own instructions — applied only with your approval.

## Bring your own model

First launch walks you through a short onboarding with in-app sign-in. Switch models any time from a searchable picker — per window, mid-conversation.

| Provider | Connection |
| --- | --- |
| Claude (Anthropic) | Sign in with your account (OAuth) or API key |
| ChatGPT (OpenAI) | Sign in with your account (OAuth) or API key |
| OpenRouter | API key |
| Ollama | Local server, no key |
| LM Studio | Local server, no key |

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/settings-providers-dark.png">
    <img alt="Settings with the model picker and AI providers" src="docs/screenshots/settings-providers-light.png" width="320">
  </picture>
</p>

Native **web search** uses your provider's built-in search — no separate search API key.

## Getting started

Runs on **macOS and Linux** (release installers). **Windows** can run from source
for development — see [Windows development](docs/windows-dev.md) (portable Node,
no admin; experimental).

Development needs **Node.js 24 or newer** (`node:sqlite`, which backs the
recall store, is only flag-free from 24). There's an `.nvmrc`, so `nvm use` picks the right one
on macOS/Linux; on Windows use a [portable Node zip](docs/windows-dev.md) if you lack admin rights.

```bash
npm install
npm run dev      # launch the app in development
```

`npm install` also downloads the Electron binary (~120MB). Electron 42 dropped its own install
script and now fetches the binary lazily on first `require('electron')`, which electron-vite never
does — so a `postinstall` here handles it. It warns rather than fails if the download doesn't go
through, so `npm run dev` preflights for the binary (and for the Node version) and prints the one
command to re-run; you can also check on its own with `npm run preflight`.

npm 11 may warn that `N packages have install scripts not yet covered by allowScripts`. Nothing in
Stem needs them — every native dependency ships prebuilt binaries through its platform package — so
you can leave them unapproved.

First run opens the onboarding wizard — pick a provider and sign in, and you're chatting. Use `--fresh` (or `--profile=<name>`) to try Stem with a separate profile without touching your main one.

### Installing a release

Grab an artifact from [GitHub Releases](https://github.com/join3r/stem/releases):

- **Linux** — `.AppImage` (make it executable and run it, any distro) or `.deb` (Ubuntu/Debian/Mint; also puts `stem` on your PATH).
- **macOS** — `.dmg`. Builds are currently unsigned: right-click → Open the first time, or run `xattr -dr com.apple.quarantine /Applications/Stem.app`.

### Linux notes

- **Summoning Quick Chat on Wayland** (default GNOME/KDE sessions): Electron's global shortcuts don't fire there. Instead, bind a system keyboard shortcut to `stem --quick-chat` (deb) or `/path/to/Stem.AppImage --quick-chat` — a second launch hands the toggle to the running app. On X11 the in-app global shortcut works as on macOS.
- A tray icon offers Summon Quick Chat / Open Stem / Quit. Stock GNOME hides tray icons without the [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/) — running `stem` again reopens the main window if you have no tray.
- Closing the main window leaves Stem running in the background (like the macOS dock behavior); quit from the tray.
- Secrets are encrypted via the system keyring (`libsecret`/kwallet). Without one, Stem falls back to plaintext files readable only by your user (mode 0600).

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Run the app in development (electron-vite) |
| `npm run build` | Type-check and build |
| `npm run typecheck` | Type-check only |
| `npm run lint` | Lint with ESLint |
| `npm test` | Run unit tests (Vitest) |
| `npm run test:e2e` | Run end-to-end tests (Playwright) |
| `npm run dist` | Package installers for the current OS (electron-builder) |
| `npm run eval:retrieval` | Run the real local-embedding Recall retrieval gate |
| `npm run eval:memory` | Run the real extraction gate against a configured OpenAI-compatible model |

## Tech stack

Electron, React 19, TypeScript, Vite (electron-vite), Vitest, Playwright, and unified/remark for MDX. Screenshots in this README are captured by `scripts/capture-readme-shots.mts`.
