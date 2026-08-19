# Scheduled tasks

← [Stem guide](../README.md)

Maya creates tasks by asking in a chat:

> Every Monday, check whether all software installed on this Mac is supported by
> the next macOS version currently in beta. Alert me only about unsupported or
> unknown apps, with source links.

> Every Friday, find AI-generated sci-fi short films released that week on YouTube
> or discussed on Reddit. Show only well-liked films, with direct links and visible
> audience signals.

Future runs and their answers return to that same conversation.

<!-- TODO(screenshot): Recapture with the two canonical Maya demo tasks. -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../screenshots/tasks-dark.png">
    <img alt="Stem Scheduled tasks showing recurring work and its next run" src="../screenshots/tasks-light.png" width="320">
  </picture>
</p>

## What to expect

- Stem must be running. If Stem is closed or the computer sleeps, each overdue task
  runs once when Stem can run again.
- Times use the computer’s local time.
- Runs use the task chat’s last selected model and effort, unless the task pins its
  own in **Scheduled tasks** (see below). Speed, output format, and custom
  instructions do not carry over.
- Runs can use enabled tools. Web-search tasks request search automatically. Native
  search needs a compatible model; otherwise enable a search-capable tool.
- Every run and answer is recorded in that chat. Stem speaks up only when the task
  explicitly asks it to notify you — by default with a pop-up that brings Stem to the
  front. Settings → App → **Notifications** turns that down to a dock bounce, or to
  nothing at all; the chat still turns up unread in your Inbox in every case.
- A one-time task disappears after its scheduled run finishes, even if it fails.
- Commands needing interactive approval are denied. Use clearly safe commands or a
  narrowly saved allowed prefix.

## Task controls

Open **Scheduled tasks**, then:

- **Next** is the useful date. The `cron` line is Stem’s stored repeat pattern.
- A run marked **(failed)** carries the reason: hover it. The same line is in the log
  (`stem.log` in Stem’s state folder), which is where to look if the row is gone.
- Click the task text to show the full instruction.
- The dotted model label on each row names what its runs execute on. Click it to
  change that: left on **Chat model**, runs follow whatever model is selected in
  the task’s chat; pick a model (and optionally an effort) to pin runs of this
  task to it, regardless of what the chat later switches to.
- **Open chat** to inspect its history or change its model.
- **Run now** to test it without changing the next scheduled time.
- **Pause** to keep the task without running it.
- **Delete** to remove the schedule. Existing chat messages remain.

To replace the instruction or timing, ask Stem in that chat to cancel the task and
create a new one.
