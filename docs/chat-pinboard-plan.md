# Chat pinboard

Status: implemented on branch `chat-pinboard` (phases 1–5). Mobile UI and the "Ideas for later" are not.

## Purpose

Long chats bury the parts worth keeping — a mixing ratio, a setting, a deadline —
somewhere in the scroll. Quick notes (`//`, `/note`) don't fit: they go to Recall,
which is memory *about the user*, unscoped from any chat. A pinboard is memory
*about this chat*: what the user chose to keep, visible at the top of the thread
and, just as important, never forgotten by the model.

## Proposed shape

| Area | Proposal |
| --- | --- |
| Placement | A strip directly under the chat header (title + model line), full width of the chat column, sticky while the messages scroll. Not the window's top edge — that is the title bar. |
| Collapsed | One ~32px line: pin icon, count, then a very short summary in parentheses — `📌 3 (Rubio mix · curing · 2nd coat)` — built from each item's 2–4 word label, truncated to the row. Hidden entirely until the chat has a first item. |
| Expanded | Drops down *over* the messages (does not push them), max ~40% of the chat height, scrolls inside. A click anywhere outside it (the messages, the composer) collapses it again. A "keep open" toggle docks it instead, pushing the messages down; docked, it stays open until collapsed explicitly. Docked/floating remembered per chat. |
| Labels | Every item carries a 2–4 word label for the collapsed summary, written by a cheap background completion (the chat-subject model) and editable by hand. Until it arrives, the first words of the item stand in. |
| Item: pinned message | Pin in the message action row (next to copy / retry / branch / delete). Shows the first lines; expand for the rest. |
| Item: pinned passage | Select text in a message → Pin. The common case: the formula is one sentence of a long answer. |
| Item: chat note | User-written, editable text that the AI never said ("2nd coat done Oct 3"). |
| Jump to source | Clicking a pinned message or passage scrolls to the message and highlights it (passage: the exact range). |
| In the model's context | All items are injected into every turn of the chat, like pinned Recall facts — so they survive pi's compaction of a long thread. |
| Private chats | Pins work (they are the user's explicit choice), but nothing flows into Recall. |
| Clients | Desktop main window only in v1 (not Quick Chat). Stored and served by the server, so the mobile app can follow; the PR documents what mobile needs. |

## Decisions (v1)

- Passages are in v1 (select text → Pin), not only whole messages.
- Pins always go to the model, every turn of the chat (capped).
- Desktop only; server API ready for mobile; mobile work listed in the PR.
- Click outside collapses a floating board; summary labels in the collapsed row.

## Implementation plan

### How the pieces fit today

- Threads are pi session files; Stem's per-thread metadata (folder, subject,
  private, filing) is a JSON store (`server/workspace/chats.ts`, `folders.json`).
- A server feature is a channel: handler in `server/ipc/*.ts` via `registerServer`,
  argument spec in `server/ipc/guard.ts` (`IPC_ARGS`), method on the `StemApi` type
  in `shared/types.ts`, binding in `preload/index.ts`. Server → client pushes go
  through `emit(channel, payload)` in `server/index.ts` and an `on…` listener in
  preload. Every client, remote or local, uses the same registry.
- Each turn's context is assembled in `PiRuntime.buildMessage`
  (`server/pi/runtime.ts`): standing instructions, private-chat note, Recall,
  skills, files, … — pi has no per-turn context field, so blocks are prepended.
- Messages carry `turnId` (shared by a user message and its reply) and `role`;
  retry/edit/fork/delete all key on it (`ChatView.tsx` action row).
- Backup/transfer lists every store explicitly (`server/workspace/state-transfer.ts`).

### Phase 1 — store and API (server)

- `server/pins/store.ts`: new `chat_pins.sqlite` (`chatPinsDbPath()` in
  `workspace/paths.ts`), `node:sqlite` + WAL like `chatsearch/store.ts`. Table
  `pins`: `id` (uuid), `thread_id`, `kind` (`message|passage|note`), `turn_id`,
  `role`, `text` (snapshot or note body), `label`, `label_source`
  (`auto|user|null`), `position`, `created_at`, `updated_at`. Index on `thread_id`.
