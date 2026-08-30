// Every keyboard shortcut Stem offers, described once and platform-neutrally.
//
// Three consumers read from here and must never disagree with each other:
//   1. renderer/shortcuts.tsx — turns each chord into a keydown predicate and a
//      keycap for the hold-⌘ hints.
//   2. The generated docs page, docs/user/shortcuts.md (scripts/gen-shortcuts-doc.mjs),
//      which is what a GitHub reader and the in-app assistant both answer from.
//   3. Tooltips and menu items that want the same wording the docs use.
//
// So this module stays pure data plus text derivation: no React, no DOM, nothing
// that reads `window`. The doc generator imports it under plain `node`, and the
// *platform* is always an argument — never ambient — because the page has to
// print the Mac and the Windows/Linux column side by side on one machine.

export type ShortcutId =
  | 'new-conversation'
  | 'new-mail'
  | 'toggle-inspector'
  | 'cycle-effort'
  | 'toggle-speed'
  | 'toggle-format'
  | 'attach'
  | 'stop'
  | 'delete-thread'
  | 'focus-chat-search'
  | 'archive-thread'
  | 'snooze-thread'
  | 'toggle-read'
  | 'send';

/** One key combination, before it becomes either a keycap or a keydown predicate. */
export interface Chord {
  /** Held with the platform mod key: ⌘ on macOS, Ctrl everywhere else. */
  mod?: boolean;
  /**
   * Held with the literal Control key on every platform — ⌃ on macOS, where it is a
   * modifier in its own right rather than a synonym for ⌘. Off macOS `control` and
   * `mod` describe the same physical key; only `delete-thread` needs the distinction.
   */
  control?: boolean;
  /**
   * Shift required (`true`), rejected (`false`), or unconstrained (omitted — the
   * matcher then ignores the Shift state entirely).
   *
   * Omitting it is deliberate for the punctuation combos: `\` and `.` have no
   * unshifted twin among the bindings to be confused with, and on layouts where
   * reaching the character itself needs Shift, demanding an exact state would make
   * the shortcut unreachable.
   */
  shift?: boolean;
  /** The key as printed on its cap: 'N', '\\', '.', 'Enter'. Matching lowercases it. */
  key: string;
  /** Keycap override on macOS, for keys the Mac prints as a glyph (Enter → ⏎). */
  macKey?: string;
}

export interface ShortcutDef {
  id: ShortcutId;
  /** Short name for the action, as a docs table or a menu item would print it. */
  label: string;
  /** One line on what it does, in the voice of the user docs — no trailing period. */
  description: string;
  /** The combination everywhere except macOS. */
  chord: Chord;
  /** macOS override, for the one shortcut whose combination genuinely differs. */
  macChord?: Chord;
  /**
   * `false` when Stem's global keydown listener does not own the combination — the
   * definition exists to document it and to draw its keycap, nothing more. Defaults
   * to bound; only `send` opts out, since the composer's own textarea handles Enter.
   */
  bound?: boolean;
}

/**
 * The shortcut table. Order is the order the doc page prints and the order the
 * renderer tests its matchers in, so keep related actions adjacent.
 */
