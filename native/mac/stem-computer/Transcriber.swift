import AVFoundation
import Foundation
import Speech

// On-device speech to text through Apple's SpeechAnalyzer (macOS / iOS 26).
// Shared verbatim by the Mac helper's dictate mode (Dictate.swift) and the
// iPhone composer (ios/project.yml compiles this file into the app), so both
// pick a model, download it and stitch results the same way. Nothing is
// bundled: the model is the system's own, fetched once per language.
//
// Two transcribers, chosen by language. SpeechTranscriber is the newer,
// long-form model but knows ~45 languages; DictationTranscriber is the model
// behind the keyboard's mic and also covers the rest (Slovak, Czech, …), and
// every device where SpeechTranscriber is unavailable.

enum TranscriberError: LocalizedError, CustomStringConvertible {
  case unsupportedLocale(String)
  case noMicrophone
  case unavailable

  var description: String {
    switch self {
    case .unsupportedLocale(let id): return "Dictation does not support \(id) on this device."
    case .noMicrophone: return "No microphone is available."
    case .unavailable: return "Dictation needs macOS or iOS 26."
    }
  }

  var errorDescription: String? { description }
}

/// A language dictation can take, for a picker.
struct DictationLanguage: Hashable {
  let id: String
  let name: String
}

@available(macOS 26, iOS 26, *)
final class Transcriber: @unchecked Sendable {
  /// Every language either model knows, named in the person's own language.
  static func languages() async -> [DictationLanguage] {
    var ids = SpeechTranscriber.isAvailable ? Set(await SpeechTranscriber.supportedLocales.map(\.identifier)) : []
    ids.formUnion(await DictationTranscriber.supportedLocales.map(\.identifier))
    return ids
      .map { DictationLanguage(id: $0, name: Locale.current.localizedString(forIdentifier: $0) ?? $0) }
      .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
  }

  /// The settled text so far, and the tail the model may still revise.
  var onUpdate: ((_ final: String, _ volatile: String) -> Void)?
  /// The language's model is being downloaded (first use only).
  var onDownloading: (() -> Void)?

  private(set) var locale = Locale.current
  private var module: (any SpeechModule)?
  private var analyzer: SpeechAnalyzer?
  private var feed: AsyncStream<AnalyzerInput>.Continuation?
  private var results: Task<Void, Error>?
  private var format: AVAudioFormat?
  private var converter: AVAudioConverter?
  private var engine: AVAudioEngine?
  private var settled = ""
  private var pending = ""

  var text: String { settled + pending }

  /// Readies the model for `localeId` (nil = the device's language), downloading it if needed.
  func prepare(localeId: String?) async throws {
    let wanted = localeId.map(Locale.init(identifier:)) ?? Locale.current
    // SpeechTranscriber needs hardware some devices (and the Simulator) lack.
    if SpeechTranscriber.isAvailable, let l = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) {
      locale = l
      module = SpeechTranscriber(locale: l, preset: .progressiveTranscription)
    } else if let l = await DictationTranscriber.supportedLocale(equivalentTo: wanted) {
      locale = l
      module = DictationTranscriber(locale: l, preset: .progressiveLongDictation)
    } else {
      throw TranscriberError.unsupportedLocale(wanted.identifier)
    }
    let modules = [module!]
    try await reserve(locale)
    if let install = try await AssetInventory.assetInstallationRequest(supporting: modules) {
      onDownloading?()
      try await install.downloadAndInstall()
    }
    format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules)
    let analyzer = SpeechAnalyzer(modules: modules)
    try await analyzer.prepareToAnalyze(in: format)
    self.analyzer = analyzer
    results = Task { [weak self] in try await self?.collect() }
    let (stream, feed) = AsyncStream<AnalyzerInput>.makeStream()
    self.feed = feed
    try await analyzer.start(inputSequence: stream)
  }

  /// An app may only use the languages it has reserved, and only a few at once:
  /// a new one makes room by giving up the others.
  private func reserve(_ locale: Locale) async throws {
    let held = await AssetInventory.reservedLocales
    if held.contains(where: { $0.identifier == locale.identifier }) { return }
    if held.count >= AssetInventory.maximumReservedLocales {
      for old in held { await AssetInventory.release(reservedLocale: old) }
    }
    try await AssetInventory.reserve(locale: locale)
  }

  private func collect() async throws {
    if let m = module as? SpeechTranscriber {
      for try await r in m.results { take(String(r.text.characters), final: r.isFinal) }
    } else if let m = module as? DictationTranscriber {
      for try await r in m.results { take(String(r.text.characters), final: r.isFinal) }
    }
  }

  private func take(_ chunk: String, final: Bool) {
    if final {
      settled += chunk
      pending = ""
    } else {
      pending = chunk
    }
    onUpdate?(settled, pending)
  }

  /// Starts feeding the microphone. Call after prepare (and, on iOS, after the audio session is active).
  func listen() throws {
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let inFormat = input.outputFormat(forBus: 0)
    guard inFormat.sampleRate > 0, inFormat.channelCount > 0 else { throw TranscriberError.noMicrophone }
    input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buffer, _ in
      self?.push(buffer)
    }
    engine.prepare()
    try engine.start()
    self.engine = engine
  }

  /// Feeds a recording instead of the microphone, then finishes: the helper's self-test path.
  func transcribe(file url: URL) async throws -> String {
    let file = try AVAudioFile(forReading: url)
    while file.framePosition < file.length,
          let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 8192) {
      try file.read(into: buffer)
      push(buffer)
    }
    return try await finish()
  }

  private func push(_ buffer: AVAudioPCMBuffer) {
    guard let out = convert(buffer) else { return }
    feed?.yield(AnalyzerInput(buffer: out))
  }

  private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let format, buffer.format != format else { return buffer }
    if converter == nil || converter!.inputFormat != buffer.format {
      converter = AVAudioConverter(from: buffer.format, to: format)
      converter?.primeMethod = .none
    }
    guard let converter else { return nil }
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    var fed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if fed {
        status.pointee = .noDataNow
        return nil
      }
      fed = true
      status.pointee = .haveData
      return buffer
    }
    return error == nil && out.frameLength > 0 ? out : nil
  }

  private func stopMic() {
    engine?.inputNode.removeTap(onBus: 0)
    engine?.stop()
    engine = nil
  }

  /// Stops listening and waits for the model to settle what it heard.
  func finish() async throws -> String {
    stopMic()
    feed?.finish()
    try await analyzer?.finalizeAndFinishThroughEndOfInput()
    try await results?.value
    return text
  }

  /// Drops everything at once.
  func cancel() async {
    stopMic()
    feed?.finish()
    results?.cancel()
    await analyzer?.cancelAndFinishNow()
  }
}
