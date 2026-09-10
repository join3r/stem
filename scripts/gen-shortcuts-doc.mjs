#!/usr/bin/env node
// Regenerates docs/user/shortcuts.md from src/shared/shortcut-defs.ts, so the page
// a reader (or the in-app assistant) answers shortcut questions from can never
// drift from the keys the app actually binds.
//
//   npm run gen:shortcuts-doc
//
// The shortcut table is generated; the prose around it is hand-written and lives in
// this file — edit TRICKS here, not the .md, or the next run overwrites it.
//
// Plain .mjs importing a .ts module: node ≥22.6 strips the types on the way in
// (the repo requires node ≥24), which keeps the generator a two-line npm script
// instead of a build step. shortcut-defs stays free of React and DOM for exactly
// this reason. The output must be byte-stable — no dates, no ordering by hash —
// because tests/unit/shortcuts-doc.test.ts compares it against the checked-in file.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SHORTCUTS, keycapFor } from '../src/shared/shortcut-defs.ts';

/** The page this generator owns. */
export const DOC_PATH = fileURLToPath(new URL('../docs/user/shortcuts.md', import.meta.url));

/** The npm script that rewrites it — named in the drift test's failure message. */
export const GEN_SCRIPT = 'npm run gen:shortcuts-doc';

// Hand-written half of the page: the things a keycap cannot advertise. Kept in the
// same voice as the rest of docs/user — you, not the user; bold for what is on
// screen; one idea per bullet.
const TRICKS = `## Tricks

- Hold **⌘** (**Ctrl** on Windows and Linux) for a moment. Stem labels every shortcut
  on screen with its keycap, so you can learn them from the buttons you already use.
- Start a message with \`//\` to file a note straight into Memory. No chat turn, no
  answer, no quota — just the note. Memory must be on. Paste or attach a picture and it
  is saved with the note; the picture alone is a valid note.
- Send \`/learn\` after a reply that worked to save the approach as a skill. Add a
  focus—\`/learn the invoice reconciliation steps\`—to steer what it keeps.
- Drop a file on **This chat** to use it for one message. Drop it on **Files** to copy
  it into Stem and reuse it across chats.
- **Enter** sends. **Shift+Enter** starts a new line.`;

/** Escape the characters a keycap can contain that Markdown tables would eat. */
const cell = (text) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

/** The whole page, as it should exist on disk. */
export function renderShortcutsDoc() {
  const rows = SHORTCUTS.map(
    (def) =>
      `| **${cell(def.label)}** — ${cell(def.description)} | ${cell(keycapFor(def, true))} | ${cell(keycapFor(def, false))} |`
  );

  return `# Shortcuts & tricks

← [Stem guide](../README.md)

<!-- Generated from src/shared/shortcut-defs.ts by scripts/gen-shortcuts-doc.mjs.
     Run \`${GEN_SCRIPT}\` after changing a shortcut; a unit test
     fails while this page is stale. Edit the prose in the generator, not here. -->

Everything Stem binds to a key, and a few composer tricks that no keycap advertises.

| Action | Mac | Windows / Linux |
| --- | --- | --- |
${rows.join('\n')}

${TRICKS}
`;
}

// Import-safe: the drift test wants renderShortcutsDoc() without a write.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(DOC_PATH, renderShortcutsDoc());
  console.log(`Wrote ${DOC_PATH}`);
}
