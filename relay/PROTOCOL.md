# Stem relay protocol, v1

The wire contract between Stems and relays. Design and reasoning live in
`docs/inter-stem-mail-design.md`; this file is what both implementations
(the Go relay in this directory, the TypeScript client in Stem) must match.
`testdata/vectors.json` holds byte-exact examples for every signed or sealed
structure.

Conventions: JSON bodies, UTF-8. Binary values are standard base64 with
padding (`b64`). Hashes are lowercase hex SHA-256 (`hex`). Times are Unix
milliseconds. Addresses are lowercased and trimmed before any use; the domain
is the part after the last `@`.

## Keys

A Stem has two keypairs:

- **identity**: Ed25519. Signs requests and envelopes. Its fingerprint is
  `hex(sha256(raw 32-byte public key))`.
- **encryption**: X25519. Mail is sealed to it.

The relay knows the identity public key (`authKey`, it authenticates requests
with it). The encryption key travels inside the **key blob**, which the relay
stores and returns but never parses:

```json
{"v":1,"sig":"<b64 ed25519 pub>","enc":"<b64 x25519 pub>","encSig":"<b64>"}
```

`encSig` is the identity key's signature over `"stem-key-v1\n" + enc` (the
base64 text). Stems reject a blob whose `sig` differs from the `authKey`
returned beside it or whose `encSig` fails.

## Request authentication

Requests to a Stem's own relay (and lookups on any relay) are signed by the
identity key:

```
Stem-Key:  <b64 ed25519 pub>
Stem-Time: <unix ms>
Stem-Sig:  <b64 sig over the string below>

"stem-req-v1\n" + METHOD + "\n" + path-with-query + "\n" + Stem-Time + "\n" + hex(sha256(body))
```

The relay rejects a skew over 5 minutes. An empty body hashes the empty
string.

Requests to a relay that is **not** the requester's own (lookups, invites,
status) also carry the requester's sender certificate, proving which address
is asking:

```
Stem-Cert: <b64 of the certificate JSON>
```

The relay verifies the certificate (see below) and that its `keyFp` matches
`Stem-Key`. Limits for these requests are keyed by the certified address.

## Relay identity and authority

Each relay has an Ed25519 signing key (or two during rotation), each with a
short id (`kid`).

`GET /.well-known/stem-relay` (public):

```json
{"v":1,"url":"https://relay.example","global":false,
 "keys":[{"kid":"k1","pub":"<b64>"}]}
```

**Which relay is authoritative for an address** comes from DNS. A TXT record
at `_stem.<domain>`:

```
v=stem1; relay=https://relay.acme.com; k=k1:<b64 pub>; k=k2:<b64 pub>
```

Several `k=` entries mean rotation; all are valid. A domain with no record
belongs to the **global relay**, whose URL and keys Stems ship with and
relays are configured with. A relay only registers, certifies and serves
addresses it is authoritative for; the global relay refuses domains that
have a record.

`access=closed` in the record marks a **closed domain**: its people talk
only among themselves. Every relay that doesn't serve the domain refuses
certificates for its addresses (`403 closed_relay` on delivery, `404
not_reachable` on lookups). Fields a relay doesn't know are ignored, so an
older relay reads the record as open.

```
v=stem1; relay=https://relay.acme.com; k=k1:<b64 pub>; access=closed
```

A **closed relay** (`closed = true`) also refuses senders outside its own
domains and its `partner_domains`, the same way: their mail gets `403
closed_relay`, their lookups `404 not_reachable`, so outsiders can't tell
who is on it.

## Sender certificates

```json
{"v":1,"address":"vlado@awantech.sk","keyFp":"<hex>","issuer":"https://relay.example",
 "kid":"k1","iat":1760000000000,"exp":1760086400000,"sig":"<b64>"}
```

`sig` is the relay key's signature over

```
"stem-cert-v1\n" + address + "\n" + keyFp + "\n" + issuer + "\n" + iat + "\n" + exp + "\n" + kid
```

Validity is 24 hours. A verifier checks: the issuer key `kid` is one the
address's authority publishes (DNS record, or the global relay's keys), the
signature, `iat <= now + 5 min`, `now < exp`.

## Envelope

```json
{"v":1,"id":"<32 hex>","ts":1760000000000,"from":"vlado@awantech.sk","to":"martin@gmail.com",
 "cert":{...},"signer":"<b64 ed25519 pub>","sealed":"<b64>","sig":"<b64>"}
```

`sig` is the signer's signature over

```
"stem-env-v1\n" + id + "\n" + ts + "\n" + from + "\n" + to + "\n" + hex(sha256(sealed bytes)) + "\n" + hex(sha256(certString))
```

where `certString` is the certificate's signing string plus `"\n" + cert.sig`.

Valid when: the certificate is valid for `from`, `hex(sha256(signer)) ==
cert.keyFp`, the signature verifies, `ts` is within 5 minutes of now on
arrival at the relay, and `id` hasn't been seen in the last 7 days.

### Sealing

