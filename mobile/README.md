# Stem for iOS

The phone half of Stem: read and start chats, answer approval cards while the agent
waits, triage the Inbox, watch a turn stream in live. It is a **companion**, not a second Stem
— no Manage panel, no provider onboarding, no API key ever on the device. It talks to
the same server the desktop app talks to, over the same six HTTP routes.

The shared types come from `../src/shared`, imported as `@shared/*` (Metro
`watchFolders`, see `metro.config.js`). There is no second copy of `ChatSummary` here.

```
npm install
npm start          # Metro; press i for the simulator, or scan with Expo Go
npm test           # vitest, headless, no simulator
npm run typecheck
```

## Pairing

On the desktop: **Settings → Devices → Pair a phone**. Scan the QR with the app's own
scanner, or type the address and the eight-character code by hand. The code is spent
once and expires in ten minutes.

## Running in Expo Go

Everything works except the two things Expo Go structurally cannot do:

- **No remote push.** Expo Go carries no APNs entitlement for your project, so asking
  for a device token fails. The app notices, logs one line, and carries on — there is
  nothing to fix and no dialog to dismiss.
- **No `stem://` links from outside the app.** Expo Go owns its own URL scheme. QR
  pairing still works, because the scanner reads and parses the code in-process rather
  than routing a link through iOS.

Everything else — pairing, chat, streaming turns, approvals, the Inbox, the offline
cache — behaves as it will in a real build.

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
is a server that is up, and its error is what you see. There is no outbox and no sync:
composing is disabled while offline, which is what keeps this a cache rather than a
second source of truth. Unpairing empties it.

## TestFlight

1. `eas build --profile production --platform ios` (or archive in Xcode after
   `npx expo prebuild`).
2. `eas submit --platform ios`, or upload the `.ipa` with Transporter.
3. In App Store Connect the build appears under **TestFlight** after processing. Internal
   testers (up to 100, same team) need no review; external testers need a short one.
4. Set `STEM_APNS_ENV=production` on the server before testing push against a TestFlight
   build, and re-pair the phone so the server holds a token minted by that build.

Bump `version` in `app.json` for a new build; EAS handles `buildNumber`.
