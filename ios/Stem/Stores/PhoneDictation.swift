import AVFoundation
import Foundation
import Observation

/// Dictation into the composer through Apple's on-device SpeechAnalyzer
/// (Transcriber.swift, shared with the Mac helper). Words land in the field as
/// they are heard: what was typed before stays, and the live tail is rewritten
/// until the model settles it. iOS 26 and later; older phones get no mic.
@MainActor
@Observable
final class PhoneDictation {
  enum Phase { case idle, starting, downloading, listening, stopping }

  static var supported: Bool {
    if #available(iOS 26, *) { return true }
    return false
  }

  private static let localeKey = "dictationLocale"
  /// The chosen language, nil for the phone's own.
  static var locale: String? {
    get { UserDefaults.standard.string(forKey: localeKey) }
    set { UserDefaults.standard.set(newValue, forKey: localeKey) }
  }

  private(set) var phase: Phase = .idle
  private(set) var error: String?
  /// Every language either model knows, loaded on first ask.
  private(set) var languages: [DictationLanguage] = []

  /// The text this last wrote, so the composer can tell its own update from a hand edit.
  private(set) var lastWritten: String?
  private var transcriber: AnyObject?
  private var base = ""
  private var apply: ((String) -> Void)?

  var active: Bool { phase != .idle }

  func loadLanguages() async {
    guard languages.isEmpty, #available(iOS 26, *) else { return }
    languages = await Transcriber.languages()
  }

  func toggle(current: String, apply: @escaping (String) -> Void) {
    if phase == .idle {
      Task { await start(current: current, apply: apply) }
    } else if phase == .listening {
      Task { await stop() }
    } else {
      freeze()
    }
  }

  private func write(_ heard: String) {
    let text = base + heard.drop { $0 == " " }
    lastWritten = text
    apply?(text)
  }

  private func start(current: String, apply: @escaping (String) -> Void) async {
    guard #available(iOS 26, *) else { return }
    error = nil
    phase = .starting
    base = current.isEmpty || current.last?.isWhitespace == true ? current : current + " "
    self.apply = apply
    guard await AVAudioApplication.requestRecordPermission() else {
      fail("Stem is not allowed to use the microphone. Turn it on in Settings → Stem.")
      return
    }
    let t = Transcriber()
    transcriber = t
    t.onDownloading = { [weak self] in
      Task { @MainActor in if self?.phase == .starting { self?.phase = .downloading } }
    }
    t.onUpdate = { [weak self, weak t] final, volatile in
      Task { @MainActor in
        guard let self, let t, self.transcriber === t, self.phase == .listening else { return }
        self.write(final + volatile)
      }
    }
    do {
      try await t.prepare(localeId: Self.locale)
      guard transcriber === t else { return await t.cancel() }
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .measurement, options: .duckOthers)
      try session.setActive(true, options: .notifyOthersOnDeactivation)
      try t.listen()
      phase = .listening
    } catch {
      await t.cancel()
      if transcriber === t { fail(error.localizedDescription) }
    }
  }

  /// Stops listening and writes the settled text.
  func stop() async {
    guard #available(iOS 26, *), let t = transcriber as? Transcriber else { return }
    phase = .stopping
    do {
      let text = try await t.finish()
      if transcriber === t, !text.isEmpty { write(text) }
    } catch {
      if transcriber === t { self.error = error.localizedDescription }
    }
    if transcriber === t { release() }
  }

  /// Drops the microphone and leaves the field as it reads now (a send, or a hand edit).
  func freeze() {
    guard phase != .idle else { return }
    if #available(iOS 26, *), let t = transcriber as? Transcriber {
      Task { await t.cancel() }
    }
    release()
  }

  private func fail(_ message: String) {
    error = message
    release()
  }

  private func release() {
    transcriber = nil
    apply = nil
    lastWritten = nil
    phase = .idle
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}
