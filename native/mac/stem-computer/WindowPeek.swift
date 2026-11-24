import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// "Ask about this window": the desktop app's shortcut asks which window the
// person was in, takes one picture of it, and reads its text while they type.
// None of this touches a run's state — no window is selected, no capture
// geometry changes — so it can be served by a helper that is also driving a
// computer-control run, or by one of its own.

enum WindowPeek {
  /// The window the person was looking at: the front window of the frontmost
  /// app, else (Stem itself was in front) the topmost ordinary window that is
  /// not Stem's. Nil when no other app has a window on screen.
  ///
  /// The frontmost app's window can float, and its app can have no Dock icon:
  /// jbrow's hotkey window is both. Only the fallback keeps to ordinary
  /// windows, so a floating window of an app in the back never wins.
  static func frontWindow() -> WindowInfo? {
    guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    // On-screen listing comes front to back; `Windows.list` has already dropped
    // Stem's own windows and helpers.
    let all = Windows.list(minimized: false, floating: true)
    let known = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    let ordered = raw.compactMap { ($0[kCGWindowNumber as String] as? Int).flatMap { known[CGWindowID($0)] } }
    if let front = ordered.first(where: { $0.frontmost }) { return front }
    let ordinary = Set(Windows.list(minimized: false).map(\.id))
    return ordered.first(where: { ordinary.contains($0.id) })
  }

  /// A window asked about before, again (the panel's New re-captures it); nil once it is gone.
  static func window(id: CGWindowID) -> WindowInfo? {
    Windows.list(minimized: false, floating: true).first(where: { $0.id == id })
  }

  static func describe(_ w: WindowInfo) -> [String: Any] {
    [
      "windowId": Int(w.id),
      "app": w.app,
      "bundleId": w.bundleId ?? NSNull(),
      "title": w.title,
      "bounds": ["x": w.bounds.origin.x, "y": w.bounds.origin.y, "width": w.bounds.width, "height": w.bounds.height]
    ]
  }

  /// One frame of `w`, the same size and encoding a run's frames have.
  static func picture(_ w: WindowInfo) throws -> [String: Any] {
    let capture = Capture()
    capture.target = Target(pid: w.pid, windowID: w.id, app: w.app, bundleId: w.bundleId, title: w.title, bounds: w.bounds)
    return try capture.screenshot()
  }

  /// The window's readable text, top to bottom, or nil when its app exposes none.
  static func text(windowId: CGWindowID, maxChars: Int) -> String? {
    guard let w = Windows.list(minimized: false, floating: true).first(where: { $0.id == windowId }) else { return nil }
    let ax = AX(pid: w.pid, windowID: w.id)
    defer { ax.release() }
    return ax.readableText(windowBounds: w.bounds, maxChars: maxChars)
  }

  /// A window's current frame in global points, or nil once it is gone.
  static func bounds(windowId: CGWindowID) -> [String: Any]? {
    guard let b = Windows.bounds(of: windowId) else { return nil }
    return ["x": b.origin.x, "y": b.origin.y, "width": b.width, "height": b.height]
  }
}

extension AX {
  /// Every piece of text the window shows — labels, messages, field contents,
  /// link text — in reading order, without the control ids and coordinates a
  /// snapshot carries: this is context for a question, not a map to act on.
  /// Secure fields are skipped; consecutive repeats are folded.
  func readableText(windowBounds: CGRect, maxChars: Int) -> String? {
    guard let root = window ?? lookUpWindow(tries: 5) else { return nil }
    let visible = windowBounds.insetBy(dx: -2, dy: -2)
    var parts: [String] = []
    var total = 0
    var visited = 0

    func take(_ s: String?) {
      guard let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty, s != parts.last else { return }
      parts.append(s)
      total += s.count + 1
    }

    func walk(_ el: AXUIElement, depth: Int) {
      if total >= maxChars || depth > 60 || visited > 8000 { return }
      visited += 1
      if let f = AX.frame(el), f.width > 0, f.height > 0, !f.intersects(visible) { return }
      let role = AX.string(el, kAXRoleAttribute as String) ?? ""
      let subrole = AX.string(el, kAXSubroleAttribute as String) ?? ""
      if subrole == "AXSecureTextField" { return }
      switch role {
      case "AXStaticText", "AXHeading":
        take(AX.string(el, kAXValueAttribute as String) ?? AX.string(el, kAXTitleAttribute as String) ?? AX.string(el, kAXDescriptionAttribute as String))
      case "AXTextArea", "AXTextField", "AXComboBox":
        take(AX.string(el, kAXValueAttribute as String))
      case "AXLink":
        // A link's text is usually its child static text; only a bare link speaks for itself.
        if AX.children(el).isEmpty { take(AX.string(el, kAXTitleAttribute as String) ?? AX.string(el, kAXDescriptionAttribute as String)) }
      case "AXImage":
        if let d = AX.string(el, kAXDescriptionAttribute as String), !d.isEmpty { take("[image: \(d)]") }
      default:
        break
      }
      for child in AX.children(el) { walk(child, depth: depth + 1) }
    }

    walk(root, depth: 0)
    // A Chromium window fills its tree over the first moments after
    // accessibility is switched on (see AX.init): look again before believing
    // an almost empty one.
    var waited = 0
    while parts.count < 5 && waited < 6 {
      usleep(400_000)
      waited += 1
      parts = []; total = 0; visited = 0
      walk(root, depth: 0)
    }
    if parts.isEmpty { return nil }
    var text = parts.joined(separator: "\n")
    if text.count > maxChars { text = String(text.prefix(maxChars)) + "\n…" }
    return text
  }
}
