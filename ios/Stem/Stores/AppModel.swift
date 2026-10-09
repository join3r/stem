import Foundation
import Observation
import SwiftUI

enum AppTab: Hashable { case mail, chats, settings }

/// Where a notification tap or deep link wants to go.
enum Route: Hashable {
    case thread(String)
    case newChat
    case mail(String)
}

/// Root state: the pairing, and once paired the session every screen shares.
@MainActor @Observable
final class AppModel {
    private(set) var session: Session?
    var tab: AppTab = .chats
    var chatPath: [Route] = []
    var mailPath: [Route] = []
    /// A `stem://pair` link opened while the pair screen wasn't up yet.
    var pendingPairLink: (serverUrl: String, code: String)?
    /// The APNs token, kept until a session exists to register it with.
    @ObservationIgnored var pushToken: String?

    init() {
        if let creds = CredentialStore.load() { session = Session(creds: creds) }
    }

    func paired(_ creds: Credentials) {
        CredentialStore.save(creds)
        session?.close()
        session = Session(creds: creds)
        registerPush()
    }

    func unpair() {
        guard let s = session else { return }
        let client = s.client
        let id = s.client.creds.deviceId
        Task { try? await client.run("devices:revoke", [.string(id)]) }
        s.close()
        session = nil
        CredentialStore.clear()
        DraftStore.clearAll()
        chatPath = []
        mailPath = []
    }

    func registerPush() {
        guard let token = pushToken, let client = session?.client else { return }
        Task { try? await client.run("devices:registerPush", [.string(token), "ios"]) }
    }

    func open(_ route: Route) {
        switch route {
        case .mail:
            tab = .mail
            mailPath = [route]
        case .thread, .newChat:
            tab = .chats
            chatPath = [route]
        }
    }

    /// A `stem://pair` link never pairs by itself: anything can open one (a web
    /// page, a link in a reply), and pairing to a stranger's server would send
    /// them every message. It only fills in the pair screen, or asks first.
    func handle(url: URL) {
        guard let link = PairLink.parse(url) else { return }
        pendingPairLink = link
    }

