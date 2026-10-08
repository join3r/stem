import ApplicationServices
import CoreGraphics
import Foundation

// Accessibility: how a run reaches a window that is not in front. Where screen
// mode moves the real mouse, window mode asks the app's accessibility tree —
// press this button, focus that field, set this value — which works wherever
// the window is and never touches the person's cursor. The tree is the app's
// own account of its controls, so coverage follows it: buttons, links, fields,
// rows and menu items answer; canvases and games are blank.

/// The private call every AX inspector uses to map an AXUIElement window to its CGWindowID.
@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ identifier: UnsafeMutablePointer<CGWindowID>) -> AXError

/// One control the model can act on, as the last snapshot numbered it.
struct AXNode {
  let id: Int
  let element: AXUIElement
  let role: String
}

final class AX {
  let pid: pid_t
  /// The selected window of this app; another window of the same app is a
  /// retarget, not a new AX (the wake-up below is per app, and costly).
  private(set) var windowID: CGWindowID
  let app: AXUIElement
  /// The AX element for `windowID`, looked up on first need (a snapshot) — not
  /// at selection, where a window whose element is slow to find (or absent)
  /// would cost a second of retries before anything was asked of it.
  private(set) var window: AXUIElement?
  /// When the app was asked to switch its accessibility on: hit-tests in the
  /// moments after give a tree that is still being built a few more tries.
  private let wokeAt = Date()
  /// Ids handed out by the last snapshot; replaced wholesale on the next one.
  private var nodes: [Int: AXNode] = [:]
  private var snapshotTaken = false
  /// How many controls the last snapshot listed.
  private(set) var lastSnapshotCount = 0

  /// Why the last window lookup found nothing, for the error the model reads.
  private(set) var lookupNote = ""

  init(pid: pid_t, windowID: CGWindowID) {
    self.pid = pid
    self.windowID = windowID
    app = AXUIElementCreateApplication(pid)
    // Ask the app to answer AX queries within a beat; a hung app must not hang the helper.
    AXUIElementSetMessagingTimeout(app, 2.0)
    // Electron apps (Discord, Slack, VS Code…) build their accessibility tree
    // only for an assistive client that asks for it — this attribute is how
    // Electron documents asking. Chromium browsers switch theirs on at the
    // first query and fill it over the next moments, hence the retries below.
    // AXEnhancedUserInterface is the signal VoiceOver sends; Chromium turns on
    // its web-content tree for it. Both are undone in release() so the app is
    // left as it was.
    let manual = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let enhanced = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    wakeNote = "AXManualAccessibility set → \(manual.rawValue), reads \(AX.readBack(app, "AXManualAccessibility")); AXEnhancedUserInterface set → \(enhanced.rawValue), reads \(AX.readBack(app, "AXEnhancedUserInterface"))"
    trace("ax wake: \(wakeNote)")
  }

  /// Another window of the same app: same wake-up, fresh window and ids.
  func retarget(_ id: CGWindowID) {
    guard id != windowID else { return }
    windowID = id
    window = nil
    nodes = [:]
    snapshotTaken = false
    lastSnapshotCount = 0
    lookupNote = ""
  }

  /// How the app took the wake-up above, quoted when a tree comes back bare.
  private(set) var wakeNote = ""

