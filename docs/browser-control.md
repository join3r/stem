# Browser control through a Chromium extension

Status: built on the 0.6.0 branch (October 2026). User-facing page:
[user/browser-control.md](user/browser-control.md).

Stem drives the user's own, signed-in browser through the Stem extension, replacing
the earlier setup of launching Arc with `--remote-debugging-port` and pointing a
DevTools MCP server at it, which needed a special launch and left an unauthenticated
CDP port open to every local process.

## Decisions (2026-10-05)

These replace the stricter plan of 7 September 2026, which had per-tab grants, origin
gates, approval before submits, and an automatic pause when the user touched a tab.
The user chose the computer-control posture instead.

| Area | Decision |
| --- | --- |
| Reach | Any ordinary tab, signed-in ones included. No tab grants, no origin gates, no approval before a submit. Incognito is excluded. |
| Who | Its own persona pin, `Persona.browser {device}`, separate from the computer pin. Chats with no persona follow `chatFeatures.browser` (Settings → Features → Browser control → Allow in chats), either a fixed Mac or the model's pick. It applies to chats, mail and scheduled runs, as for computer control. |
| Consent | A client-local switch on the Mac, off by default and never sent over the wire. |
| Where | Pages Stem opens are background tabs in the user's last-focused window (in Arc, the current Space). Stem never switches the view, and the tabs stay open after the run. The model may also act in any existing tab, but closes only tabs it opened. |
| Debugging bar | `chrome.debugger` is attached on the first touch of a tab and detached at the end of the run, or after 3 idle minutes, so the bar shows only during runs. Cancelling the bar counts as Stop. |
| Marker | A border and a "Stem is working · Stop" pill inside the tab, drawn in a CDP isolated world and hidden while a screenshot is taken. There is no automatic pause, and no floating screen pill. |
| Actions | `tabs`, `open`, `navigate`, `snapshot` (an accessibility outline with refs), `screenshot`, `click`, `hover`, `type`, `fill`, `press`, `scroll`, `wait`, `dialog`, `evaluate`, `console`, `network`, `upload`, `downloads`, `close`. |
| Uploads | Only files Stem holds: Files, scratch, connected folders, `img_` ids, and the conversation's attachments, which a browser turn keeps as files. Never an arbitrary path on the Mac. |
| Downloads | Copied into the conversation's scratch `downloads/` on the server. |
| Several browsers | One per Mac, chosen in that Mac's Settings. The chosen browser is started (`open -g -a`) when a run needs it and it is closed. |
| Concurrency | Several runs at once, each keeping track of its own tabs, with one action queue per tab. A run is warned when another run used the same tab recently. |
| Platform | macOS only for now: Arc, Chrome, Dia, Brave, plus Chromium, Edge and Chrome for Testing when they are installed. |
| Install | An unpacked extension: Set up copies it into the profile's state folder and writes native-messaging manifests. The extension id is fixed by the manifest `key`. A Web Store listing comes later. |
| Local server | Works when the server runs on the same Mac. Computer control was opened up to that case at the same time. |

## How a call travels

```
pi `browser` tool ──ctx.ui.input(stem-browser-bridge)──▶ PiRuntime.handleMacToolBridge
  └▶ startup/browser.ts (files) ──▶ browser-device/router.ts ──SSE 'browser-request'──▶ Mac
       └▶ desktop/browser-host ──unix socket (0600, token)──▶ native host (Stem binary as Node)
            └▶ native messaging ──▶ extension service worker ──chrome.debugger/tabs/downloads──▶ tab
  ◀── answers return the same way; the Mac replies with RPC `browserHost:result`
```

- The wire messages and framing are defined in `src/shared/browser-native.ts`. Both
  legs use Chrome's 4-byte length framing, so the native host relays frames without
  re-serialising them.
- File bytes never travel in SSE frames or native messages (Chrome caps host→extension
  messages at 1 MB). For an upload, the server checks each file and copies it through
  the verified handle into a private outbox (`files/outbox.ts`, `files/browser-sources.ts`).
  The Mac fetches it once through `GET /files/stem-outbox:<id>`, the extension attaches
  it with `DOM.setFileInputFiles`, and the local copy is removed when the run ends.
- Downloads: the native host copies a finished download out of `~/Downloads` into the
  spool. It runs as the browser's child, so macOS attributes that read to the browser.
  The desktop then streams the copy up with `POST /upload`, and the server files it into
  scratch.
- The native host keeps retrying the socket while Stem is down. The open native port
  keeps the extension's service worker alive, so it sees Stem come back.

## Arc's unloaded tabs

Arc gives extensions only the tabs it has loaded since it started. A sidebar tab
nobody has clicked since then is not a Chromium tab at all, so `chrome.tabs` misses it
(found 2026-10-06: 2 of 101 tabs listed). For Arc, the desktop completes the `tabs`
answer from Arc's AppleScript dictionary (`browser-host/arc-tabs.ts`, about 0.2 s): the
extension reports the URLs it saw, and the rest are listed by Space without ids. To work
in one, the model opens its URL in a new background tab. Stem never selects a sidebar
tab, because that would switch the user's view. The first read asks for macOS Automation
permission (Stem → Arc).

## Security notes

- The token in `<state>/browser/config.json` (0600) proves only that the native host was
  installed by this Stem profile. It does not protect against malware running as the
  same user, which could read the same file.
- `allowed_origins` limits which extension the browser lets start the host.
- Page content is untrusted. The tool description and the persona brief tell the model
  never to follow instructions found on a page. That is the main defence against a
  hostile page steering a run into the user's other signed-in tabs, and it is a
  prompt, not a boundary. The user accepted that trade for the no-approvals posture.

## Feasibility probe

`experiments/browser-control/` holds the September probe, which passed 14/14 checks in
Chrome and Chrome for Testing. Arc stayed unverified because Arc ignores
`--user-data-dir`, so an isolated second instance never started. Arc is reported to read
native-messaging manifests from Chrome's folder, so Set up writes to both Arc's folder
and Chrome's. One probe finding still holds: `Input.insertText` through extension CDP
produces `isTrusted: true` events, which is part of why automatic pause on takeover was
dropped.
