# Running Stem on a server

← [Stem guide](README.md)

Stem normally runs on the computer you are sitting at. This is how to move it to a
server instead, so the same chats, memory and skills are there from whichever machine
you open the app on — and so a scheduled task at three in the morning runs whether your
laptop is shut or not.

What you end up with:

- **Two containers.** `stem` is Stem itself; `caddy` is the front door that terminates
  HTTPS on your domain.
- **No open port on Stem.** The two talk over a Unix socket in a shared volume, so the
  Stem container has no TCP listener at all — Caddy is not the recommended way in, it is
  the only one.
- **One directory to back up.** The state root is bind-mounted from the host: chats,
  memory, skills, your Files, settings and credentials, all in one place you can `rsync`.
- **One secret.** A file holding the passphrase your archive was exported under. Docker
  mounts it into the container; it is never in the image and never in an environment
  variable.
- **Your Mac becomes a client.** [Moving and backups](user/moving-and-backups.md) is the
  export side of this; Settings → Server is where the Mac is pointed at the result.

## Before you start

- A domain name — `stem.example.com` — with an A record already pointing at the server's
  IP. Caddy asks Let's Encrypt for a certificate on first boot and that will not work
  until DNS resolves.
- Ports **80 and 443** reachable from the internet. 80 is only used for the certificate,
  but the certificate needs it.
