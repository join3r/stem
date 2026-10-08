import CoreGraphics
import Foundation

// stem-computer — the Mac half of Stem's computer-control persona.
//
// A long-lived child of the Stem desktop app that speaks one JSON object per
// line on stdin/stdout: the app sends {id, cmd, ...}, this answers {id, ok,
// ...}, and while a run is being watched it may also write an unsolicited
// {"event":"human-input"} the moment the person at the keyboard touches
// anything. Everything that needs a macOS permission — capturing the screen
// (Screen Recording), posting events (Accessibility), listening for the user's
// own input (Input Monitoring) — is attributed to the PARENT app by TCC, which
// is why this is a plain child process and never a launchd job or a separate
// app of its own.
//
// Coordinates on the wire are pixels of the LAST SCREENSHOT this helper
// produced (downscaled so the long side is at most MAX_SIDE); the helper keeps
// the scale and maps them to global display points itself. The model on the
// far end never sees points, backing pixels, or a Retina factor.
//
// Two modes. SCREEN (the default): the frame is the main display, clicks and
// keys are real session events, and the person's first touch of their own
// mouse or keyboard ends the run. WINDOW (after select-window): the frame is
// one window wherever it is (ScreenCaptureKit), clicks are hit-tests + AXPress
// and keys go to that process alone, so the app never comes forward and the
// person's own input is theirs — the run ends from the banner's Stop instead.

let stdoutLock = NSLock()

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
        let line = String(data: data, encoding: .utf8) else { return }
  stdoutLock.lock()
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
  stdoutLock.unlock()
}

/// stderr breadcrumbs when STEM_COMPUTER_TRACE is set; the desktop app forwards stderr to its log.
let tracing = ProcessInfo.processInfo.environment["STEM_COMPUTER_TRACE"] != nil
func trace(_ message: String) {
  guard tracing else { return }
  FileHandle.standardError.write(("[stem-computer] " + message + "\n").data(using: .utf8)!)
}

func fail(_ id: Any, _ message: String) {
  emit(["id": id, "ok": false, "error": message])
}

func number(_ v: Any?) -> Double? {
  if let d = v as? Double { return d }
  if let i = v as? Int { return Double(i) }
  if let n = v as? NSNumber { return n.doubleValue }
  return nil
}

let capture = Capture()
let input = Input(capture: capture)
let watch = Watch()
let recorder = Recorder()
/// The accessibility side of the selected app, made the first time a command
/// needs it (windowAX) and kept for the run: selecting another window of the
/// same app retargets it, leaving for the whole screen keeps it, and only
/// another app (or the run's end) puts the app's accessibility back.
var axCache: AX?

/// True in window mode: a window is selected and the run works through it.
var windowMode: Bool { capture.target != nil }

/// What every reply says about the mode: the selected window, or null.
func targetField() -> Any {
  capture.target?.summary ?? NSNull()
}

/// False while serving a command sent with "shot": false — a step in the
/// middle of a batch, whose frame nobody would look at.
var wantShot = true

/// The selected app's windows as last seen, to tell when an action made it
/// open another (a dialog, Import Media…); nil until the first look.
var knownWindows: (pid: pid_t, ids: Set<CGWindowID>)?

/// A line for the model when the selected app has opened a window since the
/// last look — it is a window of its own, which this window's picture will
/// never show, and the model can select it instead of leaving window mode.
func noteNewWindows(_ records: [[String: Any]]) -> String? {
  guard let t = capture.target else { return nil }
  let now = Windows.appWindows(pid: t.pid, in: records)
  defer { knownWindows = (t.pid, Set(now.map(\.id))) }
  guard let known = knownWindows, known.pid == t.pid else { return nil }
  let fresh = now.filter { !known.ids.contains($0.id) && $0.id != t.windowID }
  guard let first = fresh.first else { return nil }
  return "\(t.app) opened a new window: \(fresh.map(Windows.brief).joined(separator: "; ")). It is a separate window, not in this one's picture: select_window window_id \(first.id) to work in it (staying in window mode), rather than switching to the whole screen."
}

/// Every input command settles for a beat and then answers with a fresh frame,
/// so one round-trip carries both the effect and the evidence of it. Without a
/// picture wanted it still settles (the next step expects the app to have
/// reacted) and answers with its text, or "Done." — text is what the desktop
/// app accepts in place of a frame. In window mode one read of the window
/// server serves both the new-window check and the capture's bounds.
func answerWithScreenshot(_ id: Any, settleMs: Int = 300, text: String? = nil) {
  if settleMs > 0 { usleep(useconds_t(settleMs) * 1000) }
  let records = windowMode ? Windows.records() : nil
  let said = [text, records.flatMap(noteNewWindows)].compactMap { $0 }.joined(separator: "\n\n")
  if !wantShot {
    emit(["id": id, "ok": true, "text": said.isEmpty ? "Done." : said, "target": targetField()])
    return
  }
  do {
    let shot = try capture.screenshot(records: records)
    var reply: [String: Any] = ["id": id, "ok": true, "screenshot": shot, "cursor": input.cursorInScreenshot(), "target": targetField()]
    if !said.isEmpty { reply["text"] = said }
    emit(reply)
  } catch {
    fail(id, "\(error)")
  }
}

