# Mail

Send mail to a persona when you want it to work on a request and return a reply.
The first recipient coordinates the conversation and can consult the other
personas. Replies arrive in your Inbox. A persona that makes pictures while answering
(see [image generation](settings.md#image-generation)) attaches them to its reply.

## Agents

A persona allowed to start agents (the "Can start agents" box in its editor;
Normal, Secretary and Orchestrator ship with it on) can hand pieces of a job to
agents. An agent is a named copy of one of your personas, such as two Critics
called reviewer-a and reviewer-b, that works its piece and reports back to the
persona that started it. Several agents started together work in parallel, and
their reports come back as one. An agent started blind judges without your
memory and without knowing who wrote the work. Agents keep no memory, never
answer you directly, and never appear in the Personas list: they belong to the
conversation and go away with it. Their work shows under **Work** like any
other persona's. A conversation can have at most six agents.

## Scheduled tasks

A scheduled task that finds something worth telling you sends mail. All firings
of one task share one conversation. Each firing keeps its own headline, and the
conversation takes the latest headline as its subject. Beneath the short notice
the mail carries the run's full reply, such as a report or the drafts it wrote,
once the run finishes. Every run happens in a thread of its own that no chat
shows; the mail, and the Work beneath it, is the only place a run appears. A
task that starts failing sends one mail with the reason. Pictures a run makes come
with its mail, and a run that made pictures always sends one.

## Work history

Expand **Work** beneath your message to see what happened while you waited.
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
