import SwiftUI

struct ChatListView: View {
    @Environment(AppModel.self) private var app
    @Environment(Session.self) private var session
    @State private var query = ""
    @State private var showArchived = false

    var body: some View {
        @Bindable var app = app
        NavigationStack(path: $app.chatPath) {
            List {
                if !session.approvals.queue.isEmpty {
                    Section("Waiting for you") {
                        ForEach(session.approvals.queue) { a in
                            ApprovalCard(approval: a, showThreadLink: true)
                                .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                        }
                    }
                }
                Section {
                    ForEach(rows) { chat in
                        NavigationLink(value: Route.thread(chat.threadId)) { ChatRow(chat: chat) }
                            .swipeActions(edge: .leading) {
                                let unread = session.chats.isUnread(chat)
                                Button { Task { await session.chats.setRead([chat.threadId], unread) } } label: {
                                    Label(unread ? "Read" : "Unread", systemImage: unread ? "envelope.open" : "envelope.badge")
                                }
                                .tint(.blue)
                            }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) { Task { await session.chats.delete(chat.threadId) } } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                                let archived = session.chats.isArchived(chat)
                                Button { Task { await session.chats.setArchived([chat.threadId], !archived) } } label: {
                                    Label(archived ? "Unarchive" : "Archive", systemImage: "archivebox")
                                }
                                .tint(.gray)
                            }
                    }
                }
            }
            .listStyle(.plain)
            .overlay {
                if !session.chats.loaded { ProgressView() }
                else if rows.isEmpty {
                    if query.isEmpty { ContentUnavailableView("No chats", systemImage: "bubble.left.and.bubble.right") }
                    else { ContentUnavailableView.search(text: query) }
                }
            }
            .searchable(text: $query, prompt: "Search chats")
            .refreshable { await session.chats.reload() }
            .navigationTitle(showArchived ? "Archive" : "Chats")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { ConnectionDot() }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Toggle("Show archive", isOn: $showArchived)
                        Button { Task { await session.chats.setRead(session.chats.chats.map(\.threadId), true) } } label: {
                            Label("Mark all read", systemImage: "envelope.open")
                        }
                    } label: { Image(systemName: "line.3.horizontal.decrease.circle") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink(value: Route.newChat) { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel("New chat")
                }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .thread(let id): ThreadView(session: session, threadId: id).id(id)
                case .newChat: ThreadView(session: session, threadId: nil)
                case .mail(let id): MailConversationView(conversationId: id)
                }
            }
            .task { if !session.chats.loaded { await session.chats.reload() } }
        }
    }

    private var rows: [ChatSummary] {
        let q = query.lowercased()
        return session.chats.chats.filter { c in
            (showArchived == session.chats.isArchived(c))
                && (q.isEmpty || c.displayTitle.lowercased().contains(q) || (c.preview ?? "").lowercased().contains(q))
        }
    }
}

struct ChatRow: View {
    @Environment(Session.self) private var session
    let chat: ChatSummary

    var body: some View {
        let unread = session.chats.isUnread(chat)
        let running = session.connection.liveTurns[chat.threadId] != nil
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(running ? Color.green : unread ? Color.accentColor : .clear)
                .frame(width: 8, height: 8)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    if chat.private == true { Image(systemName: "eye.slash").font(.caption).foregroundStyle(.secondary) }
                    Text(chat.displayTitle)
                        .font(.body.weight(unread ? .semibold : .regular))
                        .lineLimit(1)
                    Spacer()
                    Text(RelativeTime.short(Inbox.toMs(chat.updatedAt)))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let p = chat.preview, !p.isEmpty {
                    Text(p).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct ConnectionDot: View {
    @Environment(Session.self) private var session
    var body: some View {
        let status = session.connection.status
        Circle()
            .fill(status == .live ? Color.green : status == .connecting ? Color.gray : Color.red)
            .frame(width: 9, height: 9)
            .accessibilityLabel(status == .live ? "Connected" : status == .connecting ? "Connecting" : "Offline")
    }
}

enum RelativeTime {
    static func short(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let cal = Calendar.current
        if cal.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        if abs(date.timeIntervalSinceNow) < 6 * 86400 { return date.formatted(.dateTime.weekday(.abbreviated)) }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }
}