/// The window selected for this run, as listed; nil in screen mode.
var selected: WindowInfo?

/// Enter window mode on `info`, or leave it (nil). Cheap on purpose — the
/// model switches often: no accessibility work happens here (see windowAX).
func selectWindow(_ info: WindowInfo?) {
  selected = info
  knownWindows = nil
  if let info {
    if let a = axCache, a.pid != info.pid {
      a.release()
      axCache = nil
    }
    capture.target = Target(pid: info.pid, windowID: info.id, app: info.app, bundleId: info.bundleId, title: info.title, bounds: info.bounds)
    input.keyboardPid = info.pid
    watch.disarm()
  } else {
    capture.target = nil
    input.keyboardPid = nil
    // Stays disarmed: the first screen-mode input action arms the watch.
  }
}

/// The selected window's accessibility, woken on first need: the app is asked
/// to switch its tree on once per run, not on every select. Nil in screen mode.
func windowAX() -> AX? {
  guard let t = capture.target else { return nil }
  if let a = axCache, a.pid == t.pid {
    a.retarget(t.windowID)
    return a
  }
  axCache?.release()
  let a = AX(pid: t.pid, windowID: t.windowID)
  axCache = a
  return a
}

func screenOnly(_ what: String) -> HelperError {
  HelperError("\(what) is a screen-mode action (it moves the real mouse). Clear the window first: select_window with no arguments.")
}

/// A window-mode click: pixels of the window picture → global point → the control there.
func windowClick(_ ax: AX, x: Double?, y: Double?, button: String, count: Int) throws {
  guard let x, let y else { throw HelperError("In window mode a click needs a coordinate (there is no cursor to click at).") }
  try ax.click(at: try capture.toPoint(x: x, y: y), button: button, count: count)
}