```
eph            = new X25519 keypair
shared         = X25519(eph.priv, recipient.enc)
key            = HKDF-SHA256(ikm = shared, salt = eph.pub || recipient.enc, info = "stem-seal-v1", 32 bytes)
aad            = "stem-seal-v1\n" + id + "\n" + from + "\n" + to
ct             = AES-256-GCM(key, nonce = 12 zero bytes, plaintext, aad)   (ciphertext || 16-byte tag)
sealed         = eph.pub (32 bytes) || ct
```

The key is single-use, so the fixed nonce is safe. (AES-GCM rather than
ChaCha20-Poly1305 because Electron's BoringSSL has no ChaCha20 in node:crypto.) The plaintext is Stem's
inner mail format; the relay never sees it. Inner payloads carry their own
version, and a Stem shows "needs a newer Stem" for one it doesn't know.

## Endpoints

All under the relay URL. `S` = signed request by a key registered on this
relay (own-account calls). `SC` = signed request with `Stem-Cert`, from any
relay. `K` = signed request by any key, registered or not. Errors are
`{"error":"<code>"}` with a 4xx/5xx status.

| Method & path | Auth | Body → response |
|---|---|---|
| `GET /v1/info` | — | → `{v, features[], limits{maxMailBytes, ...}}` |
| `POST /v1/register` | S | `{address, keyBlob, pow}` → `202 {status:"code_sent"}`, always |
| `POST /v1/verify` | S | `{address, code}` → `{cert}` or `400 invalid_code` |
| `GET /v1/verify-link?t=` | — | email link; → confirmation page only |
| `POST /v1/verify-link` | — | form `t=` → completes the verification |
| `POST /v1/cert` | S | `{address}` → `{cert}` |
| `GET /v1/keys?address=` | SC | → `{authKey, keyBlob}` or `404 not_reachable` |
| `GET /v1/keystatus?address=&fp=` | — | → `{current: bool}` |
| `POST /v1/mail` | envelope | envelope → `202 {status}` |
| `GET /v1/mail/status?id=` | SC, the envelope's signer | → `{status}` |
| `GET /v1/stream` | S | SSE of `mail` events |
| `POST /v1/ack` | S | `{ids[]}` → `{acked}` |
| `POST /v1/allow` `/v1/unallow` | S | `{address}` → `{}` |
| `POST /v1/block` `/v1/unblock` | S | `{address}` → `{}` |
| `PUT /v1/account` | S | `{unlisted}` → `{unlisted}` |
| `POST /v1/invite` | SC | `{address}` → `202 {status:"ok"}`, always |
| `POST /v1/revoke` | S | `{}` → `{}`; this key stops being certified |
| `GET /v1/unsubscribe?t=` | — | email link; → confirmation page only |
| `POST /v1/unsubscribe` | — | form `t=` → adds the address to the suppression list |
| `POST /v1/push` | K | `{token, env, wake}` → `{result:"sent"\|"gone"}`; `409 token_bound`, `502 apns_failed` |
| `POST /v1/shares?ttl=<days>&card=<b64url JSON>&to=<b64url JSON>` | SC | blob bytes → `{id, url, expires, recipients?}`; `400 bad_ttl`, `400 bad_recipients`, `413`, `429`, `507 too_many_links`, `507 quota_full` |
| `GET /v1/shares` | SC | → `{shares:[{id, url, size, created, expires, recipients?, opens?:[{address, first, last, count}]}]}` |
| `GET /v1/shares/{id}` | — (locked: the view cookie) | → blob bytes; `401 {error:"locked", recipients:[masked]}`, `404 not_found`, `410 {error:"gone", why:"revoked"\|"taken_down"}` |
| `POST /v1/shares/{id}/code` | — | `{r: index}` → `202 {}`; mails a code to that recipient; `400 bad_recipient`, `400 not_locked`, `429` |
| `POST /v1/shares/{id}/unlock` | — | `{r: index, code}` → `200 {}` + `Set-Cookie: stem_view`; `403 bad_code`, `429` |
| `DELETE /v1/shares/{id}` | SC, the owner address | → `{}` |
| `POST /v1/shares/{id}/report` | — | `{reason, detail?, contact?, key?}` → `202 {}` |

### Register and verify

`pow` is `{"nonce":"<string>"}` such that
`sha256("stem-pow-v1\n" + address + "\n" + Stem-Key + "\n" + nonce)` starts
with `limits.powBits` zero bits. The relay always answers `code_sent`: for a
new address it emails a 6-digit code and a link; for a registered one it
emails the owner that someone tried to add a key. Verifying binds the address
to the key (replacing any earlier key for that address) and returns the first
certificate.

### Lookups and discoverability

`/v1/keys` answers only to a certified requester, within per-address
limits. A target
that is unregistered, unlisted (unless it has allowed the requester's certified
address), revoked, or suppressed answers identically: `404 not_reachable`.

### Allow and block lists

The relay can't see whom a Stem mails on other relays, so each Stem tells its
own relay: `allow` the addresses it has mailed or accepted, `block` the ones
it blocked. Allow lists drive unlisted lookups, the one-knock rule and
delivery status; blocks drop mail silently.

### Delivery

`POST /v1/mail` checks the envelope, then applies, in order: recipient
authority (this relay serves `to`), sender limits, block list, one knock,
queue quotas. The answer is always `202 {"status":"sent"}` unless the
recipient has allowed the sender, in which case a full queue answers
`507 queue_full`, or the sender is shut out by a closed relay or a closed
domain (`403 closed_relay`, see above). Mail to an address nobody holds is dropped.

`/v1/stream` (SSE) first replays every held envelope for the account's
addresses, then pushes new ones as `event: mail`, `data: <envelope JSON>`,
with a comment ping every 25 s. A Stem acks after storing; acked envelopes
are deleted. Held envelopes expire after 7 days.

`/v1/mail/status` answers `pending`, `delivered` or `expired` only to the
envelope's signer and only if the recipient allows the sender; otherwise
`sent`.

### Invites

`POST /v1/invite` counts as a knock toward that address. If the address is
unregistered, not suppressed, and every invite limit allows, the relay emails
an invite naming only the requester's certified address. The answer is always
`ok`.

Email links never act on GET: mail scanners and link previews open every
link they see, so a GET only shows a page with a button that POSTs.

### Push gateway

Only relays with `[push]` configured (feature `push`). A Stem without the
app's APNs key sends `token` (the device's hex APNs token), `env`
(`production`, the default, or `sandbox`) and `wake`: `{kind, approvalKind?,
conversationId?, threadId?, approvalId?, taskId?, failed?}`. `kind` is
`approval`, `turn`, `task` or `mail`, and ids match `[A-Za-z0-9_.:-]{1,128}`.
Anything else is `400 bad_wake`.

