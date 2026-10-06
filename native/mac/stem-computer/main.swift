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
/// The accessibility side of the selected window; nil in screen mode.
var ax: AX?

/// What every reply says about the mode: the selected window, or null.
func targetField() -> Any {
  capture.target?.summary ?? NSNull()
}

/// Every input command settles for a beat and then answers with a fresh frame,
/// so one round-trip carries both the effect and the evidence of it.
func answerWithScreenshot(_ id: Any, settleMs: Int = 300, text: String? = nil) {
  if settleMs > 0 { usleep(useconds_t(settleMs) * 1000) }
  do {
    let shot = try capture.screenshot()
    var reply: [String: Any] = ["id": id, "ok": true, "screenshot": shot, "cursor": input.cursorInScreenshot(), "target": targetField()]
    if let text { reply["text"] = text }
    emit(reply)
  } catch {
    fail(id, "\(error)")
  }
}

/// The window selected for this run, as listed; nil in screen mode.
var selected: WindowInfo?

/// Enter window mode on `info`, or leave it (nil).
func selectWindow(_ info: WindowInfo?) {
  ax?.release()
  selected = info
  if let info {
    capture.target = Target(pid: info.pid, windowID: info.id, app: info.app, bundleId: info.bundleId, title: info.title, bounds: info.bounds)
    ax = AX(pid: info.pid, windowID: info.id)
    input.keyboardPid = info.pid
    watch.disarm()
  } else {
    capture.target = nil
    ax = nil
    input.keyboardPid = nil
    // Stays disarmed: the first screen-mode input action arms the watch.
  }
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
  trace("cmd \(cmd)")
  do {
    switch cmd {
    case "status":
      emit(["id": id, "ok": true, "status": Status.check()])
    case "request-access":
      emit(["id": id, "ok": true, "status": Status.request()])
    case "screenshot":
      answerWithScreenshot(id, settleMs: 0)
    case "cursor":
      if ax != nil { throw screenOnly("cursor_position") }
      emit(["id": id, "ok": true, "cursor": input.cursorInScreenshot(), "target": targetField()])
    case "move":
      if ax != nil { throw screenOnly("mouse_move") }
      watch.arm()
      try input.move(x: number(obj["x"]), y: number(obj["y"]))
      answerWithScreenshot(id)
    case "click":
      let button = obj["button"] as? String ?? "left"
      let count = Int(number(obj["count"]) ?? 1)
      if let ax {
        try windowClick(ax, x: number(obj["x"]), y: number(obj["y"]), button: button, count: count)
      } else {
        watch.arm()
        try input.click(x: number(obj["x"]), y: number(obj["y"]), button: button, count: count)
      }
      answerWithScreenshot(id)
    case "drag":
      if ax != nil { throw screenOnly("left_click_drag") }
      watch.arm()
      let from = obj["from"] as? [String: Any] ?? [:]
      let to = obj["to"] as? [String: Any] ?? [:]
      try input.drag(fromX: number(from["x"]), fromY: number(from["y"]), toX: number(to["x"]), toY: number(to["y"]))
      answerWithScreenshot(id)
    case "scroll":
      let dir = obj["dir"] as? String ?? "down"
      let amount = Int(number(obj["amount"]) ?? 3)
      if let ax {
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
      if let ax, ax.focusedElement() == nil {
        throw HelperError("Nothing in this window has keyboard focus. Click a field or `focus` its id first, then type.")
      }
      if ax == nil { watch.arm() }
      try input.type(text: obj["text"] as? String ?? "")
      answerWithScreenshot(id)
    case "key":
      if ax == nil { watch.arm() }
      try input.key(combo: obj["combo"] as? String ?? "")
      answerWithScreenshot(id)
    case "hold":
      if ax == nil { watch.arm() }
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
        // Prove the window can be captured before committing to it.
        do {
          _ = try capture.screenshot()
        } catch {
          selectWindow(nil)
          throw error
        }
        answerWithScreenshot(id, settleMs: 0, text: Windows.chromiumOffScreenNote(info))
      }
    case "snapshot":
      guard let ax, let target = capture.target else {
        throw HelperError("snapshot lists the controls of a selected window; select_window first (or take a screenshot of the screen).")
      }
      // The picture first, so the ids' positions are in its pixels.
      let shot = try capture.screenshot()
      let depth = Int(number(obj["depth"]) ?? 12)
      var tree = try ax.snapshot(depth: max(1, min(depth, 30)), windowBounds: capture.target?.bounds ?? target.bounds, toPixel: { capture.pixel($0) }, ppp: capture.pointsPerPixel)
      if ax.lastSnapshotCount < 12, let selected, selected.chromium, !Windows.isOnScreen(selected.id) {
        tree += "\n\n" + (Windows.chromiumOffScreenNote(selected) ?? "")
      }
      emit(["id": id, "ok": true, "screenshot": shot, "cursor": input.cursorInScreenshot(), "text": tree, "target": targetField()])
    case "press":
      guard let ax else { throw HelperError("press acts on a snapshot id; select_window and snapshot first.") }
      try ax.press(id: Int(number(obj["element"]) ?? -1))
      answerWithScreenshot(id)
    case "focus":
      guard let ax else { throw HelperError("focus acts on a snapshot id; select_window and snapshot first.") }
      try ax.focus(id: Int(number(obj["element"]) ?? -1))
      answerWithScreenshot(id, settleMs: 100)
    case "menu":
      guard let ax else { throw HelperError("menu acts on a snapshot id; select_window and snapshot first.") }
      try ax.menu(id: Int(number(obj["element"]) ?? -1))
      answerWithScreenshot(id)
    case "set-value":
      guard let ax else { throw HelperError("set_value acts on a snapshot id; select_window and snapshot first.") }
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
      ax?.release()
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
ax?.release()
watch.stop()
recorder.end()
