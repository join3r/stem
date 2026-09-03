# Running Stem on a LAN, or on Tailscale

← [Stem guide](README.md) · [Running on a server](running-on-a-server.md)

[Running on a server](running-on-a-server.md) is the public-hostname path: Caddy
gets a Let's Encrypt certificate for `stem.example.com`, ports 80 and 443 are
open on the internet, and the desktop and the phone dial `https://` that name.

This is the same two containers and the same import, for a machine that should
**not** have a website. Typical case: a Linux VM or a NUC on your desk, Docker
on it, Tailscale on it, and you open Stem from a laptop and a phone that are
also on the tailnet.

What changes:

- **Caddy stays HTTP.** It listens on port 80 only and does not call Let's
  Encrypt. The overlay is [`deploy/docker-compose.private.yml`](../deploy/docker-compose.private.yml).
- **Tailscale Serve is the HTTPS front door.** It terminates TLS for
  `<machine>.<tailnet>.ts.net` and proxies to Caddy on 80. Certificates are
  Tailscale's. Nothing is published on the public internet unless you also turn
  on **Funnel** (see below).
- **The desktop wants `https://`.** Pairing accepts `http://` if you type the
  scheme, but the field's placeholder is HTTPS, and that is what you should
  store once Serve is up. Pair with `https://stem.tailxxxxx.ts.net`, not a bare
  hostname and not `https://` against Caddy's port 80.

`*.ts.net` MagicDNS names are already on Stem's Host allowlist
(`src/server/transport/auth.ts`). A LAN IP is not — put it in
`STEM_TRUSTED_HOSTS` if you still want `http://192.168.x.x` as a fallback.

Do **not** port-forward 80 or 443 on the router for this path.

## Before you start

- A Linux host with **Docker Engine and the Compose plugin**, 2 GB of RAM and
  ~10 GB of disk — the same as the public path. Ubuntu Server is enough; Stem's
  server has no Linux desktop of its own.
- **Tailscale** on that host, and on every computer and phone that should reach
  Stem when you are away from the LAN.
- The MagicDNS name of the host: `tailscale status` prints it. It looks like
  `stem.tailxxxxx.ts.net`. That is the name you will type in Settings → Server.
- A copy of this repository on the host, and Stem still installed on the
  computer you sit at (macOS/Linux installer, or Windows from source).

Everything below assumes you are in a checkout at `/opt/stem`. Adjust as you
like; nothing depends on the path.

The archive, `stem_key`, `docker compose build`, import, pairing codes, backups
and upgrades are the same commands as [Running on a server](running-on-a-server.md).
Only the `.env` lines, the compose overlay, and how HTTPS is obtained are
different.

## 1. `.env`

```
cp deploy/env.example .env
```

```
STEM_HOSTNAME=stem.tailxxxxx.ts.net
STEM_TRUSTED_HOSTS=stem.tailxxxxx.ts.net,192.168.1.50
TZ=Europe/Bratislava
COMPOSE_FILE=docker-compose.yml:deploy/docker-compose.private.yml
```

`STEM_HOSTNAME` is the MagicDNS name **without** `http://`. Putting `http://` on
that line would make the Host allowlist the wrong shape.

`STEM_TRUSTED_HOSTS` is every Host header a client might send: the `.ts.net`
name, and the LAN IPv4 if you want that as a fallback. Comma-separated, no
spaces required. A Tailscale 100.x address belongs here too if you ever dial
that.

`COMPOSE_FILE` is how Compose picks up the private overlay every time, so you
do not have to remember `-f` on `up` and `logs`.

`TZ` is still the clock scheduled tasks are read in.

Then `stem_key` exactly as in the public runbook — the passphrase the archive
was exported under, or a long random string if this Stem is empty:

```
printf '%s' 'the passphrase you exported under' > /opt/stem/stem_key
chmod 600 /opt/stem/stem_key
```

## 2. Build and start

Same as the public path: import the archive if you have one, then:

```
docker compose build
docker compose up -d
docker compose logs -f caddy
```

Caddy should say it is listening on HTTP only, and that automatic HTTPS will
not be applied. That is the point. `docker compose ps` shows **caddy on port 80**
and **stem with no published ports**.

If Caddy starts talking about Let's Encrypt, `COMPOSE_FILE` did not include the
private overlay. Fix `.env` and `docker compose up -d` again.

