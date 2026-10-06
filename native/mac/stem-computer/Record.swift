import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO

// Record mode: the person shows Stem a task and this writes down what they did,
// by NAME — "pressed button \"Save\" in agrisys (Arc)" — never by position, plus
// the text they had in front of them, so the far end can work out where each
// typed value came from (the date in the order form ← the date in the email).
//
// Events, one JSON line each, no id:
//   {"event":"rec-step", "step":{kind, t, app, bundleId, window, url?, ...}}
//   {"event":"rec-seen", "seen":{t, app, window, url?, text, hash}}
//   {"event":"rec-shot", "shot":{t, app, window, path}}
//   {"event":"rec-note", "note":"..."}            (something the person should know)
// Passwords never leave this process: a secure field's value is "[password]".

final class Recorder {
  private let queue = DispatchQueue(label: "stem-computer-record")
  private var tap: CFMachPort?
  private var tapLoop: CFRunLoop?
  private var timer: DispatchSourceTimer?
  private let lock = NSLock()
  private var paused = false
  private var running = false
  private var start = Date()
  private var shotsDir: URL?
  /// Our parent (Stem): its windows — the pill, the chat — are not part of the task.
  private let stemPid = getppid()
  private let systemWide = AXUIElementCreateSystemWide()

  // All below: touched on `queue` only.
  private var lastFocus: (pid: pid_t, window: String)?
  private var editing: (element: AXUIElement, field: String, role: String, secure: Bool, before: String, app: Context)?
  private var lastSeenHash: [String: Int] = [:]
  private var lastShotAt = Date.distantPast
  private var lastSeenAt = Date.distantPast
  private var woken: [pid_t: AXUIElement] = [:]
  private var pasteboardCount = NSPasteboard.general.changeCount
  private var shotsDenied = false

  /// Password managers mark what they copy as concealed (nspasteboard.org); such text is never written down.
  private static let concealedTypes = [
    NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"),
    NSPasteboard.PasteboardType("org.nspasteboard.TransientType"),
    NSPasteboard.PasteboardType("com.agilebits.onepassword")
  ]

  /// Apps whose windows are secrets by nature: their text and pictures are never kept.
  private static let secretApps: Set<String> = [
    "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.apple.keychainaccess",
    "com.apple.Passwords", "com.dashlane.dashlanephonefinal", "com.lastpass.lastpassmacdesktop", "org.keepassxc.keepassxc",
    "com.keepersecurity.passwordmanager", "com.nordsec.nordpass", "in.sinew.Enpass-Desktop"
  ]

  static func isSecretApp(_ bundleId: String) -> Bool {
    secretApps.contains(bundleId) || bundleId.lowercased().contains("password")
  }

  /// Fields whose name says they hold a secret even though they are not password fields.
  private static let sensitiveName = try! NSRegularExpression(
    pattern: "pass(word|wort|code|phrase)|\\bpass\\b|heslo|\\bpin\\b|\\botp\\b|2fa|one[- ]?time|verification code|security code|overovac|\\bcvv\\b|\\bcvc\\b|card ?number|číslo karty|\\biban\\b|secret|api[ _-]?key|access[ _-]?key|\\btoken\\b|private key|seed phrase|recovery",
    options: [.caseInsensitive])

  static func isSensitiveName(_ name: String?) -> Bool {
    guard let name, !name.isEmpty else { return false }
    return sensitiveName.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
  }

  /// A payment card number (13–19 digits passing Luhn), however spaced.
  static func looksLikeCard(_ value: String) -> Bool {
    let digits = value.filter { $0.isNumber }
    guard (13...19).contains(digits.count), value.allSatisfy({ $0.isNumber || $0 == " " || $0 == "-" }) else { return false }
    var sum = 0
    for (i, ch) in digits.reversed().enumerated() {
      var d = Int(String(ch)) ?? 0
      if i % 2 == 1 { d *= 2; if d > 9 { d -= 9 } }
      sum += d
    }
    return sum % 10 == 0
  }

  private static func pasteboardIsConcealed(_ pb: NSPasteboard) -> Bool {
    guard let types = pb.types else { return false }
    return types.contains { concealedTypes.contains($0) }
  }

