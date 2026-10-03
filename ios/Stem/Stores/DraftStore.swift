import Foundation
import UIKit

/// A file picked for the composer, held locally until send uploads it.
struct DraftAttachment: Codable, Hashable, Identifiable {
    var id = UUID()
    var name: String
    var mime: String
    var file: String

    var url: URL { DraftStore.filesDir.appendingPathComponent(file) }
    var isImage: Bool { mime.hasPrefix("image/") }
    var data: Data? { try? Data(contentsOf: url) }

    /// Copies the bytes into the drafts folder so the draft survives a relaunch.
    static func make(data: Data, name: String, mime: String) -> DraftAttachment? {
        let file = UUID().uuidString + "-" + name.replacingOccurrences(of: "/", with: "_")
        do {
            try FileManager.default.createDirectory(at: DraftStore.filesDir, withIntermediateDirectories: true)
            try data.write(to: DraftStore.filesDir.appendingPathComponent(file))
        } catch { return nil }
        return DraftAttachment(name: name, mime: mime, file: file)
    }

    func delete() { try? FileManager.default.removeItem(at: url) }

    /// Inline preview for the optimistic bubble.
    var preview: MessageAttachment {
        if isImage, let d = data {
            return MessageAttachment(kind: "image", name: name, mime: mime, dataUrl: "data:\(mime);base64,\(d.base64EncodedString())")
        }
        return MessageAttachment(kind: "file", name: name, mime: mime)
    }
}

/// An unsent message: kept per chat, per mail conversation, and for the
/// new-chat and new-mail screens, on disk so it survives a relaunch.
struct Draft: Codable, Equatable {
    var text = ""
    var attachments: [DraftAttachment] = []
    var personaId: String?
    var isPrivate = false
    var to: [String] = []
    var subject = ""

    var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty && subject.isEmpty
    }
}

enum DraftStore {
    static var dir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("drafts", isDirectory: true)
    }
    static var filesDir: URL { dir.appendingPathComponent("files", isDirectory: true) }

    private static func url(_ key: String) -> URL {
        dir.appendingPathComponent(key.replacingOccurrences(of: ":", with: "_") + ".json")
    }

    static func load(_ key: String) -> Draft {
        guard let d = try? Data(contentsOf: url(key)), let draft = try? JSONDecoder().decode(Draft.self, from: d) else {
            return Draft()
        }
        return draft
    }

    static func save(_ key: String, _ draft: Draft) {
        if draft.isEmpty && draft.to.isEmpty {
            try? FileManager.default.removeItem(at: url(key))
            return
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let d = try? JSONEncoder().encode(draft) { try? d.write(to: url(key), options: .atomic) }
    }

    /// After a send: the draft and its files go.
    static func clear(_ key: String, _ draft: Draft) {
        draft.attachments.forEach { $0.delete() }
        try? FileManager.default.removeItem(at: url(key))
    }

    static func clearAll() { try? FileManager.default.removeItem(at: dir) }
}

enum Uploads {
    /// Uploads every attachment, converting HEIC photos to JPEG first.
    static func upload(_ items: [DraftAttachment], client: StemClient) async throws -> [TurnAttachment] {
        var out: [TurnAttachment] = []
        for a in items {
            guard var data = a.data else { throw StemError(message: "\(a.name) is no longer on this phone") }
            var name = a.name, mime = a.mime
            if mime == "image/heic" || mime == "image/heif", let img = UIImage(data: data), let jpg = img.jpegData(compressionQuality: 0.85) {
                data = jpg
                mime = "image/jpeg"
                name = (name as NSString).deletingPathExtension + ".jpg"
            }
            out.append(try await client.upload(data, name: name, mime: mime))
        }
        return out
    }

    /// Note images travel inline: the memory model reads the bytes directly.
    static func inline(_ items: [DraftAttachment]) -> [TurnAttachment] {
        items.compactMap { a in
            guard let d = a.data else { return nil }
            var data = d, mime = a.mime
            if let img = UIImage(data: d), d.count > 1_500_000 || mime.contains("heic") || mime.contains("heif"),
               let jpg = img.jpegData(compressionQuality: 0.8) {
                data = jpg; mime = "image/jpeg"
            }
            return TurnAttachment(name: a.name, path: nil, dataBase64: data.base64EncodedString(), mime: mime)
        }
    }
}

/// Decoded images by key, so scrolling a transcript doesn't re-decode or refetch.
@MainActor
final class ImageCache {
    static let shared = ImageCache()
    private var images: [String: UIImage] = [:]
    private var data: [String: Data] = [:]

    func image(dataUrl: String) -> UIImage? {
        if let i = images[dataUrl] { return i }
        guard let comma = dataUrl.firstIndex(of: ","),
              let d = Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...])),
              let img = UIImage(data: d) else { return nil }
        images[dataUrl] = img
        return img
    }

    func generated(_ ref: GeneratedImageRef, client: StemClient) async -> Data? {
        let key = "\(ref.threadId)/\(ref.id)"
        if let d = data[key] { return d }
        guard let r = try? await client.call("chats:image", [.string(ref.threadId), .string(ref.id)], as: ImageResult?.self),
              let comma = r.dataUrl.firstIndex(of: ","),
              let d = Data(base64Encoded: String(r.dataUrl[r.dataUrl.index(after: comma)...])) else { return nil }
        data[key] = d
        return d
    }
}
