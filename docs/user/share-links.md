# Share links

Maya asked Stem to compare three ways to deploy her app, and a friend wants to
read the answer. She shares the question and answer as a link and pastes it in
a chat. Her friend opens it in a browser, without Stem.

A share link is a copy of the conversation as it was when you shared it. Later
messages are not added. Sharing again makes a new link.

## Before you start

Sharing needs a verified email address, so every public link traces back to a
real person. Add one under Settings → Features → **Your email address** (see
[Mail with other Stems](other-stems.md)). Without one, the Share dialog says so
and offers **Verify an address in Settings**.

## Share an answer

- **In a chat**, hover an answer and click the share button (**Share this
  answer as a link**).
- **In mail**, click the share button on a persona's reply (**Share as a
  link**).
- **On the iPhone**, touch and hold an answer or a persona's reply and choose
  **Share as Link…**.

The dialog **Share as a link** opens. Pick what to share:

- **Whole chat** (**Whole mail thread** in mail): every message.
- **Question and answer**: the answer and the question before it. This is the
  default.
- **Answer only**.

Below it is a preview of exactly what will be published. Check it: anyone with
the link can read what you see there. Then:

- **Show which model answered** is on by default. The model shows by name, such
  as `gpt-6.1-sol`.
- **Include my pictures** appears when you attached pictures. They are left out
  unless you tick it.
- Expiry: **Expires in 30 days** (the default), 7 days or 1 day.

Press **Create link**. Stem copies the link to the clipboard and shows it with
**Copy link**, **Open in the browser** and **Revoke**.

## What is left out

Tool steps, memory cards and in-app links are left out. Links to places inside
Stem keep their words as plain text. Suggested replies, notices about failed
turns and messages that failed to send stay out too. In mail, only the mails
between you and your personas are shared: the personas' mail to each other and
approval cards stay out.

The page shows an answer as the chat shows it. Pictures Stem made, web pictures
the answer shows, sounds it shared and its web sources are all included. The
page has no Stem behind it, so Stem copies them into the link when you make it.
A link to a file on your computer shows as its text.

A private chat can be shared. Private only means Stem doesn't learn from it.

## The preview card

Chat apps show a card when a link is pasted. **Show a preview when the link is
pasted in a chat app** is on by default, with a title and description Stem
suggests from the conversation. Edit them before you create the link, or switch
the card off. Unlike the page, this preview is not encrypted: the share server
and anyone the link reaches can read it. Search engines are told not to index
any of it, page or card.

## Encryption

Your Stem encrypts the page before it uploads it to `share.heystem.app`. The
key is the part after `#` in the link. Browsers never send that part to a
server, so the share server can't read the page, and only people you give the
whole link to can. A link missing that part opens as *This link is incomplete*.
The link is published under your verified address.

## Limits

- A link works for at most 30 days.
- You can have at most 100 working links at a time, and make at most 30 a day.
- A share that is too big fails with a note to leave out the pictures or share
  one answer instead of the whole chat.

## Take a link down

Settings → Features → **Shared links** → **Public links you made** lists your
working links with what they share and their end date. The section appears once
you have made a link. Each row has **Copy link** and a revoke button (**Revoke —
the link stops opening**). A revoked link opens as *This link was turned off*.
Anyone who already saved the page keeps their copy.

Each shared page also has a **Report** button for readers. A link taken down after a
report opens as *This link was removed*.

## What can't be shared

- Mail with another person (see [Mail with other Stems](other-stems.md)). Their
  mail is theirs to publish.
- The Memory tab's deep check conversation.

## Company computers

When a company [policy file](../stem-policy.md) turns off or limits mail with
other Stems, sharing is off too: *Your organization has turned off sharing
outside the company.* It is also off when your address is on a company relay
that keeps its people inside.
