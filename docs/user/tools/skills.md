# Skills

← [Stem guide](../../README.md) · [Tools](README.md)

Examples only. These skills are not bundled with Stem.

| Example skill | Reusable procedure |
| --- | --- |
| `food-ordering` | Rebuild a usual order; verify items, address, and total; stop before checkout |
| `agent-browser-vercel` | Smoke-test a Vercel deployment with an existing agent-browser setup |
| `monthly-invoice-report` | Reconcile invoice data; total the month; flag missing or overdue invoices |
| `standup-meeting-report` | Turn standup notes into completed work, next steps, owners, and blockers |

Skills are reusable procedures: when to use a workflow, its steps, and how to verify
the result. Not memories. They provide no accounts, tools, or permissions by
themselves.

A skill can also hold how you want a recurring job done for you. Tell Stem "sign my
email drafts as Stem, on behalf of me" or "write to my doctors formally, from my Gmail
address", and it saves that in a skill for drafting your mail rather than in your
custom instructions. Every chat and scheduled task that drafts mail then follows it,
and later corrections update the same skill. Stem also proposes one on its own after
it drafts a message for you, under the **Saving skills** setting.

Open **Tools → Skills**.

<!-- TODO(screenshot): Skills list showing the four demo skills, an auto label, usage details, and enabled switches. -->

## What you can do

- Use the switch to disable a skill without deleting it.
- Click a skill to select it, then the trash button under the list deletes it for
  good — it asks first. This works on skills you wrote yourself too: on a server
  install the skills folder is on the server, so this is the only way to reach it.
- The history button under the list shows the earlier versions of the selected
  skill, each with the reason it changed. Pick one and press **Restore** to put it
  back. The current text is kept as an earlier version, so a restore can be undone.
  Stem keeps the last ten versions of each skill.
- **Tidy up** keeps one skill per job: it splits a skill that grew to cover several
  unrelated jobs, merges two write-ups of the same job, and archives ones untouched
  for 90 days. Archiving is the same reversible switch as above, so an archived
  skill can be switched back on. Anything it rewrites is backed up first.
- **Saving skills** decides how much Stem may save on its own. Asking it to save
  one always works, whichever you pick.
- **Skills model** does the model-driven skills work: writing, `/learn`, tidy-up.
  It is also under **Settings → Models → Judgment work**.

An **auto** label marks a skill Stem created. Usage details show whether it is still
useful. Stem reshapes only skills that were its own idea, including ones you accepted
from a proposal card; it may change or split those without asking. Skills you asked it
to save, skills you imported or added yourself, `/learn` skills and recorded skills are
never rewritten by tidy-up or by the rewrite below. Stem changes them only when you ask,
or when you correct a result that followed one. Imported skills never change that way.

A cloud curator receives relevant chat excerpts during collection and auto-skill text
during upkeep. It may use provider quota.

Keep skills narrow and verifiable. Disable an auto skill to stop Stem using it.

## How skills improve

Each time a skill is used, Stem keeps a short record of that use: your request, what
Stem did, and how you took the result in your next message. It reads that from your
next message in the background, with the memory pass that already reads it, so this
costs no extra model call per message.

- When you correct a result ("no, sign it as Stem"), Stem changes the skill that
  produced it, with your correction as a step.
- When three uses of a skill went wrong, Stem looks at all of its records at once,
  works out which steps caused the trouble, and rewrites the skill. This applies only
  to skills that were Stem's own idea.
- Before Stem saves any change it made on its own, a separate check compares the new
  text with the old one and with the records. A change that would break what worked
  before, or that only fits one case, is not saved.

The Skills list shows the result as "5 accepted · 1 needed a fix". The **Saving
skills** setting applies to all of this: **Only when I ask** stops it, and **Ask
first** shows each change as a card.

The records need Memory on. Private chats, scheduled runs and personas without memory
leave no record, and deleting a chat deletes its records.

## Recording a skill

Recording is in **Alpha**. On the Mac app, press **Record** under the message box
(or type `/record`, or ⌃⌥R) and do the task in your own apps as usual; press **Stop** when done. Stem
notes what you click, type and switch to, plus the settings of any dialog you
confirm, and writes a draft skill card in the chat. It may ask up to three
questions in the card; answer in a sentence. **Save skill** adds it to your library.

**Practice run** lets Stem try the draft first. It fills the message box with the
task and the final steps it must stop and ask about; edit it, then send. Correct it
in the chat as it goes. Taking over the mouse or keyboard (or pressing Stop on a
browser run) stops it at once, and the card asks what went wrong. Afterwards, **Update
the skill from this run** rewrites the draft from what happened, your corrections
first.

Nothing is recorded inside password managers or password fields, and one-time codes,
card numbers and keys typed anywhere are masked. While recording, Stem minimizes
itself and a small pill with **Stop** stays on screen.

## Seeing a skill in use

Stem decides which skills to load by comparing your message with each skill's
description and with a few example requests it writes for every skill in the
background, in the languages you write in. When a description changes, its examples
are written again. While Memory is off, no examples are written and skills are matched
on their descriptions alone.

Under the reply, the folded tool line counts skills separately — "Used 2 tools and 1
skill". A skill is listed there only when the answer actually followed it ("Followed
the skill monthly-invoice-report"); one that was merely loaded, or only known by name,
is not. A skill already used earlier in the same chat is not loaded again.

The **used N×** figure on the Skills list is a different, stricter count: it credits a skill only
when the turn ran something the skill's steps name.

## Skills and the machine they run on

A skill is followed later, possibly somewhere else: your library travels with Stem when you
move it to a server, and a step that worked on your own Mac may then run on a machine that
cannot reach the same files, the same home network, or the same sites. Stem is told which
machine it is on when it writes a skill, and a procedure that depends on one is written down
with the machine, the reason, and the way in — `run_command`'s `device` parameter, or an MCP
server pinned to that computer. If a skill you wrote by hand needs a particular machine, say
so in its steps for the same reason.