- **Docker Engine and the Compose plugin** on the server
  ([install guide](https://docs.docker.com/engine/install/)).
- **2 GB of RAM and ~10 GB of disk**, comfortably. The image is around 1.3 GB, the
  embedding models add ~1.4 GB the first time memory search runs, and what your MCP
  servers download to start adds a few hundred MB more over time.
- A copy of this repository on the server, and Stem still installed on your Mac.

Everything below assumes you are `root` in a checkout at `/opt/stem`. Adjust as you like;
nothing depends on the path.

## 1. Take the archive off your Mac

In Stem: **Settings → Server → Move or back up this Stem**. Choose a passphrase of at
least 12 characters, type it twice, press **Export…**. You get `stem-<date>.tar`.

Keep that passphrase. It is what unlocks the sign-ins of every tool you have connected,
and the server will need it in a moment. Everything else in the archive arrives either
way.

> The archive is **not** encrypted — it holds your chats and your credentials in
> readable form. Move it over `ssh` and delete the copies you no longer need.

```
scp ~/Desktop/stem-2026-08-08.tar root@stem.example.com:/root/
```

## 2. Set the server up

```
git clone <your Stem repo> /opt/stem
cd /opt/stem
cp deploy/env.example .env
```

Edit `.env`. Two lines matter:

```
STEM_HOSTNAME=stem.example.com
TZ=Europe/Bratislava
```

The hostname must already resolve to this server. `TZ` is the clock your scheduled
tasks are read in — a container is UTC unless told otherwise, and "every weekday at
9" is a different hour in each.

Then write the passphrase into the file Docker will mount as a secret:

```
printf '%s' 'the passphrase you exported under' > /opt/stem/stem_key
chmod 600 /opt/stem/stem_key
```

`printf` rather than `echo` only so you can see what is in the file; a single trailing
newline is forgiven either way, and anything else — a leading space, a second line — is
taken as part of the passphrase.

> Do not put the passphrase in `.env`, and do not commit `stem_key`. `docker-compose.yml`
> names the *path*; the value stays on the disk of the machine that needs it.

## 3. Build the images

```
docker compose build
```

This installs Stem's production dependencies **inside** the image, on Linux, which is the
only way the compiled parts of the memory search (`onnxruntime-node`) are the right build.
Never copy a `node_modules` from your Mac into a server.

It also builds Caddy with its rate-limiting module, which is not in the stock binary and
means a Go toolchain is downloaded on the first build. Expect five to ten minutes the
first time and almost nothing after that.

On an arm server (Hetzner CAX, Ampere, a Raspberry Pi) add `STEM_PLATFORM=linux/arm64` to
`.env` first. The default is `linux/amd64`, because a VPS is x86_64 unless it says
otherwise.

### What is in the image

Two things run arbitrary programs on this machine — the assistant's shell, and every
MCP server started by a command — so the image carries what they reach for:

- **`uvx` and `npx`**, which is how nearly every published MCP server is distributed.
  `uvx` fetches its own Python, so nothing has to be installed for it first.
- **`git`, `rg`, `curl`, `jq`, `file`, `less`, `ps`, `unzip`, `python3`**, and the
  coreutils the base already had. The first few are not garnish: Stem's own list of
  commands that may run without asking includes `rg` and `git status`, and on a machine
  without them "safe enough to run unasked" would mean "fails unasked".
- **`zsh`**, so a command behaves here the way it did on your Mac.

What is deliberately missing: browsers and Playwright (~400 MB for something Stem does
not require), an SSH client, and compilers.

That short list goes further than it looks, because most of what is "missing" does not
need installing at all. In order of least effort:

- **Anything on PyPI or npm already runs.** `uvx yt-dlp <url>` or `npx -y <package>`
  fetches the tool and runs it in one step; the download lands in the cache volume, so
  it is only slow the first time and survives upgrades. The assistant is told to try
  this before declaring a program missing, so "download this video" just works.
- **A tool worth keeping goes on the PATH.** `uv tool install <tool>` installs into a
  bin directory inside the same volume, so it outlives upgrades too. A static binary
  dropped into it works the same way — ffmpeg publishes static builds, and
  `/var/lib/stem/cache/bin/ffmpeg` is a real ffmpeg that no rebuild removes.
- **`apt-get install` works, but is temporary.** The container runs as root, so the
  assistant can install a system package when you approve the command — and the next
  upgrade replaces the container and takes the install with it. Fine for trying
  something out; the assistant is told to warn you it is temporary.
- **What earns its place goes in a file**, next to `docker-compose.yml`:

  ```dockerfile
  # Dockerfile.local
  FROM stem-server:local
  RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
  ```

  then point the `stem` service's `build.dockerfile` at it. This is the only one of the
  four that is part of your deployment rather than its state — the one to use for
  anything the server should never be found without.

The other way to get at a tool is not to install it here at all: a job that only means
something on your own computer — its files, its apps, its network — belongs on that
computer. An MCP server pinned to it (step 7) covers tools; for shell commands, the
assistant can target a paired computer directly once that computer allows it — the
switch is **Run commands on this computer** in Settings → Chat → Command execution,
on the machine itself, and [Settings](user/settings.md) describes the approvals that
still apply.

## 4. Unpack your Stem into it

```
docker compose run --rm -v /root/stem-2026-08-08.tar:/import/stem.tar:ro \
  stem node dist/main/server.js import /import/stem.tar
```

No `--key-file`: inside the container the passphrase is already at
`/run/secrets/stem_key`, which is where `import` looks by default.

It prints what landed and what needs you — a tool whose command does not exist on Linux,
a connected folder that is not on this machine, anything that will ask to be signed in
again. Read that list; it is the only time it is shown. Nothing is repointed for you: the
tools it names are dealt with in step 7, once your Mac is paired and there is a machine to
name.

If it refuses because the state root already has something in it, that is deliberate —
unpacking on top would merge two Stems. Empty the directory named in the message and run
it again.

## 5. Start it

```
docker compose up -d
docker compose logs -f caddy
```

Watch for Caddy obtaining a certificate. When it goes quiet, `https://stem.example.com`
is live. `Ctrl-C` stops watching the log, not the server.

```
docker compose ps
```

`stem` shows **no published ports**. That is correct and is the point: it is listening on
`/run/stem/stem.sock` and nothing else.

## 6. Pair your Mac

On the server:

```
docker compose exec stem node dist/main/server.js pair --label "Vlado's MacBook"
```

It prints an eight-character code, good for ten minutes and one device.

In Stem on your Mac: **Settings → Server**, enter

- Address: `https://stem.example.com`
- Code: the code it printed

Press **Connect**, then restart Stem. Stem connects to its server when it starts, so the
change takes effect on the next launch — the pane says so.

## 7. Pin the tools that only work on your Mac

Two kinds of MCP server stopped working in the move, and step 4 listed them: one that
runs a command your Mac has and this server does not, and one whose URL is on your home
network, which the server has no route to. Now that your Mac is paired, both have
somewhere to run. If step 4 named none of them, there is nothing to do here.

In Stem on your Mac: **Settings → Tools → MCP servers**. Select the server and choose
**Move to** your Mac. It moves into the **On this computer** section, and Stem asks you
to approve it there before it starts anything — a server named in a config somewhere
else never runs a command on your own computer unasked. The question opens under the
server's own row; **Approve and start** answers it.

From then on it runs on your Mac and the rest of Stem uses it as it always did,
including from your phone, whenever your Mac is awake with Stem running. When it is
asleep, the tools are still listed and Stem says which machine is away rather than
pretending the tools are gone.

## 8. Check it

Open Stem after the restart and confirm all four:

- Your chats are listed, and opening one shows its messages.
- **Memory → Facts** has what it had.
- The Files panel lists your files, and one of them downloads.
- A new chat gets an answer.

Connected tools may ask to be signed in again if their access had expired — that is
ordinary. If *every* tool is signed out, the passphrase in `stem_key` is not the one the
archive was exported under; see the last section.

## 9. Keep the old one, for now

**Do not delete the Stem on your Mac.** Its state root is your rollback:

```
~/Library/Application Support/Stem
```

Nothing has moved out of it — the export was a copy. If the server turns out to be wrong
for you, **Settings → Server → Use this computer's server** puts everything back the way
it was, with that directory exactly as you left it.

Give it a week of real use before you consider that directory disposable, and take a
backup of it before you do.

---

## Ollama, if memory search used to run on your Mac

Stem's memory search embeds your facts with a small model that runs **inside Stem's own
process** — nothing to install, nothing to point at, and it is what a fresh Stem uses. You
only need this section if you had switched Settings → Memory to your own endpoint, because
the endpoint you switched it to was probably `localhost:11434` on the Mac that used to be
the server. That machine is not this one, and the setting now points at nothing.

The fix is a third container, off unless you ask for it. In `.env`:

```
COMPOSE_PROFILES=ollama
```

Then the ordinary two commands, and one pull:

```
docker compose up -d
docker compose exec ollama ollama pull qwen3-embedding:4b
```

In Stem: **Settings → Memory → Embeddings**, your own endpoint, base URL

```
http://ollama:11434
```

and the model name you pulled. `localhost` is the one address that does not work here — on
this server localhost is Stem's own container, and Ollama is a neighbour with a name.

**What it costs.** ~3 GB of disk for the weights of a 4b embedding model, and roughly the
same in RAM whenever one is loaded — on top of Stem's own gigabyte, on a box that is
running the model on its CPU because a VPS has no GPU. On a 2 GB machine, pull
`qwen3-embedding:0.6b` instead, or leave the bundled embedder alone; it was measured
against the alternatives and it is not a consolation prize.

**No port is opened.** Ollama listens on 11434 on the private network the containers share,
and `docker compose ps` shows no published port for it — the same arrangement as Stem
itself. This matters more than it does at home: Ollama has no authentication of any kind,
and an 11434 reachable from the internet is a machine other people run models on.

The weights live in a volume (`ollama-models`), so upgrading Stem does not re-download
them, and `docker compose down -v` does. Ollama itself upgrades separately from Stem, with
`docker compose pull ollama && docker compose up -d`.

## Backing up

The state root is a directory on the host — `./state` unless you changed
`STEM_STATE_ROOT` — so `rsync` and any ordinary backup tool work on it. The tidier way is
the same archive format you arrived with:

```
mkdir -p /backups
docker compose run --rm -v /backups:/backup \
  stem node dist/main/server.js export /backup/stem-$(date +%F).tar
```

`run` rather than `exec`, so the archive can be written to a directory outside the state
root — a backup kept inside the thing it is a backup of grows every time you take one.

It can be taken while Stem is running — the databases are snapshotted rather than copied
— and it refuses to write over an existing file, so a repeated run cannot quietly replace
the backup you are relying on.

Restoring is `import` into an **empty** state root, exactly as in step 4.

Two things are deliberately not in the backup and do not need to be: the embedding model
weights (identical for everybody, re-downloaded on demand) and the list of paired
devices (a device pairs with the Stem it is talking to, not with an archive).

If the server cannot reach Hugging Face, copy a model folder onto it — `scp -r` the
`embed-models` folder from a machine where memory search already works, anywhere the
container can read — and use **Import model files** under Memory → Facts → Relevance
ranking. The picker browses the SERVER's disk, because that is where the models run.

## Upgrading

```
cd /opt/stem
docker compose run --rm -v /backups:/backup \
  stem node dist/main/server.js export /backup/before-upgrade.tar
git pull
docker compose build
docker compose up -d
```

Nothing touches the state root, the model cache, what `uvx`/`npx` downloaded, tools
installed with `uv tool install`, what Ollama pulled, or Caddy's certificates: they are a bind mount and
named volumes, and rebuilding an image does not go near them. What *is* lost is anything
installed with `apt-get` into the running container — that lived in the container's own
filesystem, which is exactly what an upgrade replaces. Take the backup
anyway — it costs a minute and it is the only thing that makes going back possible.

To go back, check out the previous commit and run the same two commands.

## When it does not come up

**Read the log first.** Almost everything says what it is:

```
docker compose logs stem
docker compose logs caddy
```

**Everything answers 403.** `STEM_HOSTNAME` in `.env` is not the name you are reaching
Stem under. Stem checks the `Host` header against that name — it is what stops a hostile
site pointing a browser at your server — and Caddy passes the header through unchanged.
Fix `.env` and `docker compose up -d`.

**No certificate.** Caddy's log says why. The usual two are DNS not yet pointing at this
machine and port 80 blocked by the provider's firewall. Neither is something Stem can
work around.

**`refusing to bind /run/stem/stem.sock: something is already listening on it.`** Another
Stem container is still up. `docker compose down`, then `up -d`.

**The container starts and immediately stops.** The log's last lines are the reason. A
state root that is not writable is the common one — check what owns `./state` on the host.

**Every connected tool is signed out.** The passphrase in `stem_key` did not open the key
that came with the archive. There is no way to fix it in place; the credentials in the
state root are unreadable. Move the state root aside, correct `stem_key`, and import the
archive again:

```
docker compose down
mv state state.wrong-passphrase
docker compose run --rm -v /root/stem-2026-08-08.tar:/import/stem.tar:ro \
  stem node dist/main/server.js import /import/stem.tar
docker compose up -d
```

**You want to start over.** `docker compose down -v` removes the containers, the socket
volume, the model cache, the `uvx`/`npx` download cache with any tools installed into it,
anything Ollama had pulled, and Caddy's certificates — but not the state root, which is a bind mount on the host and
is only ever removed by you.
