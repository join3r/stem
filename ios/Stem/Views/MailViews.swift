import QuickLook
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
                if !requests.isEmpty {
                    // First mail from someone not yet accepted: out of the Inbox until Accept or Block.
                    Section("Requests") {
                        ForEach(requests) { c in
                            NavigationLink(value: Route.mail(c.id)) { MailRow(conversation: c) }
                        }
                    }
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
                // Mail the personas are still working on waits under Sent, like
                // email, and comes back up when their answer lands.
            }
            .listStyle(.plain)
            .overlay {
                if !session.mail.loaded { ProgressView() }
                else if rows.isEmpty {
                    ContentUnavailableView("No mail in \(folder.rawValue)", systemImage: "tray")
                }
            }
            .refreshable { await session.mail.reload() }
            .navigationTitle("Mail")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                OfflineToolbarItem()
                ToolbarItem(placement: .topBarTrailing) {
                    Button { composing = true } label: { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel("New mail")
                }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .mail(let id): MailConversationView(conversationId: id)
                case .thread(let id): ThreadView(session: session, threadId: id).id(id)
                case .newChat(let folderId): ThreadView(session: session, threadId: nil, folderId: folderId)
                case .folder(let id): ChatFolderView(folderId: id)
                }
            }
            .sheet(isPresented: $composing) {
                // Sending closes the sheet and stays on the list: nothing working shows.
                MailComposeView().environment(session)
            }
            .task { if !session.mail.loaded { await session.mail.reload() } }
        }
    }

    private var rows: [MailConversation] {
        (session.mail.sections[folder] ?? []).filter { folder != .inbox || !session.interStem.isRequest($0) }
    }
    private var requests: [MailConversation] {
        folder == .inbox ? (session.mail.sections[.inbox] ?? []).filter { session.interStem.isRequest($0) } : []
    }
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
                    HStack(spacing: 4) {
                        if conversation.external != nil { Image(systemName: "at").font(.caption) }
                        Text(conversation.external.map { session.interStem.label($0.address) }
                             ?? conversation.participants.map(session.personaName).joined(separator: ", "))
                            .font(.body.weight(unread ? .semibold : .regular))
                            .lineLimit(1)
                    }
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
                    Text(MdxText.preview(p.body))
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
    @State private var showAdd = false
    /// The name being typed for the other person (nil: the alert is closed).
    @State private var naming: String?
    /// The open Reply sheet; `focus` when a form's Ask opened it.
    @State private var replying: ReplyRequest?
    /// Mails the user opened or folded, flipping their default (see MailThread.layout).
    @State private var flipped: Set<String> = []
    /// Replies whose folded-in persona exchange is shown.
    @State private var shownExchanges: Set<String> = []
    /// Forms in this conversation answer by mail, sent from the answer bar
    /// over the Reply button; asking about a question starts a reply.
    @State private var formHost = MdxFormHost(place: .below)
    @State private var formError: String?
    /// The reply whose Share sheet is open.
    @State private var sharing: ShareRequest?

    private var conversation: MailConversation? { session.mail.conversation(conversationId) }
    private var working: Bool { conversation?.status == "working" }
    private var lead: String { conversation?.participants.first ?? "normal" }

    /// A persona's reply in the user's own thread. Mail with another person
    /// isn't ours to publish, and the memory check is the user's memory.
    private func shareable(_ item: MailItem) -> Bool {
        item.from != "user" && item.approval == nil && conversation?.external == nil && conversation?.owner == nil
    }

    var body: some View {
        let items = session.mail.items(conversationId)
        let layout = MailThread.layout(items)
        let newestFromThem = items.last { $0.from != "user" }?.id
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if let c = conversation { header(c) }
                    if let ext = conversation?.external {
                        PersonBanners(address: ext.address)
                        CollabCard(collab: conversation?.collab, turn: Self.turn(items, ext.address),
                                   who: session.interStem.label(ext.address))
                    }
                    // A draft answers their mail: offered once they have written.
                    if let ext = conversation?.external, items.contains(where: { $0.from == ext.address }) {
                        ExternalDraftBar(conversationId: conversationId, address: ext.address, working: working,
                                         held: items.contains { $0.external?.held == true })
                    }
                    if working { liveRow }
                    if !layout.trailing.isEmpty { exchange(key: "trailing", layout.trailing, author: lead) }
                    ForEach(layout.entries) { entry in
                        Group {
                            if layout.open.contains(entry.id) != flipped.contains(entry.id) {
                                MailItemCard(item: entry.item, onFold: entry.item.approval?.status == "pending" ? nil : { flip(entry.id) },
                                             onShare: shareable(entry.item) ? {
                                                 sharing = ShareRequest(source: .mail(conversationId: conversationId), anchorId: entry.item.id)
                                             } : nil)
                                    .environment(\.mdxActions, entry.item.from == "user" ? nil : mdxActions)
                                    .environment(\.mdxIsLatest, entry.id == newestFromThem && !working)
                                    .environment(\.mdxSource, MdxSource(key: "mail:\(entry.id)", scrollId: entry.id, order: entry.item.at))
                            } else {
                                foldedRow(entry)
                            }
                        }
                        .id(entry.id)
                        if !entry.exchange.isEmpty { exchange(key: entry.id, entry.exchange, author: entry.item.from) }
                    }
                }
                .padding(14)
            }
            .environment(\.mdxFormHost, formHost)
            .onAppear {
                formHost.scrollTo = { id in
                    let layout = MailThread.layout(session.mail.items(conversationId))
                    if layout.open.contains(id) == flipped.contains(id) { flip(id) }
                    withAnimation { proxy.scrollTo(id, anchor: .top) }
                }
                formHost.ask = { label in askAbout(label) }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if let formError { ErrorBanner(text: formError) { self.formError = nil } }
                MdxAnswerBar(host: formHost, running: working)
                HStack {
                    Button { Task { await session.mail.setArchived([conversationId], true) } } label: {
                        Image(systemName: "archivebox").font(.title3)
                    }
                    .accessibilityLabel("Archive")
                    .frame(minWidth: 44, minHeight: 44)
                    Spacer()
                    Button { replying = ReplyRequest(focus: false) } label: {
                        Label("Reply", systemImage: "arrowshape.turn.up.left").font(.body.weight(.semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .controlSize(.large)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(.bar)
            }
        }
        .sheet(item: $sharing) { r in ShareLinkSheet(request: r).environment(session) }
        .sheet(item: $replying) { r in
            MailReplySheet(conversationId: conversationId, focusRequest: r.focus ? 1 : 0).environment(session)
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
                    if let ext = conversation?.external {
                        Button { naming = session.interStem.contact(ext.address)?.name ?? "" } label: {
                            Label("Name them…", systemImage: "pencil")
                        }
                        if session.interStem.contact(ext.address)?.verifiedByUser == true {
                            let on = session.interStem.contact(ext.address)?.autoDraft == true
                            Button { Task { await session.interStem.setAutoDraft(ext.address, !on) } } label: {
                                Label(on ? "Turn off auto-draft" : "Auto-draft their mail", systemImage: "sparkles")
                            }
                        }
                    } else {
                        Button { showAdd = true } label: { Label("Add a persona", systemImage: "person.badge.plus") }
                    }
                    Button { Task { await session.mail.setArchived([conversationId], true) } } label: {
                        Label("Archive", systemImage: "archivebox")
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .alert("Their name", isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })) {
            TextField("Name", text: Binding(get: { naming ?? "" }, set: { naming = $0 }))
            Button("Save") {
                if let ext = conversation?.external, let name = naming { Task { await session.interStem.setName(ext.address, name) } }
                naming = nil
            }
            Button("Cancel", role: .cancel) { naming = nil }
        } message: { Text("Shown beside their address on this Stem only.") }
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
        .task { await session.mail.open(conversationId) }
        .onDisappear { session.mail.close(conversationId) }
        // A reply that lands while the conversation is open has been read.
        .onChange(of: conversation?.userUpdatedAt) { _, _ in Task { await markRead() } }
    }

    /// Whose move it is in mail with another person: whoever did not write last.
    static func turn(_ items: [MailItem], _ address: String) -> String? {
        guard let last = items.last(where: { $0.from == address || ($0.from == "user" && $0.to.contains(address)) }) else { return nil }
        return last.from == address ? "you" : "them"
    }

    private func header(_ c: MailConversation) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(c.subject.isEmpty ? "(no subject)" : c.subject).font(.title3.bold())
            HStack(spacing: 8) {
                if let ext = c.external {
                    let contact = session.interStem.contact(ext.address)
                    let named = contact?.name.map { "\($0) · \(ext.address)" } ?? ext.address
                    let trust = contact?.verifiedByUser == true ? "verified by you"
                        : (contact?.keyFp.isEmpty ?? true) ? "not on Stem yet" : "verified by email"
                    Text("\(named) · \(trust)")
                        .font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                } else {
                    let others = c.participants.dropFirst().map(session.personaName)
                    Text(([session.personaName(lead) + (others.isEmpty ? "" : " leads")] + others).joined(separator: " · "))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if c.status == "awaiting-user" { pill("Waiting on you", .orange) }
                if c.status == "failed" { pill("Failed", .red) }
                if c.status == "aborted" { pill("Stopped", .secondary) }
            }
        }
    }

    private func pill(_ text: String, _ color: Color) -> some View {
        Text(text).font(.caption.weight(.semibold)).foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(color.opacity(0.14), in: Capsule())
    }

    /// While personas work: who is on it, and Stop — at the top, where you look.
    private var liveRow: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("\(session.personaName(lead)) is on it").font(.subheadline.weight(.semibold))
            Spacer()
            Button(role: .destructive) { Task { await session.mail.stop(conversationId) } } label: {
                Label("Stop", systemImage: "stop.circle")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(12)
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.accentColor.opacity(0.45)))
    }

    private func foldedRow(_ entry: MailThreadEntry) -> some View {
        Button { flip(entry.id) } label: {
            HStack(spacing: 10) {
                Text(session.personaName(entry.item.from)).font(.subheadline.weight(.semibold))
                Text(MdxText.preview(entry.item.body))
                    .font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 4)
                Text(RelativeTime.short(entry.item.at)).font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.secondary.opacity(0.25)))
    }

    @ViewBuilder
    private func exchange(key: String, _ items: [MailItem], author: String) -> some View {
        Button {
            if shownExchanges.contains(key) { shownExchanges.remove(key) } else { shownExchanges.insert(key) }
        } label: {
            Label(MailThread.exchangeLabel(items, author: author, name: session.personaName),
                  systemImage: "arrow.turn.down.right")
                .font(.caption)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .tint(.secondary)
        if shownExchanges.contains(key) {
            // Newest first, like the thread around it.
            ForEach(items.reversed()) { MailItemCard(item: $0).padding(.leading, 16).opacity(0.85) }
        }
    }

    /// Forms and suggested replies in this conversation answer by mail: a
    /// submit is a reply, the same one the Reply sheet sends.
    private var mdxActions: MdxActions {
        let id = conversationId
        let mail = session.mail
        return MdxActions(submit: { text in
            Task {
                do {
                    try await mail.reply(id, body: text, attachments: [])
                    formError = nil
                } catch {
                    formError = error.localizedDescription
                }
            }
        }, running: working)
    }

    /// A form's Ask: start the reply with the question and open it, caret after.
    private func askAbout(_ label: String) {
        let key = "mail:\(conversationId)"
        var draft = DraftStore.load(key)
        let prefix = "About “\(label)”: "
        if !draft.text.hasPrefix(prefix) { draft.text = prefix + draft.text }
        DraftStore.save(key, draft)
        replying = ReplyRequest(focus: true)
    }

    private func flip(_ id: String) {
        if flipped.contains(id) { flipped.remove(id) } else { flipped.insert(id) }
    }

    private func markRead() async {
        if let c = conversation, MailSections.isUnread(c, session.mail.mail) {
            await session.mail.setRead([conversationId], true)
        }
    }
}

