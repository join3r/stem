import Foundation
import Observation

@MainActor @Observable
final class ChatListStore {
    private(set) var chats: [ChatSummary] = []
    private(set) var folders: [ChatFolder] = []
    private(set) var inbox = InboxState()
    private(set) var loaded = false
    var error: String?

    private let client: StemClient
    @ObservationIgnored private weak var connection: Connection?
    @ObservationIgnored private var debounce: Task<Void, Never>?

    init(client: StemClient) {
        self.client = client
        // The last list this pairing saw, so a cold start shows chats at once
        // instead of a spinner while a few hundred KB come over a phone link.
        if client.demo == nil, let data = try? Data(contentsOf: Self.cacheURL(client.creds.deviceId)),
           let cached = try? JSONDecoder().decode(ChatListResult.self, from: data) {
            apply(cached)
            loaded = true
        }
    }

    private static var cacheDir: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("chat-list", isDirectory: true)
    }

    private static func cacheURL(_ deviceId: String) -> URL {
        cacheDir.appendingPathComponent("\(deviceId).json")
    }

    /// Unpairing forgets the list along with the pairing.
    static func clearCache() { try? FileManager.default.removeItem(at: cacheDir) }

    private func save(_ r: ChatListResult) {
        guard client.demo == nil else { return }
        let url = Self.cacheURL(client.creds.deviceId)
        Task.detached(priority: .utility) {
            guard let data = try? JSONEncoder().encode(r) else { return }
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

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
            let r = try await client.call("chats:list", as: ChatListResult.self)
            apply(r)
            save(r)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func apply(_ r: ChatListResult) {
        chats = r.chats.sorted { Inbox.toMs($0.updatedAt) > Inbox.toMs($1.updatedAt) }
        folders = r.folders ?? []
        inbox = r.inbox
    }

    // MARK: Folders

    func childFolders(of parentId: String?) -> [ChatFolder] {
        folders.filter { $0.parentId == parentId }.sorted { $0.order < $1.order }
    }

    func folder(_ id: String?) -> ChatFolder? {
        id.flatMap { id in folders.first { $0.id == id } }
    }

    /// The folder and every folder under it.
    func subtree(_ id: String) -> Set<String> {
        var out: Set<String> = [id]
        var frontier = [id]
        while let next = frontier.popLast() {
            for f in folders where f.parentId == next && !out.contains(f.id) {
                out.insert(f.id)
                frontier.append(f.id)
            }
        }
        return out
    }

    /// Unread chats anywhere under the folder, so a bold row can't hide inside it.
    func unreadCount(in id: String) -> Int {
        let ids = subtree(id)
        return chats.filter { c in c.folderId.map(ids.contains) == true && !isArchived(c) && isUnread(c) }.count
    }

    /// Every folder in tree order with its depth, for the Move picker.
    var folderTree: [(folder: ChatFolder, depth: Int)] {
        var out: [(ChatFolder, Int)] = []
        func walk(_ parent: String?, _ depth: Int) {
            for f in childFolders(of: parent) {
                out.append((f, depth))
                walk(f.id, depth + 1)
            }
        }
        walk(nil, 0)
        return out
    }

    func moveChats(_ ids: [String], to folderId: String?) async {
        for id in ids {
            if let i = chats.firstIndex(where: { $0.threadId == id }) { chats[i].folderId = folderId }
        }
        for id in ids { await mutate("chats:setFolder", [.string(id), folderId.map(JSONValue.string) ?? .null]) }
    }

    /// Answers the new folder's id, told apart from the folders that were there before.
    @discardableResult
    func createFolder(_ name: String, in parentId: String?) async -> String? {
        let before = Set(folders.map(\.id))
        await mutate("folders:create", [.string(name), parentId.map(JSONValue.string) ?? .null])
        return folders.first { !before.contains($0.id) }?.id
    }

    func renameFolder(_ id: String, _ name: String) async {
        await mutate("folders:rename", [.string(id), .string(name)])
    }

    /// Its chats and subfolders move up to its parent; nothing is deleted with it.
    func deleteFolder(_ id: String) async {
        await mutate("folders:delete", [.string(id)])
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
        do {
            let r = try await client.call(channel, args, as: ChatListResult.self)
            apply(r)
            save(r)
        }
        catch { self.error = error.localizedDescription }
    }
}
