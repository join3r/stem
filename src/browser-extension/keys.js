// "Meta+Shift+Z" → the Input.dispatchKeyEvent calls that press it. Pure, so the
// mapping is unit-tested without a browser.
//
// The definitions follow Puppeteer's US layout (key, code, windowsVirtualKeyCode,
// text). The one macOS wrinkle: Chrome on a Mac does not turn a synthetic key
// into an editing action by itself — the real keyboard path goes through
// AppKit's NSResponder commands, which CDP skips — so chords like Meta+A or a
// plain Backspace carry the matching `commands` (selectAll, deleteBackward),
// the same table Playwright sends.

export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const MODIFIER_KEYS = {
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 }
};

const ALIASES = {
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  super: 'Meta',
  win: 'Meta',
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
  esc: 'Escape',
  escape: 'Escape',
  return: 'Enter',
  enter: 'Enter',
  tab: 'Tab',
  space: 'Space',
  spacebar: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  insert: 'Insert'
};

const NAMED = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' }
};
for (let n = 1; n <= 12; n++) NAMED[`F${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };

// Unshifted / shifted punctuation on a US keyboard: [code, keyCode].
const PUNCTUATION = {
  '-': ['Minus', 189, false],
  _: ['Minus', 189, true],
  '=': ['Equal', 187, false],
  '+': ['Equal', 187, true],
  '[': ['BracketLeft', 219, false],
  '{': ['BracketLeft', 219, true],
  ']': ['BracketRight', 221, false],
  '}': ['BracketRight', 221, true],
  '\\': ['Backslash', 220, false],
  '|': ['Backslash', 220, true],
  ';': ['Semicolon', 186, false],
  ':': ['Semicolon', 186, true],
  "'": ['Quote', 222, false],
  '"': ['Quote', 222, true],
  ',': ['Comma', 188, false],
  '<': ['Comma', 188, true],
  '.': ['Period', 190, false],
  '>': ['Period', 190, true],
  '/': ['Slash', 191, false],
  '?': ['Slash', 191, true],
  '`': ['Backquote', 192, false],
  '~': ['Backquote', 192, true]
};
const SHIFTED_DIGITS = { '!': 1, '@': 2, '#': 3, $: 4, '%': 5, '^': 6, '&': 7, '*': 8, '(': 9, ')': 0 };

/** One character → its key definition (shiftNeeded: the character is the key's shifted form). */
function charKey(ch) {
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch, shiftNeeded: true };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
  if (ch in SHIFTED_DIGITS) {
    const d = SHIFTED_DIGITS[ch];
    return { key: ch, code: `Digit${d}`, keyCode: 48 + d, text: ch, shiftNeeded: true };
  }
  if (ch in PUNCTUATION) {
    const [code, keyCode, shiftNeeded] = PUNCTUATION[ch];
    return { key: ch, code, keyCode, text: ch, shiftNeeded };
  }
  if (ch === ' ') return NAMED.Space;
  // Anything else (é, ß, an emoji): no physical key on a US layout, so it goes
  // through as text alone, which is what an IME would deliver.
  return { key: ch, code: '', keyCode: 0, text: ch };
}

// Playwright's macEditingCommands, the entries a model is plausibly going to
// press. Keyed by "Shift+Control+Alt+Meta+Code" in that order.
const MAC_COMMANDS = {
  Backspace: 'deleteBackward',
  Enter: 'insertNewline',
  Escape: 'cancelOperation',
  ArrowUp: 'moveUp',
  ArrowDown: 'moveDown',
  ArrowLeft: 'moveLeft',
  ArrowRight: 'moveRight',
  Delete: 'deleteForward',
  Home: 'scrollToBeginningOfDocument',
  End: 'scrollToEndOfDocument',
  PageUp: 'scrollPageUp',
  PageDown: 'scrollPageDown',
  'Shift+Backspace': 'deleteBackward',
  'Shift+ArrowUp': 'moveUpAndModifySelection',
  'Shift+ArrowDown': 'moveDownAndModifySelection',
  'Shift+ArrowLeft': 'moveLeftAndModifySelection',
  'Shift+ArrowRight': 'moveRightAndModifySelection',
  'Shift+Delete': 'deleteForward',
  'Shift+Home': 'moveToBeginningOfDocumentAndModifySelection',
  'Shift+End': 'moveToEndOfDocumentAndModifySelection',
  'Shift+PageUp': 'pageUpAndModifySelection',
  'Shift+PageDown': 'pageDownAndModifySelection',
  'Control+KeyA': 'moveToBeginningOfParagraph',
  'Control+KeyB': 'moveBackward',
  'Control+KeyD': 'deleteForward',
  'Control+KeyE': 'moveToEndOfParagraph',
  'Control+KeyF': 'moveForward',
  'Control+KeyH': 'deleteBackward',
  'Control+KeyK': 'deleteToEndOfParagraph',
  'Control+KeyN': 'moveDown',
  'Control+KeyP': 'moveUp',
  'Control+KeyT': 'transpose',
  'Control+Backspace': 'deleteBackwardByDecomposingPreviousCharacter',
  'Control+ArrowLeft': 'moveToLeftEndOfLine',
  'Control+ArrowRight': 'moveToRightEndOfLine',
  'Alt+Backspace': 'deleteWordBackward',
  'Alt+ArrowLeft': 'moveWordLeft',
  'Alt+ArrowRight': 'moveWordRight',
  'Alt+Delete': 'deleteWordForward',
  'Shift+Alt+ArrowLeft': 'moveWordLeftAndModifySelection',
  'Shift+Alt+ArrowRight': 'moveWordRightAndModifySelection',
  'Meta+Backspace': 'deleteToBeginningOfLine',
  'Meta+ArrowUp': 'moveToBeginningOfDocument',
  'Meta+ArrowDown': 'moveToEndOfDocument',
  'Meta+ArrowLeft': 'moveToLeftEndOfLine',
  'Meta+ArrowRight': 'moveToRightEndOfLine',
  'Shift+Meta+ArrowUp': 'moveToBeginningOfDocumentAndModifySelection',
  'Shift+Meta+ArrowDown': 'moveToEndOfDocumentAndModifySelection',
  'Shift+Meta+ArrowLeft': 'moveToLeftEndOfLineAndModifySelection',
  'Shift+Meta+ArrowRight': 'moveToRightEndOfLineAndModifySelection',
  'Meta+KeyA': 'selectAll',
  'Meta+KeyC': 'copy',
  'Meta+KeyX': 'cut',
  'Meta+KeyV': 'paste',
  'Meta+KeyZ': 'undo',
  'Shift+Meta+KeyZ': 'redo'
};