export const SHORTCUTS: ShortcutDef[] = [
  {
    id: 'new-conversation',
    label: 'New chat',
    description: 'starts a fresh conversation; the current one stays in Chats',
    chord: { mod: true, shift: false, key: 'N' }
  },
  // The Shift variant of New chat — the mail-client convention for compose.
  {
    id: 'new-mail',
    label: 'New mail',
    description: 'opens a mail compose addressed to your personas',
    chord: { mod: true, shift: true, key: 'N' }
  },
  {
    id: 'toggle-inspector',
    label: 'Toggle inspector',
    description: 'shows or hides the right-hand panel',
    chord: { mod: true, key: '\\' }
  },
  {
    id: 'cycle-effort',
    label: 'Cycle effort',
    description: 'steps through the effort levels the chosen model supports',
    chord: { mod: true, shift: false, key: 'E' }
  },
  {
    id: 'toggle-speed',
    label: 'Toggle Fast',
    description: 'turns the faster service tier on or off, where the model has one',
    chord: { mod: true, shift: true, key: 'F' }
  },
  {
    id: 'toggle-format',
    label: 'Toggle MDX / Markdown',
    description: 'switches the answer format between interactive MDX and plain Markdown',
    chord: { mod: true, shift: true, key: 'M' }
  },
  {
    id: 'attach',
    label: 'Attach files',
    description: 'opens the file picker for this message',
    chord: { mod: true, shift: false, key: 'U' }
  },
  {
    id: 'focus-chat-search',
    label: 'Search chats',
    description: 'opens the chat search box, or refocuses it when it is already open',
    chord: { mod: true, shift: false, key: 'F' }
  },
  // Inbox triage on the A/S/D home-row triad — three neighbouring keys for the
  // three triage verbs. All mod+Shift, which keeps them clear of the plain-mod
  // set and of Electron's default Windows/Linux menu (Ctrl+Shift+I and +R).
  //
  // D, not U, for mark-unread despite the worse mnemonic: Ctrl+Shift+U is IBus's
  // Unicode-entry sequence, so on a default GNOME/Ubuntu desktop the input method
  // eats the keystroke and the app never sees it.
  {
    id: 'archive-thread',
    label: 'Archive thread',
    description: 'archives the selection, or restores it when it is already archived',
    chord: { mod: true, shift: true, key: 'A' }
  },
  {
    id: 'snooze-thread',
    label: 'Snooze thread',
    description: 'hides the selection until a time you pick, or wakes it again',
    chord: { mod: true, shift: true, key: 'S' }
  },
  {
    id: 'toggle-read',
    label: 'Mark read or unread',
    description: 'flips the unread mark on the selection',
    chord: { mod: true, shift: true, key: 'D' }
  },
  {
    id: 'stop',
    label: 'Stop',
    description: 'interrupts the answer in progress',
    chord: { mod: true, key: '.' }
  },
  // The one shortcut that is a different key on each platform. On macOS it is
  // Control (not ⌘) — the only ctrl-based mac binding, and so the only one no
  // hold-⌘ hint anchors. Elsewhere Ctrl+X must keep meaning "cut", so deletion
  // moves out of its way to Ctrl+Shift+X.
  {
    id: 'delete-thread',
    label: 'Delete chat',
    description: 'asks to delete the open chat; press again to confirm',
    chord: { control: true, shift: true, key: 'X' },
    macChord: { control: true, key: 'X' }
  },
  {
    id: 'send',
    label: 'Send',
    description: 'sends the message; Shift+Enter starts a new line instead',
    chord: { key: 'Enter', macKey: '⏎' },
    bound: false
  }
];

/** The chord that applies on a platform — the macOS override where one exists. */
export function chordFor(def: ShortcutDef, mac: boolean): Chord {
  return mac && def.macChord ? def.macChord : def.chord;
}

/**
 * A chord as a keycap: compact glyphs on macOS ('⌘⇧A', '⌃X', '⏎'), plus-joined
 * words everywhere else ('Ctrl+Shift+A').
 *
 * The mac form leads with the mod key ('⌘⇧A'), which is *not* the canonical ⌃⌥⇧⌘
 * order accel.ts renders user-recorded accelerators in. It is what Stem has always
 * drawn on these particular keycaps, and the docs page has to match the app.
 */
export function keycap(chord: Chord, mac: boolean): string {
  const key = (mac && chord.macKey) || chord.key;
  if (mac) {
    return `${chord.mod ? '⌘' : ''}${chord.control ? '⌃' : ''}${chord.shift ? '⇧' : ''}${key}`;
  }
  // Off macOS the mod key *is* Control, so both flags print the same word.
  const parts: string[] = [];
  if (chord.mod || chord.control) parts.push('Ctrl');
  if (chord.shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** Keycap for a shortcut on a platform: '⌘⇧A' on mac, 'Ctrl+Shift+A' elsewhere. */
export function keycapFor(def: ShortcutDef, mac: boolean): string {
  return keycap(chordFor(def, mac), mac);
}
