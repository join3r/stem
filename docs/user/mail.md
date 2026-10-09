# Mail

Send mail to a persona when you want it to work on a request and return a reply.
The first recipient coordinates the conversation and can consult the other
personas. Replies arrive in your Inbox. A persona that makes pictures while answering
(see [image generation](settings.md#image-generation)) attaches them to its reply.

## Built-in personas

Stem ships with four personas. You can edit each one, but you cannot delete
it.

| Persona | What it does | Starts agents | Your memory |
| --- | --- | --- | --- |
| Normal | Answers on its own and brings in agents when a job needs them | yes | yes |
| Secretary | Delegates the work instead of doing it, schedules follow-ups, and mails you only decisions and results | yes | yes |
| Verifier | Checks the factual claims in the work it is sent and lists what is wrong | no | yes |
| Critic | Reads what it is sent as its recipient would, without knowing who wrote it | no | no |

Personas that work on your computer (a coding agent, screen control or browser
control) are not built in. You make them in the Personas tab.

## Who to mail first

Mail **Normal** when you are not sure. It answers simple requests itself and
starts agents when a job needs checking or several hands.

Mail **Secretary** for errands you want handled without the details, especially
ones that need a follow-up later. It always hands the work to someone else, so
it adds a step that a direct question does not need.

Mail **Verifier** or **Critic** directly when that is the whole job: check
these claims, or read this draft cold. Mail a coding, screen or browser persona
directly when the request is that work. To let Normal or Secretary use one of
those, add it to the conversation yourself.

## Agents

A persona allowed to start agents (the "Can start agents" box in its editor;
Normal and Secretary ship with it on) can hand pieces of a job to
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
only in a conversation you added it to.

Orchestrator is no longer a built-in persona, because every persona that can
start agents now does its job. If you had edited Orchestrator's prompt, it
stays as one of your own personas.

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