    /// Already paired and the user confirmed the link: switch only once the
    /// new code is accepted, so a bad or expired link leaves the pairing alone.
    func switchServer(to link: (serverUrl: String, code: String)) async -> String? {
        if let problem = PairLink.validate(link.serverUrl) { return problem }
        guard let old = session else { return nil }
        do {
            let creds = try await StemClient.pair(serverUrl: link.serverUrl, code: link.code)
            let oldClient = old.client
            Task { try? await oldClient.run("devices:revoke", [.string(oldClient.creds.deviceId)]) }
            DraftStore.clearAll()
            chatPath = []
            mailPath = []
            paired(creds)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

}

/// Everything that lives as long as one pairing: the client, the stream,
/// and the shared lists (personas, models, approvals, composer prefs).
@MainActor @Observable
final class Session {
    let client: StemClient
    let connection: Connection
    let chats: ChatListStore
    let mail: MailStore
    let approvals: ApprovalStore
    private(set) var personas: [Persona] = []
    private(set) var models: [ModelSummary] = []
    private(set) var webSearch = false
    var prefs = ComposerPrefs.load()
    /// The chat on screen, so a push about it can stay quiet: its reply or
    /// approval card is already in front of the user.
    @ObservationIgnored var visibleThreadId: String?
    @ObservationIgnored private var sub: UUID?

    init(creds: Credentials) {
        client = StemClient(creds: creds)
        connection = Connection(client: client)
        chats = ChatListStore(client: client)
        mail = MailStore(client: client)
        approvals = ApprovalStore(client: client)
        sub = connection.subscribe { [weak self] e in self?.on(e) }
        chats.attach(connection)
        mail.attach(connection)
        approvals.attach(connection)
        connection.start()
    }

    func close() {
        connection.stop()
    }

    /// Personas a phone may start a chat as (the server refuses the others).
    var chatPersonas: [Persona] { personas.filter { $0.clients == true } }
    var mailPersonas: [Persona] { personas }

    func personaName(_ id: String) -> String {
        if id == "user" { return "You" }
        if id.hasPrefix("task:") { return "Scheduled task" }
        // An agent (`<roleId>~<name>`) reads as its name and its role.
        if let sep = id.range(of: "~", options: .backwards), sep.lowerBound > id.startIndex {
            let name = String(id[sep.upperBound...])
            let roleId = String(id[..<sep.lowerBound])
            if let role = personas.first(where: { $0.id == roleId })?.name { return "\(name) (\(role))" }
            return name
        }
        // Once the list has loaded, an id it lacks is a deleted persona; its raw id means nothing.
        return personas.first { $0.id == id }?.name ?? (personas.isEmpty ? id : "Deleted persona")
    }

    var currentModel: ModelSummary? {
        models.first { $0.id == prefs.model } ?? models.first { $0.isDefault } ?? models.first
    }

    private func on(_ e: StreamEvent) {
        switch e {
        case .snapshot, .resync:
            Task { await refreshShared() }
        case .push(let channel, _):
            if channel == "personas:changed" { Task { await loadPersonas() } }
        }
    }

    func refreshShared() async {
        await loadPersonas()
        if let m = try? await client.call("backend:listModels", as: [ModelSummary].self) {
            models = m
            if prefs.model == nil || !m.contains(where: { $0.id == prefs.model }) {
                if let s = try? await client.call("settings:get", as: ServerSettings.self) {
                    webSearch = s.webSearch.main
                    prefs.model = s.defaults?.model
                }
            }
        }
        if let s = try? await client.call("settings:get", as: ServerSettings.self) { webSearch = s.webSearch.main }
    }

    private func loadPersonas() async {
        if let p = try? await client.call("personas:list", as: [Persona].self) { personas = p }
    }

    // MARK: Composer settings shared with the desktop

    func selectModel(_ id: String) {
        guard let m = models.first(where: { $0.id == id }) else { return }
        prefs.model = id
        // Keep effort and speed to what the new model supports, like the desktop.
        if let e = prefs.effort, !m.supportedEfforts.contains(e) { prefs.effort = m.defaultEffort }
        if !m.hasFast { prefs.serviceTier = nil }
        prefs.save()
        Task { try? await client.run("settings:updateDefaults", [["model": .string(id)]]) }
    }

    func setWebSearch(_ on: Bool) {
        webSearch = on
        Task {
            if let s = try? await client.call("settings:updateWebSearch", [["main": .bool(on)]], as: ServerSettings.self) {
                webSearch = s.webSearch.main
            }
        }
    }

    /// The per-turn model settings, as the desktop composer sends them.
    func turnSettings() -> (model: String?, effort: String?, serviceTier: String?, format: String) {
        let m = currentModel
        var effort = prefs.effort
        if let m, let e = effort, !m.supportedEfforts.contains(e) { effort = nil }
        let tier = (m?.hasFast ?? false) ? prefs.serviceTier : nil
        return (m?.id, effort, tier, prefs.format)
    }
}

/// Model, effort, speed and format the composer sends with each turn.
/// Kept on the phone, like the desktop keeps them in localStorage.
struct ComposerPrefs: Codable, Equatable {
    var model: String?
    var effort: String?
    var serviceTier: String?
    var format = "mdx"

    private static let key = "stem.composerPrefs"

    static func load() -> ComposerPrefs {
        guard let d = UserDefaults.standard.data(forKey: key),
              let p = try? JSONDecoder().decode(ComposerPrefs.self, from: d) else { return ComposerPrefs() }
        return p
    }

    func save() {
        if let d = try? JSONEncoder().encode(self) { UserDefaults.standard.set(d, forKey: Self.key) }
    }
}

enum EffortLabel {
    static func text(_ e: String) -> String {
        ["off": "Off", "low": "Low", "medium": "Medium", "high": "High", "xhigh": "X-High", "minimal": "Minimal"][e] ?? e.capitalized
    }
}
