import SwiftUI

struct MailListView: View {
    @Environment(AppModel.self) private var app
    @Environment(Session.self) private var session
    @State private var folder: MailFolder = .inbox
    @State private var composing = false

    var body: some View {
        @Bindable var app = app
        NavigationStack(path: $app.mailPath) {
            List {
                Section {
                    Picker("Folder", selection: $folder) {
                        ForEach(MailFolder.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowSeparator(.hidden)
                }
                Section {
                    ForEach(rows) { c in
                        NavigationLink(value: Route.mail(c.id)) { MailRow(conversation: c) }
                            .swipeActions(edge: .leading) {
                                let unread = MailSections.isUnread(c, session.mail.mail)
                                Button { Task { await session.mail.setRead([c.id], unread) } } label: {
                                    Label(unread ? "Read" : "Unread", systemImage: unread ? "envelope.open" : "envelope.badge")
                                }
                                .tint(.blue)
                            }
                            .swipeActions(edge: .trailing) {
                                Button { Task { await session.mail.setArchived([c.id], folder != .archived) } } label: {
                                    Label(folder == .archived ? "Unarchive" : "Archive", systemImage: "archivebox")
                                }
                                .tint(.gray)
                                Button(role: .destructive) { Task { await session.mail.delete(c.id) } } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                    }
                }
            }
            .listStyle(.plain)
            .overlay {
                if !session.mail.loaded { ProgressView() }
                else if rows.isEmpty { ContentUnavailableView("No mail in \(folder.rawValue)", systemImage: "tray") }
            }
            .refreshable { await session.mail.reload() }
            .navigationTitle("Mail")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { ConnectionDot() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { composing = true } label: { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel("New mail")
                }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .mail(let id): MailConversationView(conversationId: id)
                case .thread(let id): ThreadView(session: session, threadId: id).id(id)
                case .newChat: ThreadView(session: session, threadId: nil)
                }
            }
            .sheet(isPresented: $composing) {
                MailComposeView { id in app.mailPath = [.mail(id)] }
                    .environment(session)
            }
            .task { if !session.mail.loaded { await session.mail.reload() } }
        }
    }

    private var rows: [MailConversation] { session.mail.sections[folder] ?? [] }
}

struct MailRow: View {
    @Environment(Session.self) private var session
    let conversation: MailConversation

    var body: some View {
        let mail = session.mail.mail
        let unread = MailSections.isUnread(conversation, mail)
        let preview = MailSections.preview(mail, conversation.id)
        let status = MailSections.statusLabel(conversation.status)
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(unread ? Color.accentColor : .clear).frame(width: 8, height: 8).padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(conversation.participants.map(session.personaName).joined(separator: ", "))
                        .font(.body.weight(unread ? .semibold : .regular))
                        .lineLimit(1)
                    Spacer()
                    Text(RelativeTime.short(conversation.updatedAt)).font(.caption).foregroundStyle(.secondary)
                }
                HStack(spacing: 4) {
                    if conversation.private == true { Image(systemName: "eye.slash").font(.caption2) }
                    Text(conversation.subject.isEmpty ? "(no subject)" : conversation.subject).lineLimit(1)
                }
                .font(.subheadline.weight(unread ? .semibold : .regular))
                if !status.isEmpty {
                    Text(status).font(.caption).foregroundStyle(conversation.status == "failed" ? .red : .orange)
                }
                if let p = preview {
                    Text(p.body.replacingOccurrences(of: "\n", with: " "))
                        .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct MailConversationView: View {
    @Environment(Session.self) private var session
    let conversationId: String
    @State private var draft: Draft
    @State private var error: String?
    @State private var showAdd = false

    init(conversationId: String) {
        self.conversationId = conversationId
        _draft = State(initialValue: DraftStore.load("mail:\(conversationId)"))
    }

    private var conversation: MailConversation? { session.mail.conversation(conversationId) }
    private var working: Bool { conversation?.status == "working" }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if let c = conversation {
                    Text(c.subject.isEmpty ? "(no subject)" : c.subject).font(.title3.bold())
                    Text("With " + c.participants.map(session.personaName).joined(separator: ", "))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(session.mail.items(conversationId)) { item in MailItemCard(item: item) }
                if working {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Working…").font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(14)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if let error { ErrorBanner(text: error) { self.error = nil } }
                Composer(kind: .mail, draftKey: "mail:\(conversationId)", draft: $draft, busy: false,
                         placeholder: "Reply", onSend: reply)
            }
        }
        .navigationTitle(conversation?.subject ?? "Mail")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if working {
                        Button(role: .destructive) { Task { await session.mail.stop(conversationId) } } label: {
                            Label("Stop", systemImage: "stop.circle")
                        }
                    }
                    Button { showAdd = true } label: { Label("Add a persona", systemImage: "person.badge.plus") }
                    Button { Task { await session.mail.setArchived([conversationId], true) } } label: {
                        Label("Archive", systemImage: "archivebox")
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .confirmationDialog("Add to this conversation", isPresented: $showAdd) {
            ForEach(session.mailPersonas.filter { !(conversation?.participants.contains($0.id) ?? false) }) { p in
                Button(p.name) { Task { await session.mail.addParticipant(conversationId, persona: p.id) } }
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .refreshable { await session.mail.reload() }
        .task {
            if !session.mail.loaded { await session.mail.reload() }
            await markRead()
        }
        // A reply that lands while the conversation is open has been read.
        .onChange(of: conversation?.userUpdatedAt) { _, _ in Task { await markRead() } }
    }

    private func markRead() async {
        if let c = conversation, MailSections.isUnread(c, session.mail.mail) {
            await session.mail.setRead([conversationId], true)
        }
    }

    private func reply(_ text: String, _ files: [DraftAttachment]) async -> Bool {
        do {
            let uploads = try await Uploads.upload(files, client: session.client)
            try await session.mail.reply(conversationId, body: text, attachments: uploads)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}

struct MailItemCard: View {
    @Environment(Session.self) private var session
    let item: MailItem

    var body: some View {
        let mine = item.from == "user"
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(session.personaName(item.from)).font(.subheadline.weight(.semibold))
                if !item.to.isEmpty {
                    Text("→ " + item.to.map(session.personaName).joined(separator: ", "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Text(Date(timeIntervalSince1970: item.at / 1000).formatted(date: .abbreviated, time: .shortened))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if item.stale == true {
                Text("Late reply — written before your newest message").font(.caption).foregroundStyle(.orange)
            }
            MarkdownView(item.body)
            if let approval = item.approval { MailApprovalView(itemId: item.id, approval: approval) }
            AttachmentStrip(attachments: item.attachments ?? [])
            ForEach(item.images ?? [], id: \.id) { ref in GeneratedImage(ref: ref, store: nil, client: session.client) }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(mine ? Color.accentColor.opacity(0.10) : Color(.secondarySystemBackground).opacity(0.7),
                    in: RoundedRectangle(cornerRadius: 14))
    }
}

/// A parked run's Allow/Deny: the command and why the safety check held it.
struct MailApprovalView: View {
    @Environment(Session.self) private var session
    let itemId: String
    let approval: MailApproval
    @State private var busy = false

    private var settled: String {
        switch approval.status {
        case "allowed": return "You allowed it — the task continued."
        case "denied": return "You denied it — the task continued without it."
        case "superseded": return "You answered with a mail instead."
        default: return "The conversation was stopped."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(approval.deviceLabel.map { "Run this on \($0)?" } ?? "Run this command?", systemImage: "exclamationmark.shield")
                .font(.subheadline.weight(.semibold))
            Text(approval.command).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
            if let reason = approval.reason { Text("Safety check: \(reason)").font(.caption).foregroundStyle(.secondary) }
            if approval.status == "pending" {
                HStack {
                    Button("Deny", role: .destructive) { answer(false) }.buttonStyle(.bordered)
                    Button("Allow once") { answer(true) }.buttonStyle(.borderedProminent)
                }
                .disabled(busy)
            } else {
                Text(settled).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func answer(_ allow: Bool) {
        busy = true
        Task {
            await session.mail.resolveApproval(itemId, allow: allow)
            busy = false
        }
    }
}

struct MailComposeView: View {
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    var onSent: (String) -> Void
    @State private var draft = DraftStore.load("mail:new")
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Form {
                    Section {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("To — the first one leads").font(.caption).foregroundStyle(.secondary)
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(session.mailPersonas) { p in
                                        let idx = draft.to.firstIndex(of: p.id)
                                        Button {
                                            if let idx { draft.to.remove(at: idx) } else { draft.to.append(p.id) }
                                        } label: {
                                            HStack(spacing: 4) {
                                                if let idx { Text("\(idx + 1)").font(.caption2.bold()) }
                                                Text(p.name)
                                            }
                                        }
                                        .chipStyle(on: idx != nil)
                                    }
                                }
                                .font(.subheadline)
                            }
                        }
                        TextField("Subject", text: $draft.subject)
                        Toggle(isOn: $draft.isPrivate) { Label("Private", systemImage: "eye.slash") }
                    }
                    if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
                }
                .scrollDismissesKeyboard(.interactively)
                Composer(kind: .mail, draftKey: "mail:new", draft: $draft, placeholder: "Write your mail", onSend: send)
            }
            .navigationTitle("New mail")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .onChange(of: draft) { _, d in DraftStore.save("mail:new", d) }
            .onAppear { if draft.to.isEmpty, session.mailPersonas.contains(where: { $0.id == "normal" }) { draft.to = ["normal"] } }
        }
    }

    private func send(_ text: String, _ files: [DraftAttachment]) async -> Bool {
        do {
            let uploads = try await Uploads.upload(files, client: session.client)
            let input = MailComposeInput(
                to: draft.to, subject: draft.subject.isEmpty ? nil : draft.subject, body: text,
                attachments: uploads.isEmpty ? nil : uploads, private: draft.isPrivate ? true : nil)
            let before = Set(session.mail.mail.conversations.map(\.id))
            let r = try await session.mail.compose(input)
            let created = r.conversations.filter { !before.contains($0.id) }.max { $0.createdAt < $1.createdAt }
            draft.subject = ""
            draft.isPrivate = false
            DraftStore.clear("mail:new", draft)
            dismiss()
            if let created { onSent(created.id) }
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}
