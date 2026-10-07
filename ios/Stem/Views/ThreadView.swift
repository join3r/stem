import SwiftUI

/// A chat, or a new one when `threadId` is nil (it becomes a chat on first send).
struct ThreadView: View {
    @Environment(Session.self) private var session
    @Environment(\.scenePhase) private var phase
    @State private var store: ThreadStore
    @State private var draft: Draft
    @State private var draftKey: String

    init(session: Session, threadId: String?) {
        _store = State(initialValue: ThreadStore(session: session, threadId: threadId))
        let key = threadId.map { "chat:\($0)" } ?? "chat:new"
        _draftKey = State(initialValue: key)
        _draft = State(initialValue: DraftStore.load(key))
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if store.threadId == nil && store.messages.isEmpty { newChatHeader }
                if store.loading { ProgressView().frame(maxWidth: .infinity).padding() }
                let latest = latestReplyId
                ForEach(store.messages) { m in
                    MessageRow(message: m, store: store, isLatest: m.id == latest, submit: submitFromReply)
                        .id(m.id)
                }
                if store.busy {
                    LiveActivity(label: store.activityLabel, activities: store.activities)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                ForEach(session.approvals.forThread(store.threadId)) { a in
                    ApprovalCard(approval: a).padding(.horizontal, 12).padding(.bottom, 6)
                }
                if let e = store.error {
                    ErrorBanner(text: e) { store.error = nil }
                }
                if session.connection.status == .offline {
                    Text("Offline — your draft is saved").font(.footnote).foregroundStyle(.secondary).padding(.bottom, 4)
                }
                Composer(
                    kind: .chat, draftKey: draftKey, draft: $draft, busy: store.busy,
                    placeholder: store.threadId == nil ? "Ask anything" : "Message",
                    onSend: send,
                    onStop: { await store.stop() },
                    onRetract: retract,
                    onNote: note,
                    onLearn: store.threadId == nil ? nil : { await store.learn(focus: $0) },
                    chatFormat: store.format.map { (value: $0, set: switchFormat) })
            }
        }
        .navigationTitle(navTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if store.isPrivate {
                ToolbarItem(placement: .topBarTrailing) {
                    Image(systemName: "eye.slash").foregroundStyle(.secondary).accessibilityLabel("Private chat")
                }
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .refreshable { await store.reload() }
        .onAppear {
            store.open()
            session.visibleThreadId = store.threadId
        }
        .onDisappear {
            store.close()
            if session.visibleThreadId == store.threadId { session.visibleThreadId = nil }
        }
        // Anything that lands in the chat on screen is read: a title written
        // after the first reply, a reply from another device. A chat marked
        // unread on purpose stays unread.
        .onChange(of: unreadOnScreen, initial: true) { _, unread in
            if unread, let id = store.threadId { Task { await session.chats.setRead([id], true) } }
        }
        .onChange(of: store.threadId) { old, new in
            session.visibleThreadId = new
            // The new-chat draft moves to the chat it became.
            if old == nil, let new {
                DraftStore.clear(draftKey, Draft())
                draftKey = "chat:\(new)"
            }
        }
    }

    private var unreadOnScreen: Bool {
        guard phase == .active, let id = store.threadId,
              session.chats.inbox.entries[id]?.forcedUnread != true,
              let row = session.chats.chats.first(where: { $0.threadId == id }) else { return false }
        return session.chats.isUnread(row)
    }

    private func switchFormat(_ next: String) {
        let store = store
        Task { await store.setFormat(next) }
    }

    private var navTitle: String {
        if store.threadId == nil { return draft.isPrivate ? "New private chat" : "New chat" }
        return store.title.isEmpty ? "Chat" : store.title
    }

    private var newChatHeader: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !session.chatPersonas.isEmpty {
                Text("Talk to").font(.footnote).foregroundStyle(.secondary)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        Button("Stem") { draft.personaId = nil }.chipStyle(on: draft.personaId == nil)
                        ForEach(session.chatPersonas) { p in
                            Button(p.name) { draft.personaId = p.id }.chipStyle(on: draft.personaId == p.id)
                        }
                    }
                    .font(.subheadline)
                }
            }
            Toggle(isOn: $draft.isPrivate) {
                VStack(alignment: .leading, spacing: 2) {
                    Label("Private chat", systemImage: "eye.slash")
                    Text("Nothing from it goes into memory, and memory isn't used.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground).opacity(0.6), in: RoundedRectangle(cornerRadius: 14))
        .padding(.top, 8)
    }

    /// The newest reply once its turn has settled: where suggested replies show.
    private var latestReplyId: String? {
        guard !store.busy, let last = store.messages.last(where: { $0.role != "system" }), last.role != "user" else { return nil }
        return last.id
    }

    /// A tap on a Quiz, Form or suggested reply: sent like a typed message.
    private func submitFromReply(_ text: String) {
        Task { _ = await send(text, []) }
    }

    private func send(_ text: String, _ files: [DraftAttachment]) async -> Bool {
        let personaId = store.threadId == nil ? draft.personaId : nil
        let client = session.client
        return await store.send(text: text, previews: files.map(\.preview),
                                upload: { try await Uploads.upload(files, client: client) },
                                personaId: personaId, private: draft.isPrivate)
    }

    private func retract() async {
        guard let m = await store.retract() else { return }
        draft.text = m.content
    }

    private func note(_ text: String, _ files: [DraftAttachment]) async -> (saved: Bool, message: String) {
        if files.contains(where: { !$0.isImage }) { return (false, "Notes take pictures only, not files") }
        var args: [JSONValue] = [.string(text)]
        if !files.isEmpty { args.append(.from(Uploads.inline(files))) }
        do {
            let r = try await session.client.call("memory:addNote", args, as: MemoryNoteResult.self)
            return (r.saved, NoteMode.flash(r))
        } catch {
            return (false, error.localizedDescription)
        }
    }
}

struct ErrorBanner: View {
    let text: String
    var dismiss: () -> Void
    var body: some View {
        HStack(alignment: .top) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(text).font(.footnote)
            Spacer()
            Button(action: dismiss) { Image(systemName: "xmark") }.buttonStyle(.borderless)
        }
        .padding(10)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
    }
}