struct ReplyRequest: Identifiable {
    let id = UUID()
    var focus: Bool
}

/// Reply, Apple Mail style: a sheet with your text on top and the mail you are
/// answering quoted beneath it. Cancel keeps the draft.
struct MailReplySheet: View {
    @Environment(Session.self) private var session
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    /// Above zero: the caret goes into the reply at once (a form's Ask).
    var focusRequest = 0
    @State private var draft: Draft
    @State private var error: String?

    init(conversationId: String, focusRequest: Int = 0) {
        self.conversationId = conversationId
        self.focusRequest = focusRequest
        _draft = State(initialValue: DraftStore.load("mail:\(conversationId)"))
    }

    private var conversation: MailConversation? { session.mail.conversation(conversationId) }
    private var items: [MailItem] { session.mail.items(conversationId) }
    /// A run parked on Allow/Deny takes the reply instead of the lead.
    private var parkedBy: String? { items.last { $0.approval?.status == "pending" }?.from }
    private var recipient: String { conversation?.external?.address ?? parkedBy ?? conversation?.participants.first ?? "normal" }
    private var quoted: MailItem? { items.last { $0.from != "user" && $0.to.contains("user") } }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text("To").foregroundStyle(.secondary)
                        Text(session.personaName(recipient))
                            .padding(.horizontal, 10).padding(.vertical, 2)
                            .background(Color.accentColor.opacity(0.12), in: Capsule())
                            .overlay(Capsule().strokeBorder(Color.accentColor))
                        let others = conversation?.external != nil ? []
                            : (conversation?.participants ?? []).filter { $0 != recipient }.map(session.personaName)
                        if parkedBy != nil, conversation?.external == nil {
                            Text("instead of its Allow or Deny").font(.footnote).foregroundStyle(.secondary)
                        } else if !others.isEmpty {
                            Text("\(others.joined(separator: ", ")) only if \(session.personaName(recipient)) asks")
                                .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    if conversation?.status == "working", conversation?.external == nil {
                        Text("\(session.personaName(recipient)) reads this when its current run ends.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .font(.subheadline)
                .padding(.horizontal, 16).padding(.vertical, 10)
                if let error { ErrorBanner(text: error) { self.error = nil } }
                Composer(kind: .mail, draftKey: "mail:\(conversationId)", draft: $draft, busy: false,
                         placeholder: "Reply to \(session.personaName(recipient))", onSend: send,
                         focusRequest: focusRequest)
                ScrollView {
                    if let q = quoted {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(session.personaName(q.from)) · \(RelativeTime.short(q.at))")
                                .font(.caption).foregroundStyle(.secondary)
                            MarkdownView(q.body)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.secondarySystemBackground).opacity(0.7), in: RoundedRectangle(cornerRadius: 12))
                        .padding(16)
                    }
                }
            }
            .navigationTitle("Reply")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func send(_ text: String, _ files: [DraftAttachment]) async -> Bool {
        do {
            let uploads = try await Uploads.upload(files, client: session.client)
            try await session.mail.reply(conversationId, body: text, attachments: uploads)
            dismiss()
            // Sent: back to the list, like email — the answer brings it up again.
            if app.mailPath.last == .mail(conversationId) { app.mailPath.removeLast() }
            return true
        } catch {
            // The sheet stays open with the text kept, so nothing is lost.
            self.error = error.localizedDescription
            return false
        }
    }
}

