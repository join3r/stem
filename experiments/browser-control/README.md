# Stem browser-control feasibility probe

This is a development experiment, **not the installable Stem integration**. It
controls only fictional loopback pages in newly created browser profiles. Do not
register it as a trusted MCP tool or install it into a normal browsing profile.

The agreed product behavior and integration sequence are in
[the browser-control plan](../../docs/browser-control-plan.md).

## Results — 2026-09-07

| Browser | Result |
| --- | --- |
| Installed Chrome 152.0.7977.77, macOS | All 14 live checks passed. Extension installed using Load unpacked in a temporary profile. |
| Chrome for Testing 149, headless macOS | All 14 live checks passed. Extension loaded by its supported launch flag. |
| Arc 1.163.1, macOS | Unverified. The attempted second process did not initialize its requested temporary profile or connect the native host while normal Arc was running. Test process stopped; normal Arc was left running. |

Final captured results and launch arguments are in [results](results). The browser
user-agent string reduces patch versions; installed application versions above
were read separately from their macOS Info.plist files. Four policy unit tests and
scoped ESLint also passed.

The native host drives every browser action via Chrome Native Messaging. The
runner launches the browser using `spawn`; it never connects through Playwright,
CDP TCP, or a debugging pipe. Playwright is used only to find its installed test
browser executable. Two temporary loopback HTTP servers serve fictional pages;
they do not expose browser control.

Live checks cover:

- Native handshake; listing a pre-existing fixture tab without granting access.
- Rejecting an attempted native-peer permission grant and non-web URLs.
- Opening background tabs, reusing a fictional session cookie, inspecting text.
- Filling fields and clicking a fixture control.
- PNG screenshots through the extension debugger API.
- Selecting and submitting a fictional file; checking the server received its bytes.
- Downloading a fixture and checking its contents and configured destination.
- Refusing direct cross-origin navigation and revoking access after a redirect.
- Allowing same-origin frame screenshots; refusing those with unapproved frames.
- Excluding child-frame text from the top-document inspection.
- Revoking access on Stop.
- Demonstrating that CDP-generated input has `isTrusted: true`.

The last result matters: **`isTrusted` alone cannot detect human takeover**. The
promised pause-on-user-interaction behavior remains a separate design/validation
task. Chrome also visibly showed its extension-debugging banner during the tests.

## Run

From the repository root, with its Node dependencies and Playwright browser present:

```sh
node --test experiments/browser-control/policy.test.mjs
npx eslint experiments/browser-control
node experiments/browser-control/run.mjs chromium
```

The runner needs permission to start a browser process and bind local fixture
servers. A sandbox `listen EPERM` means the test environment denied that bind,
not that Native Messaging failed.

For installed Chrome:

```sh
node experiments/browser-control/run.mjs chrome
```

In the newly created Chrome test window, open `chrome://extensions`, enable
Developer mode, choose Load unpacked, and select the extension path printed by
the runner. The test then runs and closes its browser process. Current branded
Chrome does not support loading this unpacked extension with `--load-extension`.

The experimental `arc` runner mode records a launch attempt, but isolated Arc
startup has **not** been established. Do not substitute a real profile or terminate
a user's existing Arc process to make the experiment pass.

Each run prints its temporary directory. That contains the fresh profile,
extension copy/key, native-host manifest, fictional upload/download, screenshot,
result JSON and browser log. Native-host registration is confined to that profile's
`NativeMessagingHosts` directory. These test artifacts are retained for inspection.

## Limits

The native peer is a fixed test scenario, not an authenticated Stem desktop bridge.
Its origin-argument check verifies the expected browser launch convention; a local
process could forge that argument. There is no generic local control socket here.
It does not prove security against malware running as the same OS user.

Only ephemeral grants for newly opened fixture tabs are implemented. There is no
production Settings/extension popup, persistent site/all-tab permissions,
browser-owned existing-tab grant UI, submission approval UI, human-takeover pause,
remote routing, Work integration or production file permission gate. Upload paths
come from the test fixture's fixed configuration. The extension's toolbar button
connects the test peer; Stop is exercised through the test protocol.

Evaluations use isolated, unique document contexts. The screenshot/frame check is
conservative, but these fixtures do not establish adversarial navigation-race
safety, full OOPIF interaction, arbitrary-site form compatibility, or native OS
dialog behavior. Stop and disconnect cleanup tests do not establish cancellation
of all in-flight browser side effects. Those are production acceptance gates.

No public extension store listing, production installation or release is created
by this experiment.
