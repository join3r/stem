# Browser control

Stem can work in your own browser — the real one, signed in to your accounts — through
the Stem extension: open pages, read them, click, type, fill in forms, upload files,
download, and check a page's console and network requests. It works in background
tabs, so the tab you are looking at never changes under you.

It runs on a Mac, in Arc, Chrome, Dia, Brave, Edge or Chromium; on Windows, in Chrome, Edge, Brave or
Chromium; and on Linux, in Chrome, Brave, Chromium, Edge, Vivaldi, Opera, or any other Chromium
browser, including AppImages such as Helium or Thorium. It works whether Stem's server runs on that computer or somewhere else. On Linux,
Snap and Flatpak builds of a browser can't reach Stem; use the browser's own .deb, .rpm or AppImage.
Run a new browser once before Set up, so Stem finds its settings folder.

## Setting it up

On the computer whose browser Stem should use:

1. Open Settings → Features → **Browser control** and switch on **Let Stem control this
   Mac's browser** (**this computer's browser** on Windows and Linux).
2. Press **Set up…**. Stem puts the extension in a folder, copies that folder's path,
   brings your browser forward, and tells the browsers on this computer how to reach Stem.
   The steps below then appear in Settings, with Copy and Open buttons.
3. In your browser, type the extensions page into the address bar (`chrome://extensions`,
   `arc://extensions` in Arc, or `edge://extensions` in Edge) and turn on **Developer mode**.
4. Click **Load unpacked**. In the folder picker press ⌘⇧G, paste the path with ⌘V,
   press Return, then **Select**. On Linux press Ctrl+L, paste with Ctrl+V, and press Enter.
   On Windows click the folder picker's address bar, paste with Ctrl+V, press Enter, then
   **Select Folder**.

Settings shows the browser as connected within a couple of seconds. You do this once per browser; when Stem
updates, the extension updates itself. When that browser is closed and a run needs it,
Stem starts it in the background. On Windows and Linux it may open in front. On Linux,
Stem starts only Chrome, Brave, Chromium, Edge and AppImage browsers itself; open any
other browser, such as Vivaldi or Opera, before a run that needs it.

## Several profiles

If you keep separate browser profiles — an Arc profile for work and one for personal
things, say — load the extension in each one (press **Set up again** and repeat steps
3–4 from a window of the other profile). Each profile connects on its own, and Stem can
work in all of them:

- **Profiles** in Settings lists them. Give each one a name, such as *Work* and
  *Personal*. To tell which is which, click the Stem button in a browser's toolbar: it
  says the name that profile goes by.
- **Use** picks the profile a task starts in.
- When you ask for something in a particular one ("in my work browser, …"), or the page
  it needs is open there, the assistant switches to that profile and stays in it for
  the rest of the task. Asked for the open tabs, it sees every open profile's tabs under
  that profile's name.
- A profile you removed the extension from can be forgotten from the list once it is
  closed.

## Who can use it

The same two places as computer control, and a conversation gets it from exactly one:

- **A persona** gets it from its browser pin: in the Personas tab, open the persona,
  choose **Computer** on its **Runs as** tab, and pick a computer under **Browser**. The
  browser pin is separate from **Screen and apps**: a persona can have the browser
  without your screen. Pinned personas use it in chats, mail and scheduled
  tasks.
- **A chat with no persona** gets it from Settings → Features → Browser control →
  **Allow in chats**, either on a fixed computer or letting the model pick one.

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
- Stem never types passwords, one-time codes, PINs or card details; it tells you and
  waits. A bank account number (IBAN) is not a secret: it fills one in when you ask.
  On a form it picks the details that fit, private email and phone for a private
  matter and work ones for work, and asks when it can't tell. Computer control
  follows the same rules for passwords, codes, card details and IBANs.

Web pages can contain text written to mislead an assistant. Stem is told never to
follow instructions found on a page and to act only on what you asked, but a page is
still a page from the internet: keep an eye on runs that touch accounts that matter.

## Files

- **Uploads** take only files Stem already holds: attachments in the conversation,
  files in your Files place, files the assistant made, and files in connected folders.
  It cannot upload an arbitrary file from your computer.
- **Downloads** land in your browser's Downloads folder as usual, and a copy goes to the
  conversation's scratch folder on the server so the assistant can read or send it.

## When it does not work

- *"does not let Stem drive its browser"*: the switch on that computer is off.
- *"No browser with the Stem extension has connected"*: Set up has not been done there,
  or the extension was not loaded with Load unpacked.
- *"the Stem extension did not connect"*: the browser started but the extension is
  disabled or removed; check its extensions page.
- *"not connected right now"*: the computer is asleep or Stem is not running on it.
- *"The browser profile … is not open"*: starting the browser opened a different
  profile. Open a window of the one named, or ask for another profile.
- Pages inside a cross-site frame (some payment and login widgets) are not part of what
  the assistant reads; a screenshot still shows them.