struct MailItemCard: View {
    @Environment(Session.self) private var session
    let item: MailItem
    /// Fold this mail back to one line (absent where it can't fold).
    var onFold: (() -> Void)? = nil
    /// Opens the Share sheet for this reply (absent where it can't be shared).
    var onShare: (() -> Void)? = nil

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
                if let onFold {
                    Button(action: onFold) { Image(systemName: "chevron.up").font(.caption.weight(.semibold)) }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Fold this mail")
                }
            }
            if item.stale == true {
                Text("Late reply — written before your newest message").font(.caption).foregroundStyle(.orange)
            }
            if item.statusReply == true {
                Text("Live status — answered on the spot while the work carries on").font(.caption).foregroundStyle(.secondary)
            }
            if item.statusQuery == true {
                Text("Answered on the spot, not passed to the personas at work").font(.caption).foregroundStyle(.secondary)
            }
            if item.filed == true {
                Text("Arrived after the answer — filed without starting another turn").font(.caption).foregroundStyle(.secondary)
            }
            if let label = item.external?.statusLabel {
                Text(label).font(.caption.weight(.medium)).foregroundStyle(statusColor(item.external?.status))
            }
            if item.external?.held == true { HeldNote(item: item) }
            // A send draft's text is the editable box below, not a second copy here.
            // Another person's words are shown as they wrote them, not rendered.
            if item.from.contains("@") { Text(item.body).textSelection(.enabled) }
            else if item.approval?.kind != "send" { MarkdownView(item.body) }
            if let x = item.external, x.error != nil || x.status == "joined", x.status != "sent", x.status != "delivered" {
                SendStateRow(item: item, external: x)
            }
            if let approval = item.approval {
                if approval.kind == "send" { SendDraftView(itemId: item.id, approval: approval) }
                else { MailApprovalView(itemId: item.id, approval: approval) }
            }
            AttachmentStrip(attachments: item.attachments ?? [])
            let files = (item.attachments ?? []).filter { $0.fileId != nil }
            if !files.isEmpty { MailFilesRow(files: files) }
            ForEach(item.images ?? [], id: \.id) { ref in GeneratedImage(ref: ref, store: nil, client: session.client) }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(mine ? Color.accentColor.opacity(0.10) : Color(.secondarySystemBackground).opacity(0.7),
                    in: RoundedRectangle(cornerRadius: 14))
        .contextMenu {
            Button("Copy") { UIPasteboard.general.string = item.body }
            if let onShare { Button("Share as Link…", systemImage: "square.and.arrow.up") { onShare() } }
        }
    }
}

