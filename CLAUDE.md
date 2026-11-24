# Stem: rules for coding agents

## Done means verified where the user will see it

An audit of the history (2026-11-18) found that about 40 % of non-chore commits fix
work built shortly before, with a median of 2 days between the bug going in and the fix.
In nearly every case the broken work had been checked only by unit tests, a dry run, or
an e2e test that skipped the real interaction. The agent often said so, and the task was
closed anyway.

A task is not done until the change has run the way the user will use it:

- **Desktop UI** (renderer, Quick Chat / Ask about this window, composer, mail, settings):
  run a separate dev instance with its own profile (`STEM_PROFILE=<name>
  STEM_DEVTOOLS_PORT=<free port> npx electron-vite dev`), drive it over CDP
  (`agent-browser connect <port>`), do the user's actual clicks and keys, and take a
  screenshot. Never test against the user's running Stem.app or the real profile.
- **iOS**: build, install and screenshot in the Simulator against a separate server
  (`STEM_STATE_DIR=…`), never the VPS.
- **Prompts, recall gates, skill or tool gating, anything a model reads**: run at least
  one real-model turn on the case that prompted the change, plus one that used to work,
  so a regression shows up.
- **Deploy and release scripts**: a dry run is not a test. Run the real thing, or leave
  the task open.
- **Integrations** (browser extension / jbrow, computer control, MCP, relay, LM Studio):
  exercise the real connection end to end once.
- **Bug fixes**: reproduce the bug first and confirm it is gone afterwards in the same
  place. A new e2e test must click and type through the visible UI like a person, not
  set hidden inputs or call handlers directly.

If you cannot verify it (no GUI access, needs the user's device, costs real quota they
did not approve), do not call the task done. Say plainly "built, not verified", what
remains to check, and how. "Tests pass" alone is never the closing line for a UI,
prompt or integration change.

## Before you start a fix

Search `git log` for earlier fixes to the same area. If this is the second or later
attempt, read why the earlier ones failed and say so in your reply before changing code.
