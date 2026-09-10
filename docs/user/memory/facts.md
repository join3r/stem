# Facts

← [Stem guide](../../README.md) · [Memory](README.md)

Facts are stable details Stem may pick up from ordinary conversations.

Maya says during a regular chat:

```text
My App Source uses pnpm and Node 22.
```

No special wording. With **Memory** on, Stem reviews new conversations in the
background. Reusable details may appear as facts shortly afterward.

Open the right sidebar → **Memory** → **Facts**.

<!-- TODO(screenshot): Facts tab with source, confidence, Pin, Confirm, and Forget actions visible. -->

## How facts arrive

- **Learned** — extracted from regular conversations. The normal path.
- **From Personal Obsidian** — learned from a connected folder when its
  [settings allow it](../connected-folders.md).
- **On request** — optional direct save with “remember this,” `/note`, or `//`. A note
  can carry a picture: attach or paste an image while in note mode and the picture is
  kept with the fact. Stem describes what the image shows into the fact's text in the
  background, so a photo of a router label or a menu can be recalled later. The picture
  itself is only ever shown to you, in the fact's details; the assistant sees the text.

The source appears on each fact. One-off completed task details are normally skipped.

## Review stored facts

Expand **Stored memory**. A fact can show:

- its source and category;
- **sensitive**, **pinned**, **draft**, **injected**, or **conflicting**;
- confidence and supporting evidence in its details.

**Draft** means the fact would be used for the message currently being written.
**Injected** means it was used for the last turn.

Actions appear on a fact:

- **Confirm** — accept a low-confidence fact.
- **Pin** — send this fact with every message; up to five. Confirm before pinning
  sensitive information.
- **Restore** — bring back a superseded fact.
- **Forget permanently** — delete that fact.

## What Stem chooses

Stem normally sends only facts relevant to the current message, not the whole store.
Sensitive facts need a more direct match. Expired details are never sent, and a
low-confidence guess Stem inferred stays out until you **Confirm** or pin it. While two
facts disagree, one side may still be sent, marked as **conflicting** so the model treats
it as uncertain rather than forgetting both.

Selected facts go to the model used for that chat—local or cloud.

Use **Preview draft** in **Stored memory** to see which facts the current message would
use.

## When two facts disagree

Stem cross-checks stored facts against each other in the background. When two of them
cannot both be true, the pair becomes a conflict: both facts are marked **conflicting**,
neither stays pinned, and a **Conflicts** card appears above **Stored memory** with
**Keep newer**, **Keep older**, and **Keep both**.

Until the conflict is settled, Stem still sends one side of it — what you stated
explicitly, or otherwise the side with the newest evidence — marked as conflicting so
the model treats it as uncertain. Nothing is sent if that side has expired or is an
unconfirmed guess.

Conflicts between two details Stem inferred are also settled for you in the background.
A conflict where one side is something you stated explicitly is always left for you.
For the rest, Stem may:

- **supersede one side** — the better supported statement stays, the other moves to
  **Superseded**;
- **keep both** — they turned out to describe different things, and both go back to
  normal;
- **rewrite both** — each was partly right, so they are replaced by shorter corrected
  statements, and the originals move to **Superseded**.

The twenty most recent of these are listed under **Recently auto-resolved**, below the
**Conflicts** card. Expand it to see both statements, which one was **Kept** and which
**Superseded**, what was done, and when.

To overrule one: **Restore** the superseded statement from the **Superseded** list in
**Stored memory**, and **Forget permanently** the one you do not want. Anything Stem
wrote during a rewrite is an ordinary fact — forget it the same way. When Stem cannot
tell which side is right, it leaves the conflict in the **Conflicts** card for you.

## Settings that matter

- **Memory** — stops saving new facts and Recall, and stops using stored Memory across
  chats. Existing data remains until reset.
- **Model** — reviews conversations for durable facts, creates summaries, and tidies
  Memory. A remote model receives transcript excerpts and may use provider quota.
- **Tidy up automatically** — merges duplicates and drops stale facts after the chosen
  number of new facts.

Leave **Relevance ranking (advanced)** at its default unless fact matching is poor.
Built-in matching runs locally. A configured server receives fact text and each
search; a separate ranking server also receives the search and candidate facts.

## Erase facts

Choose **Reset facts** at the bottom of the tab. This permanently erases durable facts.
It keeps Recall and Files.
