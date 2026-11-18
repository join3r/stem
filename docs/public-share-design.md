# Public share links

Status: built 2026-10-19 (relay, server, desktop, viewer, iOS); relay and
viewer live on share.heystem.app.

## What it is

From the Share button on an answer (chat message or mail reply, shown on
hover) the user picks what to share: the whole chat / mail thread, the
question and that answer, or the answer alone. Anyone with the link can open
it in a browser, without a Stem:

```
https://share.heystem.app/s/<id>#<key>
```

- **Snapshot, not live.** The link shows the chat as it was when shared.
  Sharing again makes a new link; the old one keeps working until revoked.
- **Short-lived and capped (abuse).** A link works 30 days by default and
  at most (7 and 1 day are offered); an address holds at most 100 working
  links and makes at most 30 a day. The relay enforces all three.
- **Mail too, but only the user's own.** Mail with another person (inter-Stem)
  and the memory check's conversation can't be shared; persona↔persona
  consulting and approval cards are left out.
- **The relay never sees the content.** Stem encrypts the snapshot before
  upload. The key rides in the URL fragment, which browsers never send to a
  server.
- **Link previews, no indexing.** For the card chat apps show when the link
  is pasted, the sharer publishes a title and a short description in the
  clear: suggested from the snapshot (its title, the start of the first
  answer), editable in the dialog, and switchable off. The relay fills the
  viewer page's `og:` tags with it. Every page and response says `noindex,
  nofollow, noarchive`; there is no robots.txt Disallow, since that would also
  stop the crawlers that draw previews.
- **Only verified people publish.** Uploading needs a sender certificate for
  an inter-Stem address (an email verified with a code). Every share is tied
  to that address, so abuse can be traced and the address suspended. Viewers
  stay anonymous; no login on the web.
- **Awantech hosts it** on the global relay box (EU DSA hosting provider):
  every page has a report link; takedown by id; contact address on the page.

## What is in a snapshot

Built on the server from the same history the app shows (`readThread`), then
cleaned:

| Kept | Dropped |
| --- | --- |
| User text, assistant MDX (charts, diagrams, tables, callouts) | System notices (failed/interrupted turns), failed sends |
| Generated images (embedded as data URLs) | Tool rows / activity (queries, paths, commands) |
| Web pictures the chat shows (`![…](https://…)`, embedded) | Recall, file, mail and schedule context (already stripped from history) |
| Sounds from `share_audio` (embedded) | |
| Web sources (public URLs, with the site icon embedded) | |
| The model's name (optional) | `<FactChange>` (personal memory), `<Replies>` (dead in a static page) |
| User attachments: only when the user ticks "Include my pictures" | `stem://` and `file:` links (become plain text) |

The user always sees a preview of exactly what will be published before the
upload. That preview is the main protection against leaking something private,
so "Create link" publishes the very snapshot the server built for it (kept as
a draft for 30 minutes, named by `draftId`), never a fresh build that could
pick up a message that arrived after the user looked.

Private chats can be shared: "private" means "not learned from", and sharing
is an explicit act.

### Format (plaintext, before encryption)

```json
{ "v": 1, "kind": "answer" | "thread", "title": "…", "sharedAt": 1760000000000,
  "messages": [
    { "role": "user" | "assistant", "text": "…", "createdAt": 1760000000000,
      "model": "GPT-6.1 Sol · ChatGPT",
      "images": [{ "mime": "image/png", "dataUrl": "data:…", "alt": "…", "generated": true, "width": 1024, "height": 1024 }],
      "webImages": [{ "url": "https://…", "dataUrl": "data:…" }],
      "audio": [{ "mime": "audio/mpeg", "dataUrl": "data:…", "title": "…" }],
      "sources": [{ "url": "https://…", "title": "…", "icon": "data:…" }] } ] }
```

Viewers ignore unknown fields and show "made by a newer Stem" for `v > 1`.

The page has no Stem to ask, so everything the app fetches from the server as
it draws a reply rides in the snapshot. `webImages` holds exactly the pictures
the chat shows: the server runs the same provenance check as
`chats:remoteImage` (src/server/chats/remote-image.ts) when the link is made,
and a refused picture stays a link, as in the app. Mail shows web pictures as
links, so a mail share carries none. The page draws a reply with the app's own
parts (src/renderer/share/ShareView.tsx); `MdxStaticContext` hands them the
snapshot's bytes and makes file and Files links plain text.
tests/e2e/share-view.spec.ts renders one reply in the app and on the built page
under the CSP of relay/deploy/global/Caddyfile.snippet, and compares the markup.

### Encryption

```
key       = 32 random bytes
plain     = gzip(JSON)
nonce     = 12 random bytes
blob      = 0x01 || nonce || AES-256-GCM(key, nonce, plain, aad = "stem-share-v1")
fragment  = base64url(key), no padding
```

The browser decrypts with WebCrypto and `DecompressionStream('gzip')`.

## Relay (global relay only, feature `share`)

| Method & path | Auth | Body → response |
| --- | --- | --- |
| `POST /v1/shares` | SC | raw blob (`application/octet-stream`), `?ttl=<days>` optional → `{id, url, expires}` |
| `GET /v1/shares/{id}` | — | → blob bytes; `404 not_found`, `410 gone` (revoked or taken down) |
| `DELETE /v1/shares/{id}` | SC, same address | → `{}` |
| `GET /v1/shares` | SC | → `{shares: [{id, size, created, expires}]}` for the certified address |
| `POST /v1/shares/{id}/report` | — | `{reason, detail?, contact?, key?}` → `202 {}` |

- `id` = 16 random bytes, base64url (22 chars).
- Store: SQLite table `shares(id, owner, size, blob, created, expires,
  removed, removed_why)`. Revoke/takedown keeps a tombstone (blob dropped) so
  the link answers 410. Expired rows are swept.
- Limits in `[share]`: `max_bytes` (12 MiB), `max_ttl_days` (30, also the
  default expiry), `max_live` (100 working links per address),
  `per_address_day` (30), `quota_bytes` per address (500 MiB),
  `reports_per_ip_hour` (20).
- Reports go to a `share_reports` table and the relay log. The optional `key`
  is the reporter consenting to show us the content.
- CLI: `stem-relay share-reports`, `stem-relay share-takedown <id> <why>`.
- Closed-domain certificates are already refused by `certified()`. Stems
  whose policy is anything but open never publish (the global relay is never
  contacted under a restriction).

## Viewer (`share.heystem.app`)

- A separate origin from `heystem.app`, so shared content never runs where a
  future web login would.
- Static build `vite.share.config.ts` → `dist/share`, reusing
  `src/renderer/mdx` and a shared `ShareView` component (also used for the
  in-app preview). Only web-safe imports: no `window.stem`.
- stem-relay serves the whole viewer origin from `[share] viewer_dir`
  (only on the viewer host): `/s/*`, `/assets/*`, icons, `/v1/shares/*`.
  Caddy proxies just those paths and 404s the rest of the relay API there. Strict CSP (`script-src 'self'`,
  `connect-src 'self'`, `img-src 'self' data: blob:`, `media-src blob:` for
  shared sounds, `frame-ancestors 'none'`), `Referrer-Policy:
  no-referrer`, `X-Robots-Tag: noindex`.
- Footer: "Made with Stem · heystem.app" and "Report".
- `/s/<id>` is the built `index.html` with its `<!--stem-card-->` block
  replaced by the share's card. `og:image` is the
  Stem icon (`/og.png`).

## Stem server

- `src/server/share/`:
  - `snapshot.ts`: history → snapshot (the cleaning above).
  - `seal.ts`: encrypt, build the link.
  - `store.ts`: `shares.json` (id, link with key, thread, turn, kind, title,
    dates) so the user can copy a link again or revoke it.
- `InterStemService.shareIdentity()`: the default verified address with a
  fresh certificate; throws `no_address` / policy errors in plain words.
- IPC: `share:preview(source, opts)`, `share:create(source, opts)`,
  `share:list()`, `share:revoke(id)`; `source = {kind:'chat', threadId} |
  {kind:'mail', conversationId}`, `opts = {scope: 'thread'|'pair'|'answer',
  anchorId, includeAttachments?, includeModel?, ttlDays?, draftId?}`. The
  preview answers with a `draftId`; `share:create` publishes that draft. A
  client that sends none gets the newest preview of the same options.

## Desktop UI

- The one entry point: a Share icon among an answer's hover actions (chat
  message action row; a persona's reply in a mail thread).
- Dialog: what to share (whole chat / mail thread · question and answer ·
  answer only; question and answer preselected), rendered preview, toggles
  (include my pictures, show model name), expiry (30 / 7 / 1 days), the link
  preview card (editable title and description, drawn like an unfurl, with a
  note that it is not encrypted), Create link. Then: the link with Copy, its end date, and Revoke. Without a verified address, the dialog explains and links to
  Settings → Your email address.
- Settings → Features → Shared links: one row with the count. It opens a
  searchable list (newest first, a clock on links that stop within 3 days);
  each link opens its own page with Copy and Revoke, and for a locked link
  the recipients and who opened it.

## Locked to chosen people (2026-11-09)

A link can name the people who may open it ("Only people I choose" in the
dialog). Decided with Vlado:

- **The sharer sends the link.** The relay never mails the link itself, so it
  cannot become a spam channel for arbitrary addresses.
- **Link + inbox.** The key stays in the fragment. The relay hands out the
  blob only to a browser that entered a code it mailed to one of the
  recipients. A forwarded link shows nothing; the relay still cannot read
  the page.
- **A verified browser stays in for 7 days** (an HttpOnly cookie scoped to
  that one share).
- **Stem says when someone opens it.** The server asks the relay every 10
  minutes (and when the Settings list opens) who opened its locked links,
  stores it in shares.json, and posts a private mail ("martin@… opened the
  link you shared") for each recipient's first opening. Who was told is
  stored apart from the openings (`notified`), so a notice that failed goes
  out on the next check.
- The visitor picks a masked address (`m•••@gmail.com`) by index, so the page
  never shows full addresses. The relay keeps the recipients in the clear
  while the share lives; revoking deletes them with the blob.
- The link-preview card starts off for a locked link (it is not encrypted).
- An old relay ignores `to` and would make the link public. The upload answer
  echoes the recipients; when it does not, Stem deletes the share and says
  nothing was shared.
- iOS still makes public links only.

Protocol: relay/PROTOCOL.md, "Locked to recipients".

## Phase 2: iOS

Share in the answer's context menu (chat and mail) with the same three
choices; calls `share:create` and opens the system share sheet. No preview renderer on the
phone at first, so the sheet shows what is included (counts, pictures off).

## Not doing

- Live links, comments, view counts for public links.
- Server-side moderation of content (we can't read it).
- Mailing the link from the relay (the sharer sends it; see above).