- Types in `shared/types.ts`: `ChatPin`, `ChatPinInput`, `ChatPinPatch`.
- Channels (`server/ipc/pins.ts`): `pins:list(threadId)`, `pins:add(threadId, input)`,
  `pins:update(threadId, pinId, patch)` (text, label, position), `pins:remove(threadId,
  pinId)`. Each mutation returns the chat's fresh list and emits `pins:changed
  {threadId}` so other windows/clients refetch.
- Lifecycle: `chats:delete` drops the chat's pins; `chats:forkThread` copies pins
  whose turn is in the fork (+ notes). Rollback/edit change nothing server-side —
  the client marks a pin whose `turnId` is gone as "source no longer in chat".
- `state-transfer.ts`: add `chat_pins.sqlite` (kind `sqlite`) to the archive list.
- Tests: store CRUD/ordering/fork-copy/delete; guard specs; state-transfer list.

### Phase 2 — the board (renderer)

- `renderer/chat/PinBoard.tsx`: the strip + dropdown under the chat header, above
  `.messages` in `ChatView` (main window only: rendered when `threadId` is set and
  not in Quick Chat). Collapsed summary from labels; floating vs docked; click
  outside (pointerdown on document, ignoring the board itself) collapses floating;
  Escape collapses too. Docked state per chat in `localStorage` (a per-viewer
  convenience, wrapped in try/catch).
- `renderer/session/pins.ts` hook: load on chat open, apply mutation results,
  refetch on `pins:changed` for this thread.
- Styles in `styles.css`, following `docs/ui-conventions.md`; works in all themes.

### Phase 3 — pinning

- Pin button in the message action row (user and assistant messages with a
  `turnId`); toggles: a pinned message shows an active pin and unpins on click.
- Passage: on mouseup inside a finished message body with a non-empty selection, a
  small floating "Pin" button near the selection; stores the selected text plus
  `turnId`/`role`. Jump highlights it by searching the snapshot text in the message
  (falls back to highlighting the whole message if the text no longer matches).
- Notes: "Add note" in the board; inline edit/delete for every item; drag or
  up/down to reorder (`position`).
- Jump: scroll the message into view, brief highlight; source missing → disabled
  jump with the "no longer in chat" hint.

### Phase 4 — model context and labels

- `server/pins/context.ts`: `buildPinsContext(threadId)` → a block like *"Pinned in
  this chat by the user (keep these in mind; the user chose them as important):"*
  followed by the items. Inserted in `buildMessage` after the private-chat line and
  before Recall. Applies to private chats too (explicit user content, nothing goes
  to Recall). Capped (e.g. 4 000 chars): notes first, then newest pins; truncated
  items end with "…".
- Labels: after `pins:add` (and on text edit unless `label_source = user`), a
  background completion writes a 2–4 word label in the chat's language, using the
  chat-subject model settings (`backgroundRunOf('subject', …)` in
  `chats/subject.ts`), short timeout, failure leaves the fallback. Emits
  `pins:changed` when done.
- Tests: context block shape, cap, ordering; label sanitizing.

### Phase 5 — search and polish

- Chat search: index pins and notes with the thread (`chatsearch/index-sync.ts`
  `reindexOne`), reindex on pin changes, so a search for "Rubio ratio" finds the chat.
- e2e (Playwright): pin a message, pin a passage, add a note, collapse by clicking
  outside, reload and see them, delete the chat and see them gone.
- Release notes entry; README screenshot optional.

### For the PR: mobile later

The server side is complete for mobile: `pins:list/add/update/remove` and the
`pins:changed` push. The mobile app needs the board UI (collapsed strip under the
chat header), a pin action on messages (long-press menu), passage pinning via the
native text-selection menu, and note editing. Nothing server-side changes.

## Ideas for later

- **Suggested key points.** After a turn, a cheap background pass (like chat naming
  in `chats/subject.ts`) proposes items — "Mixing ratio: 3 parts oil : 1 accelerator"
  — that the user accepts with one click. Suggest, never auto-add: a board the user
  didn't curate stops being trusted.
- **Dated items → reminders.** "Fully cured on Oct 8" pinned with a date, offered as
  a Task/reminder.
- **Space boards.** A pinboard per folder (e.g. *Domácnosť*: inverter settings, error
  codes) collecting pins from any chat in it, injected into all of its chats.
- **Promote to memory.** "Save to memory" on a pin for the rare item that is really
  about the user, handing it to the `/note` path.
- **Checklist items.** Notes with checkboxes for multi-step jobs (coat 1 ✓, coat 2,
  buff, cure).
- **Export.** Copy the board as Markdown — a project summary in one click.
