# Moving Stem, and backing it up

← [Stem guide](../README.md)

Stem writes everything it knows into a single archive: your chats, your memory, your
skills, your Files, your settings, and the tools you have connected. Taking that
archive to another computer is how you move Stem. Keeping it somewhere safe is how you
back Stem up. It is the same file and the same command.

## Making one

**Settings → Server → Move or back up this Stem.**

Choose a passphrase (at least 12 characters), type it twice, press **Export…**, and pick
where the file goes. It is named `stem-<date>.tar`.

The passphrase is not a password on the file. It unlocks the credentials your connected
tools are signed in with, wherever the copy ends up — so keep it with the copy. Without
it, everything else still arrives, but every connected tool has to be signed in again.

> The archive itself is **not encrypted**. It holds your chats, your memory and your
> account credentials in readable form. Treat it the way you would treat a password
> manager's export: move it over `ssh`/`scp`, keep it somewhere you would keep a
> password, and delete the copies you no longer need.

If Stem is pointed at a server somewhere else, this pane says so and offers nothing to
export — your chats are over there, not here. Back that server up where it runs (see
below, and [Running on a server](../running-on-a-server.md) or
[Running on a LAN or Tailscale](../running-on-tailscale.md)).

## What travels, and what does not

Everything you made comes with you:

| Comes with you | Stays behind |
| --- | --- |
| Chats, and everything said in them | Devices paired with the old Stem |
| Memory — facts and recall | Its pairing codes |
| Skills | This computer's Quick Chat key and window settings |
| Your Files | The offline copy of your chats |
| Chat folders, the Inbox, scheduled tasks | Downloaded embedding models (~1 GB) |
| Settings, connected tools and their sign-ins | Uploads still waiting to be used, and logs |
| Search indexes for your connected folders | The address the old server was listening on |

Two of those are worth explaining.

**Embedding models do not travel; your indexes do.** The model weights are the same for
everybody and download again the first time they are needed. The index built over your
own notes is not something anything else could rebuild, so it comes along.

**Connected folders come as a list of paths.** The folders themselves live outside Stem,
so if they are not on the new machine at the same paths, Stem will say so and you can
reconnect them.

## Putting it somewhere else

On the machine that is to become your Stem, with nothing running:

```
stem-server import stem-2026-08-08.tar
```

It asks for the passphrase, and it prints what landed and what needs you — a tool whose
command does not exist here, a connected folder that is not on this machine, anything
that will ask to be signed in again. The last line is always the same one: nothing is
paired with this Stem yet.

```
stem-server pair --label "My MacBook"
```

gives you a code. Enter it in **Settings → Server** on each machine you want to connect,
along with the new address.

Once a machine is paired, a tool that only works there — a command it has, or a URL on
its own network — can be moved to it: **Settings → Tools → MCP servers**, select the
server, **Move to** that computer. See [MCP servers](tools/mcp-servers.md).

To pass the passphrase without typing it — in a script, or inside a container — put it
in a file and name it:

```
stem-server import stem-2026-08-08.tar --key-file /run/secrets/stem_key
```

`/run/secrets/stem_key` is also where it looks by default, so inside a container the
flag can be left off. There is deliberately **no** `--passphrase` option: a secret given
as an argument ends up in your shell history and in the process list, and cannot be
taken back out of either.

### It will refuse a Stem that has been used

`import` unpacks into a state root that nothing has happened in yet. If it finds chats,
skills, files, folders or memory already there, it stops and says which — unpacking on
top would merge two Stems together, some of each.

Move the old one aside and run it again:

```
mv ~/.config/Stem ~/.config/Stem.before-import
stem-server import stem-2026-08-08.tar
```

Keeping the old directory is your way back.

## Backing up a Stem that runs on a server

The same command, in the other direction:

```
stem-server export /backups/stem-$(date +%F).tar --key-file /run/secrets/stem_key
```

It refuses to write over an existing file, so a repeated run cannot quietly replace the
backup you are relying on. Restoring is `stem-server import` on an empty state root, as
above.

The archive is an ordinary tar file — `tar tf` lists it, `tar xf` unpacks it — so it is
readable years from now by something that is not Stem.
