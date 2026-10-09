import SwiftUI
import UserNotifications

@main
struct StemApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                // Links inside replies and mail are model-written: only web,
                // mail and phone links open (iOS asks before it dials); app
                // schemes (stem://, …) are dropped.
                .environment(\.openURL, OpenURLAction { url in
                    ["http", "https", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
                })
                .onAppear { delegate.app = app }
                .onOpenURL { app.handle(url: $0) }
        }
        .onChange(of: phase) { _, p in
            guard let s = app.session else { return }
            switch p {
            case .active: s.connection.foreground()
            case .background: s.connection.stop()
            default: break
            }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-mdxGallery") {
            MdxGallery()
        } else {
            content
        }
        #else
        content
        #endif
    }

    @ViewBuilder private var content: some View {
        if let session = app.session {
            MainTabs()
                .environment(session)
                .id(ObjectIdentifier(session))
        } else {
            PairView()
        }
    }
}

struct MainTabs: View {
    @Environment(AppModel.self) private var app
    @Environment(Session.self) private var session
    @State private var switchError: String?

    var body: some View {
        @Bindable var app = app
        TabView(selection: $app.tab) {
            Tab("Mail", systemImage: "tray", value: AppTab.mail) { MailListView() }
                .badge(session.mail.unreadCount)
            Tab("Chats", systemImage: "bubble.left.and.bubble.right", value: AppTab.chats) { ChatListView() }
                .badge(session.approvals.queue.count)
            Tab("Settings", systemImage: "gearshape", value: AppTab.settings) { SettingsView() }
        }
        .task { await session.refreshShared() }
        .alert("Pair with another server?", isPresented: Binding(
            get: { app.pendingPairLink != nil }, set: { if !$0 { app.pendingPairLink = nil } })
        ) {
            Button("Cancel", role: .cancel) { app.pendingPairLink = nil }
            Button("Switch", role: .destructive) {
                guard let link = app.pendingPairLink else { return }
                app.pendingPairLink = nil
                Task { switchError = await app.switchServer(to: link) }
            }
        } message: {
            Text("A link asks to move this phone to \(URL(string: app.pendingPairLink?.serverUrl ?? "")?.host ?? "another server"). Everything you send would go there. Only switch if it is your own Stem server.")
        }
        .alert("Couldn't switch", isPresented: Binding(get: { switchError != nil }, set: { if !$0 { switchError = nil } })) {
            Button("OK") { switchError = nil }
        } message: { Text(switchError ?? "") }
        .overlay {
            if session.connection.status == .unauthorized {
                ContentUnavailableView {
                    Label("This phone was unpaired", systemImage: "link.badge.plus")
                } description: {
                    Text("The server no longer accepts this phone. Pair it again from the desktop.")
                } actions: {
                    Button("Pair again") { app.unpair() }.buttonStyle(.borderedProminent)
                }
                .background(.background)
            }
        }
    }
}

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(Session.self) private var session
    @State private var confirmUnpair = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    LabeledContent("Address", value: session.client.creds.serverUrl)
                    LabeledContent("Status") {
                        HStack(spacing: 6) {
                            ConnectionDot()
                            Text(statusText)
                        }
                    }
                }
                Section("Chat defaults") {
                    LabeledContent("Model", value: session.currentModel?.displayName ?? "—")
                    Toggle("Web search", isOn: Binding(get: { session.webSearch }, set: { session.setWebSearch($0) }))
                }
                Section {
                    Button("Unpair this phone", role: .destructive) { confirmUnpair = true }
                }
                Section {
                    LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")
                }
            }
            .navigationTitle("Settings")
            .confirmationDialog("Unpair this phone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) { app.unpair() }
            } message: {
                Text("Unsent drafts on this phone are deleted. Your chats stay on the server.")
            }
        }
    }

    private var statusText: String {
        switch session.connection.status {
        case .live: return "Connected"
        case .connecting: return "Connecting"
        case .offline: return "Offline"
        case .unauthorized: return "Unpaired"
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor weak var app: AppModel? {
        didSet {
            if let route = pendingRoute { app?.open(route); pendingRoute = nil }
            if let t = pendingToken { app?.pushToken = t; app?.registerPush() }
        }
    }
    @MainActor private var pendingRoute: Route?
    @MainActor private var pendingToken: String?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { application.registerForRemoteNotifications() }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in
            pendingToken = hex
            if let app { app.pushToken = hex; app.registerPush() }
        }
    }

    // Foreground: a turn ending or an approval in the chat on screen is
    // already visible there; keep the banner for everything else (other
    // chats, mail, tasks).
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let stem = notification.request.content.userInfo["stem"] as? [String: Any]
        let thread = stem?["threadId"] as? String
        let onScreen = await MainActor.run { thread != nil && thread == app?.session?.visibleThreadId }
        return onScreen ? [] : [.banner, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let stem = info["stem"] as? [String: Any] else { return }
        let kind = stem["kind"] as? String
        let route: Route?
        if kind == "mail", let conv = stem["conversationId"] as? String { route = .mail(conv) }
        else if let thread = stem["threadId"] as? String { route = .thread(thread) }
        else { route = nil }
        await MainActor.run {
            guard let route else { app?.tab = kind == "mail" ? .mail : .chats; return }
            if let app { app.open(route) } else { pendingRoute = route }
        }
    }
}
