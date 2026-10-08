import CoreGraphics
import Foundation
import ScreenCaptureKit

/// A picture of one window wherever it is — another Space, behind everything,
/// minimized — through ScreenCaptureKit's desktop-independent window filter.
/// This is the one reason the helper needs macOS 14: SCScreenshotManager.
enum WindowCapture {
  /// Backing pixels per point of the display the window is (mostly) on.
  static func pixelScale(for bounds: CGRect) -> Double {
    var display = CGMainDisplayID()
    var count: UInt32 = 0
    var found: CGDirectDisplayID = 0
    if CGGetDisplaysWithRect(bounds, 1, &found, &count) == .success, count > 0 { display = found }
    guard let mode = CGDisplayCopyDisplayMode(display) else { return 2 }
    let points = CGDisplayBounds(display).width
    return points > 0 ? Double(mode.pixelWidth) / points : 2
  }

  /// Runs an async SCK call from the helper's synchronous command loop.
  private static func wait<T>(_ work: @escaping () async throws -> T) throws -> T {
    let done = DispatchSemaphore(value: 0)
    var result: Result<T, Error>?
    Task.detached {
      do { result = .success(try await work()) } catch { result = .failure(error) }
      done.signal()
    }
    if done.wait(timeout: .now() + 10) == .timedOut {
      throw HelperError("Capturing the window took too long.")
    }
    switch result! {
    case .success(let v): return v
    case .failure(let e): throw e
    }
  }

  /// The filter for the window last captured. Finding a window's SCWindow
  /// means SCShareableContent over every window on every Space — an XPC trip
  /// that enumerates the whole desktop and was the bulk of a window-mode
  /// answer's time when done per frame. The filter keeps naming the same
  /// window while it moves or resizes (the size is set per capture from its
  /// current bounds), so it is looked up once per selected window and again
  /// only when a capture through it fails.
  private static var cached: (windowID: CGWindowID, filter: SCContentFilter)?

  private static func filter(for windowID: CGWindowID) throws -> SCContentFilter {
    try wait {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
      guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
        throw HelperError("That window is gone. Run list_windows and select again.")
      }
      return SCContentFilter(desktopIndependentWindow: window)
    }
  }

  private static func shoot(_ filter: SCContentFilter, bounds: CGRect) throws -> CGImage {
    let config = SCStreamConfiguration()
    let scale = pixelScale(for: bounds)
    config.width = max(1, Int((bounds.width * scale).rounded()))
    config.height = max(1, Int((bounds.height * scale).rounded()))
    config.showsCursor = false
    config.ignoreShadowsSingleWindow = true
    config.captureResolution = .best
    let image: CGImage? = try wait {
      try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }
    guard let image else {
      throw HelperError("Could not capture the window. Stem needs Screen Recording access (System Settings → Privacy & Security → Screen Recording).")
    }
    return image
  }

  /// `bounds`: the window's current frame in global points, refreshed by the caller.
  static func capture(windowID: CGWindowID, bounds: CGRect) throws -> CGImage {
    if let hit = cached, hit.windowID == windowID {
      do { return try shoot(hit.filter, bounds: bounds) } catch {
        trace("cached window filter failed (\(error)); looking the window up again")
      }
    }
    cached = nil
    let fresh = try filter(for: windowID)
    let image = try shoot(fresh, bounds: bounds)
    cached = (windowID, fresh)
    return image
  }
}