while let line = readLine(strippingNewline: true) {
  guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
  guard let data = line.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    emit(["ok": false, "error": "unreadable command"])
    continue
  }
  let id: Any = obj["id"] ?? NSNull()
  let cmd = obj["cmd"] as? String ?? ""
  wantShot = (obj["shot"] as? Bool) ?? true
  trace("cmd \(cmd)")
  do {
    switch cmd {
    case "status":
      emit(["id": id, "ok": true, "status": Status.check()])
    case "request-access":
      emit(["id": id, "ok": true, "status": Status.request()])
    case "screenshot":
      wantShot = true
      answerWithScreenshot(id, settleMs: 0)
    case "cursor":
      if windowMode { throw screenOnly("cursor_position") }
      emit(["id": id, "ok": true, "cursor": input.cursorInScreenshot(), "target": targetField()])
    case "move":
      if windowMode { throw screenOnly("mouse_move") }
      watch.arm()
      try input.move(x: number(obj["x"]), y: number(obj["y"]))
      answerWithScreenshot(id)
    case "click":
      let button = obj["button"] as? String ?? "left"
      let count = Int(number(obj["count"]) ?? 1)
      if let ax = windowAX() {
        try windowClick(ax, x: number(obj["x"]), y: number(obj["y"]), button: button, count: count)
      } else {
        watch.arm()
        try input.click(x: number(obj["x"]), y: number(obj["y"]), button: button, count: count)
      }
      answerWithScreenshot(id)
    case "drag":
      if windowMode { throw screenOnly("left_click_drag") }
      watch.arm()
      let from = obj["from"] as? [String: Any] ?? [:]
      let to = obj["to"] as? [String: Any] ?? [:]
      try input.drag(fromX: number(from["x"]), fromY: number(from["y"]), toX: number(to["x"]), toY: number(to["y"]))
      answerWithScreenshot(id)
    case "scroll":
      let dir = obj["dir"] as? String ?? "down"
      let amount = Int(number(obj["amount"]) ?? 3)
      if let ax = windowAX() {
        guard let x = number(obj["x"]), let y = number(obj["y"]) else {
          throw HelperError("In window mode scroll needs a coordinate over the area to scroll.")
        }
        try ax.scroll(at: try capture.toPoint(x: x, y: y), direction: dir, amount: amount)
      } else {
        watch.arm()
        try input.scroll(x: number(obj["x"]), y: number(obj["y"]), direction: dir, amount: amount)
      }
      answerWithScreenshot(id)
    case "type":
      if let ax = windowAX(), ax.focusedElement() == nil {
        throw HelperError("Nothing in this window has keyboard focus. Click a field or `focus` its id first, then type.")
      }
      if !windowMode { watch.arm() }
      try input.type(text: obj["text"] as? String ?? "")
      answerWithScreenshot(id)
    case "key":
      if !windowMode { watch.arm() }
      try input.key(combo: obj["combo"] as? String ?? "")
      answerWithScreenshot(id)
    case "hold":
      if !windowMode { watch.arm() }
      try input.hold(combo: obj["combo"] as? String ?? "", ms: Int(number(obj["ms"]) ?? 0))
      answerWithScreenshot(id)
    case "wait":
      answerWithScreenshot(id, settleMs: Int(number(obj["ms"]) ?? 1000))
    case "zoom":
      let shot = try capture.zoom(
        x: number(obj["x"]) ?? 0, y: number(obj["y"]) ?? 0,
        w: number(obj["w"]) ?? 0, h: number(obj["h"]) ?? 0)
      emit(["id": id, "ok": true, "screenshot": shot, "cursor": input.cursorInScreenshot(), "target": targetField()])
    case "list-windows":
      emit(["id": id, "ok": true, "text": Windows.describe(Windows.list()), "target": targetField()])
    case "select-window":
      let windowId = number(obj["windowId"]).map { Int($0) }
      let app = (obj["app"] as? String)?.trimmingCharacters(in: .whitespaces)
      let title = (obj["title"] as? String)?.trimmingCharacters(in: .whitespaces)
      if windowId == nil && (app ?? "").isEmpty {
        selectWindow(nil)
        answerWithScreenshot(id, settleMs: 0)
      } else {
        let info = try Windows.find(windowId: windowId, app: app, title: title)
        selectWindow(info)
        // Prove the window can be captured before committing to it — and that
        // capture is the answer's picture; one read of the window server
        // serves it and the first look at the app's windows.
        let records = Windows.records()
        _ = noteNewWindows(records)
        let shot: [String: Any]
        do {
          shot = try capture.screenshot(records: records)
        } catch {
          selectWindow(nil)
          throw error
        }
        var reply: [String: Any] = ["id": id, "ok": true, "target": targetField()]
        if wantShot {
          reply["screenshot"] = shot
          reply["cursor"] = input.cursorInScreenshot()
        }
        let note = Windows.chromiumOffScreenNote(info)
        if let note { reply["text"] = note } else if !wantShot { reply["text"] = "Done." }
        emit(reply)
      }
    case "snapshot":
      guard let target = capture.target, let ax = windowAX() else {
        throw HelperError("snapshot lists the controls of a selected window; select_window first (or take a screenshot of the screen).")
      }
      // The picture first, so the ids' positions are in its pixels.
      let shot = try capture.screenshot()
      let depth = Int(number(obj["depth"]) ?? 12)
      var tree = try ax.snapshot(depth: max(1, min(depth, 30)), windowBounds: capture.target?.bounds ?? target.bounds, toPixel: { capture.pixel($0) }, ppp: capture.pointsPerPixel)
      if ax.lastSnapshotCount < 12, let selected, selected.chromium, !Windows.isOnScreen(selected.id) {
        tree += "\n\n" + (Windows.chromiumOffScreenNote(selected) ?? "")
      }
      // Without a picture wanted the frame above still set the geometry the ids' positions are in.
      var reply: [String: Any] = ["id": id, "ok": true, "text": tree, "target": targetField()]
      if wantShot {
        reply["screenshot"] = shot
        reply["cursor"] = input.cursorInScreenshot()
      }
      emit(reply)
    case "press":
      guard let ax = windowAX() else { throw HelperError("press acts on a snapshot id; select_window and snapshot first.") }
      try ax.press(id: Int(number(obj["element"]) ?? -1))
      answerWithScreenshot(id)
    case "focus":
      guard let ax = windowAX() else { throw HelperError("focus acts on a snapshot id; select_window and snapshot first.") }
      try ax.focus(id: Int(number(obj["element"]) ?? -1))
      answerWithScreenshot(id, settleMs: 100)
    case "menu":
      guard let ax = windowAX() else { throw HelperError("menu acts on a snapshot id; select_window and snapshot first.") }
      try ax.menu(id: Int(number(obj["element"]) ?? -1))
      answerWithScreenshot(id)
    case "set-value":
      guard let ax = windowAX() else { throw HelperError("set_value acts on a snapshot id; select_window and snapshot first.") }
      try ax.setValue(id: Int(number(obj["element"]) ?? -1), text: obj["text"] as? String ?? "")
      answerWithScreenshot(id)
    case "watch":
      let on = obj["on"] as? Bool ?? true
      if on {
        try watch.start { kind in emit(["event": "human-input", "kind": kind]) }
      } else {
        watch.stop()
      }
      emit(["id": id, "ok": true])
    case "record-start":
      try recorder.begin(shotsDir: obj["shotsDir"] as? String)
      emit(["id": id, "ok": true])
    case "record-pause":
      recorder.setPaused(obj["paused"] as? Bool ?? true)
      emit(["id": id, "ok": true])
    case "record-stop":
      recorder.end()
      emit(["id": id, "ok": true])
    case "stop":
      axCache?.release()
      watch.stop()
      recorder.end()
      emit(["id": id, "ok": true])
      exit(0)
    default:
      fail(id, "unknown command \"\(cmd)\"")
    }
  } catch {
    fail(id, "\(error)")
  }
}
axCache?.release()
watch.stop()
recorder.end()
