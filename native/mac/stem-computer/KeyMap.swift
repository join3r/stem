import Carbon
import CoreGraphics
import Foundation

/// xdotool-style key names → macOS virtual key codes (US layout). Modifiers are
/// spelled cmd|super|command, ctrl|control, alt|option, shift, joined by "+".
enum KeyMap {
  struct Parsed {
    let code: CGKeyCode
    let flags: CGEventFlags
  }

  private static let named: [String: CGKeyCode] = [
    "return": 0x24, "enter": 0x24, "kp_enter": 0x4C,
    "tab": 0x30, "space": 0x31, "delete": 0x75, "backspace": 0x33, "escape": 0x35, "esc": 0x35,
    "up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
    "home": 0x73, "end": 0x77, "page_up": 0x74, "pageup": 0x74, "page_down": 0x79, "pagedown": 0x79,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
    "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
    "caps_lock": 0x39,
    "minus": 0x1B, "equal": 0x18, "plus": 0x18, "bracketleft": 0x21, "bracketright": 0x1E,
    "semicolon": 0x29, "apostrophe": 0x27, "quote": 0x27, "grave": 0x32, "backslash": 0x2A,
    "comma": 0x2B, "period": 0x2F, "slash": 0x2C
  ]

  private static let chars: [Character: CGKeyCode] = [
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08,
    "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11,
    "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18, "9": 0x19, "7": 0x1A,
    "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E, "o": 0x1F, "u": 0x20, "[": 0x21, "i": 0x22, "p": 0x23,
    "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29, "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D,
    "m": 0x2E, ".": 0x2F, "`": 0x32
  ]

  static func parse(_ combo: String) throws -> Parsed {
    let parts = combo.split(separator: "+", omittingEmptySubsequences: false).map {
      $0.trimmingCharacters(in: .whitespaces)
    }
    guard let last = parts.last, !last.isEmpty else { throw HelperError("Name a key, e.g. \"Return\" or \"cmd+shift+t\".") }
    var flags = CGEventFlags()
    for mod in parts.dropLast() {
      switch mod.lowercased() {
      case "cmd", "command", "super", "meta", "win": flags.insert(.maskCommand)
      case "ctrl", "control": flags.insert(.maskControl)
      case "alt", "option", "opt": flags.insert(.maskAlternate)
      case "shift": flags.insert(.maskShift)
      case "fn", "function": flags.insert(.maskSecondaryFn)
      default: throw HelperError("Unknown modifier \"\(mod)\" (use cmd, ctrl, alt, shift).")
      }
    }
    let name = last.lowercased()
    if let code = named[name] { return Parsed(code: code, flags: flags) }
    if name.count == 1, let ch = name.first, let code = chars[ch] { return Parsed(code: code, flags: flags) }
    // Modifier alone (e.g. "shift" for hold_key).
    switch name {
    case "cmd", "command": return Parsed(code: 0x37, flags: flags)
    case "shift": return Parsed(code: 0x38, flags: flags)
    case "alt", "option": return Parsed(code: 0x3A, flags: flags)
    case "ctrl", "control": return Parsed(code: 0x3B, flags: flags)
    default: break
    }
    throw HelperError("Unknown key \"\(last)\". Use xdotool names: Return, Tab, Escape, space, BackSpace, Delete, Up/Down/Left/Right, Home, End, Page_Up, Page_Down, F1–F12, or a single character.")
  }

  /// Character → key + modifiers on the keyboard layout in use now, read with
  /// UCKeyTranslate over every key under none/shift/option/shift+option. The
  /// first (plainest) way to reach a character wins.
  static func currentLayoutChars() -> [Character: Parsed] {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
          let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return [:] }
    let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
    var out: [Character: Parsed] = [:]
    let mods: [(UInt32, CGEventFlags)] = [
      (0, []), (UInt32(shiftKey >> 8), .maskShift),
      (UInt32(optionKey >> 8), .maskAlternate), (UInt32((shiftKey | optionKey) >> 8), [.maskShift, .maskAlternate])
    ]
    data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
      guard let layout = buf.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
      for (modState, flags) in mods {
        for code in 0..<128 {
          var dead: UInt32 = 0
          var length = 0
          var chars = [UniChar](repeating: 0, count: 4)
          let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), modState,
                                      UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysBit),
                                      &dead, chars.count, &length, &chars)
          guard status == noErr, length == 1 else { continue }
          let str = String(utf16CodeUnits: chars, count: length)
          // Control characters (Return, Tab, arrows' private-use codes) are not typed text.
          guard let ch = str.first, let scalar = str.unicodeScalars.first,
                scalar.value >= 0x20, !(0xF700...0xF8FF).contains(scalar.value),
                out[ch] == nil else { continue }
          out[ch] = Parsed(code: CGKeyCode(code), flags: flags)
        }
      }
    }
    return out
  }
}
