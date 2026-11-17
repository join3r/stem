# Mail

Send mail to a persona when you want it to work on a request and return a reply.
The first recipient coordinates the conversation and can consult the other
personas. Replies arrive in your Inbox. A persona that makes pictures while answering
(see [image generation](settings.md#image-generation)) attaches them to its reply.

This page is about mail with your own personas. To mail other people who use Stem,
see [Mail with other Stems](other-stems.md).

## Built-in personas

Stem ships with four personas. You can edit each one, but you cannot delete
it.

| Persona | What it does | Starts agents | Your memory |
| --- | --- | --- | --- |
| Normal | Answers on its own and brings in agents when a job needs them | yes | yes |
| Secretary | Delegates the work and keeps at it until the job is done, brings in any persona it needs without asking you, schedules follow-ups, and mails you only decisions and results | yes | yes |
| Verifier | Checks the factual claims in the work it is sent and lists what is wrong | no | yes |
| Critic | Reads what it is sent as its recipient would, without knowing who wrote it | no | no |

Personas that work on your computer (a coding agent, screen control or browser
control) are not built in. You make them in the Personas tab.

## The Personas tab

Open **Personas & people** in the side panel and choose **Personas** at the top
(**People** is the list of real people in your life; see
[Memory](memory/README.md#people)). The list groups personas by what they run as: **Assistants**, **Coding agents** and
**Computer control**. **New** starts one of each kind. Click a persona to edit it;
its header has buttons to duplicate it and, for your own personas, **Delete
persona**. Nothing changes until you press **Save**. Three tabs:

- **Role** — the role prompt, and optionally a model and effort of its own.
- **Runs as** — **Assistant** (Stem's own tools), **Coding agent** (Claude Code,
  Codex or another agent working in one folder on a computer you pick), or
  **Computer** (**Screen and apps** on a Mac, **Browser** through the Stem
  extension, or both).
- **Access** — **Private memory** (notes it keeps from its work; for a coding agent,
  **Standing answers** to the agent's recurring questions), **Sees your memory**,
  **Open to chats** (offered in the chat composer on the phone), **Can start
  helpers** (see Agents below), **Adds personas without asking** (it brings any
  persona into a conversation it leads, including ones that work on your
  computer; Secretary ships with it on), **Uses every MCP server** (switch it off to pick which
  servers it may use; the rest are hidden from it entirely), and **Send budget** (how
  many mails it may start between your sends).

## Who to mail first

Mail **Normal** when you are not sure. It answers simple requests itself and
starts agents when a job needs checking or several hands.

Mail **Secretary** for errands you want handled without the details, especially
ones that need a follow-up later. It always hands the work to someone else, so
it adds a step that a direct question does not need. It adds whichever personas
the job needs to the conversation itself, your coding, screen and browser
personas included, and does not ask you first. When a reply comes back
incomplete or stuck, it sends the work back or tries another persona instead of
handing the problem to you. It writes to you with the result, or when only you
can unblock it (a decision, a password, a payment). Normal is the one that stops
and suggests which persona to add.

Mail **Verifier** or **Critic** directly when that is the whole job: check
these claims, or read this draft cold. Mail a coding, screen or browser persona
directly when the request is that work. Secretary brings those in on its own.
To let Normal use one of them, add it to the conversation yourself.

## Write and read mail

**New mail** (`⌘⇧N`) opens as one letter: **To** and **Subject** lines on top, your
message below, and the attach, dictation, discard and Send buttons underneath. It
starts addressed to whoever your last mail went to. In
**To**, type a persona's name to add it. The first one leads: it gets your mail
and answers you. Click the crown on another to make it lead. The subject is
optional; Stem names the conversation after the first reply. **Private** in the
header makes the whole conversation private: nothing in it is saved to memory or
read from it, and the personas keep no notes of it. It is fixed once sent. Send
names the lead ("Send to Normal"); `⌘↵` (Ctrl+Enter) sends too. Closing the pane
keeps an unsent draft, which waits as a **Draft** row at the top of the Inbox; the
trash button (**Discard this draft**) asks first.

Attachments start uploading the moment you add them, so Send does not wait for
them. A file still uploading shows a spinner; one that failed shows a warning and
is tried again when you send.

Sending works like email: the mail closes and the conversation goes to **Sent**.
It comes back to the Inbox when the reply arrives. A reply you send closes its
conversation the same way. If a send fails, the mail stays open with your text and
the error. Every mail you write gets a reply, even one that asks nothing; then the
reply is a short line that shows it was read.

A conversation reads newest first. The reply box sits on top, under the header,
and says who gets your reply. Each conversation keeps its own reply draft. While
personas work, a live card shows who is on it and the latest steps, with **Stop**.
Below it the newest mail is open and older ones fold to one line. Mail the
personas sent each other folds onto the reply it led to ("Consulted Verifier · 2
mails"). If you reply while they are still working and only ask how it is going
("what's the status?"), the lead answers right away from their reports
and live work, and the work carries on undisturbed. A mail that also asks for
something is answered that way too and then read when the current run ends; any
other mail just waits for the run to end. A reply the server refused stays in the thread as **Not sent**,
with Retry, Edit and Delete, so its text is never lost. **Forward** sends a mail on
to other personas with a note of your own.

The Inbox lists the mail waiting on you first (unread in bold), then **Requests**
(first mail from people on other Stems you haven't accepted yet), then the folded
**Snoozed**, **Archived** and **Sent** sections. Conversations the personas are
still working on wait under **Sent** until their reply lands. A run that needs your
approval for a command waits in its mail with **Allow once** and **Deny**. You can
also answer in words in the reply box instead. Once you
answer, the run carries on. The reply and compose boxes have the dictation mic too.

Click a picture attached to a mail to open it full-window.

## Agents

A persona allowed to start agents (**Can start helpers** under its editor's
**Access** tab; Normal and Secretary ship with it on) can hand pieces of a job to
agents. An agent is a named copy of one of your personas, such as two Critics
called reviewer-a and reviewer-b, that works its piece and reports back to the
persona that started it. Several agents started together work in parallel, and
their reports come back as one. The persona decides per request whether
agents are worth the extra turns. It answers most requests alone. When an
answer rests on facts that could be wrong, one agent checks them first. For a
consequential question, agents gather evidence in parallel and a blind Critic
reads the draft cold. For a hard problem, two or three agents solve it
separately and the persona keeps the best-argued answer. For a code change, the
coding persona does the work and ends its report with the change's diff; a
blind agent that runs no coding agent reviews that diff, the findings go back
to the coding persona once, and you get one report. A Critic on a
different model from the persona that leads gives a more independent read;
set its model in its editor. For a persona without a model of its own, the
persona starting the agent can pick one of your models, so two agents of the
same persona can still work on different models. An agent started blind judges
without your memory and without knowing who wrote the work, and it only ever
gets mail addressed to it alone, so it never sees the other agents'
assignments. Agents keep no memory, never
answer you directly, and never appear in the Personas list: they belong to the
conversation and go away with it. Their work shows under **Work** like any
other persona's. A conversation can have at most six agents, and agents started by another
agent can fill only five of those places. The last one is kept for the persona
you mailed, so it can always have its lead's work checked. An agent never
gets integrations its starter lacks, and a persona that works on your
computer (a coding agent, screen or browser control) is started as an agent
only in a conversation you added it to, or one led by a persona with **Adds
personas without asking** on.

Orchestrator is no longer a built-in persona, because every persona that can
start agents now does its job. If you had edited Orchestrator's prompt, it
stays as one of your own personas.

## Scheduled tasks

A scheduled task that finds something worth telling you sends mail. All firings
of one task share one conversation. Each firing keeps its own headline, and the
conversation takes the latest headline as its subject. Beneath the short notice
the mail carries the run's full reply, such as a report or the drafts it wrote,
once the run finishes. A task scheduled from a mail conversation, such as a
follow-up check a persona set up, reports in that same conversation instead, so a
chain of checks stays one Inbox row. Every run happens in a thread of its own that
no chat shows; the mail, and the Work beneath it, is the only place a run appears. A
task that starts failing sends one mail with the reason. Pictures a run makes come
with its mail, and a run that made pictures always sends one.

## Work history

Expand **Work** under a reply to see what happened while you waited. Work that
cannot be tied to one mail folds into **Earlier work** at the bottom.
Each request has its own history, grouped by persona and run. The timeline shows
recorded actions, progress updates, timestamps, and outcomes. Expand an action to
inspect its input and output. On iOS, action details open in a full-screen view.
Coding-agent actions appear inside the same history, including work performed on
a paired computer.

Work updates while the request runs. These updates do not mark the conversation
unread or trigger notifications. Replies and requests for your input still arrive
as mail. Intermediate progress stays in Work rather than being appended to the
final reply.

Failed and stopped runs keep their recorded partial results. An unfinished action
is not shown as successful merely because the run ended. After a server restart,
a run without a saved outcome is marked as interrupted by the server restart.

Scheduled notifications have Work beneath them, linked to the run that produced
them. If a run produces several notifications, each can show that run's history.

Older mail uses recoverable session records. Stem marks missing records and
uncertain mail-to-run links explicitly. Large inputs and outputs can be shortened,
and retention limits are marked where details were omitted. Work contains visible
actions and progress, not private model reasoning.