function resolveKeyName(part) {
  if (part.length === 1) return { char: part };
  const alias = ALIASES[part.toLowerCase()];
  if (alias && MODIFIER_BITS[alias] !== undefined) return { modifier: alias };
  const name = alias || part;
  if (NAMED[name]) return { named: name };
  const f = /^f(\d{1,2})$/i.exec(part);
  if (f && NAMED[`F${Number(f[1])}`]) return { named: `F${Number(f[1])}` };
  return null;
}

/**
 * Parse a key or chord and return the dispatchKeyEvent parameter objects in
 * order (modifier downs, the key down/up, modifier ups) — or { error }.
 * `mac` adds the editing `commands` a Mac browser needs.
 */
export function keyPresses(spec, { mac = true } = {}) {
  const raw = String(spec ?? '');
  if (!raw.trim()) return { error: 'press needs a key, e.g. "Enter", "Escape", "Meta+A".' };
  // "+" alone, or a chord ending in "+" ("Shift++"), means the plus key.
  const parts = raw === '+' ? ['+'] : raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), '+'] : raw.split('+');
  if (parts.some((p) => p === '')) return { error: `"${raw}" is not a key: write chords like "Control+Shift+T".` };
  const modifiers = [];
  let main = null;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim() || parts[i];
    const resolved = resolveKeyName(part);
    if (!resolved) return { error: `Unknown key "${part}". Use names like Enter, Tab, Escape, Backspace, ArrowDown, PageDown, F5, a single character, or chords like "Meta+A".` };
    if (resolved.modifier && i < parts.length - 1) {
      if (!modifiers.includes(resolved.modifier)) modifiers.push(resolved.modifier);
      continue;
    }
    if (i !== parts.length - 1) return { error: `"${raw}": only Meta, Control, Alt and Shift can come before the last key.` };
    main = resolved;
  }
  let bits = modifiers.reduce((acc, m) => acc | MODIFIER_BITS[m], 0);
  const events = [];
  let running = 0;
  for (const m of modifiers) {
    running |= MODIFIER_BITS[m];
    const k = MODIFIER_KEYS[m];
    events.push({ type: 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: running });
  }
  if (main.modifier) {
    // A lone modifier ("Shift"): press and release it.
    const k = MODIFIER_KEYS[main.modifier];
    bits |= MODIFIER_BITS[main.modifier];
    events.push({ type: 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: bits });
    events.push({ type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: 0 });
    return { events, label: raw, modifiers: [...modifiers, main.modifier], commands: [] };
  }
  // In a chord a letter names the key, not its case: "Meta+A" is Cmd-A, not
  // Cmd-Shift-A. Typed alone, "A" still means the capital.
  const char = main.char && modifiers.length && /^[A-Z]$/.test(main.char) ? main.char.toLowerCase() : main.char;
  const def = main.named ? NAMED[main.named] : charKey(char);
  // A shifted character typed alone ("A", "!") implies Shift for the page's
  // benefit; the text already carries the right glyph.
  const effectiveBits = def.shiftNeeded ? bits | MODIFIER_BITS.Shift : bits;
  let key = def.key;
  let text = def.text || '';
  if (/^Key[A-Z]$/.test(def.code)) {
    const upper = (effectiveBits & MODIFIER_BITS.Shift) !== 0;
    key = upper ? def.code.slice(3) : def.code.slice(3).toLowerCase();
    text = key;
  }
  // Like a real keyboard, a chord with Control/Alt/Meta inserts no text.
  if (bits & (MODIFIER_BITS.Control | MODIFIER_BITS.Alt | MODIFIER_BITS.Meta)) text = '';
  let commands = [];
  if (mac && def.code) {
    const order = ['Shift', 'Control', 'Alt', 'Meta'].filter((m) => effectiveBits & MODIFIER_BITS[m]);
    const shortcut = [...order, def.code].join('+');
    const cmd = MAC_COMMANDS[shortcut];
    // insertNewline and friends are left out: the key's own text inserts them,
    // and sending both would type the newline twice.
    if (cmd && !cmd.startsWith('insert')) commands = [cmd];
  }
  const down = {
    type: text ? 'keyDown' : 'rawKeyDown',
    key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    modifiers: effectiveBits,
    ...(text ? { text, unmodifiedText: text } : {}),
    ...(commands.length ? { commands } : {})
  };
  events.push(down);
  events.push({ type: 'keyUp', key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers: effectiveBits });
  for (const m of [...modifiers].reverse()) {
    running &= ~MODIFIER_BITS[m];
    const k = MODIFIER_KEYS[m];
    events.push({ type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: running });
  }
  return { events, label: raw, modifiers, commands };
}
