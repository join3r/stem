# Building Stem from source

← [Stem guide](README.md)

Development needs **Node.js 24 or newer** (`node:sqlite`, which backs the
recall store, is only flag-free from 24). There's an `.nvmrc`, so `nvm use` picks the right one
on macOS/Linux; on Windows use a [portable Node zip](windows-dev.md) if you lack admin rights.

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

First run opens the onboarding wizard — pick a provider and sign in, and you're chatting. Use
`--fresh` (or `--profile=<name>`) to try Stem with a separate profile without touching your main one.

**Windows** runs from source for development only — see [Windows development](windows-dev.md)
(portable Node, no admin; experimental).

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

Electron, React 19, TypeScript, Vite (electron-vite), Vitest, Playwright, and unified/remark for
MDX. The model runtime is [pi](https://pi.dev). The iPhone app is SwiftUI, in [`ios/`](../ios/README.md).
