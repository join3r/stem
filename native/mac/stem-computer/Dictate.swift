import AVFoundation
import Foundation

// Dictation for the desktop composer: the dictate-* commands drive one
// Transcriber (Transcriber.swift) on the Mac's microphone. The desktop app
// spawns a helper of its own for this, separate from computer control's, and
// the microphone grant is attributed to the parent app by TCC like every other
// permission here (Stem.app's Info.plist carries the usage string).
//
// Replies arrive when the work is done, not in line: preparing can mean a
// model download, and a cancel must be readable meanwhile. While listening the
// helper writes {"event":"dictate-update","final":…,"volatile":…} on every
// change and {"event":"dictate-downloading"} before a first-use download.

actor Dictation {
  /// The live Transcriber, typed loosely so the actor itself needs no macOS 26.
  private var current: AnyObject?
  /// Bumped by every stop/cancel, so a start still preparing knows it was abandoned.
  private var generation = 0

  /// Called from the (blocking) stdin loop; the work runs on the actor.
  nonisolated func handle(_ cmd: String, _ id: Any, _ obj: [String: Any]) {
    let locale = obj["locale"] as? String
    let path = obj["path"] as? String ?? ""
    Task { await run(cmd, id, locale: locale, path: path) }
  }

  private func run(_ cmd: String, _ id: Any, locale localeId: String?, path: String) async {
    guard #available(macOS 26, *) else {
      fail(id, "\(TranscriberError.unavailable)")
      return
    }
    switch cmd {
    case "dictate-languages":
      let list = await Transcriber.languages().map { ["id": $0.id, "name": $0.name] }
      emit(["id": id, "ok": true, "languages": list, "current": Locale.current.identifier])
    case "dictate-start":
      await start(id, localeId: localeId)
    case "dictate-stop":
      generation += 1
      // Stopped before the model was ready: nothing was heard.
      guard let t = current as? Transcriber else { return emit(["id": id, "ok": true, "text": ""]) }
      current = nil
      do {
        emit(["id": id, "ok": true, "text": try await t.finish()])
      } catch {
        fail(id, error.localizedDescription)
      }
    case "dictate-cancel":
      generation += 1
      let t = current as? Transcriber
      current = nil
      await t?.cancel()
      emit(["id": id, "ok": true])
    case "dictate-file":
      do {
        let t = Transcriber()
        try await t.prepare(localeId: localeId)
        let text = try await t.transcribe(file: URL(fileURLWithPath: path))
        emit(["id": id, "ok": true, "text": text, "locale": t.locale.identifier])
      } catch {
        fail(id, error.localizedDescription)
      }
    default:
      fail(id, "unknown command \"\(cmd)\"")
    }
  }

  @available(macOS 26, *)
  private func start(_ id: Any, localeId: String?) async {
    await cancelCurrent()
    guard await AVCaptureDevice.requestAccess(for: .audio) else {
      return fail(id, "Stem is not allowed to use the microphone. Turn it on in System Settings → Privacy & Security → Microphone.")
    }
    let mine = generation
    let t = Transcriber()
    t.onDownloading = { emit(["event": "dictate-downloading"]) }
    t.onUpdate = { final, volatile in emit(["event": "dictate-update", "final": final, "volatile": volatile]) }
    do {
      try await t.prepare(localeId: localeId)
      guard generation == mine else {
        await t.cancel()
        return fail(id, "Dictation was stopped before it started.")
      }
      try t.listen()
      current = t
      emit(["id": id, "ok": true, "locale": t.locale.identifier])
    } catch {
      await t.cancel()
      fail(id, error.localizedDescription)
    }
  }

  private func cancelCurrent() async {
    guard #available(macOS 26, *), let t = current as? Transcriber else { return }
    current = nil
    await t.cancel()
  }

  /// Releases the microphone before the helper exits; blocks the caller up to a second.
  nonisolated func end() {
    let done = DispatchSemaphore(value: 0)
    Task {
      await cancelCurrent()
      done.signal()
    }
    _ = done.wait(timeout: .now() + 1)
  }
}
