import Foundation

// Wire shapes from src/shared/types.ts. Only the fields the phone reads are
// declared; Codable skips the rest.

// MARK: Chats

struct ChatListResult: Decodable {
    var chats: [ChatSummary]
    var inbox: InboxState
}

struct ChatSummary: Decodable, Identifiable, Hashable {
    var threadId: String
    var title: String
    var subject: String?
    var preview: String?
    var `private`: Bool?
    var createdAt: Double
    /// Unix seconds (ms for rows created this session, see `Inbox.toMs`).
    var updatedAt: Double
    var id: String { threadId }
    var displayTitle: String {
        let s = subject?.isEmpty == false ? subject! : title
        return s.isEmpty ? "New chat" : s
    }
}

struct InboxEntry: Codable, Hashable {
    var readAt: Double?
    var forcedUnread: Bool?
    var archivedAt: Double?
    var snoozedAt: Double?
    var snoozedUntil: Double?
}

struct InboxState: Codable, Hashable {
    var baseline: Double = 0
    var entries: [String: InboxEntry] = [:]
}

struct ChatHistory: Decodable {
    var threadId: String
    var title: String
    var messages: [ChatMessage]
}

struct MessageAttachment: Codable, Hashable {
    var kind: String
    var name: String?
    var mime: String?
    var dataUrl: String?
    var imageId: String?
}

struct GeneratedImageRef: Codable, Hashable {
    var id: String
    var threadId: String
    var mime: String
    var width: Double?
    var height: Double?
    var prompt: String?
}

struct SourceRef: Codable, Hashable {
    var url: String
    var title: String?
}

struct ActivityItem: Codable, Hashable, Identifiable {
    var id: String
    var kind: String
    var type: String
    var name: String?
    var detail: String?
    var status: String
    var image: GeneratedImageRef?
}

struct MessageMeta: Codable, Hashable {
    var model: String?
    var effort: String?
}

struct ChatMessage: Codable, Hashable, Identifiable {
    var id: String
    var role: String
    var content: String
    var attachments: [MessageAttachment]?
    var turnAttachments: [TurnAttachment]?
    var meta: MessageMeta?
    var turnId: String?
    var runtimeTurnId: String?
    var activity: [ActivityItem]?
    var sources: [SourceRef]?
    var images: [GeneratedImageRef]?
    var createdAt: String?
    var sendFailed: Bool?

    // Client-only.
    /// Where this bubble's text starts inside the turn's accumulated reply,
    /// for applying offset deltas.
    var streamOffset: Int?
    /// Loaded from saved history: deltas for it are ignored until the item completes.
    var hydrated: Bool?
    /// Sent from this phone and not yet seen in history.
    var optimistic: Bool?

    enum CodingKeys: String, CodingKey {
        case id, role, content, attachments, turnAttachments, meta, turnId, runtimeTurnId, activity,
             sources, images, createdAt, sendFailed
    }
}

// MARK: Turns

struct TurnAttachment: Codable, Hashable {
    var name: String
    var path: String?
    var dataBase64: String?
    var mime: String?
}

struct StartTurnInput: Encodable {
    var input: String
    var threadId: String?
    var turnId: String?
    var model: String?
    var effort: String?
    var serviceTier: String?
    var format: String?
    var `private`: Bool?
    var attachments: [TurnAttachment]?
    var personaId: String?
}

struct StartTurnResult: Decodable {
    var threadId: String?
    var turnId: String?
    var handled: Bool?
    var canceled: Bool?
    var assistantMessage: String?
}

struct LiveTurnInfo: Decodable {
    var threadId: String
    var turnId: String?
}

struct MemoryNoteResult: Decodable {
    var saved: Bool
    var reason: String?
}

struct SkillLearnResult: Decodable {
    var ok: Bool
    var message: String
}

// MARK: Models + settings

struct ModelServiceTier: Decodable, Hashable { var id: String; var name: String }

struct ModelSummary: Decodable, Hashable, Identifiable {
    var id: String
    var displayName: String
    var description: String
    var provider: String
    var providerName: String
    var supportedEfforts: [String]
    var defaultEffort: String
    var serviceTiers: [ModelServiceTier]
    var isDefault: Bool
    var contextWindow: Double?
    var input: [String]?
    var hasFast: Bool { serviceTiers.contains { $0.id == "priority" } }
}

/// The slice of server settings the phone reads.
struct ServerSettings: Decodable {
    struct WebSearch: Decodable { var main: Bool }
    struct Defaults: Decodable { var model: String? }
    struct Instructions: Decodable { var main: String; var quickChat: String }
    var webSearch: WebSearch
    var defaults: Defaults?
    var customInstructions: Instructions?
}

// MARK: Personas

struct Persona: Decodable, Hashable, Identifiable {
    var id: String
    var name: String
    var clients: Bool?
    var builtin: Bool?
}

// MARK: Mail

struct MailListResult: Decodable {
    var conversations: [MailConversation]
    var items: [MailItem]
    var inbox: InboxState
}

struct MailConversation: Decodable, Hashable, Identifiable {
    var id: String
    var subject: String
    var participants: [String]
    var `private`: Bool?
    var status: String
    var updatedAt: Double
    var userUpdatedAt: Double
    var userSentAt: Double?
    var createdAt: Double
}

struct MailItem: Decodable, Hashable, Identifiable {
    var id: String
    var conversationId: String
    var from: String
    var to: [String]
    var body: String
    var at: Double
    var subject: String?
    var stale: Bool?
    var attachments: [MessageAttachment]?
    var images: [GeneratedImageRef]?
    var agentReplies: [String]?
}

struct MailComposeInput: Encodable {
    var to: [String]
    var subject: String?
    var body: String
    var attachments: [TurnAttachment]?
    var `private`: Bool?
}

// MARK: Approvals

struct ExecApprovalRequest: Decodable, Hashable {
    var id: String
    var threadId: String
    var command: String
    var cwd: String
    var prefixes: [String]
    var judgeVerdict: String?
    var judgeReason: String?
    var deviceLabel: String?
}

struct McpAdminProposal: Decodable, Hashable {
    var id: JSONValue
    var threadId: String
    var action: String
    var name: String?
    var input: JSONValue?
}

struct InstructionsProposal: Decodable, Hashable {
    var id: JSONValue
    var threadId: String
    var action: String
    var incomingText: String
    var suggestedSurface: String?
}

struct SkillProposal: Decodable, Hashable {
    var id: JSONValue
    var threadId: String
    var name: String
    var description: String
    var body: String
    var isPatch: Bool
}

struct ImageResult: Decodable { var dataUrl: String; var mime: String }
