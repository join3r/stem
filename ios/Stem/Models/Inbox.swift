import Foundation

/// Port of src/shared/inbox.ts — archive and snooze are timestamps, so new
/// activity lifts a row out of the archive by itself.
enum Inbox {
    enum Placement { case inbox, snoozed, archived }

    static func toMs(_ ts: Double) -> Double { ts < 1e12 ? ts * 1000 : ts }

    static func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

    static func placement(id: String, updatedAt: Double, state: InboxState, now: Double = nowMs()) -> Placement {
        guard let e = state.entries[id] else { return .inbox }
        let updated = toMs(updatedAt)
        if let until = e.snoozedUntil, let at = e.snoozedAt, now < until, updated <= at { return .snoozed }
        if let archived = e.archivedAt, updated <= archived { return .archived }
        return .inbox
    }

    static func isUnread(id: String, updatedAt: Double, state: InboxState, turnRunning: Bool = false) -> Bool {
        let e = state.entries[id]
        if e?.forcedUnread == true { return true }
        if turnRunning { return false }
        return toMs(updatedAt) > max(e?.readAt ?? 0, state.baseline)
    }
}

enum MailFolder: String, CaseIterable, Identifiable {
    case inbox = "Inbox", sent = "Sent", snoozed = "Snoozed", archived = "Archived"
    var id: String { rawValue }
}

/// Port of mobile/src/mail/list.ts: internal persona traffic may reorder a
/// conversation but can't make it unread or bring it back from the archive.
enum MailSections {
    static func build(_ mail: MailListResult, now: Double = Inbox.nowMs()) -> [MailFolder: [MailConversation]] {
        var out: [MailFolder: [MailConversation]] = [.inbox: [], .sent: [], .snoozed: [], .archived: []]
        var lastSent: [String: Double] = [:]
        for item in mail.items where item.from == "user" {
            lastSent[item.conversationId] = max(lastSent[item.conversationId] ?? 0, item.at)
        }
        for c in mail.conversations {
            switch Inbox.placement(id: c.id, updatedAt: c.userUpdatedAt, state: mail.inbox, now: now) {
            case .snoozed: out[.snoozed]!.append(c)
            case .archived: out[.archived]!.append(c)
            case .inbox:
                if c.userUpdatedAt > (c.userSentAt ?? 0) || c.status == "aborted" { out[.inbox]!.append(c) }
            }
            if lastSent[c.id] != nil { out[.sent]!.append(c) }
        }
        out[.inbox]!.sort { $0.updatedAt > $1.updatedAt }
        out[.archived]!.sort { $0.updatedAt > $1.updatedAt }
        out[.snoozed]!.sort {
            (mail.inbox.entries[$0.id]?.snoozedUntil ?? 0) < (mail.inbox.entries[$1.id]?.snoozedUntil ?? 0)
        }
        out[.sent]!.sort { lastSent[$0.id]! > lastSent[$1.id]! }
        return out
    }

    static func isUnread(_ c: MailConversation, _ mail: MailListResult) -> Bool {
        Inbox.isUnread(id: c.id, updatedAt: c.userUpdatedAt, state: mail.inbox)
    }

    /// The newest item the user sent or received, for the row preview.
    static func preview(_ mail: MailListResult, _ id: String) -> MailItem? {
        mail.items
            .filter { $0.conversationId == id && ($0.to.contains("user") || $0.from == "user") }
            .max { $0.at < $1.at }
    }

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "working": return "Working"
        case "awaiting-user": return "Waiting for you"
        case "failed": return "Failed"
        case "aborted": return "Stopped"
        default: return ""
        }
    }
}