private func statusColor(_ status: String?) -> Color {
    switch status {
    case "delivered", "joined": return .green
    case "failed", "unreachable": return .red
    case "key-changed", "expired", "waiting": return .orange
    default: return .secondary
    }
}

/// Files in mail with another person: tap to fetch and preview (Share is in the preview).
struct MailFilesRow: View {
    @Environment(Session.self) private var session
    let files: [MessageAttachment]
    @State private var preview: URL?
    @State private var busy: String?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(files, id: \.fileId) { f in
                Button {
                    open(f)
                } label: {
                    HStack(spacing: 6) {
                        if busy == f.fileId { ProgressView().controlSize(.mini) } else { Image(systemName: "arrow.down.doc") }
                        Text(f.name ?? "File").lineLimit(1)
                        if let size = f.size {
                            Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).foregroundStyle(.secondary)
                        }
                    }
                    .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(busy != nil)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .quickLookPreview($preview)
    }

    private func open(_ f: MessageAttachment) {
        guard let id = f.fileId else { return }
        busy = id
        error = nil
        Task {
            do { preview = try await session.client.download("stem-mailfile:\(id)", name: f.name ?? "file") } catch { self.error = error.localizedDescription }
            busy = nil
        }
    }
}

/// Where a conversation with another person stands, folded to its goal line on tap.
struct CollabCard: View {
    let collab: MailCollab?
    let turn: String?
    let who: String
    @State private var open = true

