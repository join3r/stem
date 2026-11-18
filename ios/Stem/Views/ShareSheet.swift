import SwiftUI

/// Publish an answer, the question and answer, or the whole chat / mail thread
/// as a public link (docs/public-share-design.md). Opened from an answer's
/// context menu. The preview is the snapshot as it will be uploaded.
struct ShareLinkSheet: View {
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    let request: ShareRequest

    @State private var status: ShareStatus?
    @State private var scope: ShareScope = .pair
    @State private var includeModel = true
    @State private var includeAttachments = false
    @State private var ttlDays = ShareLimits.ttlChoices[0]
    @State private var preview: ShareDraftPreview?
    @State private var cardOn = true
    @State private var cardTitle: String?
    @State private var cardDesc: String?
    @State private var error: String?
    @State private var busy = false
    @State private var link: SharedLink?
    @State private var revoked = false
    @State private var copied = false

    private var title: String { cardTitle ?? preview?.card?.title ?? "" }
    private var desc: String { cardDesc ?? preview?.card?.description ?? "" }

    var body: some View {
        NavigationStack {
            Form {
                if let link { done(link) } else { compose }
            }
            .navigationTitle(link == nil ? "Share as a link" : (revoked ? "Link revoked" : "Link ready"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(link == nil ? "Cancel" : "Done") { dismiss() }
                }
                if link == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(busy ? "Publishing…" : "Create link") { Task { await publish() } }
                            .disabled(busy || preview == nil || status?.available != true)
                    }
                }
            }
        }
        .task { await loadStatus() }
        .task(id: "\(scope.rawValue)|\(includeModel)|\(includeAttachments)") { await loadPreview() }
    }

    @ViewBuilder private var compose: some View {
        if let status, !status.available {
            Section {
                Label(status.message ?? "Sharing is not available.", systemImage: "exclamationmark.circle")
                if status.code == "no_address" {
                    Text("Verify an address in the desktop app: Settings → Features → Your email address.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        Section {
            Picker("What to share", selection: $scope) {
                Text(request.source.isMail ? "Whole thread" : "Whole chat").tag(ShareScope.thread)
                Text("Q & A").tag(ShareScope.pair)
                Text("Answer").tag(ShareScope.answer)
            }
            .pickerStyle(.segmented)
        }
        Section("Preview") {
            if let preview {
                Text(preview.snapshot.title).font(.headline)
                ForEach(Array(preview.snapshot.messages.enumerated()), id: \.offset) { _, m in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(m.role == "user" ? "Question" : (m.author ?? "Stem")).font(.caption.weight(.semibold))
                            if let model = m.model { Text(model).font(.caption).foregroundStyle(.secondary) }
                        }
                        if m.role == "user" { Text(m.text) } else { MarkdownView(m.text) }
                        if let n = m.images?.count, n > 0 {
                            Text(n == 1 ? "1 picture" : "\(n) pictures").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            } else if error == nil {
                ProgressView()
            }
        }
        Section {
            Toggle("Show which model answered", isOn: $includeModel)
            if includeAttachments || (preview?.omittedAttachments ?? 0) > 0 {
                Toggle("Include my pictures", isOn: $includeAttachments)
            }
            Picker("Expires", selection: $ttlDays) {
                ForEach(ShareLimits.ttlChoices, id: \.self) { d in Text(d == 1 ? "In 1 day" : "In \(d) days").tag(d) }
            }
        } footer: {
            Text("Tool steps, memory cards and in-app links are left out. Anyone with the link can read the preview above.")
        }
        Section {
            Toggle("Preview in chat apps", isOn: $cardOn)
            if cardOn {
                TextField("Title", text: Binding(get: { title }, set: { cardTitle = String($0.prefix(ShareLimits.cardTitleMax)) }))
                TextField("Description", text: Binding(get: { desc }, set: { cardDesc = String($0.prefix(ShareLimits.cardDescMax)) }),
                          axis: .vertical)
                    .lineLimit(2...4)
            }
        } footer: {
            if cardOn {
                Text("Shown when the link is pasted in a chat app. Unlike the page, this preview is not encrypted. Search engines are told not to index any of it.")
            }
        }
        if let error { Section { Text(error).foregroundStyle(.red) } }
    }

    @ViewBuilder private func done(_ link: SharedLink) -> some View {
        if revoked {
            Section { Text("The link no longer opens.") }
        } else {
            Section {
                Text(link.url).font(.footnote.monospaced()).textSelection(.enabled)
                if let url = URL(string: link.url) {
                    ShareLink(item: url) { Label("Share…", systemImage: "square.and.arrow.up") }
                }
                Button {
                    UIPasteboard.general.string = link.url
                    copied = true
                } label: { Label(copied ? "Copied" : "Copy link", systemImage: copied ? "checkmark" : "doc.on.doc") }
            } footer: {
                Text("Works until \(Date(timeIntervalSince1970: link.expiresAt / 1000).formatted(date: .long, time: .omitted)). The key is the part after #, so only people you give the link to can read it.")
            }
            Section {
                Button("Revoke", role: .destructive) { Task { await revoke(link) } }.disabled(busy)
            }
        }
        if let error { Section { Text(error).foregroundStyle(.red) } }
    }

    private var options: JSONValue {
        var o: [String: JSONValue] = [
            "scope": .string(scope.rawValue),
            "anchorId": .string(request.anchorId),
            "includeModel": .bool(includeModel),
            "includeAttachments": .bool(includeAttachments),
            "ttlDays": .number(Double(ttlDays))
        ]
        o["card"] = cardOn ? .object(["title": .string(title), "description": .string(desc)]) : .null
        // Publish the snapshot on screen, not a fresh build.
        if let draftId = preview?.draftId { o["draftId"] = .string(draftId) }
        return .object(o)
    }

    private func loadStatus() async {
        do { status = try await session.client.call("share:status", as: ShareStatus.self) }
        catch { self.error = error.localizedDescription }
    }

    private func loadPreview() async {
        preview = nil
        do {
            preview = try await session.client.call("share:preview", [request.source.json, options], as: ShareDraftPreview.self)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func publish() async {
        busy = true
        defer { busy = false }
        do {
            let made = try await session.client.call("share:create", [request.source.json, options], as: SharedLink.self)
            link = made
            error = nil
            UIPasteboard.general.string = made.url
            copied = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func revoke(_ link: SharedLink) async {
        busy = true
        defer { busy = false }
        do {
            try await session.client.run("share:revoke", [.string(link.id)])
            revoked = true
        } catch {
            self.error = error.localizedDescription
        }
    }
}
