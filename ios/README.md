# Stem for iOS

The phone half of Stem, in SwiftUI: chats, persona mail, approval cards, and replies
streaming in live. Tabs are Mail · Chats · Settings. It is a **companion**, not a
second Stem — no Manage panel, no provider onboarding, no API key on the device. It
talks to the same server the desktop app talks to, over `/pair`, `/rpc`, `/events`
and `/upload`.

The Xcode project is generated from `project.yml` and not committed:

```sh
brew install xcodegen
xcodegen generate
open Stem.xcodeproj
# or headless:
xcodebuild -project Stem.xcodeproj -scheme Stem \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build test
```

No third-party packages. iOS 18 or later.

## Layout

| Folder | What lives there |
| --- | --- |
| `Stem/Transport` | Keychain pairing, `StemClient` (RPC, upload, pair), the SSE stream (`Connection`) |
| `Stem/Models` | Wire shapes from `src/shared/types.ts`, and the inbox/mail placement rules from `src/shared/inbox.ts` |
| `Stem/Stores` | Observable state: session, chat list, open thread (the streaming reducer, a port of `src/shared/chatState.ts`), mail, approvals, drafts |
| `Stem/Markdown` | Block parser + SwiftUI renderer for replies |
| `Stem/Views` | Screens, and the shared `Composer` |

When a shape in `src/shared/types.ts` changes, `Stem/Models/Types.swift` has to follow
by hand — nothing checks it.

## Pairing

On the desktop: **Settings → Server → Devices → Pair a phone**. Scan the QR with the
app's scanner, or type the address and the eight-character code. Opening a
`stem://pair?url=…&code=…` link fills both in and pairs. The code is spent once and
expires in ten minutes.

Release builds refuse plain `http://` to anything but loopback; use the `https://`
address of the proxy in front of the server ([Tailscale Serve](../docs/running-on-tailscale.md)
or your own).

## The composer

Chats get the desktop composer's controls:

- **Model and effort** — the pill opens a searchable model list with the effort picker.
  The model is saved to the server's defaults, like on the desktop; effort, Fast and
  MDX are kept on the phone.
- **Fast**, shown when the model has a priority tier; **Web** (the server's web search
  switch); **MDX / Markdown**.
- **`/note`** or **`//`** at the start switches to note mode and saves straight to
  memory, pictures included. **`/learn [focus]`** saves a skill from the last turn.
  Typing `/` lists both.
- Attachments from Photos, the camera, Files, or the clipboard, uploaded on send.
- **Stop** while a turn runs; long-press it for **Stop and edit message**, which rolls
  the turn back and puts the text back in the field (the desktop's Escape).
- A new chat can pick a persona (those with *clients* on) and be private.

Mail gets text and attachments: reply, and compose with To (first one leads),
subject and private. Drafts are kept per chat and per conversation, on disk, until
sent or until the phone is unpaired.

Replies render headings, lists, quotes, code blocks, tables and links. MDX components
the phone can't draw (charts and the like) show as a labelled box with their title.

## Push notifications

Pushes are wake-up taps: a kind and an id to open. The server sends them, so it needs
the APNs key (`STEM_APNS_KEY_PATH`, `STEM_APNS_KEY_ID`, `STEM_APNS_TEAM_ID`,
`STEM_APNS_BUNDLE_ID=sk.awantech.stem`, `STEM_APNS_ENV`). `STEM_APNS_ENV` must match the
build: Xcode debug builds use `sandbox`, TestFlight and App Store builds `production`.

The app asks for permission at launch and sends its token over `devices:registerPush`
whenever it has one and is paired. Tapping a notification opens the chat or mail
conversation it names.

## TestFlight

```sh
./scripts/testflight.sh
# or with an API key:
ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=…/AuthKey_….p8 ./scripts/testflight.sh
```

It regenerates the project, archives with automatic signing in the Awantech team
(AX23G9CAL9) and uploads. Bump `MARKETING_VERSION` in `project.yml` for a new release;
the build number climbs on its own.
