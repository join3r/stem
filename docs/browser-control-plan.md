# Browser control through a Chromium extension

Status: product decisions agreed; feasibility prototype in `experiments/browser-control`.
The production extension, installer, and Stem integration are not implemented yet.

## Purpose

Control the user's existing signed-in browser tabs without an open DevTools TCP
endpoint. Initial support is Arc and Chrome on macOS. Keep the protocol portable
for later Windows/Linux support.

## Agreed behavior

| Area | Decision |
| --- | --- |
| Installation | Settings offers Install browser control; prepare the bundled helper, open the extension store listing, let the browser confirm installation, detect the connection. |
| Access modes | Selected tabs, selected sites, or all ordinary tabs; configurable by the user. |
| Default | Selected tabs, plus automatic access to tabs Stem opens at their initial origin. |
| Discovery | List titles and URLs of ordinary tabs on request, including unapproved tabs. Reading their content still requires a grant. |
| Tab grants | Expire on tab close or browser restart. An extension restart may conservatively discard grants too. |
| Persistent grants | Site and all-tab access persist until changed/revoked. |
| Navigation | Crossing an origin requires a grant for the destination unless already covered by site/all-tab permission. This also applies to Stem-created tabs. |
| New tab approvals | Approve inside the browser, not remotely from a phone. |
| Remote and scheduled use | Allowed while the browser's desktop is connected and awake, under the same permissions. New tab grants wait for browser approval. |
| Consequential actions | Separate configurable policy. By default, ordinary navigation/filling proceeds and consequential submissions require confirmation in Stem, including on the phone. Semantic classification is a heuristic, not a security boundary. |
| User takeover | Interaction in the controlled tab pauses its automation. Explicit Resume is required; unrelated tabs may continue. |
| Focus | Operate in the background where possible; ask before taking focus. |
| Connection loss | Reconnect and inspect before continuing. Never automatically repeat an action with an unknown outcome. |
| Private windows | Excluded from v1. |
| Visibility | Show the controlled tab, provide Stop in the extension, retain browser actions in existing Work history. |
| Page features | Reading, screenshots, navigation, clicking, typing, forms, uploads and downloads. |
| Uploads | Explicit attachments or files allowed through Stem's file permissions. Permission to read a file is distinct from authorization to submit it to a website. |
| Downloads | Save to a configured folder. |
| Exclusions | Browser configuration management, bookmarks/history management, extension management, and saved-password management. |

## Proposed technical implementation

Commands flow from Stem's existing device-routed tools to a desktop browser
controller, through a bundled native helper and Native Messaging, to the extension.
The browser launches the helper and communicates on stdin/stdout. No public or
unauthenticated localhost browser-control server is needed.

The extension ID allowlist restricts browser-originated Native Messaging clients;
it does not authenticate arbitrary local processes to Stem. The desktop/helper
connection needs its own authenticated, bounded protocol and lifecycle. A host
origin command-line argument is not proof of caller identity. Do not claim this
design protects an already-compromised OS account from its own malware.

Use the existing device MCP host/router infrastructure for naming and routing, but
do not inherit trusted MCP's lack of per-action approval for consequential browser
actions. Keep access grants in the browser, distinguish them from submission
approvals in Stem, and validate both at execution time.

Relevant current code:

- `src/desktop/mcp-host/index.ts`: device-local MCP execution and remembered catalogs.
- `src/server/mcp-device/router.ts`: calls addressed to the paired desktop.
- `src/desktop/local/index.ts`: client-owned approval/settings channels.
- `src/server/workspace/connected-folders.ts`: folders and their source devices.
- `src/server/files/staging.ts`: uploaded file handles.
- `src/server/mail/work.ts`, `src/shared/work-detail.ts`: persisted activity and display.
- `src/renderer/manage/tabs/settings/SettingsTab.tsx`: current Settings organization.

Resolve file IDs against the device which owns the bytes; a server pathname is not
a pathname on the Mac. Stage permitted attachments on the browser's desktop and
pass short-lived file handles through the controller. Never expose raw
`DOM.setFileInputFiles` or arbitrary filesystem paths as a model-facing escape
from the file gate. Check download destinations against the configured folder.

Expose bounded commands such as list/open/inspect/fill/click/screenshot, not a raw
CDP relay or a general JavaScript evaluator. Revalidate the tab, origin, document,
permission revision, connection session and pause state when a queued command runs.
Bind evaluations to unique document contexts. Do not permit an allowed top-level
tab to grant access automatically to unrelated iframe origins.

Use request IDs and explicit action outcomes: not started, completed, failed, or
unknown. A disconnected or timed-out submission is unknown unless completion can
be established. Reconnection cannot turn an unknown result into a fresh submission.
Stop/revoke must cancel pending work and invalidate approvals for stale documents.
Log useful action metadata while redacting credentials, form values and sensitive
URL parameters; avoid automatically retaining full-page captures in activity logs.

## Prototype and validation gates

The probe has a scripted native peer, not a running Stem integration. It only
controls fictional loopback pages, uses temporary profiles, and never registers a
helper in a normal browser profile. It validates the communication path and CDP
capabilities independently of Playwright/CDP control of the browser itself.

Chrome for Testing and installed Chrome have completed live Native Messaging,
tabs, form, screenshot, file-selection/download and origin/frame/Stop checks.
See the experiment README and recorded evidence for exact final coverage.

The initial Arc attempt did not initialize the requested temporary Chromium
profile or connect the native host while the normal Arc instance was already
running. The probe process was stopped. This establishes a test-harness limitation,
not that Arc lacks extension or Native Messaging support. Arc remains unverified.
Do not silently replace this test with control of the user's existing Arc profile.

One live finding changes the takeover implementation: `Input.insertText` dispatched
through extension CDP produces `isTrusted: true` input events. That property alone
cannot distinguish human input from automation. Prototype a conservative policy
using correlated automation events and independent interaction signals; if reliable
distinction cannot be established, return with that limitation and an explicit UX
tradeoff before promising automatic pause.

Whole-tab captures include cross-origin frames. The prototype refuses screenshots
containing unapproved frame origins and inspects only top-document text. Production
must preserve that boundary, or implement verified masking/additional frame grants.
The current probe is not evidence for adversarial frame/navigation race safety,
OOPIF interaction, native OS dialogs, CAPTCHA handling or arbitrary-site fidelity.

## Delivery sequence

1. Complete Arc compatibility and takeover experiments; record exact evidence.
2. Build authenticated desktop/helper sessions and bounded browser commands.
3. Implement browser-owned grants, frame/document enforcement, pause/Stop/revoke.
4. Integrate submission approvals, permitted file transfer, remote routing and Work.
5. Add Settings and extension onboarding/control UI, then distribution packaging.
6. Validate fresh installation, both browsers, restarts, navigation races, user
   takeover, remote/scheduled flows, file permissions, uncertain actions and revocation.

## Primary references

- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome extension installation](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)
- [Chrome's removal of the load-extension launch flag](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)
- [Arc extension support](https://resources.arc.net/hc/en-us/articles/19434259167767-Extensions-in-Arc-How-to-Import-Add-Open)
