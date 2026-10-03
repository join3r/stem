import Foundation
import Observation

@MainActor @Observable
final class MailStore {
    private(set) var mail = MailListResult(conversations: [], items: [], inbox: InboxState())
    private(set) var sections: [MailFolder: [MailConversation]] = [:]
    private(set) var loaded = false
    var error: String?

    private let client: StemClient

    init(client: StemClient) { self.client = client }

    func attach(_ c: Connection) {
        _ = c.subscribe { [weak self] e in
            guard let self else { return }
            switch e {
            case .snapshot, .resync: Task { await self.reload() }
            case .push(let channel, _): if channel == "mail:changed" { Task { await self.reload() } }
            }
        }
    }

    func reload() async {
        do {
            apply(try await client.call("mail:list", as: MailListResult.self))
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func apply(_ r: MailListResult) {
        mail = r
        sections = MailSections.build(r)
    }

    var unreadCount: Int {
        (sections[.inbox] ?? []).filter { MailSections.isUnread($0, mail) }.count
    }

    func conversation(_ id: String) -> MailConversation? { mail.conversations.first { $0.id == id } }

    func items(_ id: String) -> [MailItem] {
        mail.items.filter { $0.conversationId == id }.sorted { $0.at < $1.at }
    }

    // Every mutator answers with the fresh list.

    func compose(_ input: MailComposeInput) async throws -> MailListResult {
        let r = try await client.call("mail:compose", [.from(input)], as: MailListResult.self)
        apply(r)
        return r
    }

    func reply(_ id: String, body: String, attachments: [TurnAttachment]) async throws {
        var args: [JSONValue] = [.string(id), .string(body)]
        if !attachments.isEmpty { args.append(.from(attachments)) }
        apply(try await client.call("mail:reply", args, as: MailListResult.self))
    }

    func addParticipant(_ id: String, persona: String) async {
        await mutate("mail:addParticipant", [.string(id), .string(persona)])
    }

    func setRead(_ ids: [String], _ read: Bool) async { await mutate("mail:setRead", [.init(ids), .bool(read)]) }
    func setArchived(_ ids: [String], _ a: Bool) async { await mutate("mail:setArchived", [.init(ids), .bool(a)]) }
    func delete(_ id: String) async { await mutate("mail:delete", [.string(id)]) }

    func stop(_ id: String) async {
        do { try await client.run("mail:stop", [.string(id)]) } catch { self.error = error.localizedDescription }
        await reload()
    }

    private func mutate(_ channel: String, _ args: [JSONValue]) async {
        do { apply(try await client.call(channel, args, as: MailListResult.self)) }
        catch { self.error = error.localizedDescription }
    }
}
