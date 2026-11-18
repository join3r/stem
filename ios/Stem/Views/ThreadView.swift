import SwiftUI

/// A chat, or a new one when `threadId` is nil (it becomes a chat on first send).
struct ThreadView: View {
    @Environment(Session.self) private var session
    @Environment(\.scenePhase) private var phase
    @State private var store: ThreadStore
    @State private var draft: Draft
    @State private var draftKey: String
    /// Forms in this chat send from the answer bar over the composer.
    @State private var formHost = MdxFormHost(place: .below)
    @State private var focusRequest = 0
    /// Voice chat in this chat; leaving the chat ends the call.
    @State private var voice = PhoneVoice()
    /// Whether the list sits at its end, so growth below follows it there.
    /// Not observed: re-rendering on every scroll step looped the layout.
    @State private var follow = ScrollFollow()
    /// The answer whose Share sheet is open.
    @State private var sharing: ShareRequest?

    init(session: Session, threadId: String?, folderId: String? = nil) {
        _store = State(initialValue: ThreadStore(session: session, threadId: threadId, folderId: folderId))
        let key = threadId.map { "chat:\($0)" } ?? "chat:new"
        _draftKey = State(initialValue: key)
        _draft = State(initialValue: DraftStore.load(key))
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if store.threadId == nil && store.messages.isEmpty { newChatHeader }
                    if store.loading { ProgressView().frame(maxWidth: .infinity).padding() }
                    let rows = Array(store.messages.enumerated())
                    // The split moves in steps, so a row isn't rebuilt on every message.
                    let split = max(0, (rows.count - Self.eagerTail) / Self.eagerStep * Self.eagerStep)
                    let latest = latestReplyId
                    ForEach(rows[..<split], id: \.element.id) { i, m in row(m, i, latest: latest) }
                    // The end of the chat is drawn in one block, not lazily. The
                    // lazy stack guesses the height of rows it hasn't drawn, and
                    // when the sent bubble was swapped for its saved copy or a
                    // reply grew, the bottom anchor landed past the drawn rows: a
                    // blank screen until a scroll redrew them.
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(rows[split...], id: \.element.id) { i, m in row(m, i, latest: latest) }
                        if store.busy {
                            LiveActivity(label: store.activityLabel, activities: store.activities)
                                .id(Self.activityId)
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
            .onScrollGeometryChange(for: Bool.self) { g in
                g.contentOffset.y + g.containerSize.height >= g.contentSize.height - 80
            } action: { _, now in follow.atBottom = now }
            // The bottom anchor alone stopped short of a new reply in a long
            // chat; scrolling to the (always drawn) last row lands exactly.
            .onChange(of: tailSignature) { old, new in
                guard new.userCount > old.userCount || follow.atBottom, let last = lastRowId else { return }
                DispatchQueue.main.async { proxy.scrollTo(last, anchor: .bottom) }
            }
            .environment(\.mdxFormHost, formHost)
            .onAppear {
                formHost.scrollTo = { id in withAnimation { proxy.scrollTo(id, anchor: .top) } }
                formHost.ask = { label in askAbout(label) }
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            // On the message list only: `.refreshable` reaches every ScrollView
            // below it, so placed after the inset it put a refresh control on the
            // composer's chip strip and let it be pulled down.
            .refreshable { await store.reload() }
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
                    MdxAnswerBar(host: formHost, running: store.busy)
                    Composer(
                        kind: .chat, draftKey: draftKey, draft: $draft, busy: store.busy,
                        placeholder: store.threadId == nil ? "Ask anything" : "Message",
                        onSend: send,
                        onStop: { await store.stop() },
                        onRetract: retract,
                        onNote: note,
                        onLearn: store.threadId == nil ? nil : { await store.learn(focus: $0) },
                        chatFormat: store.format.map { (value: $0, set: switchFormat) },
                        focusRequest: focusRequest,
                        voice: session.voiceAllowed ? (voice, toggleVoice) : nil)
                }
            }
        }
        .sheet(item: $sharing) { r in ShareLinkSheet(request: r).environment(session) }
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
        .onAppear {
            store.open()
            session.visibleThreadId = store.threadId
        }
        .onDisappear {
            voice.stop()
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

    /// At least this many of the last messages are always drawn.
    private static let eagerTail = 12
    private static let eagerStep = 8
    private static let activityId = "thread-activity"

    /// The row drawn last. A spacer row as the target instead hung the layout.
    private var lastRowId: String? { store.busy ? Self.activityId : store.messages.last?.id }

    /// What changes at the end of the list: a new row, a growing reply, the activity line.
    private var tailSignature: TailSignature {
        TailSignature(count: store.messages.count, lastId: store.messages.last?.id,
                      lastLength: store.messages.last?.content.count ?? 0, busy: store.busy,
                      userCount: store.messages.lazy.filter { $0.role == "user" }.count)
    }

    private func row(_ m: ChatMessage, _ i: Int, latest: String?) -> some View {
        MessageRow(message: m, store: store, isLatest: m.id == latest, submit: submitFromReply,
                   onShare: { turnId in
                       if let id = store.threadId { sharing = ShareRequest(source: .chat(threadId: id), anchorId: turnId) }
                   })
            .environment(\.mdxSource, MdxSource(key: "chat:\(store.threadId ?? ""):\(m.turnId ?? m.id)",
                                                scrollId: m.id, order: Double(i)))
            .id(m.id)
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
            if let folder = session.chats.folder(store.folderId) {
                Label("In \(folder.name)", systemImage: "folder").font(.footnote).foregroundStyle(.secondary)
            }
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

    /// A form's Ask: start the message with the question and put the caret after it.
    private func askAbout(_ label: String) {
        let prefix = "About “\(label)”: "
        if !draft.text.hasPrefix(prefix) { draft.text = prefix + draft.text }
        focusRequest += 1
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

    private func toggleVoice() {
        voice.toggle(client: session.client) { [store, draft] request in
            try await store.ask(request, personaId: store.threadId == nil ? draft.personaId : nil, private: draft.isPrivate)
        }
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

private final class ScrollFollow {
    var atBottom = true
}

private struct TailSignature: Equatable {
    var count: Int
    var lastId: String?
    var lastLength: Int
    var busy: Bool
    var userCount: Int
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
    /// Opens the Share sheet for this answer's turn.
    var onShare: ((String) -> Void)?

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
                        // Settled replies only: a streaming one would ask for half-typed URLs.
                        .environment(\.mdxRemoteImage, store.busy && isLatest ? nil : { await store.remoteImage($0) })
                }
                ForEach(message.images ?? [], id: \.id) { ref in GeneratedImage(ref: ref, store: store) }
                if let sources = message.sources, !sources.isEmpty { SourcesList(sources: sources) }
            }
            .contextMenu {
                // The reply as clean Markdown, without its component tags.
                Button("Copy") { UIPasteboard.general.string = MdxCopy.markdown(message.content) }
                if let onShare, let turn = message.turnId, !message.content.isEmpty, !store.busy || !isLatest {
                    Button("Share as Link…", systemImage: "square.and.arrow.up") { onShare(turn) }
                }
            }
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
