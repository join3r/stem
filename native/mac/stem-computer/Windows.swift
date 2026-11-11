import AppKit
import CoreGraphics
import Foundation

/// The window a run works on once it has selected one. Nil target = the whole
/// main display, driven with the real mouse; a target = that window alone,
/// captured wherever it is (another Space, behind other windows, minimized)
/// and driven through Accessibility so the app never has to come forward.
struct Target {
  let pid: pid_t
  let windowID: CGWindowID
  let app: String
  let bundleId: String?
  var title: String
  /// Global CG points, top-left origin. Refreshed on every capture: windows move.
  var bounds: CGRect

  var summary: [String: Any] {
    ["app": app, "title": title, "windowId": Int(windowID)]
  }
}

/// One line of `list-windows`.
struct WindowInfo {
  let id: CGWindowID
  let pid: pid_t
  let app: String
  let bundleId: String?
  let title: String
  let bounds: CGRect
  let onScreen: Bool
  let minimized: Bool
  let appHidden: Bool
  let frontmost: Bool
  /// Built on Chromium (Electron apps, Chrome-family browsers): such an app
  /// keeps its accessibility tree only for a window that is at least partly
  /// visible, so off-screen it can be pictured but not driven.
  let chromium: Bool
}

enum Windows {
  /// Every ordinary window (layer 0, a real size, not ours), whatever Space it
  /// is on. Titles need Screen Recording, which the helper has anyway.
  ///
  /// `minimized: false` skips telling minimized windows apart — one AX round
  /// trip (up to 0.3 s) per app with an off-screen window, which only the
  /// listing the model reads needs.
  /// The app in front right now. `NSWorkspace.frontmostApplication` is only
  /// refreshed by notifications on the main run loop, which this process never
  /// runs (it blocks in readLine), so on its own it keeps naming whichever app
  /// was in front when the helper started. Accessibility asks the system live;
  /// without it, the pending notifications are drained first.
  static func frontmostPid() -> pid_t? {
    if AXIsProcessTrusted() {
      let system = AXUIElementCreateSystemWide()
      AXUIElementSetMessagingTimeout(system, 0.3)
      var pid: pid_t = 0
      if let app = AX.attribute(system, kAXFocusedApplicationAttribute as String),
         AXUIElementGetPid(app as! AXUIElement, &pid) == .success, pid > 0 {
        return pid
      }
    }
    // A short spin, not run(until: now): that can return before the pending
    // activation notifications are handled, and then the answer is stale.
    if Thread.isMainThread { RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01)) }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
  }

  /// Make the app that owns `id` the active one, so that it gets the keyboard
  /// back (a window panel that shrinks to its pill leaves no key window).
  /// Accessibility first: it works from a background process. False when the
  /// window is gone.
  static func focusApp(of id: CGWindowID) -> Bool {
    guard let pidNum = record(of: id)?[kCGWindowOwnerPID as String] as? Int else { return false }
    let pid = pid_t(pidNum)
    if AXIsProcessTrusted() {
      let app = AXUIElementCreateApplication(pid)
      AXUIElementSetMessagingTimeout(app, 0.3)
      if AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue) == .success { return true }
    }
    return NSRunningApplication(processIdentifier: pid)?.activate() ?? false
  }

  static func list(minimized wantMinimized: Bool = true) -> [WindowInfo] {
    guard let raw = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return [] }
    trace("window list: \(raw.count) entries")
    let front = frontmostPid()
    let ours = getppid()
    var seen = Set<CGWindowID>()
    var apps: [pid_t: NSRunningApplication?] = [:]
    var minimizedByPid: [pid_t: Set<CGWindowID>] = [:]
    var chromiumByPid: [pid_t: Bool] = [:]
    let axTrusted = AXIsProcessTrusted()
    var out: [WindowInfo] = []
    for w in raw {
      guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
            let idNum = w[kCGWindowNumber as String] as? Int,
            let pidNum = w[kCGWindowOwnerPID as String] as? Int,
            let boundsDict = w[kCGWindowBounds as String] as? NSDictionary,
            let bounds = CGRect(dictionaryRepresentation: boundsDict) else { continue }
      let id = CGWindowID(idNum)
      let pid = pid_t(pidNum)
      if pid == ours || pid == getpid() { continue }
      if bounds.width < 50 || bounds.height < 50 { continue }
      if let alpha = w[kCGWindowAlpha as String] as? Double, alpha == 0 { continue }
      if seen.contains(id) { continue }
      seen.insert(id)
      // Only apps a person would name: the Dock kind, not view services and helpers.
      let app: NSRunningApplication?
      if let known = apps[pid] { app = known } else {
        app = NSRunningApplication(processIdentifier: pid)
        apps[pid] = app
      }
      guard let app, app.activationPolicy == .regular else { continue }
      let name = app.localizedName ?? (w[kCGWindowOwnerName as String] as? String) ?? "pid \(pid)"
      let onScreen = (w[kCGWindowIsOnscreen as String] as? Bool) ?? false
      let title = (w[kCGWindowName as String] as? String) ?? ""
      var minimized = false
      if !onScreen && axTrusted && wantMinimized {
        if minimizedByPid[pid] == nil { minimizedByPid[pid] = AX.minimizedWindows(pid: pid) }
        minimized = minimizedByPid[pid]!.contains(id)
      }
      if chromiumByPid[pid] == nil { chromiumByPid[pid] = isChromium(app) }
      out.append(WindowInfo(
        id: id, pid: pid, app: name, bundleId: app.bundleIdentifier, title: title, bounds: bounds,
        onScreen: onScreen, minimized: minimized, appHidden: app.isHidden,
        frontmost: front != nil && front == pid, chromium: chromiumByPid[pid] ?? false))
    }
    trace("window list: \(out.count) kept")
    return out
  }

  /// Whether an app is built on Chromium: an Electron or Chrome-family framework
  /// in its bundle, or a known browser id.
  static func isChromium(_ app: NSRunningApplication) -> Bool {
    let knownIds = ["com.google.chrome", "org.chromium.chromium", "com.brave.browser", "com.microsoft.edgemac",
                    "com.vivaldi.vivaldi", "company.thebrowser.browser", "com.operasoftware.opera"]
    if let id = app.bundleIdentifier?.lowercased(), knownIds.contains(where: { id.hasPrefix($0) }) { return true }
    guard let url = app.bundleURL else { return false }
    let frameworks = url.appendingPathComponent("Contents/Frameworks")
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: frameworks.path) else { return false }
    return names.contains { $0.contains("Electron Framework") || $0.contains("Chromium Embedded") || $0.contains("Chrome Framework") }
  }

  /// The one-line explanation for a Chromium window that is not on screen.
  static func chromiumOffScreenNote(_ w: WindowInfo) -> String? {
    guard w.chromium, !w.onScreen else { return nil }
    return "\(w.app) is built on Chromium (Electron / Chrome family): it keeps the controls of a window only while that window is at least partly visible on the current Space. This one is not, so its picture is fine but snapshot will find (almost) nothing and clicks will find nothing pressable. Ask the user to bring the window onto the current Space — it can stay behind their other windows — and retry; do not keep trying meanwhile."
  }

  /// The listing the model reads: one window per line, front app first.
  static func describe(_ windows: [WindowInfo]) -> String {
    if windows.isEmpty { return "No windows are open." }
    let sorted = windows.sorted { a, b in
      if a.frontmost != b.frontmost { return a.frontmost }
      if a.onScreen != b.onScreen { return a.onScreen }
      return a.app.localizedCaseInsensitiveCompare(b.app) == .orderedAscending
    }
    var lines = ["Windows (id  app  \"title\"  where  size). select_window by window_id, or by app (+ title)."]
    for w in sorted {
      let place: String
      if w.appHidden { place = "app hidden" }
      else if w.minimized { place = "minimized" }
      else if w.onScreen { place = "on screen" }
      else { place = "other Space or covered" }
      let title = w.title.isEmpty ? "(untitled)" : "\"\(w.title)\""
      let size = "\(Int(w.bounds.width))x\(Int(w.bounds.height))"
      let hint = (w.chromium && !w.onScreen) ? "  · Chromium app: controls only while visible" : ""
      lines.append("\(w.id)  \(w.app)  \(title)  \(place)  \(size)\(hint)\(w.frontmost ? "  ← frontmost app" : "")")
    }
    return lines.joined(separator: "\n")
  }

  /// Resolve a `select-window` request against the live list.
  static func find(windowId: Int?, app: String?, title: String?) throws -> WindowInfo {
    // Selecting is the hot path of a mode switch: no minimized lookups across
    // every app, only (below) for the one app being picked among.
    let all = list(minimized: false)
    if let windowId {
      guard let w = all.first(where: { Int($0.id) == windowId }) else {
        throw HelperError("No window \(windowId) is open now. Run list_windows again.")
      }
      return w
    }
    guard let app, !app.isEmpty else { throw HelperError("select_window needs window_id, or app (and optionally title).") }
    let needle = app.lowercased()
    var candidates = all.filter {
      $0.app.lowercased() == needle || ($0.bundleId?.lowercased() == needle)
    }
    if candidates.isEmpty {
      candidates = all.filter { $0.app.lowercased().contains(needle) || ($0.bundleId?.lowercased().contains(needle) ?? false) }
    }
    if candidates.isEmpty {
      let names = Set(all.map(\.app)).sorted().joined(separator: ", ")
      throw HelperError("No running app called \"\(app)\" has a window. Apps with windows: \(names).")
    }
    if let title, !title.isEmpty {
      let t = title.lowercased()
      candidates = candidates.filter { $0.title.lowercased().contains(t) }
      if candidates.isEmpty { throw HelperError("\(app) has no window whose title contains \"\(title)\". Run list_windows to see its windows.") }
    }
    // The app's front window: on screen first, then not minimized, then the largest.
    var minimizedIds = Set<CGWindowID>()
    if AXIsProcessTrusted(), candidates.count > 1 {
      for pid in Set(candidates.filter { !$0.onScreen }.map(\.pid)) { minimizedIds.formUnion(AX.minimizedWindows(pid: pid)) }
    }
    return candidates.sorted { a, b in
      if a.onScreen != b.onScreen { return a.onScreen }
      let am = minimizedIds.contains(a.id), bm = minimizedIds.contains(b.id)
      if am != bm { return !am }
      return a.bounds.width * a.bounds.height > b.bounds.width * b.bounds.height
    }.first!
  }

  /// The window server's records of every window on every Space — one read,
  /// shared by everything an answer needs to know about windows.
  static func records() -> [[String: Any]] {
    (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
  }

  /// The window server's current record of one window, on any Space, or nil once it is gone.
  /// (`optionIncludingWindow` alone answers only for on-screen windows, so scan the full list.)
  static func record(of id: CGWindowID, in all: [[String: Any]]? = nil) -> [String: Any]? {
    (all ?? records()).first { ($0[kCGWindowNumber as String] as? Int).map { CGWindowID($0) } == id }
  }

  static func bounds(_ record: [String: Any]) -> CGRect? {
    guard let dict = record[kCGWindowBounds as String] as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: dict)
  }

  /// A window's current bounds (it may have moved since selection), or nil once it is gone.
  static func bounds(of id: CGWindowID) -> CGRect? {
    record(of: id).flatMap { bounds($0) }
  }

  /// An app's ordinary windows (layer 0, a real size, not transparent), as the
  /// window server lists them: what "the app opened a new window" is read from.
  static func appWindows(pid: pid_t, in all: [[String: Any]]) -> [(id: CGWindowID, title: String, bounds: CGRect)] {
    all.compactMap { w in
      guard (w[kCGWindowOwnerPID as String] as? Int).map({ pid_t($0) }) == pid,
            (w[kCGWindowLayer as String] as? Int) == 0,
            let n = w[kCGWindowNumber as String] as? Int,
            let b = bounds(w), b.width >= 50, b.height >= 50 else { return nil }
      if let alpha = w[kCGWindowAlpha as String] as? Double, alpha == 0 { return nil }
      return (CGWindowID(n), (w[kCGWindowName as String] as? String) ?? "", b)
    }
  }

  /// One window as a line of a note: `4567 "Import Media" 900x600`.
  static func brief(_ w: (id: CGWindowID, title: String, bounds: CGRect)) -> String {
    "\(w.id) \(w.title.isEmpty ? "(untitled)" : "\"\(w.title)\"") \(Int(w.bounds.width))x\(Int(w.bounds.height))"
  }

  static func isOnScreen(_ id: CGWindowID) -> Bool {
    (record(of: id)?[kCGWindowIsOnscreen as String] as? Bool) ?? false
  }

  static func title(of id: CGWindowID) -> String? {
    record(of: id)?[kCGWindowName as String] as? String
  }
}
