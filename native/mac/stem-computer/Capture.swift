import CoreGraphics
import Foundation
import ImageIO

struct HelperError: Error, CustomStringConvertible {
  let description: String
  init(_ text: String) { description = text }
}

/// Longest side of a frame handed to the model, in pixels. Anthropic's
/// computer-use guidance: past ~1568 px the image is downscaled by the API
/// anyway, and coordinates the model returns then drift from what it saw.
let MAX_SIDE = 1568.0

/// Capture of the main display — or, once a run has selected a window, of that
/// window alone — downscaled, plus the geometry needed to turn screenshot
/// pixels back into global points. One coordinate space at a time: selecting
/// or clearing a window resets it, and the next screenshot re-derives it.
final class Capture {
  /// Size (in screenshot pixels) of the last frame produced, and the factor
  /// that maps one of its pixels to display points. Both are re-derived on
  /// every full screenshot; a zoom leaves them alone (a zoom is a magnified
  /// look, not a new coordinate space).
  private(set) var lastWidth = 0
  private(set) var lastHeight = 0
  private(set) var pointsPerPixel = 1.0
  /// Where the last frame's (0,0) sits in global points: the display's origin,
  /// or the window's top-left.
  private(set) var origin = CGPoint.zero

  /// The window this capture is of; nil = the whole main display.
  var target: Target? {
    didSet {
      // A new window (or none) is a new coordinate space; a refreshed title or
      // bounds of the same window is not.
      guard oldValue?.windowID != target?.windowID else { return }
      lastWidth = 0
      lastHeight = 0
      pointsPerPixel = 1.0
      origin = .zero
    }
  }

  private var displayID: CGDirectDisplayID { CGMainDisplayID() }

  /// The area the frame covers, in global points — refreshed for a window,
  /// which may have moved. One read of the window server for bounds and title
  /// (`records`, when the caller already has them).
  private func currentBounds(_ records: [[String: Any]]?) throws -> CGRect {
    guard let t = target else { return CGDisplayBounds(displayID) }
    let all = records ?? Windows.records()
    guard let record = Windows.record(of: t.windowID, in: all), let b = Windows.bounds(record) else {
      // A dialog that closed on the action just taken is the usual case: name
      // the app's windows left so the model can pick one without a full list.
      let left = Windows.appWindows(pid: t.pid, in: all).map(Windows.brief)
      let others = left.isEmpty ? "Run list_windows and select again." : "\(t.app)'s windows now: \(left.joined(separator: "; ")) — select_window one of them."
      throw HelperError("The selected window has closed (an action that closed it went through). \(others)")
    }
    target?.bounds = b
    if let title = record[kCGWindowName as String] as? String { target?.title = title }
    return b
  }

  private func grab() throws -> CGImage {
    if let t = target {
      return try WindowCapture.capture(windowID: t.windowID, bounds: t.bounds)
    }
    guard let image = CGDisplayCreateImage(displayID) else {
      throw HelperError("Could not capture the screen. Stem needs Screen Recording access (System Settings → Privacy & Security → Screen Recording).")
    }
    return image
  }

  /// A frame of the whole main display or the selected window: {jpegBase64, width, height, scale}.
  /// `records`: the window server's list, when the caller has just read it.
  func screenshot(records: [[String: Any]]? = nil) throws -> [String: Any] {
    let bounds = try currentBounds(records)
    let image = try grab()
    let longest = Double(max(image.width, image.height))
    let factor = longest > MAX_SIDE ? MAX_SIDE / longest : 1.0
    let width = max(1, Int((Double(image.width) * factor).rounded()))
    let height = max(1, Int((Double(image.height) * factor).rounded()))
    let scaled = try resize(image, width: width, height: height)
    lastWidth = width
    lastHeight = height
    pointsPerPixel = bounds.width / Double(width)
    origin = bounds.origin
    return [
      "jpegBase64": try jpeg(scaled),
      "width": width,
      "height": height,
      "scale": pointsPerPixel
    ]
  }

  /// A magnified look at a region given in LAST-SCREENSHOT pixels. The region is
  /// cropped from a fresh full-resolution capture and scaled to fit MAX_SIDE, so
  /// small text becomes legible; coordinates in the reply are NOT usable for
  /// clicking (the model is told so) — that is what the next screenshot is for.
  func zoom(x: Double, y: Double, w: Double, h: Double) throws -> [String: Any] {
    guard lastWidth > 0, lastHeight > 0 else {
      throw HelperError("Take a screenshot before zooming.")
    }
    guard w >= 1, h >= 1 else { throw HelperError("The zoom region needs a positive width and height.") }
    let image = try grab()
    let toBacking = Double(image.width) / Double(lastWidth)
    let rect = CGRect(
      x: max(0, x * toBacking), y: max(0, y * toBacking),
      width: min(Double(image.width), w * toBacking), height: min(Double(image.height), h * toBacking)
    ).integral
    guard rect.width >= 1, rect.height >= 1, let cropped = image.cropping(to: rect) else {
      throw HelperError("The zoom region lies outside the screen.")
    }
    let longest = Double(max(cropped.width, cropped.height))
    let factor = MAX_SIDE / longest
    let width = max(1, Int((Double(cropped.width) * factor).rounded()))
    let height = max(1, Int((Double(cropped.height) * factor).rounded()))
    let scaled = try resize(cropped, width: width, height: height)
    return [
      "jpegBase64": try jpeg(scaled),
      "width": width,
      "height": height,
      "zoomed": true
    ]
  }

  private func resize(_ image: CGImage, width: Int, height: Int) throws -> CGImage {
    if image.width == width && image.height == height { return image }
    guard let ctx = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else { throw HelperError("Could not allocate a drawing context.") }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let out = ctx.makeImage() else { throw HelperError("Could not scale the screenshot.") }
    return out
  }

  private func jpeg(_ image: CGImage) throws -> String {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else {
      throw HelperError("Could not encode the screenshot.")
    }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw HelperError("Could not encode the screenshot.") }
    return (data as Data).base64EncodedString()
  }

  /// Screenshot pixels → global points (CG coordinates, origin top-left).
  func toPoint(x: Double, y: Double) throws -> CGPoint {
    guard lastWidth > 0 else { throw HelperError("Take a screenshot before pointing at it.") }
    let px = min(max(x, 0), Double(lastWidth - 1))
    let py = min(max(y, 0), Double(lastHeight - 1))
    return CGPoint(x: origin.x + px * pointsPerPixel, y: origin.y + py * pointsPerPixel)
  }

  /// Global points → screenshot pixels, as a pair.
  func pixel(_ p: CGPoint) -> (Int, Int) {
    guard lastWidth > 0 else { return (Int(p.x), Int(p.y)) }
    return (Int(((p.x - origin.x) / pointsPerPixel).rounded()), Int(((p.y - origin.y) / pointsPerPixel).rounded()))
  }

  /// Global points → screenshot pixels (for reporting the cursor).
  func toPixel(_ p: CGPoint) -> [String: Any] {
    let (x, y) = pixel(p)
    return ["x": x, "y": y]
  }
}