/// "Thinking…" and the tools running right now.
struct LiveActivity: View {
    let label: String?
    let activities: [ActivityItem]
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(label ?? "Working").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.vertical, 4)
    }
}

struct MessageRow: View {
    let message: ChatMessage
    let store: ThreadStore
    var isLatest = false
    var submit: ((String) -> Void)?

    var body: some View {
        switch message.role {
        case "user":
            HStack {
                Spacer(minLength: 40)
                VStack(alignment: .trailing, spacing: 6) {
                    AttachmentStrip(attachments: message.attachments ?? [])
                    if !message.content.isEmpty {
                        Text(message.content)
                            .textSelection(.enabled)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 16))
                    }
                    if message.sendFailed == true {
                        Label("Not sent", systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.red)
                    }
                }
            }
            .contextMenu { Button("Copy") { UIPasteboard.general.string = message.content } }
        case "system":
            Label(message.content, systemImage: "info.circle")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground).opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
        default:
            VStack(alignment: .leading, spacing: 8) {
                if let acts = message.activity, !acts.isEmpty { ActivityList(items: acts) }
                if !message.content.isEmpty {
                    MarkdownView(message.content)
                        .environment(\.mdxActions, submit.map { MdxActions(submit: $0, running: store.busy) })
                        .environment(\.mdxIsLatest, isLatest)
                }
                ForEach(message.images ?? [], id: \.id) { ref in GeneratedImage(ref: ref, store: store) }
                if let sources = message.sources, !sources.isEmpty { SourcesList(sources: sources) }
            }
            .contextMenu { Button("Copy") { UIPasteboard.general.string = message.content } }
        }
    }
}