    var body: some View {
        if collab != nil || turn != nil {
            VStack(alignment: .leading, spacing: 6) {
                Button { withAnimation { open.toggle() } } label: {
                    HStack(alignment: .firstTextBaseline) {
                        Text(collab?.goal ?? "Mail with them").font(.subheadline.weight(.semibold)).multilineTextAlignment(.leading)
                        Spacer()
                        if let turn {
                            Text(turn == "you" ? "Your turn" : "Waiting on \(who)")
                                .font(.caption.weight(turn == "you" ? .semibold : .regular))
                                .foregroundStyle(turn == "you" ? Color.accentColor : .secondary)
                        }
                    }
                }
                .buttonStyle(.plain)
                if open, let c = collab {
                    if !c.agreed.isEmpty { section("Agreed", c.agreed, mark: "checkmark") }
                    if !c.open.isEmpty { section("Open", c.open, mark: "circle") }
                    if let next = c.next, !next.isEmpty {
                        (Text("NEXT  ").font(.caption2).foregroundStyle(.secondary) + Text(next).font(.caption))
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private func section(_ title: String, _ lines: [String], mark: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title.uppercased()).font(.caption2).foregroundStyle(.secondary)
            ForEach(lines, id: \.self) { l in
                Label(l, systemImage: mark).font(.caption).labelStyle(.titleAndIcon)
            }
        }
    }
}

/// Held mail from another person: only the user sees it until they let their agents read it.
struct HeldNote: View {
    @Environment(Session.self) private var session
    let item: MailItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Only you can see this. Your agents can’t read it until you let them.", systemImage: "lock")
                .font(.caption)
            Button("Only let them read it") { Task { await session.interStem.release(item.conversationId, item.id) } }
                .font(.caption).buttonStyle(.bordered).controlSize(.small)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// Why a mail to a person didn't go (yet), with what the user can do about it.
struct SendStateRow: View {
    @Environment(Session.self) private var session
    let item: MailItem
    let external: MailItemExternal
    @State private var invited = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(external.status == "joined" ? "\(session.personaName(item.to.first ?? "")) is on Stem now. Send it?" : external.error ?? "")
                .font(.caption).foregroundStyle(statusColor(external.status))
            HStack {
                if external.status == "waiting" || external.status == "unreachable", let to = item.to.first {
                    Button(invited ? "Invite sent" : "Invite them") {
                        invited = true
                        Task { await session.interStem.invite(to) }
                    }
                    .disabled(invited)
                    .buttonStyle(.bordered)
                }
                if item.from == "user", external.resendable {
                    Button(external.status == "joined" ? "Send now" : "Send again") {
                        Task { await session.interStem.resend(item.conversationId, item.id) }
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .controlSize(.small)
        }
    }
}

/// Accept / Block for a first mail, and the loud notice when their key changed.
struct PersonBanners: View {
    @Environment(Session.self) private var session
    let address: String

    var body: some View {
        let c = session.interStem.contact(address)
        if c?.state == "request" {
            VStack(alignment: .leading, spacing: 8) {
                Text("\(session.interStem.label(address)) wrote to you for the first time.").font(.subheadline)
                HStack {
                    Button("Accept") { Task { await session.interStem.contactOp("accept", address) } }.buttonStyle(.borderedProminent)
                    Button("Block", role: .destructive) { Task { await session.interStem.contactOp("block", address) } }.buttonStyle(.bordered)
                }
                .controlSize(.small)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
        if c?.keyChanged == true {
            VStack(alignment: .leading, spacing: 8) {
                Label("\(address)’s key changed — a new device, or someone else. Check with them another way before you send anything.",
                      systemImage: "key").font(.subheadline).foregroundStyle(.orange)
                Button("It’s them — use the new key") { Task { await session.interStem.contactOp("ackKey", address) } }
                    .buttonStyle(.bordered).controlSize(.small)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
        }
        if let error = session.interStem.error {
            ErrorBanner(text: error) { session.interStem.error = nil }
        }
    }
}

/// Ask a persona to draft the next reply to a person. With held mail, the tap
/// is also the release: the agents read it, then draft.
struct ExternalDraftBar: View {
    @Environment(Session.self) private var session
    let conversationId: String
    let address: String
    let working: Bool
    let held: Bool
    @State private var persona: String?
    @State private var instructions = ""
    @State private var busy = false
    @State private var error: String?

    private var chosen: String {
        persona ?? session.interStem.contact(address)?.draftPersona.flatMap { id in
            session.mailPersonas.contains { $0.id == id } ? id : nil
        } ?? (session.mailPersonas.contains { $0.id == "normal" } ? "normal" : session.mailPersonas.first?.id ?? "normal")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "sparkles").foregroundStyle(Color.accentColor)
                Menu {
                    ForEach(session.mailPersonas) { p in Button(p.name) { persona = p.id } }
                } label: {
                    Text(session.personaName(chosen)).font(.subheadline.weight(.semibold))
                    Image(systemName: "chevron.up.chevron.down").font(.caption2)
                }
                Spacer()
            }
            TextField("What should the reply say? (optional)", text: $instructions, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .font(.subheadline)
            Button {
                draft()
            } label: {
                Label(held ? "Read it and draft a reply" : "Draft a reply", systemImage: "sparkles")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy || working)
            if working { Text("A draft is being written…").font(.caption).foregroundStyle(.secondary) }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .padding(12)
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.secondary.opacity(0.25)))
    }

    private func draft() {
        busy = true
        error = nil
        Task {
            do {
                try await session.interStem.draft(conversationId, persona: chosen, instructions: instructions, release: held)
                instructions = ""
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

/// A persona's draft to another person: the exact text that would go out,
/// editable. Nothing reaches them until the user presses Send.
struct SendDraftView: View {
    @Environment(Session.self) private var session
    let itemId: String
    let approval: MailApproval
    @State private var text: String
    @State private var busy = false

    init(itemId: String, approval: MailApproval) {
        self.itemId = itemId
        self.approval = approval
        _text = State(initialValue: approval.command)
    }

    private var settled: String {
        switch approval.status {
        case "allowed": return "You sent it to \(approval.to ?? "them")."
        case "superseded": return "You wrote your own reply instead."
        default: return "You discarded this draft."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if approval.status == "pending" {
                Label("Send this to \(approval.to ?? "them")?", systemImage: "paperplane")
                    .font(.subheadline.weight(.semibold))
                TextEditor(text: $text)
                    .font(.body)
                    .frame(minHeight: 120)
                    .padding(4)
                    .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityLabel("The draft — edit before sending")
                Text("This is exactly what they will receive.").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Discard", role: .destructive) { answer(false) }.buttonStyle(.bordered)
                    Spacer()
                    Button { answer(true) } label: { Label("Send", systemImage: "paperplane.fill") }
                        .buttonStyle(.borderedProminent)
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .disabled(busy)
            } else {
                Text(settled).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func answer(_ send: Bool) {
        busy = true
        Task {
            await session.mail.resolveApproval(itemId, allow: send, body: send ? text : nil)
            busy = false
        }
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
            if let reason = approval.reason { Text("Safety check: \(MdxText.preview(reason))").font(.caption).foregroundStyle(.secondary) }
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
    @State private var draft = DraftStore.load("mail:new")
    @State private var error: String?
    @State private var reach: InterStemReach?
    @State private var invited: String?
    @State private var from: String?

    private var writingOut: Bool { draft.outTo != nil }
    private var outAddress: String { (draft.outTo ?? "").trimmingCharacters(in: .whitespaces).lowercased() }
    private var outLooksValid: Bool { outAddress.wholeMatch(of: /[^\s@]+@[^\s@]+\.[^\s@]+/) != nil }
    private var outSendable: Bool { outLooksValid && (reach == nil || reach?.state == "reachable" || reach?.state == "unreachable") }

    private var leadName: String? {
        draft.to.first.flatMap { id in session.mailPersonas.first { $0.id == id }?.name }
    }

    var body: some View {
        NavigationStack {
            Composer(kind: .mail, draftKey: "mail:new", draft: $draft, busy: writingOut ? !outSendable : draft.to.isEmpty,
                     placeholder: writingOut ? "Write your mail" : "Write the task — the reply lands in your Inbox",
                     onSend: send, page: AnyView(header),
                     sendTitle: writingOut ? "Send" : leadName.map { "Send to \($0)" })
            .navigationTitle("New mail")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                if !writingOut {
                    ToolbarItem(placement: .primaryAction) {
                        Button { draft.isPrivate.toggle() } label: {
                            Image(systemName: draft.isPrivate ? "lock.fill" : "lock")
                        }
                        .tint(draft.isPrivate ? Color.accentColor : .secondary)
                        .accessibilityLabel(draft.isPrivate ? "Private on" : "Private off")
                    }
                }
            }
            .onChange(of: draft) { _, d in DraftStore.save("mail:new", d) }
            .onAppear { if draft.to.isEmpty, session.mailPersonas.contains(where: { $0.id == "normal" }) { draft.to = ["normal"] } }
            .task(id: outAddress) {
                reach = nil
                guard writingOut, outLooksValid else { return }
                // Lookups are rate-limited on the relay: wait for a pause in typing.
                try? await Task.sleep(for: .milliseconds(700))
                guard !Task.isCancelled else { return }
                reach = try? await session.interStem.lookup(outAddress)
            }
        }
    }

    /// To, Subject and the notes above the body, as lines on one page.
    @ViewBuilder private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            if session.interStem.canWriteOut {
                Picker("Write to", selection: Binding(get: { writingOut }, set: { draft.outTo = $0 ? (draft.outTo ?? "") : nil })) {
                    Text("Personas").tag(false)
                    Text("A person").tag(true)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.top, 10)
                .padding(.bottom, writingOut ? 4 : 10)
                if writingOut {
                    Text("To someone on their own Stem, by email address. End-to-end encrypted; only you send.")
                        .font(.caption).foregroundStyle(.secondary)
                        .padding(.horizontal, 16).padding(.bottom, 10)
                }
            }
            if writingOut { personLines } else { personaLines }
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
                    .padding(.horizontal, 16).padding(.top, 10)
            }
        }
    }

    /// One header line: a muted label, then its field. `labelTop` lines the
    /// label up with a taller first row (the persona chips).
    private func line<Content: View>(_ label: String, labelTop: CGFloat = 0, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 10) {
                Text(label).foregroundStyle(.secondary).frame(width: 62, alignment: .leading).padding(.top, labelTop)
                content().frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            Divider().padding(.leading, 16)
        }
    }

    @ViewBuilder private var personaLines: some View {
        line("To", labelTop: 5) {
            VStack(alignment: .leading, spacing: 6) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(session.mailPersonas) { p in
                            let idx = draft.to.firstIndex(of: p.id)
                            Button {
                                if let idx { draft.to.remove(at: idx) } else { draft.to.append(p.id) }
                            } label: {
                                HStack(spacing: 4) {
                                    if let idx, draft.to.count > 1 { Text("\(idx + 1)").font(.caption2.bold()) }
                                    Text(p.name)
                                }
                            }
                            .chipStyle(on: idx != nil)
                        }
                    }
                    .font(.subheadline)
                }
                Text(toHint).font(.caption).foregroundStyle(.secondary)
            }
        }
        line("Subject") {
            TextField("Optional", text: $draft.subject).fontWeight(.semibold)
        }
        if draft.isPrivate {
            VStack(spacing: 0) {
                Label("Private: nothing here is saved to memory or read from it. Fixed once sent.", systemImage: "lock.fill")
                    .font(.footnote)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 9)
                    .background(Color.accentColor.opacity(0.12))
                Divider()
            }
        }
    }

    private var toHint: String {
        guard let lead = leadName else { return "Pick at least one persona — the first one leads." }
        let others = draft.to.dropFirst().compactMap { id in session.mailPersonas.first { $0.id == id }?.name }
        if others.isEmpty { return "\(lead) gets your mail and answers you." }
        return "\(lead) gets your mail and answers you. \(others.joined(separator: ", ")) \(others.count == 1 ? "joins" : "join") when \(lead) asks."
    }

    @ViewBuilder private var personLines: some View {
        if session.interStem.verifiedAddresses.count > 1 {
            line("From") {
                Picker("From", selection: Binding(get: { from ?? session.interStem.verifiedAddresses[0] }, set: { from = $0 })) {
                    ForEach(session.interStem.verifiedAddresses, id: \.self) { Text($0).tag($0) }
                }
                .labelsHidden()
                .pickerStyle(.menu)
            }
        }
        line("To") {
            VStack(alignment: .leading, spacing: 8) {
                TextField("their@email.com", text: Binding(get: { draft.outTo ?? "" }, set: { draft.outTo = $0 }))
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                let matches = (session.interStem.status?.contacts ?? []).filter {
                    $0.state != "blocked" && $0.address != outAddress && (outAddress.isEmpty || $0.address.contains(outAddress)
                        || ($0.name ?? "").lowercased().contains(outAddress))
                }.prefix(5)
                if !matches.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(Array(matches)) { c in
                                Button(c.name ?? c.address) { draft.outTo = c.address }.chipStyle(on: false)
                            }
                        }
                        .font(.subheadline)
                    }
                }
                if let reach, outLooksValid { reachRow(reach) }
            }
        }
        line("Subject") {
            TextField("Optional", text: $draft.subject).fontWeight(.semibold)
        }
    }

    @ViewBuilder private func reachRow(_ r: InterStemReach) -> some View {
        switch r.state {
        case "reachable":
            Label("On Stem", systemImage: "checkmark").font(.footnote).foregroundStyle(.green)
        case "unreachable":
            VStack(alignment: .leading, spacing: 6) {
                Text("Not on Stem yet. Your mail waits here, and Stem tells you when it can reach them.")
                    .font(.footnote).foregroundStyle(.secondary)
                Button(invited == outAddress ? "Invite sent" : "Invite them") {
                    invited = outAddress
                    Task { await session.interStem.invite(outAddress) }
                }
                .disabled(invited == outAddress)
                .buttonStyle(.bordered).controlSize(.small)
            }
        case "self": Text("That’s your own address.").font(.footnote).foregroundStyle(.red)
        case "blocked": Text("You blocked them. Unblock them on the desktop first.").font(.footnote).foregroundStyle(.red)
        default: Text(r.reason ?? "This address can’t be mailed.").font(.footnote).foregroundStyle(.red)
        }
    }

    private func send(_ text: String, _ files: [DraftAttachment]) async -> Bool {
        // Photo uploads take a while on mobile data; locking the phone or
        // switching apps must not cut the upload off halfway.
        let background = UIApplication.shared.beginBackgroundTask(withName: "mail:compose")
        defer { if background != .invalid { UIApplication.shared.endBackgroundTask(background) } }
        if writingOut { return await sendToPerson(text, files) }
        do {
            let uploads = try await Uploads.upload(files, client: session.client)
            let input = MailComposeInput(
                to: draft.to, subject: draft.subject.isEmpty ? nil : draft.subject, body: text,
                attachments: uploads.isEmpty ? nil : uploads, private: draft.isPrivate ? true : nil)
            _ = try await session.mail.compose(input)
            draft.subject = ""
            draft.isPrivate = false
            DraftStore.clear("mail:new", draft)
            dismiss()
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    private func sendToPerson(_ text: String, _ files: [DraftAttachment]) async -> Bool {
        guard outSendable else { return false }
        do {
            let uploads = try await Uploads.upload(files, client: session.client)
            try await session.interStem.compose(to: outAddress, from: from, subject: draft.subject, body: text, attachments: uploads)
            await session.mail.reload()
            draft.subject = ""
            draft.outTo = nil
            DraftStore.clear("mail:new", draft)
            dismiss()
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}
