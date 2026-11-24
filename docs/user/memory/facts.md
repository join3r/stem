# Facts

← [Stem guide](../../README.md) · [Memory](README.md)

Facts are stable details Stem may pick up from ordinary conversations.

Maya says during a regular chat:

```text
My App Source uses pnpm and Node 22.
```

No special wording. With **Memory** on, Stem reviews new conversations in the
background. Reusable details may appear as facts shortly afterward.

Open the right sidebar → **Memory** → **Facts**. From the top: the **Memory**
switch with a one-line status, **What Stem knows about you** (the [summary of
you](README.md#summary-of-you)), **Check my memory** (the Deep check), **Needs your
answer** when two facts disagree, then the facts themselves. **History** and
**Housekeeping** are folded away at the bottom.

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
Facts can be about the people in your life as well as about you; see
[People](README.md#people).

## Review stored facts

The **Facts** list has a search box and four filters: **All**, **This chat** (facts
the last message used, or your draft would use), **Pinned**, and **Unconfirmed**
(facts Stem is unsure of). A fact can show:

- its source and category;
- **sensitive**, **pinned**, **draft**, **injected**, or **conflicting**;
- how often it was sent with a message and how often a reply visibly drew on it;
- confidence and supporting evidence in its details.

**Draft** means the fact would be used for the message currently being written.
**Injected** means it was used for the last turn.

Actions appear on a fact:

- **Confirm** — accept a low-confidence fact.
- **Pin** — send this fact with every message; up to five. Confirm before pinning
  sensitive information.
- **Restore** — bring back a **superseded** fact (one listed under **History → Replaced**).
- **Forget permanently** — delete that fact.

## Deep check

**Run check** on the **Deep check** card reads every fact Stem learned, from chats
and from connected folders, together with where each came from. It takes a few
minutes; you can leave, and it shows in the background-activity panel meanwhile.
The findings arrive as one **Memory check** mail:

- **Fixed** — what it could prove wrong was corrected at once: a fact about someone
  else with none of your words behind it, a duplicate, or a fact your own later
  message overrules. Each fix has **Undo**.
- **Need your answer** — up to five questions, answered by picking options in the
  mail and pressing Send. Facts that disagree come first, with **Both are true**,
  **Only the first**, **Only the second** and **Neither**. Skipped questions come
  back at the next check.
- **Your call** — what it suspects but cannot prove, one card per fact: **Keep** or
  **Retire**, or for something ongoing ("working on", "planning") **Still current**,
  **Never true** or **Ended**. **Undo** on a settled card brings its choices back.

Facts you stated explicitly and pinned facts are never changed. The card then
shows how many facts were fixed, how many questions are still unanswered, and how
many are left for you to decide; **Answer in mail** opens the mail, and **Run
again** starts a new check.

## What Stem chooses

Stem normally sends only facts relevant to the current message, not the whole store.
Sensitive facts need a more direct match. Expired details are never sent, and a
low-confidence guess Stem inferred stays out until you **Confirm** or pin it. While two
facts disagree, one side may still be sent, marked as **conflicting** so the model treats
it as uncertain rather than forgetting both.

Selected facts go to the model used for that chat—local or cloud.

Next to the facts, Stem can send a few **broader memories**. In the background it
files related facts into groups ("knee surgery and recovery", "the Northwind
contract") and writes each group a short summary from its facts. When a group is
close to your message, its summary goes along with the facts, so the answer sees
the wider picture and not one detail alone. A summary is sent only while it still
matches its facts: forgetting a fact clears the summaries of its groups, and
erasing facts erases them all. A group built from a sensitive fact needs a much
stronger match.

Each chat that can see your memory is also told which topics your memory holds,
one short label per group, so the assistant knows when searching its memory will
find something and searches before asking you. A topic that holds a sensitive fact
shows only as its category ("Private: health"), and the list is left out of mail
with other people.

Use **Preview draft** (the eye button above the list) to see which facts the current
message would use, and which broader memories would go with them.

## When two facts disagree

Stem cross-checks stored facts against each other in the background. When two of them
cannot both be true, the pair becomes a conflict: both facts are marked **conflicting**,
neither stays pinned, and the pair appears under **Needs your answer** with **Keep
newer**, **Keep older**, and **Keep both**. A Deep check asks about open conflicts too.

Until the conflict is settled, Stem still sends one side of it — what you stated
explicitly, or otherwise the side with the newest evidence — marked as conflicting so
the model treats it as uncertain. Nothing is sent if that side has expired or is an
unconfirmed guess.

A statement about a past period ("worked at Northwind 2022–2024") is history, not a
conflict with a different present. Conflicts between two details Stem inferred are
settled for you in the background. A conflict where one side is something you stated
explicitly is always left for you. For the rest, Stem may:

- **replace one side** — the better supported statement stays, the other is retired;
- **keep both** — they turned out to describe different things, and both go back to
  normal;
- **rewrite both** — each was partly right, so they are replaced by shorter corrected
  statements, and the originals are retired.

**History** at the bottom of the tab lists them: **Replaced** holds every retired fact,
and **Settled automatically** the twenty most recent background settlements, with both
statements, which one was **Kept** and which **Replaced**, and when.

To overrule one: **Restore** the replaced statement from **History → Replaced**, and
**Forget permanently** the one you do not want. Anything Stem wrote during a rewrite is
an ordinary fact — forget it the same way. When Stem cannot tell which side is right,
it leaves the conflict under **Needs your answer** for you.

## Tidy-up

Tidy-up runs by itself as Stem learns. A new fact that only repeats one Stem already
has is merged into it on sight, and the existing fact keeps the evidence. Each pass
then reviews new facts beside their closest neighbours, merging duplicates and
retiring stale ones. A pass over the whole store runs once enough has been learned
since the last one (a quarter of the store), so a quiet week costs nothing. Facts
learned from connected folders are left out of tidy-up.

Under **Housekeeping**: **Tidy now** starts a full pass, **How often** sets when the
automatic passes run (**Frequent**, **Normal**, **Occasional**, or **Manual**), and
**Add sources to older memory** re-reads chats from before Stem kept sources.

## Settings that matter

- **Memory** — the switch at the top. Off stops saving new facts and Recall, and stops
  using stored Memory across chats. Existing data remains until erased.
- **Settings → Models → Judgment work → Memory** — the model that reviews
  conversations for durable facts, writes summaries, runs the Deep check and tidies
  Memory. A remote model receives transcript excerpts and may use provider quota.
- **Settings → Models → Memory recall** — how many facts go with each message, and
  the models that pick them. Leave it at its defaults unless fact matching is poor.
  Matching runs on your Stem; nothing is sent elsewhere to rank facts.

## Erase facts

Open **Housekeeping** at the bottom of the tab and choose **Erase facts**. This
permanently erases durable facts. It keeps Past chats and Files.
