import Foundation
import Observation

@MainActor @Observable
final class ChatListStore {
    private(set) var chats: [ChatSummary] = []
    private(set) var inbox = InboxState()
    private(set) var loaded = false
    var error: String?

    private let client: StemClient
    @ObservationIgnored private weak var connection: Connection?
    @ObservationIgnored private var debounce: Task<Void, Never>?

    init(client: StemClient) { self.client = client }

    func attach(_ c: Connection) {
        connection = c
        _ = c.subscribe { [weak self] e in self?.on(e) }
    }

    private func on(_ e: StreamEvent) {
        switch e {
        case .snapshot, .resync:
            scheduleReload()
        case .push(let channel, let payload):
            if channel == "chats:changed" { scheduleReload() }
            if channel == "backend:event", let m = payload["method"]?.stringValue,
               ["turn/completed", "turn/failed", "turn/aborted"].contains(m) { scheduleReload() }
        }
    }

    private func scheduleReload() {
        debounce?.cancel()
        debounce = Task {
            try? await Task.sleep(for: .milliseconds(300))
            if !Task.isCancelled { await reload() }
        }
    }

    func reload() async {
        do {
            apply(try await client.call("chats:list", as: ChatListResult.self))
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func apply(_ r: ChatListResult) {
        chats = r.chats.sorted { Inbox.toMs($0.updatedAt) > Inbox.toMs($1.updatedAt) }
        inbox = r.inbox
    }

    func isUnread(_ c: ChatSummary) -> Bool {
        Inbox.isUnread(id: c.threadId, updatedAt: c.updatedAt, state: inbox,
                       turnRunning: connection?.liveTurns[c.threadId] != nil)
    }

    func isArchived(_ c: ChatSummary) -> Bool {
        Inbox.placement(id: c.threadId, updatedAt: c.updatedAt, state: inbox) != .inbox
    }

    func setRead(_ ids: [String], _ read: Bool) async {
        await mutate("inbox:setRead", [.init(ids), .bool(read)])
    }

    func setArchived(_ ids: [String], _ archived: Bool) async {
        await mutate("inbox:setArchived", [.init(ids), .bool(archived)])
    }

    func delete(_ id: String) async {
        chats.removeAll { $0.threadId == id }
        do { try await client.run("chats:delete", [.string(id)]) } catch { self.error = error.localizedDescription }
        await reload()
    }

    private func mutate(_ channel: String, _ args: [JSONValue]) async {
        do { apply(try await client.call(channel, args, as: ChatListResult.self)) }
        catch { self.error = error.localizedDescription }
    }
}