struct AttachmentStrip: View {
    let attachments: [MessageAttachment]
    var body: some View {
        if !attachments.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(attachments.enumerated()), id: \.offset) { _, a in
                        if a.kind == "image", let url = a.dataUrl, let img = ImageCache.shared.image(dataUrl: url) {
                            Image(uiImage: img).resizable().scaledToFill()
                                .frame(width: 120, height: 120)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                        } else {
                            Label(a.name ?? "File", systemImage: "doc")
                                .font(.caption)
                                .padding(8)
                                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                        }
                    }
                }
            }
            .frame(maxWidth: 260)
        }
    }
}

/// Tool calls of a settled turn, collapsed to one line until tapped.
struct ActivityList: View {
    let items: [ActivityItem]
    @State private var open = false
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { withAnimation { open.toggle() } } label: {
                HStack(spacing: 4) {
                    Image(systemName: "wrench.and.screwdriver")
                    Text(items.count == 1 ? ActivityText.label(items[0]) : "\(items.count) steps")
                        .lineLimit(1)
                    if items.contains(where: { $0.status == "error" }) {
                        Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
                    }
                    Image(systemName: open ? "chevron.up" : "chevron.down").font(.caption2)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            if open {
                ForEach(items) { a in
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: a.status == "error" ? "xmark.circle" : a.status == "running" ? "circle.dotted" : "checkmark.circle")
                            .foregroundStyle(a.status == "error" ? .red : .secondary)
                        Text(ActivityText.label(a)).lineLimit(3)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// Web sources of a reply as cards: the site, the page title, a letter tile.
struct SourcesList: View {
    let sources: [SourceRef]
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Sources").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(Array(sources.prefix(8).enumerated()), id: \.offset) { _, s in
                        if let url = URL(string: s.url) { SourceCard(source: s, url: url) }
                    }
                }
            }
        }
    }
}

struct SourceCard: View {
    let source: SourceRef
    let url: URL

    /// The hostname without "www.", as people say a site's name.
    static func site(_ url: URL) -> String {
        let host = url.host() ?? url.absoluteString
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    var body: some View {
        let site = Self.site(url)
        let title = source.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        Link(destination: url) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(site.first.map { String($0).uppercased() } ?? "?")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(width: 18, height: 18)
                        .background(tint(site), in: RoundedRectangle(cornerRadius: 4))
                    Text(site).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(title?.isEmpty == false ? title! : url.absoluteString)
                    .font(.caption)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .padding(10)
            .frame(width: 170, height: 76, alignment: .topLeading)
            .background(Color(.secondarySystemBackground).opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
        }
        .accessibilityLabel("\(title ?? site), \(site)")
    }

    /// A steady color per site, so the same site always looks the same.
    private func tint(_ site: String) -> Color {
        let sum = site.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xffff }
        return Color(hue: Double(sum % 360) / 360, saturation: 0.45, brightness: 0.62)
    }
}

struct GeneratedImage: View {
    let ref: GeneratedImageRef
    let store: ThreadStore?
    var client: StemClient?
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 12))
                    .contextMenu {
                        Button { UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil) } label: { Label("Save to Photos", systemImage: "square.and.arrow.down") }
                        ShareLink(item: Image(uiImage: image), preview: SharePreview(ref.prompt ?? "Image", image: Image(uiImage: image)))
                    }
            } else {
                RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemBackground))
                    .frame(height: 200)
                    .overlay(ProgressView())
            }
        }
        .frame(maxWidth: 320)
        .task(id: ref.id) {
            let data: Data?
            if let store { data = await store.image(ref) }
            else if let client { data = await ImageCache.shared.generated(ref, client: client) }
            else { data = nil }
            if let data { image = UIImage(data: data) }
        }
    }
}
