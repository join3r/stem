import { IS_MAC } from '../accel';

// The tip deck for the new-chat screen. One tip shows at a time: a list would
// out-weigh the starter cards and turn the calmest screen in the app into a
// manual, whereas a single rotating line teaches the same set over many new
// chats and costs one row of height.
//
// The deck teaches what Stem *can do*, not which key does it. Shortcuts have
// their own places to be found — tooltips, menus, and the hold-to-reveal hint
// mode the first tip points at — and a deck of keycaps only taught the keys to
// people who already knew the features. So no tip here names a key, and the
// rest are mined from docs/user: one capability each, and where it lives.
//
// Data + selection live here as pure functions so the eligibility rules are
// unit-testable without React; EmptyTips.tsx is just the rendering.

export interface TipContext {
  format: 'md' | 'mdx';
  /** Shortcuts are live in this window — false in Quick Chat, which has no provider. */
  bound: boolean;
  /** Stem's server is on another machine, so "which computer runs it" is a real question here. */
  remote: boolean;
}

export interface Tip {
  id: string;
  /** Literal keycap, for the one tip that is about a key (the hold-to-reveal mod key). */
  keys?: string;
  text: string;
  /** Hidden when the thing the tip talks about isn't available right now. */
  when?: (ctx: TipContext) => boolean;
}

export const TIPS: Tip[] = [
  {
    id: 'hint-mode',
    keys: IS_MAC ? '⌘' : 'Ctrl',
    text: 'Hold the modifier key for a moment and every shortcut on screen labels itself.',
    // Nothing to reveal in a window where no shortcut is bound.
    when: (c) => c.bound
  },
  {
    id: 'ask-about-stem',
    text: 'Ask how any part of Stem works — the assistant reads Stem’s own guide and answers from it.'
  },
  {
    id: 'note',
    text: 'Start a message with // to file it straight into memory as a note — no reply, no turn.'
  },
  {
    id: 'memory-facts',
    text: 'Stem learns durable details from ordinary chats and reuses them later; Memory lists every one for you to edit.'
  },
  {
    id: 'memory-recall',
    text: 'Ask what you decided weeks ago and Stem finds it in earlier chats rather than asking you to repeat it.'
  },
  {
    id: 'learn',
    text: 'When a chat does something you will need again, send /learn to save how it was done as a reusable skill.',
    // Quick Chat wires neither /learn nor the shortcut provider.
    when: (c) => c.bound
  },
  {
    id: 'skills',
    text: 'A skill records a procedure that worked so Stem repeats it the same way — they live under Tools.'
  },
  {
    id: 'scheduled-tasks',
    text: 'Ask for something every Monday and it becomes a recurring task, reporting back into that chat.'
  },
  {
    id: 'connected-folders',
    text: 'Connect a folder of notes and Stem reads it where it already lives — nothing is copied in.'
  },
  {
    id: 'mcp-servers',
    text: 'MCP servers under Tools give Stem real actions in your other apps: mail, calendar, issues, dashboards.'
  },
  {
    id: 'mcp-elsewhere',
    text: 'A tool that only works on your own computer can still run there while Stem lives on a server — Tools says where each runs.',
    // Only a real choice once there is more than one machine; on an ordinary
    // install the tip below is the truthful version of the same capability.
    when: (c) => c.remote
  },
  {
    id: 'mcp-on-a-server',
    text: 'Stem can move to a server and answer from your phone, with the tools that need your own computer still running on it.',
    when: (c) => !c.remote
  },
  {
    id: 'commands-on-this-computer',
    text: 'The assistant can run commands on this computer too, once Settings → Features → Commands allows it here.',
    // The switch it points at only exists when the server is elsewhere.
    when: (c) => c.remote
  },
  {
    id: 'quick-chat',
    text: 'Quick Chat answers over the top of whatever app you are working in, then gets out of the way.'
  },
  {
    id: 'drop-files',
    text: 'Drop a file on This chat to use it once, or on Files to keep it available in every chat.'
  },
  {
    id: 'search',
    text: 'The search box above the chat list looks through titles and message text across every conversation.'
  },
  {
    id: 'message-actions',
    text: 'Hover any message to retry it, edit and run it again, or fork the conversation from that point.'
  },
  {
    id: 'snooze',
    text: 'Snooze a chat from its hover actions and it stays out of the way until the time you picked.'
  },
  {
    id: 'archive',
    text: 'Archive a chat from its hover actions to clear the Inbox without deleting anything.'
  },
  {
    id: 'unread',
    text: 'Right-click a chat and mark it unread when you want the Inbox to hand it back later.'
  },
  {
    id: 'context-meter',
    text: 'The meter in the composer row shows how full the conversation is.',
    // The composer is too narrow for the meter in Quick Chat, so it isn't there.
    when: (c) => c.bound
  },
  {
    id: 'standing-instructions',
    text: 'Standing instructions in Settings apply to every chat and to Quick Chat, so you say it once.'
  },
  {
    id: 'backups',
    text: 'Settings packs everything Stem knows into one archive — the same file backs Stem up and moves it to a new computer.'
  },
  {
    id: 'rich-replies',
    text: 'Replies can carry live charts, quizzes and forms — ask for one and it renders inline.',
    when: (c) => c.format === 'mdx'
  }
];

/**
 * The tips worth showing right now. A tip is dropped when the thing it talks
 * about isn't there — Markdown mode has no rich replies, and Quick Chat has
 * neither /learn nor a bound shortcut to reveal — since pointing at something
 * the window doesn't have is worse than saying nothing.
 */
export function eligibleTips(ctx: TipContext): Tip[] {
  return TIPS.filter((t) => (t.when ? t.when(ctx) : true));
}

/**
 * The tip at `seq` in the deck. Stepping a counter rather than picking at random
 * is what makes the deck a deck: random repeats itself and never promises to get
 * through the set, while a counter shows every tip before repeating any.
 */
export function tipAt(seq: number, ctx: TipContext): Tip | null {
  const list = eligibleTips(ctx);
  if (list.length === 0) return null;
  // seq only ever grows, but a corrupted stored value shouldn't blank the screen.
  const s = Number.isFinite(seq) ? Math.trunc(seq) : 0;
  return list[((s % list.length) + list.length) % list.length];
}
