# Stem for iOS

The phone half of Stem: chat with Stem, compose and reply to persona mail, answer
approval cards, and watch responses arrive live. Chats, Inbox, and Settings have
separate bottom tabs. It is a **companion**, not a second Stem
— no Manage panel, no provider onboarding, no API key ever on the device. It talks to
the same server the desktop app talks to, over the same six HTTP routes.

The shared types come from `../src/shared`, imported as `@shared/*` (Metro
`watchFolders`, see `metro.config.js`). There is no second copy of `ChatSummary` here.

```
npm install
npm start          # Metro for the native development build
npm test           # vitest, headless, no simulator
npm run typecheck
```

## Pairing

On the desktop: **Settings → Server → Devices → Pair a phone**. Scan the QR with the
app's own scanner, or type the address and the eight-character code by hand. The code
is spent once and expires in ten minutes.

The address is whatever the desktop uses to reach the Stem server:
`https://stem.example.com` on a public deployment, or
`https://stem.tailxxxxx.ts.net` when [Tailscale Serve](../docs/running-on-tailscale.md)
is the front door. The phone needs a route to that name (the tailnet, or the LAN).
`http://` works if you type the scheme; `https://` is what you want once Serve is up.

## Chats and Mail

Chats show interactive conversations. Swipe left for a confirmed Delete action or
right to change read status. Mail has its own Inbox, Sent, Snoozed, and Archived
views, with sender/recipient cards, composing, replies, and private conversations.
Swipe mail left for Archive/Snooze or right for read status. Long-press menus and
accessibility actions provide the same operations without a swipe.

Both composers accept photos and files up to 100 MiB each. Files upload over the
authenticated `/upload` endpoint before sending. Saved conversation attachments
currently expose image previews and file names, not downloads of original files.
HEIC/HEIF photos from Photos or Files are converted on the phone to full-resolution,
high-quality JPEG before upload, including photos already saved in drafts. The
original photo and draft copy are preserved for retries; conversion failures keep
the draft and show an error. This requires a native build with `expo-image-manipulator`.

Use a native build for verification: the app includes photo/document pickers, native
swipe gestures, Keychain, and push notification entitlements. Do not build the
simulator app with `CODE_SIGNING_ALLOWED=NO`; SecureStore needs its normal simulator
entitlements to pair successfully.

## Making a dev build

A build with the entitlements. Needed for push, for `stem://` links, and for anything
you intend to hand to somebody else.

```
npx expo run:ios                 # local: builds and installs on a connected device
```

or, without Xcode on the machine you are sitting at:

```
npx eas build --profile development --platform ios
```

Either way the config plugins in `app.json` write the native project, including
`aps-environment` (`expo-notifications`, `mode: development`). EAS replaces that with
`production` for a distribution build, from the provisioning profile — do not hardcode
it anywhere.

You need a **paid Apple Developer account** ($99/yr). The Mac app deliberately stays
unsigned and notify-only; iOS has no such option.

## Push notifications

Pushes are wake-up taps and nothing more: a kind, an id to deep-link with, a short
label. Never a message, a command line, or anything the model wrote — see the header of
`../src/server/push/index.ts`. The phone re-reads the real state over SSE on open, so a
missed or suppressed push can never hide anything from you.

The **server** sends them, so the server needs the key:

1. In the Apple Developer portal, **Keys → +**, tick **Apple Push Notifications service
   (APNs)**, download the `.p8`. You get it once; keep it.
2. Put the file somewhere the Stem container can read (mounted, `0600`), and set five
   environment variables:

   | Variable | What it is |
   | --- | --- |
   | `STEM_APNS_KEY_PATH` | path to the `.p8` inside the container |
   | `STEM_APNS_KEY_ID` | the key's 10-character id |
   | `STEM_APNS_TEAM_ID` | your Apple team id |
   | `STEM_APNS_BUNDLE_ID` | `sk.awantech.stem` (must match `app.json`) |
   | `STEM_APNS_ENV` | `sandbox` (default) or `production` |

   All four of the first are required together: with any of them missing the feature is
   off and no push is ever attempted. `STEM_APNS_ENV` must match how the app was built —
   a development build's token only works against the sandbox host, and a TestFlight or
   App Store build's only against production.

The **app** registers itself: after pairing it asks for permission once, sends the
native token over `devices:registerPush`, and re-sends it whenever iOS rotates it.
Permission is asked after pairing rather than on first launch on purpose — iOS gives you
exactly one prompt, forever, and it is worth more once the user can see what it is for.

Notifications are also suppressed server-side whenever somebody has used a desktop in
the last few minutes (`../src/server/push/presence.ts`). If your phone is quiet, that is
the first thing to check, and it is in the server log.

## Offline

`src/offline/cache.ts` keeps a read-only SQLite copy of the chat list and the fifty most
recently updated transcripts, written through as the server answers and read back **only
when a request could not reach the server at all**. A server that answers with an error
is a server that is up, and its error is what you see.

Drafts use a separate account-scoped SQLite database and app-owned copies of picked
files. Text, recipients, subject, and attachments survive navigation and app restart.
Offline drafting is available; sending always requires an explicit action while
connected. There is no automatic outbox or resend. An uncertain send retains the
draft, so check the conversation before sending it again. Unpairing clears both the
read cache and local drafts. Mail reads currently require a server connection.

## Message compatibility

Ship the corresponding server changes before this mobile release. New turns carry
`runtimeTurnId` in history as well as live events, independently of the persisted
`turnId` used by rollback/fork. Historical transcripts remain readable without a
migration. Incomplete history cannot acknowledge pending submissions. Reopened saved
replies may wait for the next authoritative completion before displaying overlapping
deltas, because saved text and streaming citation offsets can differ.

Mail notifications carry `kind: "mail"` and `conversationId`, and open the Mail
conversation. Triage and persona-internal traffic do not create received-mail alerts;
scheduled mail retains the scheduler's notification preferences.

## TestFlight

One-time setup, in the Awantech (AX23G9CAL9) account:

1. Create the app record at appstoreconnect.apple.com → Apps → **+** → New App
   (platform iOS, bundle id `sk.awantech.stem`). This cannot be scripted.
2. Sign in under Xcode → Settings → Apple Accounts with an account authorized to
   distribute Stem. Alternatively, use an App Store Connect API key with the
   required distribution signing access.

Then every build is:

```sh
./scripts/testflight.sh
# Or use an API key:
ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=…/AuthKey_….p8 ./scripts/testflight.sh
```

Leave all three `ASC_*` variables unset to use the signed-in Xcode account. An
API key that can read TestFlight builds may still lack cloud distribution signing
access; if Apple reports that denial, use an authorized Xcode account or have the
team administrator review the key's access.

which archives with automatic signing (creating the distribution certificate and
profile on first run) and uploads. The build appears under **TestFlight** after
processing. Internal testers (up to 100, must be members of the App Store Connect
team) need no review; an external group with a public invite link needs a short
Beta App Review on the first build of each version.

Push: a TestFlight build mints **production** APNs tokens, so set
`STEM_APNS_ENV=production` on the server and re-pair the phone so the server holds
a token minted by that build. Bump `version` in `app.json` for a new release;
Xcode's `manageAppVersionAndBuildNumber` keeps `buildNumber` ascending on its own.
