# Browser control

Stem can work in your own browser — the real one, signed in to your accounts — through
the Stem extension: open pages, read them, click, type, fill in forms, upload files,
download, and check a page's console and network requests. It works in background
tabs, so the tab you are looking at never changes under you.

It runs on a Mac, in Arc, Chrome, Dia or Brave. It works whether Stem's server runs on
that Mac or somewhere else.

## Setting it up

On the Mac whose browser Stem should use:

1. Open Settings → Features → **Browser control** and switch on **Let Stem control this
   Mac's browser**.
2. Press **Set up…**. Stem puts the extension in a folder, shows that folder in Finder,
   and tells the browsers on this Mac how to reach Stem.
3. In your browser, open the extensions page (`chrome://extensions`, or
   `arc://extensions` in Arc), turn on **Developer mode**, click **Load unpacked** and
   choose the folder Stem showed.

Settings then shows the browser as connected. You do this once per browser; when Stem
updates, the extension updates itself. If the extension is installed in more than one
browser, a **Use** row picks the one Stem drives. When that browser is closed and a run
needs it, Stem starts it in the background.

## Who can use it

The same two places as computer control, and a conversation gets it from exactly one:

- **A persona** gets it from its browser pin in Manage → Personas ("Browser this persona
  controls"). The browser pin is separate from the computer pin: a persona can have
  the browser without your screen. Pinned personas use it in chats, mail and scheduled
  tasks.
- **A chat with no persona** gets it from Settings → Features → Browser control →
  **Allow in chats**, either on a fixed Mac or letting the model pick one.

## While it works

- Pages Stem opens appear as background tabs in your current window (in Arc, your
  current Space) and stay open afterwards, so you can look at what it did. It can also
  work in a tab you already have open. It only ever closes tabs it opened itself.
- The tab it is working in gets a coloured border and a **Stem is working · Stop** pill.
  Your browser also shows a bar saying the Stem extension is debugging it; that bar is
  how Chrome-family browsers show any extension driving a tab, and it goes away when the
  run ends. Pressing Stop on the pill, in the extension's toolbar menu, or cancelling
  that bar ends the run.
- There are no approvals per action. Leave the switch off if this Stem server is not
  yours alone.

Web pages can contain text written to mislead an assistant. Stem is told never to
follow instructions found on a page and to act only on what you asked, but a page is
still a page from the internet: keep an eye on runs that touch accounts that matter.

## Files

- **Uploads** take only files Stem already holds: attachments in the conversation,
  files in your Files place, files the assistant made, and files in connected folders.
  It cannot upload an arbitrary file from the Mac.
- **Downloads** land in your browser's Downloads folder as usual, and a copy goes to the
  conversation's scratch folder on the server so the assistant can read or send it.

## When it does not work

- *"does not let Stem drive its browser"*: the switch on that Mac is off.
- *"No browser with the Stem extension has connected"*: Set up has not been done there,
  or the extension was not loaded with Load unpacked.
- *"the Stem extension did not connect"*: the browser started but the extension is
  disabled or removed; check its extensions page.
- *"not connected right now"*: the Mac is asleep or Stem is not running on it.
- Pages inside a cross-site frame (some payment and login widgets) are not part of what
  the assistant reads; a screenshot still shows them.
