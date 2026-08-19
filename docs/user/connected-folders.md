# Connected folders

← [Stem guide](../README.md)

| Connected folder | Writable | Index | Memorize | Learn facts |
| --- | --- | --- | --- | --- |
| **Personal Obsidian** | No | Yes | Yes | On use |
| **Work Obsidian** | No | Yes | No | — |
| **Argo CD — Kubernetes Code** | No | Yes | No | — |
| **My App Source** | No | Yes | No | — |
| **Invoices** | No | Yes | No | — |

Index covers supported documents, not source code. Enable **Writable** for **My App
Source** only while Stem is editing it.

Stem reads connected folders where they already live. The original files are not
copied into Stem.

Open the right sidebar → **Connected folders**, choose **+**, then select a folder.

<!-- TODO(screenshot): Connected folders tab with the five demo folders and one expanded settings card. -->

A new connected folder starts **read-only**, with **Memorize on** and **Index off**.

## Controls

- **Writable** — lets Stem create, edit, or delete files when asked.
- **Index** — scans supported files and builds a search catalog on this computer.
- **Memorize** — lets content read from this folder become cross-chat Memory.

Read-only protection stays active even in Yolo mode. Content used in a turn goes to
that chat’s selected model: its provider service for a cloud model, or the configured
local server for a local model.

**Disconnect** removes access and deletes the local index. It never deletes the
original folder.

## Index details

Index reads Markdown (`.md`, `.markdown`), plain text (`.txt`, `.text`), and PDFs with
a text layer (`.pdf`). Stem skips scanned, image-only PDFs. It can still open other
files directly while working in the folder.

The catalog stays local. If matching under **Memory → Facts → Relevance ranking**
uses **Server**, that server receives text for matching.

Turning **Index** off deletes the catalog and scan/learning progress. Learned facts
remain. Turning **Memorize** off keeps folder content out of cross-chat Memory, but
Stem can still use it for the current task.

## Learn facts

Available only when **Index** and **Memorize** are both on. **Learn facts** controls
when Stem automatically turns durable details from indexed documents into
[facts](memory/facts.md). No need to ask it to remember each one:

- **Off** — never learn facts from the connected folder.
- **On use** — learn only from excerpts that surface in chats; no extra background
  sweep.
- **New & changed** — also process files added or edited from now on.
- **Full history** — first process every indexed file, then continue with new and
  changed files.

Choose the learning model on the connected folder. **Memory default** uses the Memory
model. A cloud model receives the excerpts it processes and may add provider usage
cost. **Full history** shows an estimate before it starts.

Learned facts remain if their source file is deleted. On disconnect, Stem offers to
forget facts learned from that folder; pinned facts are kept.

## Folders on your other computers

When Stem runs on a server, **+** asks where the folder lives: **On the server**
(browse the server's own disk — the folders above) or **On this computer**. Picking a
folder on this computer connects it as a **mirror**: this computer watches the folder
and copies changes one way, up to the server, so Stem can read it even while this
computer is asleep. This is the one kind of connected folder that IS copied — the
Folders tab groups it under this computer's name and shows when it last synced.

- The first sync copies the whole folder, one file at a time — for a folder with
  tens of thousands of files that takes minutes to hours, not seconds. The card says
  **Waiting for first sync** until the entire first pass lands, and the toolbar's
  background-activity panel shows a **Syncing** row with a file-count progress bar.
  A long "Waiting for first sync" with a moving progress row is a big first upload
  doing its job, not a problem.
- Interruptions are safe: quitting the app, the server restarting, or the
  connection dropping pauses the sync, and the next round resumes from what already
  arrived instead of starting over.
- After the first sync, changes sync within seconds while this computer is online;
  deletes and renames follow. The folder on this computer is always the original —
  nothing Stem does can change the mirror's contents from the server side.
- Mirrors skip `.git`, `node_modules`, OS junk files, symbolic links, and files over
  25 MB. Anything else skipped is counted on the folder's card.
- If the folder disappears (an unplugged drive, a rename), syncing freezes and the
  card says so — the mirror keeps its last state rather than treating it as deleted.
  Disconnecting the folder in Stem is how you delete the mirror.
- **Writable** means something different here: Stem edits the folder by running
  commands **on this computer** (so [command execution](../running-on-a-server.md)
  must be switched on here), never by writing into the mirror. The edit then syncs
  up like any other change.
- Index, Memorize and Learn facts work exactly as above — they operate on the
  server's mirror copy.

Unpairing the computer leaves the folder listed and frozen, never silently deleted.
Mirrors do not travel in a [backup or move](moving-and-backups.md); after an import,
reconnect the folder from the computer it lives on.
