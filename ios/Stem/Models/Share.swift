import Foundation

// Public share links (docs/public-share-design.md). Mirrors src/shared/share.ts;
// the server builds, encrypts and uploads, the phone only asks and shows.

enum ShareSource: Hashable {
    case chat(threadId: String)
    case mail(conversationId: String)

    var json: JSONValue {
        switch self {
        case .chat(let id): return .object(["kind": .string("chat"), "threadId": .string(id)])
        case .mail(let id): return .object(["kind": .string("mail"), "conversationId": .string(id)])
        }
    }
    var isMail: Bool { if case .mail = self { return true }; return false }
}

/// What the user picked Share on: the source and the answer (turn or mail item id).
struct ShareRequest: Identifiable, Hashable {
    let source: ShareSource
    let anchorId: String
    var id: String { anchorId }
}

enum ShareScope: String, CaseIterable, Identifiable {
    case thread, pair, answer
    var id: String { rawValue }
}

struct ShareImage: Decodable, Hashable { var mime: String; var dataUrl: String; var alt: String? }

struct ShareMessage: Decodable, Hashable {
    var role: String
    var author: String?
    var text: String
    var model: String?
    var images: [ShareImage]?
}

struct ShareSnapshot: Decodable, Hashable {
    var kind: String
    var title: String
    var messages: [ShareMessage]
}

struct ShareCard: Codable, Hashable { var title: String; var description: String }

struct ShareDraftPreview: Decodable, Hashable {
    var snapshot: ShareSnapshot
    var bytes: Int
    var omittedAttachments: Int
    /// Absent from servers before link previews.
    var card: ShareCard?
    /// The snapshot "Create link" publishes; absent from older servers.
    var draftId: String?
}

struct SharedLink: Decodable, Hashable, Identifiable {
    var id: String
    var url: String
    var title: String
    var expiresAt: Double
}

struct ShareStatus: Decodable, Hashable {
    var available: Bool
    var code: String?
    var message: String?
    var address: String?
}

enum ShareLimits {
    static let ttlChoices = [30, 7, 1]
    static let cardTitleMax = 120
    static let cardDescMax = 300
}