  private static func readBack(_ el: AXUIElement, _ name: String) -> String {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, name as CFString, &value)
    if err != .success { return "error \(err.rawValue)" }
    if let n = value as? NSNumber { return n.boolValue ? "true" : "false" }
    return String(describing: value)
  }

  /// Leave the app's accessibility as we found it (Chromium apps behave
  /// differently while an assistive client is announced).
  func release() {
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanFalse)
  }

  /// The AX window for our CGWindowID, giving an app that is still building
  /// its tree a moment (200 ms per try) before giving up.
  private func lookUpWindow(tries: Int) -> AXUIElement? {
    for attempt in 0..<tries {
      if attempt > 0 { usleep(200_000) }
      var note = ""
      if let hit = AX.findWindow(app: app, windowID: windowID, title: nil, bounds: nil, note: &note) {
        lookupNote = ""
        return hit
      }
      lookupNote = note
    }
    trace("ax window lookup failed: \(lookupNote)")
    return nil
  }

  // MARK: attribute helpers

  static func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
  }

  static func string(_ element: AXUIElement, _ name: String) -> String? {
    guard let v = attribute(element, name) else { return nil }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    if let u = v as? URL { return u.absoluteString }
    return nil
  }

  static func bool(_ element: AXUIElement, _ name: String) -> Bool? {
    guard let v = attribute(element, name) else { return nil }
    return (v as? NSNumber)?.boolValue
  }

  static func point(_ element: AXUIElement, _ name: String) -> CGPoint? {
    guard let v = attribute(element, name), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
  }

  static func size(_ element: AXUIElement, _ name: String) -> CGSize? {
    guard let v = attribute(element, name), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
  }

  static func children(_ element: AXUIElement) -> [AXUIElement] {
    (attribute(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
  }

  static func frame(_ element: AXUIElement) -> CGRect? {
    guard let p = point(element, kAXPositionAttribute as String), let s = size(element, kAXSizeAttribute as String) else { return nil }
    return CGRect(origin: p, size: s)
  }

  static func actions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else { return [] }
    return list
  }

  static func cgWindowID(of element: AXUIElement) -> CGWindowID? {
    var id: CGWindowID = 0
    return _AXUIElementGetWindow(element, &id) == .success && id != 0 ? id : nil
  }

  /// Every window element an app admits to: AXWindows first, then its main and
  /// focused window and any window among its children (some apps answer one
  /// and not the others). `note` says what came back when nothing matches.
  static func axWindows(of app: AXUIElement, note: inout String) -> [AXUIElement] {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
    var out = (value as? [AXUIElement]) ?? []
    if err != .success { note = "the app answered AXWindows with error \(err.rawValue)" }
    func add(_ el: AXUIElement?) {
      guard let el, !out.contains(where: { CFEqual($0, el) }) else { return }
      out.append(el)
    }
    add(attribute(app, kAXMainWindowAttribute as String).map { $0 as! AXUIElement })
    add(attribute(app, kAXFocusedWindowAttribute as String).map { $0 as! AXUIElement })
    for child in children(app) where string(child, kAXRoleAttribute as String) == (kAXWindowRole as String) { add(child) }
    return out
  }

  /// The AX window for a CGWindowID: by the private id call, else by title and frame.
  static func findWindow(app: AXUIElement, windowID: CGWindowID, title: String?, bounds: CGRect?) -> AXUIElement? {
    var note = ""
    return findWindow(app: app, windowID: windowID, title: title, bounds: bounds, note: &note)
  }

  static func findWindow(app: AXUIElement, windowID: CGWindowID, title: String?, bounds: CGRect?, note: inout String) -> AXUIElement? {
    let windows = axWindows(of: app, note: &note)
    if let hit = windows.first(where: { cgWindowID(of: $0) == windowID }) { return hit }
    let wantTitle = title ?? Windows.title(of: windowID)
    let wantBounds = bounds ?? Windows.bounds(of: windowID)
    let hit = windows.first { w in
      let t = string(w, kAXTitleAttribute as String)
      let f = frame(w)
      if let wantBounds, let f, abs(f.origin.x - wantBounds.origin.x) < 2, abs(f.origin.y - wantBounds.origin.y) < 2,
         abs(f.width - wantBounds.width) < 2, abs(f.height - wantBounds.height) < 2 { return true }
      if let wantTitle, !wantTitle.isEmpty, t == wantTitle { return true }
      return false
    }
    if hit == nil && note.isEmpty {
      if windows.isEmpty {
        note = "the app lists no accessible windows"
      } else {
        let seen = windows.prefix(6).map { w -> String in
          let t = string(w, kAXTitleAttribute as String) ?? ""
          let f = frame(w)
          let size = f.map { "\(Int($0.width))x\(Int($0.height)) at \(Int($0.origin.x)),\(Int($0.origin.y))" } ?? "no frame"
          return "\"\(t)\" \(size)"
        }
        let want = wantBounds.map { "\(Int($0.width))x\(Int($0.height)) at \(Int($0.origin.x)),\(Int($0.origin.y))" } ?? "unknown size"
        note = "the app lists \(windows.count) accessible window(s) [\(seen.joined(separator: "; "))], none is window \(windowID) \"\(wantTitle ?? "")\" \(want)"
      }
    }
    return hit
  }

  /// The ids of an app's minimized windows — one AX round-trip per app for the windows list.
  static func minimizedWindows(pid: pid_t) -> Set<CGWindowID> {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.3)
    let windows = (attribute(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    var out = Set<CGWindowID>()
    for w in windows where bool(w, kAXMinimizedAttribute as String) == true {
      if let id = cgWindowID(of: w) { out.insert(id) }
    }
    return out
  }

  // MARK: snapshot

  private static let roleNames: [String: String] = [
    "AXButton": "button", "AXPopUpButton": "popup", "AXMenuButton": "menubutton", "AXRadioButton": "radio",
    "AXCheckBox": "checkbox", "AXTextField": "textfield", "AXTextArea": "textarea", "AXSecureTextField": "password",
    "AXStaticText": "text", "AXLink": "link", "AXImage": "image", "AXMenuItem": "menuitem", "AXMenu": "menu",
    "AXMenuBar": "menubar", "AXMenuBarItem": "menubaritem", "AXList": "list", "AXTable": "table", "AXOutline": "outline",
    "AXRow": "row", "AXCell": "cell", "AXColumn": "column", "AXGroup": "group", "AXScrollArea": "scrollarea",
    "AXScrollBar": "scrollbar", "AXTabGroup": "tabs", "AXToolbar": "toolbar", "AXSlider": "slider", "AXWebArea": "webarea",
    "AXHeading": "heading", "AXComboBox": "combobox", "AXSplitGroup": "splitgroup", "AXWindow": "window", "AXSheet": "sheet",
    "AXDisclosureTriangle": "disclosure", "AXIncrementor": "stepper", "AXProgressIndicator": "progress", "AXSwitch": "switch"
  ]

  /// Roles that are structure, not controls: shown only when they carry a label.
  private static let structural: Set<String> = ["AXGroup", "AXSplitGroup", "AXScrollArea", "AXWebArea", "AXGenericElement", "AXUnknown", "AXList", "AXTable", "AXOutline", "AXToolbar", "AXTabGroup", "AXLayoutArea", "AXLayoutItem"]

  private static let maxNodes = 400

  private func text(_ s: String?, limit: Int = 80) -> String? {
    guard let s = s?.replacingOccurrences(of: "\n", with: "⏎").trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
    return s.count > limit ? String(s.prefix(limit - 1)) + "…" : s
  }

  /// Walks the window's tree and writes one line per control with a fresh id.
  /// `toPixel` turns global points into pixels of the current window picture so
  /// the ids line up with what the model sees.
  func snapshot(depth maxDepth: Int, windowBounds: CGRect, toPixel: (CGPoint) -> (Int, Int), ppp: Double) throws -> String {
    guard let root = window ?? lookUpWindow(tries: 5) else {
      let why = lookupNote.isEmpty ? "" : " (\(lookupNote))"
      throw HelperError("This app exposes no accessible window for the selected window\(why); Accessibility cannot drive it. Clear the window (select_window with no arguments) and use the screen.")
    }
    window = root
    nodes = [:]
    snapshotTaken = true
    var lines: [String] = []
    var next = 0
    var truncated = false
    let visible = windowBounds.insetBy(dx: -2, dy: -2)

    func walk(_ el: AXUIElement, depth: Int, indent: Int) {
      if nodes.count >= AX.maxNodes { truncated = true; return }
      let role = AX.string(el, kAXRoleAttribute as String) ?? "AXUnknown"
      let frame = AX.frame(el)
      // Off the window (scrolled away, collapsed) — skip it and its children.
      if let frame, frame.width > 0, frame.height > 0, !frame.intersects(visible) { return }
      let title = text(AX.string(el, kAXTitleAttribute as String))
      let desc = text(AX.string(el, kAXDescriptionAttribute as String))
      let value = text(AX.string(el, kAXValueAttribute as String))
      let placeholder = text(AX.string(el, kAXPlaceholderValueAttribute as String))
      let label = title ?? desc ?? (role == "AXStaticText" || role == "AXHeading" || role == "AXLink" ? value : nil) ?? placeholder
      let acts = AX.actions(el)
      let focused = AX.bool(el, kAXFocusedAttribute as String) ?? false
      let enabled = AX.bool(el, kAXEnabledAttribute as String) ?? true
      let settable: Bool = {
        var s = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &s) == .success && s.boolValue
      }()
      let isStructure = AX.structural.contains(role) && label == nil && !focused
      let hasSize = (frame?.width ?? 0) >= 1 && (frame?.height ?? 0) >= 1
      if !isStructure && hasSize && role != "AXWindow" {
        let id = next
        next += 1
        nodes[id] = AXNode(id: id, element: el, role: role)
        var caps: [String] = []
        if acts.contains(kAXPressAction as String) { caps.append("press") }
        if acts.contains(kAXShowMenuAction as String) { caps.append("menu") }
        if settable { caps.append("setvalue") }
        var line = String(repeating: " ", count: min(indent, 12)) + "\(id)  " + (AX.roleNames[role] ?? role.replacingOccurrences(of: "AX", with: "").lowercased())
        if let label { line += " \"\(label)\"" }
        if let value, label != value, role != "AXStaticText", role != "AXHeading" { line += " = \"\(value)\"" }
        if let placeholder, label != placeholder { line += " placeholder \"\(placeholder)\"" }
        if focused { line += " focused" }
        if !enabled { line += " disabled" }
        if !caps.isEmpty { line += "  [\(caps.joined(separator: ","))]" }
        if let frame {
          let (x, y) = toPixel(frame.origin)
          line += "  (\(x),\(y) \(Int((frame.width / ppp).rounded()))x\(Int((frame.height / ppp).rounded())))"
        }
        lines.append(line)
      }
      if depth >= maxDepth { return }
      // Menus and their items are only present while open; children of a
      // collapsed popup are noise. Everything else: descend.
      for child in AX.children(el) {
        walk(child, depth: depth + 1, indent: isStructure ? indent : indent + 1)
      }
    }
    walk(root, depth: 0, indent: 0)
    // A tree that comes back nearly empty right after accessibility was
    // switched on is still being built (Chromium fills its web area over a
    // second or two): keep looking for a while before believing it.
    var waited = 0
    while lines.count < 12 && !truncated && waited < 8 {
      usleep(500_000)
      waited += 1
      nodes = [:]; lines = []; next = 0
      walk(root, depth: 0, indent: 0)
    }
    if waited > 0 { trace("snapshot settled after \(waited) extra looks, \(lines.count) controls") }
    lastSnapshotCount = lines.count
    var head = "Controls of this window (id  role \"label\" [what it can do]  (x,y wxh in window pixels)). Ids are valid until the next snapshot."
    if truncated { head += " Only the first \(AX.maxNodes) controls are listed; lower `depth` or scroll to see others." }
    if lines.count < 12 {
      head += "\nThe app exposed almost nothing after \(waited / 2) s (\(wakeNote))."
    }
    if lines.isEmpty { return head + "\n(none exposed — this window may be a canvas; act on it in screen mode)" }
    return ([head] + lines).joined(separator: "\n")
  }

  // MARK: acting by id

  private func node(_ id: Int) throws -> AXNode {
    guard snapshotTaken else { throw HelperError("Take a snapshot first; element ids come from it.") }
    guard let n = nodes[id] else { throw HelperError("No element \(id) in the last snapshot. Take a new snapshot and use one of its ids.") }
    return n
  }

  private func check(_ err: AXError, _ what: String) throws {
    switch err {
    case .success: return
    case .actionUnsupported, .attributeUnsupported: throw HelperError("\(what): this control does not support it.")
    case .cannotComplete: throw HelperError("\(what): the app did not answer (busy, or it exposes no accessibility).")
    case .invalidUIElement: throw HelperError("\(what): the control is gone; take a new snapshot.")
    case .notImplemented: throw HelperError("\(what): the app does not implement this.")
    default: throw HelperError("\(what) failed (AXError \(err.rawValue)).")
    }
  }

  /// AXPress on the element, or the nearest ancestor that takes it.
  private func press(_ element: AXUIElement, what: String) throws {
    var el = element
    for _ in 0..<4 {
      let acts = AX.actions(el)
      if acts.contains(kAXPressAction as String) {
        try check(AXUIElementPerformAction(el, kAXPressAction as CFString), what)
        return
      }
      guard let parent = AX.attribute(el, kAXParentAttribute as String) else { break }
      el = parent as! AXUIElement
    }
    // Chromium exposes clickable rows and links without AXPress but still
    // honours it; try once and read the answer.
    let err = AXUIElementPerformAction(element, kAXPressAction as CFString)
    if err == .success { return }
    throw HelperError("\(what): nothing pressable there. Take a snapshot and use press/focus/set_value by id, or if this is a canvas, clear the window and click in screen mode.")
  }

  func press(id: Int) throws {
    try press(try node(id).element, what: "press \(id)")
  }

  func showMenu(_ element: AXUIElement, what: String) throws {
    var el = element
    for _ in 0..<4 {
      if AX.actions(el).contains(kAXShowMenuAction as String) {
        try check(AXUIElementPerformAction(el, kAXShowMenuAction as CFString), what)
        return
      }
      guard let parent = AX.attribute(el, kAXParentAttribute as String) else { break }
      el = parent as! AXUIElement
    }
    throw HelperError("\(what): no context menu is exposed there.")
  }

  func menu(id: Int) throws {
    try showMenu(try node(id).element, what: "menu \(id)")
  }

  func focus(id: Int) throws {
    let n = try node(id)
    try check(AXUIElementSetAttributeValue(n.element, kAXFocusedAttribute as CFString, kCFBooleanTrue), "focus \(id)")
  }

  func setValue(id: Int, text: String) throws {
    let n = try node(id)
    var settable = DarwinBoolean(false)
    _ = AXUIElementIsAttributeSettable(n.element, kAXValueAttribute as CFString, &settable)
    if !settable.boolValue {
      throw HelperError("set_value \(id): this \(AX.roleNames[n.role] ?? n.role) does not take a value directly. Focus it and use type instead.")
    }
    try check(AXUIElementSetAttributeValue(n.element, kAXValueAttribute as CFString, text as CFString), "set_value \(id)")
  }

  // MARK: acting at a point (window-mode clicks)

  func element(at point: CGPoint) -> AXUIElement? {
    // Right after the wake-up an Electron or Chromium app may still be
    // building its tree; give it up to a second before calling the spot empty.
    for attempt in 0..<5 {
      if attempt > 0 { usleep(200_000) }
      var out: AXUIElement?
      if AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &out) == .success, let out { return out }
      if Date().timeIntervalSince(wokeAt) > 2 { break }
    }
    return nil
  }

  /// A click in window mode: hit-test, then press (or open the context menu).
  func click(at point: CGPoint, button: String, count: Int) throws {
    guard let el = element(at: point) else {
      throw HelperError("Nothing accessible at that point. Take a snapshot and act by id, or clear the window and click in screen mode.")
    }
    if button == "right" {
      try showMenu(el, what: "right click")
      return
    }
    // A double click means "open" where the app distinguishes it (files, rows).
    if count >= 2, AX.actions(el).contains("AXOpen") {
      try check(AXUIElementPerformAction(el, "AXOpen" as CFString), "double click")
      return
    }
    // Clicking a field is how one focuses it; fields rarely take AXPress.
    let role = AX.string(el, kAXRoleAttribute as String) ?? ""
    if ["AXTextField", "AXTextArea", "AXSecureTextField", "AXComboBox", "AXSearchField"].contains(role),
       !AX.actions(el).contains(kAXPressAction as String) {
      if AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success { return }
    }
    try press(el, what: "click")
  }

  /// The element keyboard input will land in, if the app has one.
  func focusedElement() -> AXUIElement? {
    guard let v = AX.attribute(app, kAXFocusedUIElementAttribute as String) else { return nil }
    return v as! AXUIElement
  }

  func isMinimized() -> Bool {
    guard let window else { return false }
    return AX.bool(window, kAXMinimizedAttribute as String) ?? false
  }

  /// Scroll the scroll area under a point by whole pages, through its actions
  /// where the app offers them, else by nudging its scroll bar's value.
  func scroll(at point: CGPoint, direction: String, amount: Int) throws {
    guard var el = element(at: point) else { throw HelperError("Nothing accessible at that point to scroll.") }
    let pageActions: [String: String] = ["up": "AXScrollUpByPage", "down": "AXScrollDownByPage", "left": "AXScrollLeftByPage", "right": "AXScrollRightByPage"]
    guard let action = pageActions[direction] else { throw HelperError("scroll direction must be up, down, left or right.") }
    let pages = max(1, min(amount / 5, 5))
    for _ in 0..<8 {
      if AX.actions(el).contains(action) {
        for _ in 0..<pages { try check(AXUIElementPerformAction(el, action as CFString), "scroll") }
        return
      }
      if AX.string(el, kAXRoleAttribute as String) == "AXScrollArea" {
        let barAttr = (direction == "up" || direction == "down") ? kAXVerticalScrollBarAttribute : kAXHorizontalScrollBarAttribute
        if let bar = AX.attribute(el, barAttr as String) {
          let barEl = bar as! AXUIElement
          let cur = (AX.attribute(barEl, kAXValueAttribute as String) as? NSNumber)?.doubleValue ?? 0
          let step = 0.1 * Double(pages) * ((direction == "up" || direction == "left") ? -1 : 1)
          let next = min(1, max(0, cur + step))
          try check(AXUIElementSetAttributeValue(barEl, kAXValueAttribute as CFString, NSNumber(value: next)), "scroll")
          return
        }
      }
      guard let parent = AX.attribute(el, kAXParentAttribute as String) else { break }
      el = parent as! AXUIElement
    }
    throw HelperError("Nothing scrollable is exposed there; the app may only scroll with the real mouse (screen mode).")
  }
}