The relay writes the alert itself from fixed wording per kind and ignores
any other field, so a Stem can't choose what a lock screen says. A token
belongs to the first key that pushes to it. Another key gets `409
token_bound` until the owner has been idle `rebind_days`, or until Apple
reports the token gone (`{result:"gone"}`; the Stem drops it). Limits per
hour, per client IP, per key, per token and in all are in `[push]`.

### Share links

Only relays with `[share]` enabled (feature `share`; the global relay). A
Stem uploads a snapshot it encrypted itself:

```
key    = 32 random bytes            (never sent; the link's fragment)
nonce  = 12 random bytes
blob   = 0x01 || nonce || AES-256-GCM(key, nonce, gzip(snapshot JSON), aad = "stem-share-v1")
```

The relay checks only the version byte and the size. The link is
`url + "#" + base64url(key)` (no padding). `id` is 22 base64url characters.
A share belongs to the certified address, not the key, so another device
holding the address can list and revoke it. Limits: `limits.maxShareBytes`
per blob, `[share] per_address_day`, `max_live` working links and
`quota_bytes` per address, and `maxShareTtlDays`: the longest `ttl`, and the
expiry when none is given (0: a share may never expire; the global relay
uses 30). Expired shares are deleted; revoked and taken-down ones answer
`410` for a year.

`card` (optional) is the link preview the sharer publishes in the clear:
base64url (no padding) of `{"t": title, "d": description}`. It rides in the
signed path; the relay keeps one printable line of each (120 and 300
characters). With `[share] viewer_dir` set, `GET /s/{id}` answers the
viewer's `index.html` with the `<!--stem-card-->` block replaced by that
card's `og:` tags (a removed link gets a "removed" card, a cardless one the
page as built). Every share response carries `X-Robots-Tag: noindex`.

`report` reasons: `illegal`, `privacy`, `harassment`, `spam`, `other`.

#### Locked to recipients (feature `share-to`)

`to` (optional) is base64url (no padding) of a JSON array of addresses,
in the signed path: 1 to `[share] max_recipients` (default 20), normalised
and deduplicated. The upload answer then carries `recipients`. A Stem must
check it: a relay without the feature ignores `to` and makes the link
public, so the Stem deletes the share when `recipients` is missing.

A locked `GET /v1/shares/{id}` answers `401` with the recipients masked
(`m•••@gmail.com`), in upload order. The visitor picks one by index:
`code` mails a 6-digit code to that address (valid 15 minutes, 5 tries,
one request a minute per share and recipient; `codes_per_recipient_day` per
share and recipient, five times that over all shares; `codes_per_ip_day`
per client IP; a suppressed address answers the same `202` with no mail).
`unlock` with the right code sets `stem_view`: HttpOnly, SameSite=Strict,
Path `/v1/shares/{id}`, Max-Age `view_days` (default 7). With that cookie
the blob comes back (`Cache-Control: no-store`) and the opening is counted
for that recipient. The key still rides only in the fragment, so a visitor
needs both the link and the recipient's inbox. Revoking deletes the
recipients, codes, cookies and openings with the blob.
`key` is optional: a reporter who includes it lets the operator see the
content.

## Features

`/v1/info` lists optional features (`invites`, `pow`, ...). Stems detect,
never assume. New fields are optional; unknown fields are ignored on both
sides.