## 3. Tailscale Serve

Serve has to be **allowed on the tailnet** (a one-time admin action). The CLI
prints the URL if it is not:

```
tailscale serve --bg 80
```

If that says serve is not enabled, open the link it printed, enable Serve, and
run the command again.

If it says access denied, the daemon needs root once, and then it can run as
you:

```
sudo tailscale serve --bg 80
sudo tailscale set --operator=$USER
```

Check:

```
tailscale serve status
```

You want HTTPS for `https://stem.tailxxxxx.ts.net` proxying to port 80. That is
not Funnel. Funnel is a separate switch.

## 4. Pair the desktop

On the server:

```
docker compose exec stem node dist/main/server.js pair --label "Vlado's MacBook"
```

In Stem on the computer you sit at: **Settings → Server**, address

```
https://stem.tailxxxxx.ts.net
```

and the eight-character code. **Connect**, then restart Stem. Tailscale must be
up on that computer.

The address has to start with `https://` or `http://`. A bare
`stem.tailxxxxx.ts.net` is refused before anything is dialled.

After a restart, the same checks as the public path: chats, Memory → Facts,
Files, a new chat that gets an answer.

Pin MCP servers and connected folders that only work on that computer the same
way as in [Running on a server](running-on-a-server.md) step 7.

## 5. Pair the phone

The iOS app is a companion to this server, not a second Stem. **Settings →
Server → Devices → Pair a phone** on a desktop that is already paired, or mint
a code on the server and type it by hand.

The address on the phone is the same `https://stem.tailxxxxx.ts.net`. The phone
needs Tailscale (or to be on the LAN with a Host you listed). Scan the QR, or
type the URL and the code. The code is spent once and lasts ten minutes —
[Stem for iOS](../mobile/README.md) has the Expo / push details, which do not
change.

## Funnel (optional, public)

**Serve** is only your tailnet. **Funnel** takes the same HTTPS listener and
puts it on the public internet, at a Tailscale URL, with no VPN on the client.

That is a website. Pairing still needs a code, `/pair` is still rate-limited,
and the bearer token is still the credential — but the TLS port is reachable by
strangers. Do not turn it on because HTTPS was awkward; turn on Serve for that.
Use Funnel only when you have decided the server should be dialled from a
network that will never run Tailscale.

Funnel is a second tailnet admin grant, the way Serve is. The CLI prints a
link if it is not enabled:

```
tailscale funnel --bg 443
tailscale funnel status
```

Turn it off with `tailscale funnel off`. Turning Funnel off does not turn Serve
off.

## LAN without Serve

Caddy on port 80 will answer `http://192.168.x.x` if that IP is in
`STEM_TRUSTED_HOSTS`. The desktop accepts `http://` when the scheme is typed.
Useful while Serve is not enabled yet, or for a device that will never run
Tailscale and never leaves the house.

It is not what you should store long-term if the phone and a laptop off-LAN are
the point of the move.

## When it does not come up

**Read the log first.**

```
docker compose logs stem
docker compose logs caddy
tailscale serve status
```

**Pairing says the address needs to start with http:// or https://.** The field
needs a scheme. Use `https://stem.tailxxxxx.ts.net` once Serve is up.

**`https://` fails, `http://` on port 80 works.** Serve is not running, or the
Windows/macOS/phone Tailscale client is offline. `tailscale status` on both
sides.

**Everything answers 403.** `STEM_TRUSTED_HOSTS` does not include the Host the
client sent. A LAN IP, a short MagicDNS name (`stem` without `.ts.net`), or a
100.x address each have to be listed if that is what you typed. Fix `.env` and
`docker compose up -d`.

**Serve: access denied.** `sudo tailscale serve --bg 80`, then
`sudo tailscale set --operator=$USER` so the next change does not need root.

**Serve is not enabled on your tailnet.** The printed `login.tailscale.com/f/serve`
link, once, as an admin of that tailnet.

**Caddy is asking Let's Encrypt.** `COMPOSE_FILE` is missing the private overlay,
or `STEM_SITE_ADDRESS` is a bare hostname. You do not want that on this path:
Let's Encrypt will not complete without public port 80.

The rest — wrong `stem_key`, a state root that is not empty, a socket already
bound — is [Running on a server](running-on-a-server.md)'s last section, unchanged.