  struct Context {
    let pid: pid_t
    let app: String
    let bundleId: String
    let window: String
    let url: String?

    var fields: [String: Any] {
      var out: [String: Any] = ["app": app, "bundleId": bundleId, "window": window]
      if let url { out["url"] = url }
      return out
    }
  }

  var isRunning: Bool { lock.lock(); defer { lock.unlock() }; return running }

  func begin(shotsDir: String?) throws {
    lock.lock()
    if running { lock.unlock(); throw HelperError("Already recording.") }
    lock.unlock()
    let mask: CGEventMask =
      (1 << CGEventType.leftMouseDown.rawValue) | (1 << CGEventType.rightMouseDown.rawValue) |
      (1 << CGEventType.keyDown.rawValue)
    let selfPtr = Unmanaged.passUnretained(self).toOpaque()
    guard let port = CGEvent.tapCreate(
      tap: .cghidEventTap, place: .tailAppendEventTap, options: .listenOnly,
      eventsOfInterest: mask,
      callback: { _, type, event, userInfo in
        guard let userInfo else { return Unmanaged.passUnretained(event) }
        Unmanaged<Recorder>.fromOpaque(userInfo).takeUnretainedValue().saw(type: type, event: event)
        return Unmanaged.passUnretained(event)
      },
      userInfo: selfPtr
    ) else {
      throw HelperError("Could not listen to your clicks and keys. Stem needs Input Monitoring access (System Settings → Privacy & Security → Input Monitoring).")
    }
    if !AXIsProcessTrusted() {
      CGEvent.tapEnable(tap: port, enable: false)
      throw HelperError("Stem needs Accessibility access to name what you click (System Settings → Privacy & Security → Accessibility).")
    }
    tap = port
    shotsDir.map { self.shotsDir = URL(fileURLWithPath: $0) }
    lock.lock(); running = true; paused = false; start = Date(); lock.unlock()
    let t = Thread { [weak self] in
      guard let self, let port = self.tap else { return }
      let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
      self.tapLoop = CFRunLoopGetCurrent()
      CFRunLoopAddSource(self.tapLoop, source, .commonModes)
      CGEvent.tapEnable(tap: port, enable: true)
      CFRunLoopRun()
    }
    t.name = "stem-computer-record-tap"
    t.start()
    // The focused window is polled (no AppKit run loop in this helper, so no
    // workspace notifications): a switch is a step, and what the window shows
    // is re-read now and then because the person reads as they go.
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 0.2, repeating: 0.6)
    timer.setEventHandler { [weak self] in self?.poll() }
    self.timer = timer
    timer.resume()
  }

  func setPaused(_ on: Bool) {
    queue.sync { if on { flushTyped() } }
    lock.lock(); paused = on; lock.unlock()
    if !on { queue.async { self.lastFocus = nil } }
  }

  /// Stop listening; whatever was being typed is written down first.
  func end() {
    lock.lock(); let was = running; running = false; lock.unlock()
    guard was else { return }
    if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
    if let tapLoop { CFRunLoopStop(tapLoop) }
    tap = nil
    tapLoop = nil
    timer?.cancel()
    timer = nil
    queue.sync {
      flushTyped()
      for (_, app) in woken {
        AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanFalse)
      }
      woken = [:]
      editing = nil
      lastFocus = nil
      lastSeenHash = [:]
    }
  }

  private var elapsedMs: Int { Int(Date().timeIntervalSince(start) * 1000) }

  private var active: Bool { lock.lock(); defer { lock.unlock() }; return running && !paused }

  // MARK: the tap (its own thread — copy what is needed, hand off at once)

  private func saw(type: CGEventType, event: CGEvent) {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
      return
    }
    guard active else { return }
    // Stem's own computer-control runs post tagged events; they are not the person.
    if event.getIntegerValueField(.eventSourceUserData) == STEM_EVENT_TAG { return }
    switch type {
    case .leftMouseDown, .rightMouseDown:
      let at = event.location
      let right = type == .rightMouseDown
      let count = Int(event.getIntegerValueField(.mouseEventClickState))
      queue.async { self.clicked(at: at, right: right, count: count) }
    case .keyDown:
      let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
      let flags = event.flags
      var length = 0
      var chars = [UniChar](repeating: 0, count: 4)
      event.keyboardGetUnicodeString(maxStringLength: 4, actualStringLength: &length, unicodeString: &chars)
      let text = String(utf16CodeUnits: chars, count: length)
      queue.async { self.pressed(code: code, flags: flags, text: text) }
    default:
      break
    }
  }

  // MARK: steps

  private func emitStep(_ kind: String, _ ctx: Context, _ extra: [String: Any]) {
    var step = ctx.fields
    step["kind"] = kind
    step["t"] = elapsedMs
    for (k, v) in extra { step[k] = v }
    emit(["event": "rec-step", "step": step])
  }

  private func clicked(at point: CGPoint, right: Bool, count: Int) {
    var hit: AXUIElement?
    AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &hit)
    guard let hit else { return }
    var pid: pid_t = 0
    AXUIElementGetPid(hit, &pid)
    if pid == stemPid || pid == getpid() { return }
    // Leaving a field by clicking elsewhere: its value is final now.
    if let editing, !CFEqual(editing.element, hit) { flushTyped() }
    let ctx = context(pid: pid, from: hit)
    let role = AX.string(hit, kAXRoleAttribute as String) ?? "AXUnknown"
    var extra: [String: Any] = ["role": Recorder.roleName(role), "x": Int(point.x), "y": Int(point.y)]
    if !Recorder.isSecretApp(ctx.bundleId) {
      if let label = Recorder.describe(hit) { extra["label"] = label }
      if let within = Recorder.container(of: hit) { extra["within"] = within }
    }
    if right { extra["button"] = "right" }
    if count > 1 { extra["count"] = count }
    if role == "AXSecureTextField" { extra["secure"] = true }
    emitStep("click", ctx, extra)
    // What the click led to: a field taking focus, a page or message changing.
    queue.asyncAfter(deadline: .now() + 0.15) { self.trackFocusedField() }
    queue.asyncAfter(deadline: .now() + 0.8) { self.look(ctx.pid, force: false, shot: true) }
  }

  private static let specialKeys: [Int: String] = [
    0x24: "Return", 0x4C: "Enter", 0x30: "Tab", 0x35: "Escape", 0x7E: "Up", 0x7D: "Down",
    0x7B: "Left", 0x7C: "Right", 0x75: "Delete", 0x33: "Backspace", 0x31: "Space"
  ]

  private func pressed(code: Int, flags: CGEventFlags, text: String) {
    let cmd = flags.contains(.maskCommand)
    let ctrl = flags.contains(.maskControl)
    let special = Recorder.specialKeys[code]
    if cmd || ctrl {
      let key = (special ?? text.lowercased())
      var combo = ""
      if ctrl { combo += "ctrl+" }
      if flags.contains(.maskAlternate) { combo += "alt+" }
      if flags.contains(.maskShift) { combo += "shift+" }
      if cmd { combo += "cmd+" }
      combo += key.isEmpty ? "key\(code)" : key
      guard let ctx = focusedContext() else { return }
      if cmd && !ctrl && (key == "c" || key == "x") {
        // The pasteboard changes a beat after the keystroke.
        queue.asyncAfter(deadline: .now() + 0.2) { self.copied(ctx, cut: key == "x") }
        return
      }
      if cmd && !ctrl && key == "v" {
        trackFocusedField()
        let pb = NSPasteboard.general
        let pasted = pb.string(forType: .string) ?? ""
        let hidden = Recorder.pasteboardIsConcealed(pb) || Recorder.isSecretApp(ctx.bundleId) || Recorder.looksLikeCard(pasted)
        var extra: [String: Any] = ["text": hidden ? "[password]" : Recorder.clip(pasted, 2000)]
        if hidden { extra["secure"] = true }
        if let editing { extra["field"] = editing.field; if editing.secure { extra["text"] = "[password]"; extra["secure"] = true } }
        emitStep("paste", ctx, extra)
        return
      }
      emitStep("key", ctx, ["combo": combo])
      return
    }
    if let special, ["Return", "Enter", "Tab", "Escape"].contains(special) {
      // Return/Tab/Escape usually end a field: write its value down first.
      flushTyped()
      if let ctx = focusedContext() { emitStep("key", ctx, ["combo": special.lowercased()]) }
      if special != "Escape" { queue.asyncAfter(deadline: .now() + 0.15) { self.trackFocusedField() } }
      return
    }
    // Plain typing: remember which field it goes into; the value is read when
    // the person leaves the field, so autocorrect and pickers are included.
    if editing == nil { trackFocusedField() }
  }

  private func copied(_ ctx: Context, cut: Bool) {
    let pb = NSPasteboard.general
    guard pb.changeCount != pasteboardCount else { return }
    pasteboardCount = pb.changeCount
    guard let text = pb.string(forType: .string), !text.isEmpty else { return }
    // A password manager's copy, or a copy out of a password field: say that it happened, not what.
    let focusedSecure = AX.attribute(systemWide, kAXFocusedUIElementAttribute as String).map { el -> Bool in
      let e = el as! AXUIElement
      return AX.string(e, kAXRoleAttribute as String) == "AXSecureTextField" || AX.string(e, kAXSubroleAttribute as String) == "AXSecureTextField"
    } ?? false
    if Recorder.pasteboardIsConcealed(pb) || Recorder.isSecretApp(ctx.bundleId) || focusedSecure || Recorder.looksLikeCard(text) {
      emitStep(cut ? "cut" : "copy", ctx, ["text": "[password]", "secure": true])
      return
    }
    emitStep(cut ? "cut" : "copy", ctx, ["text": Recorder.clip(text, 2000)])
  }

  private static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSecureTextField", "AXSearchField"]

  /// Start following the field that has keyboard focus now (if it takes text).
  private func trackFocusedField() {
    guard let el = AX.attribute(systemWide, kAXFocusedUIElementAttribute as String).map({ $0 as! AXUIElement }) else { return }
    if let editing, CFEqual(editing.element, el) { return }
    flushTyped()
    let role = AX.string(el, kAXRoleAttribute as String) ?? ""
    let subrole = AX.string(el, kAXSubroleAttribute as String) ?? ""
    guard Recorder.textRoles.contains(role) || subrole == "AXSecureTextField" else { return }
    var pid: pid_t = 0
    AXUIElementGetPid(el, &pid)
    if pid == stemPid || pid == getpid() { return }
    let ctx = context(pid: pid, from: el)
    let name = Recorder.fieldName(el)
    let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField" || Recorder.isSecretApp(ctx.bundleId) || Recorder.isSensitiveName(name)
    let before = secure ? "" : (AX.string(el, kAXValueAttribute as String) ?? "")
    editing = (el, name ?? Recorder.roleName(role), Recorder.roleName(role), secure, before, ctx)
  }

  /// The field being followed is done: if its value changed, that is a step.
  private func flushTyped() {
    guard let e = editing else { return }
    editing = nil
    if e.secure {
      // Whether anything was typed cannot be told without reading it; say so once.
      emitStep("type", e.app, ["field": e.field, "role": e.role, "value": "[password]", "secure": true])
      return
    }
    let now = AX.string(e.element, kAXValueAttribute as String) ?? ""
    guard now != e.before, !now.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    if Recorder.looksLikeCard(now) {
      emitStep("type", e.app, ["field": e.field, "role": e.role, "value": "[password]", "secure": true])
      return
    }
    var extra: [String: Any] = ["field": e.field, "role": e.role, "value": Recorder.clip(now, 4000)]
    if !e.before.isEmpty { extra["before"] = Recorder.clip(e.before, 400) }
    emitStep("type", e.app, extra)
  }

  // MARK: the focused window

  private func poll() {
    guard active else { return }
    guard let appEl = AX.attribute(systemWide, kAXFocusedApplicationAttribute as String).map({ $0 as! AXUIElement }) else { return }
    var pid: pid_t = 0
    AXUIElementGetPid(appEl, &pid)
    if pid == stemPid || pid == getpid() || pid == 0 { return }
    let window = AX.attribute(appEl, kAXFocusedWindowAttribute as String).map { $0 as! AXUIElement }
    let title = window.flatMap { AX.string($0, kAXTitleAttribute as String) } ?? ""
    if lastFocus?.pid != pid || lastFocus?.window != title {
      lastFocus = (pid, title)
      flushTyped()
      wake(pid: pid)
      emitStep("switch", context(pid: pid, from: window ?? appEl), [:])
      look(pid, force: true, shot: true)
      return
    }
    // Same window: re-read what it shows every few seconds (a new message
    // selected, a page loaded) — cheap when nothing changed, the hash says so.
    if Date().timeIntervalSince(lastSeenAt) > 2.5 { look(pid, force: false, shot: false) }
  }

  /// Chromium and Electron apps build their accessibility tree only for an
  /// assistive client that asks; ask once per app for the whole recording.
  private func wake(pid: pid_t) {
    guard woken[pid] == nil, let running = NSRunningApplication(processIdentifier: pid), Windows.isChromium(running) else { return }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    woken[pid] = app
  }

  /// Read the text of the app's focused window; write it down when it changed.
  private func look(_ pid: pid_t, force: Bool, shot: Bool) {
    guard active else { return }
    lastSeenAt = Date()
    let appEl = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(appEl, 1.0)
    guard let window = AX.attribute(appEl, kAXFocusedWindowAttribute as String).map({ $0 as! AXUIElement }) else { return }
    let ctx = context(pid: pid, from: window)
    if Recorder.isSecretApp(ctx.bundleId) { return }
    let text = Recorder.visibleText(window)
    if !text.isEmpty {
      let key = "\(pid)|\(ctx.window)"
      let hash = text.hashValue
      if force || lastSeenHash[key] != hash {
        lastSeenHash[key] = hash
        var seen = ctx.fields
        seen["t"] = elapsedMs
        seen["text"] = text
        seen["hash"] = String(UInt(bitPattern: hash), radix: 16)
        emit(["event": "rec-seen", "seen": seen])
      }
    }
    if shot { takeShot(window, ctx) }
  }

  /// A picture of the window, kept on the Mac; used only for a value no text explains.
  private func takeShot(_ window: AXUIElement, _ ctx: Context) {
    guard let dir = shotsDir, !shotsDenied, Date().timeIntervalSince(lastShotAt) >= 2 else { return }
    guard let windowID = AX.cgWindowID(of: window), let bounds = Windows.bounds(of: windowID) else { return }
    lastShotAt = Date()
    guard CGPreflightScreenCaptureAccess() else {
      shotsDenied = true
      emit(["event": "rec-note", "note": "Screen Recording is off, so no pictures are kept; values only an image shows cannot be traced."])
      return
    }
    do {
      let image = try WindowCapture.capture(windowID: windowID, bounds: bounds)
      let t = elapsedMs
      let url = dir.appendingPathComponent("shot-\(t).jpg")
      try Recorder.writeJpeg(image, to: url, maxSide: 1400)
      var shot = ctx.fields
      shot["t"] = t
      shot["path"] = url.path
      emit(["event": "rec-shot", "shot": shot])
    } catch {
      trace("record shot failed: \(error)")
    }
  }

  // MARK: naming things

  private func focusedContext() -> Context? {
    guard let appEl = AX.attribute(systemWide, kAXFocusedApplicationAttribute as String).map({ $0 as! AXUIElement }) else { return nil }
    var pid: pid_t = 0
    AXUIElementGetPid(appEl, &pid)
    if pid == stemPid || pid == getpid() { return nil }
    let window = AX.attribute(appEl, kAXFocusedWindowAttribute as String).map { $0 as! AXUIElement }
    return context(pid: pid, from: window ?? appEl)
  }

  private func context(pid: pid_t, from element: AXUIElement) -> Context {
    let running = NSRunningApplication(processIdentifier: pid)
    let window = Recorder.ancestor(of: element, role: "AXWindow") ?? element
    return Context(
      pid: pid,
      app: running?.localizedName ?? "pid \(pid)",
      bundleId: running?.bundleIdentifier ?? "",
      window: Recorder.clip(AX.string(window, kAXTitleAttribute as String) ?? "", 160),
      url: Recorder.pageURL(near: element)
    )
  }

  static func roleName(_ role: String) -> String {
    role.hasPrefix("AX") ? String(role.dropFirst(2)).lowercased() : role.lowercased()
  }

  static func clip(_ s: String, _ limit: Int) -> String {
    s.count > limit ? String(s.prefix(limit - 1)) + "…" : s
  }

  private static func clean(_ s: String?) -> String? {
    guard let s = s?.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
    return clip(s, 120)
  }

  /// What a person would call the thing they clicked: its title or
  /// description, a link's or text's own words, else the words inside it
  /// (a mail-list row, a web button whose text is a child).
  static func describe(_ el: AXUIElement) -> String? {
    let role = AX.string(el, kAXRoleAttribute as String) ?? ""
    if let own = clean(AX.string(el, kAXTitleAttribute as String)) ?? clean(AX.string(el, kAXDescriptionAttribute as String)) { return own }
    if ["AXStaticText", "AXHeading", "AXLink", "AXMenuItem", "AXCell", "AXPopUpButton", "AXRadioButton"].contains(role),
       let v = clean(AX.string(el, kAXValueAttribute as String)) { return v }
    var words: [String] = []
    func gather(_ e: AXUIElement, _ depth: Int) {
      if words.joined(separator: " ").count > 120 || depth > 4 { return }
      for child in AX.children(e) {
        let r = AX.string(child, kAXRoleAttribute as String) ?? ""
        if r == "AXSecureTextField" { continue }
        if let t = clean(AX.string(child, kAXTitleAttribute as String)) ?? (r == "AXStaticText" ? clean(AX.string(child, kAXValueAttribute as String)) : nil) {
          words.append(t)
        }
        gather(child, depth + 1)
      }
    }
    gather(el, 0)
    if !words.isEmpty { return clip(words.joined(separator: " · "), 160) }
    return clean(AX.string(el, kAXPlaceholderValueAttribute as String)) ?? clean(AX.string(el, kAXHelpAttribute as String))
  }

  /// A field's name: its own title/description/placeholder, else the label
  /// element that names it, else the text just before it in its group.
  static func fieldName(_ el: AXUIElement) -> String? {
    if let own = clean(AX.string(el, kAXTitleAttribute as String)) ?? clean(AX.string(el, kAXDescriptionAttribute as String)) { return own }
    if let titled = AX.attribute(el, kAXTitleUIElementAttribute as String), CFGetTypeID(titled) == AXUIElementGetTypeID(),
       let t = clean(AX.string(titled as! AXUIElement, kAXValueAttribute as String)) ?? clean(AX.string(titled as! AXUIElement, kAXTitleAttribute as String)) {
      return t
    }
    if let p = clean(AX.string(el, kAXPlaceholderValueAttribute as String)) { return p }
    // The nearest static text before the field among its parent's children.
    if let parent = AX.attribute(el, kAXParentAttribute as String).map({ $0 as! AXUIElement }) {
      var last: String?
      for child in AX.children(parent) {
        if CFEqual(child, el) { break }
        if AX.string(child, kAXRoleAttribute as String) == "AXStaticText", let v = clean(AX.string(child, kAXValueAttribute as String)) { last = v }
      }
      if let last { return last }
    }
    return nil
  }

  /// The nearest ancestor that names a region: a titled group, a sheet, a dialog.
  static func container(of el: AXUIElement) -> String? {
    var cur = AX.attribute(el, kAXParentAttribute as String).map { $0 as! AXUIElement }
    var hops = 0
    while let c = cur, hops < 8 {
      let role = AX.string(c, kAXRoleAttribute as String) ?? ""
      if role == "AXWindow" || role == "AXApplication" || role == "AXWebArea" { return nil }
      if let t = clean(AX.string(c, kAXTitleAttribute as String)) ?? clean(AX.string(c, kAXDescriptionAttribute as String)) {
        return "\(roleName(role)) \"\(t)\""
      }
      cur = AX.attribute(c, kAXParentAttribute as String).map { $0 as! AXUIElement }
      hops += 1
    }
    return nil
  }

  static func ancestor(of el: AXUIElement, role want: String) -> AXUIElement? {
    var cur: AXUIElement? = el
    var hops = 0
    while let c = cur, hops < 60 {
      if AX.string(c, kAXRoleAttribute as String) == want { return c }
      cur = AX.attribute(c, kAXParentAttribute as String).map { $0 as! AXUIElement }
      hops += 1
    }
    return nil
  }

  /// The address of the web page an element sits in (Chromium, Safari):
  /// its enclosing web area's AXURL; for a window, the first web area inside.
  static func pageURL(near el: AXUIElement) -> String? {
    if let area = ancestor(of: el, role: "AXWebArea"), let url = AX.string(area, "AXURL") { return url }
    guard AX.string(el, kAXRoleAttribute as String) == "AXWindow" else { return nil }
    var queue: [(AXUIElement, Int)] = [(el, 0)]
    var visited = 0
    while !queue.isEmpty, visited < 300 {
      let (e, depth) = queue.removeFirst()
      visited += 1
      if AX.string(e, kAXRoleAttribute as String) == "AXWebArea" { return AX.string(e, "AXURL") }
      if depth < 10 { queue.append(contentsOf: AX.children(e).map { ($0, depth + 1) }) }
    }
    return nil
  }

  /// The words a window shows, in reading order, password fields skipped. Capped at 30 KB.
  static func visibleText(_ window: AXUIElement) -> String {
    var parts: [String] = []
    var size = 0
    var visited = 0
    let limit = 30_000
    let bounds = AX.frame(window)?.insetBy(dx: -2, dy: -2)
    func walk(_ el: AXUIElement, _ depth: Int) {
      if size >= limit || visited > 6000 || depth > 40 { return }
      visited += 1
      let role = AX.string(el, kAXRoleAttribute as String) ?? ""
      if role == "AXSecureTextField" || AX.string(el, kAXSubroleAttribute as String) == "AXSecureTextField" { return }
      if let frame = AX.frame(el), let bounds, frame.width > 0, frame.height > 0, !frame.intersects(bounds) { return }
      var piece: String?
      switch role {
      case "AXTextArea", "AXTextField", "AXComboBox":
        piece = isSensitiveName(fieldName(el)) ? nil : AX.string(el, kAXValueAttribute as String)
      case "AXStaticText", "AXCell":
        piece = AX.string(el, kAXValueAttribute as String)
      case "AXHeading", "AXLink", "AXButton", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton", "AXTab":
        piece = AX.string(el, kAXTitleAttribute as String) ?? AX.string(el, kAXDescriptionAttribute as String)
      default:
        break
      }
      if let piece = piece?.trimmingCharacters(in: .whitespacesAndNewlines), !piece.isEmpty, !looksLikeCard(piece) {
        // A text area's value holds its children's words too; skip the children then.
        parts.append(piece)
        size += piece.count + 1
        if role == "AXTextArea" || role == "AXTextField" { return }
      }
      for child in AX.children(el) { walk(child, depth + 1) }
    }
    walk(window, 0)
    let joined = parts.joined(separator: "\n")
    return joined.count > limit ? String(joined.prefix(limit)) : joined
  }

  static func writeJpeg(_ image: CGImage, to url: URL, maxSide: Double) throws {
    let longest = Double(max(image.width, image.height))
    let factor = longest > maxSide ? maxSide / longest : 1.0
    let width = max(1, Int((Double(image.width) * factor).rounded()))
    let height = max(1, Int((Double(image.height) * factor).rounded()))
    guard let ctx = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else { throw HelperError("Could not allocate a drawing context.") }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let scaled = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.jpeg" as CFString, 1, nil) else {
      throw HelperError("Could not encode the picture.")
    }
    CGImageDestinationAddImage(dest, scaled, [kCGImageDestinationLossyCompressionQuality: 0.75] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw HelperError("Could not write the picture.") }
    chmod(url.path, 0o600)
  }
}
