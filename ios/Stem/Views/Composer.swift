import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Which screen the composer sits on decides which desktop controls it carries.
enum ComposerKind: Equatable {
    /// A chat (new when the thread id is nil): model, effort, Fast, MDX, web
    /// search, `/note`, `/learn`, attachments, stop.
    case chat
    /// Mail reply or compose: text and attachments.
    case mail
}

/// The text field plus its controls, shared by chats and mail. Owns the draft
/// and persists it as you type.
struct Composer: View {
    let kind: ComposerKind
    let draftKey: String
    @Binding var draft: Draft
    var busy = false
    var placeholder = "Message"
    /// Send was pressed; return true once the message went out (clears the draft).
    var onSend: (_ text: String, _ attachments: [DraftAttachment]) async -> Bool
    var onStop: (() async -> Void)?
    /// Stop and pull the message back for editing.
    var onRetract: (() async -> Void)?
    /// `/note`: answers whether it saved and what to flash.
    var onNote: ((_ text: String, _ attachments: [DraftAttachment]) async -> (saved: Bool, message: String))?
    var onLearn: ((_ focus: String?) async -> String)?
    /// The open chat's own format and how to switch it. Nil on a draft, where
    /// the MDX chip sets the default for new chats instead.
    var chatFormat: (value: String, set: (String) -> Void)?
    /// Bump to put the caret in the text field (a form's Ask button). Above
    /// zero on first show, it focuses at once.
    var focusRequest = 0
    /// The chat's voice call and how to start or end it. Nil where voice chat isn't offered.
    var voice: (call: PhoneVoice, toggle: () -> Void)?
    /// Page layout (New mail): this header and a full-width editor scroll as
    /// one sheet of paper; attach, dictate and Send sit in a bar under it.
    var page: AnyView?
    /// Send's label in the page layout ("Send to Normal").
    var sendTitle: String?

    @Environment(Session.self) private var session
    @State private var noteMode = false
    @State private var sending = false
    @State private var flash: String?
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showCamera = false
    @State private var showModels = false
    @State private var dictation = PhoneDictation()
    @AppStorage(PhoneDictation.localeKey) private var dictationLocale = ""
    @AppStorage(PhoneDictation.introKey) private var dictationIntroSeen = false
    @State private var showDictationIntro = false
    @FocusState private var focused: Bool

    private var trimmed: String { draft.text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool {
        !sending && (!trimmed.isEmpty || !draft.attachments.isEmpty) && (!busy || noteMode)
    }

    var body: some View {
        Group {
            if let page { pageBody(page) } else { barBody }
        }
        .onChange(of: draft) { _, d in DraftStore.save(draftKey, d) }
        .task(id: focusRequest) {
            guard focusRequest > 0 else { return }
            // In a sheet the field can't take focus until the sheet has settled.
            try? await Task.sleep(for: .milliseconds(450))
            focused = true
        }
        .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: 10, matching: .images)
        .onChange(of: photoItems) { _, items in Task { await addPhotos(items) } }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in
            if case .success(let urls) = r { addFiles(urls) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                if let jpg = image.jpegData(compressionQuality: 0.85),
                   let a = DraftAttachment.make(data: jpg, name: "photo-\(Int(Date().timeIntervalSince1970)).jpg", mime: "image/jpeg") {
                    draft.attachments.append(a)
                }
            }
            .ignoresSafeArea()
        }
        .sheet(isPresented: $showModels) { ModelSheet().environment(session) }
        .sheet(isPresented: $showDictationIntro, onDismiss: { dictationIntroSeen = true }) {
            DictationIntroSheet(dictation: dictation) {
                dictation.toggle(current: draft.text) { draft.text = $0 }
            }
        }
    }

    /// A hand edit ends dictation (the next update would undo it), and `/note `
    /// switches to note mode.
    private func textEdited(_ new: String) {
        if dictation.active, new != dictation.lastWritten { dictation.freeze() }
        applyNotePrefix(new)
    }

    private func pageBody(_ header: AnyView) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    TextField(placeholder, text: $draft.text, axis: .vertical)
                        .lineLimit(10...)
                        .focused($focused)
                        .onChange(of: draft.text) { _, new in textEdited(new) }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    if !draft.attachments.isEmpty {
                        attachmentChips.padding(.horizontal, 16).padding(.bottom, 12)
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .interactiveDismissDisabled(sending)
            VStack(alignment: .leading, spacing: 6) {
                if let flash {
                    Text(flash).font(.footnote).foregroundStyle(.secondary).transition(.opacity)
                }
                HStack(spacing: 20) {
                    attachMenu
                    if PhoneDictation.supported { micButton }
                    Spacer()
                    Button { Task { await submit() } } label: {
                        HStack(spacing: 6) {
                            if sending { ProgressView().controlSize(.small).tint(.white) }
                            else { Image(systemName: "paperplane.fill") }
                            Text(sendTitle ?? "Send").lineLimit(1)
                        }
                        .font(.body.weight(.semibold))
                        .padding(.horizontal, 4)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .disabled(!canSend)
                    .accessibilityLabel(sendTitle ?? "Send")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.bar)
            .overlay(alignment: .top) { Divider() }
        }
    }

    private var barBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let flash {
                Text(flash)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                    .transition(.opacity)
            }
            if kind == .chat, draft.text.hasPrefix("/"), !noteMode { slashSuggestions }
            if !draft.attachments.isEmpty { attachmentChips }
            HStack(alignment: .bottom, spacing: 8) {
                attachMenu
                VStack(alignment: .leading, spacing: 4) {
                    if noteMode {
                        Button { noteMode = false } label: {
                            Label("Note to memory", systemImage: "xmark.circle.fill")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.borderless)
                        .tint(.orange)
                    }
                    HStack(alignment: .bottom, spacing: 6) {
                        TextField(noteMode ? "Note to memory" : placeholder, text: $draft.text, axis: .vertical)
                            .lineLimit(1...8)
                            .focused($focused)
                            .onChange(of: draft.text) { _, new in textEdited(new) }
                        if PhoneDictation.supported { micButton }
                        if let voice { voiceButton(voice.call, toggle: voice.toggle) }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
                sendButton
            }
            if kind == .chat { controlsRow }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    // MARK: Slash commands

    /// `/note ` or `//` at the very start switches to note mode, like the desktop.
    private func applyNotePrefix(_ text: String) {
        guard kind == .chat, onNote != nil, !noteMode else { return }
        if text.hasPrefix("/note ") {
            noteMode = true
            draft.text = String(text.dropFirst(6))
        } else if text.hasPrefix("//") {
            noteMode = true
            draft.text = String(text.dropFirst(2))
        }
    }

    private var slashSuggestions: some View {
        let typed = draft.text.split(separator: " ", maxSplits: 1).first.map(String.init) ?? draft.text
        let commands: [(String, String, String)] = [
            ("/note", "Save a note to memory", "brain"),
            ("/learn", "Save a skill from the last turn", "graduationcap"),
        ].filter { $0.0.hasPrefix(typed) && (typed != $0.0 || !draft.text.contains(" ")) }
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(commands, id: \.0) { c in
                Button {
                    if c.0 == "/note" { noteMode = true; draft.text = "" } else { draft.text = c.0 + " " }
                    focused = true
                } label: {
                    HStack {
                        Image(systemName: c.2).frame(width: 22)
                        Text(c.0).font(.body.monospaced())
                        Text(c.1).foregroundStyle(.secondary).font(.footnote)
                        Spacer()
                    }
                    .padding(.vertical, 8)
                    .padding(.horizontal, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: Attachments

    private var attachMenu: some View {
        Menu {
            Button { showPhotos = true } label: { Label("Photos", systemImage: "photo.on.rectangle") }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button { showCamera = true } label: { Label("Camera", systemImage: "camera") }
            }
            Button { showFiles = true } label: { Label("Files", systemImage: "folder") }
            Button { pasteImage() } label: { Label("Paste image", systemImage: "doc.on.clipboard") }
                .disabled(!UIPasteboard.general.hasImages)
            if kind == .chat {
                Divider()
                if onNote != nil {
                    Button { noteMode.toggle(); focused = true } label: {
                        Label(noteMode ? "Back to message" : "Note to memory", systemImage: "brain")
                    }
                }
                if onLearn != nil {
                    Button { draft.text = "/learn "; focused = true } label: {
                        Label("Learn a skill from the last turn", systemImage: "graduationcap")
                    }
                }
            }
        } label: {
            if page != nil {
                Image(systemName: "paperclip")
                    .font(.system(size: 18))
                    .foregroundStyle(.secondary)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            } else {
                Image(systemName: "plus")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 36, height: 36)
                    .background(Color(.secondarySystemBackground), in: Circle())
            }
        }
        .tint(page != nil ? .secondary : nil)
        .accessibilityLabel("Attach")
    }

    private var attachmentChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(draft.attachments) { a in
                    HStack(spacing: 6) {
                        if a.isImage, let d = a.data, let img = UIImage(data: d) {
                            Image(uiImage: img).resizable().scaledToFill().frame(width: 28, height: 28).clipShape(RoundedRectangle(cornerRadius: 6))
                        } else {
                            Image(systemName: "doc")
                        }
                        Text(a.name).font(.caption).lineLimit(1).frame(maxWidth: 120)
                        Button {
                            draft.attachments.removeAll { $0.id == a.id }
                            a.delete()
                        } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .buttonStyle(.borderless)
                    }
                    .padding(6)
                    .background(Color(.secondarySystemBackground), in: Capsule())
                }
            }
        }
    }

    private func addPhotos(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let type = item.supportedContentTypes.first
            let mime = type?.preferredMIMEType ?? "image/jpeg"
            let ext = type?.preferredFilenameExtension ?? "jpg"
            if let a = DraftAttachment.make(data: data, name: "photo-\(draft.attachments.count + 1).\(ext)", mime: mime) {
                draft.attachments.append(a)
            }
        }
        photoItems = []
    }

    private func addFiles(_ urls: [URL]) {
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { continue }
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            if let a = DraftAttachment.make(data: data, name: url.lastPathComponent, mime: mime) {
                draft.attachments.append(a)
            }
        }
    }

    private func pasteImage() {
        for img in UIPasteboard.general.images ?? [] {
            if let png = img.pngData(), let a = DraftAttachment.make(data: png, name: "pasted-\(draft.attachments.count + 1).png", mime: "image/png") {
                draft.attachments.append(a)
            }
        }
    }

    // MARK: Dictation

    /// Tap to dictate, tap again to stop; hold for the language. The first tap
    /// explains this instead of listening.
    private func voiceButton(_ call: PhoneVoice, toggle: @escaping () -> Void) -> some View {
        Button(action: toggle) {
            Group {
                switch call.phase {
                case .connecting: ProgressView().controlSize(.small)
                case .live:
                    Image(systemName: "waveform.circle.fill")
                        .symbolEffect(.pulse, isActive: call.activity != .listening)
                        .foregroundStyle(Color.accentColor)
                case .idle: Image(systemName: "waveform")
                }
            }
            .font(.system(size: 17))
            .frame(width: 24, height: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.secondary)
        .accessibilityLabel(call.active ? "End voice chat" : "Voice chat")
        .onChange(of: call.error) { _, error in
            if let error { show(error, seconds: 6) }
        }
        .onChange(of: call.activity) { _, a in
            if a == .working { show("Stem is working on it…") }
        }
    }

    private var micButton: some View {
        Menu {
            Picker("Language", selection: $dictationLocale) {
                Text("Phone language").tag("")
                ForEach(dictation.languages, id: \.id) { Text($0.name).tag($0.id) }
            }
        } label: {
            Group {
                switch dictation.phase {
                case .idle: Image(systemName: "mic")
                case .listening: Image(systemName: "stop.circle.fill").foregroundStyle(.red)
                default: ProgressView().controlSize(.small)
                }
            }
            .font(.system(size: 17))
            .frame(width: 24, height: 22)
            .contentShape(Rectangle())
        } primaryAction: {
            if dictationIntroSeen || dictation.active {
                dictation.toggle(current: draft.text) { draft.text = $0 }
            } else {
                showDictationIntro = true
            }
        }
        .foregroundStyle(.secondary)
        .accessibilityLabel(dictation.phase == .listening ? "Stop dictating" : "Dictate")
        .task { await dictation.loadLanguages() }
        .onChange(of: dictation.phase) { _, phase in
            if phase == .downloading { show("Downloading the speech model…", seconds: 6) }
        }
        .onChange(of: dictation.error) { _, error in
            if let error { show(error, seconds: 6) }
        }
        .onDisappear { dictation.freeze() }
    }

    // MARK: Send / stop

    private var sendButton: some View {
        Group {
            if busy && !noteMode, onStop != nil {
                Button { Task { await onStop?() } } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(Color.red, in: Circle())
                }
                .contextMenu {
                    if onRetract != nil {
                        Button { Task { await onRetract?() } } label: {
                            Label("Stop and edit message", systemImage: "arrow.uturn.backward")
                        }
                    }
                }
                .accessibilityLabel("Stop")
            } else {
                Button { Task { await submit() } } label: {
                    Group {
                        if sending { ProgressView().tint(.white) }
                        else { Image(systemName: noteMode ? "brain" : "arrow.up").font(.system(size: 16, weight: .bold)) }
                    }
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(canSend ? (noteMode ? Color.orange : Color.accentColor) : Color.gray.opacity(0.4), in: Circle())
                }
                .disabled(!canSend)
                .accessibilityLabel(noteMode ? "Save note" : "Send")
            }
        }
    }

    private func submit() async {
        guard canSend else { return }
        dictation.freeze()
        let text = trimmed
        let files = draft.attachments
        sending = true
        defer { sending = false }

        if noteMode, let onNote {
            let r = await onNote(text, files)
            show(r.message)
            if r.saved {
                clearDraft(keepingMeta: true)
                noteMode = false
            }
            return
        }

        if kind == .chat, let onLearn, text == "/learn" || text.hasPrefix("/learn ") {
            let focus = text.dropFirst(6).trimmingCharacters(in: .whitespaces)
            show("Learning…")
            let msg = await onLearn(focus.isEmpty ? nil : focus)
            clearDraft(keepingMeta: true)
            show(msg, seconds: 8)
            return
        }

        // In a chat the field empties at once; the message waits in the transcript
        // while its attachments upload, and comes back here if the send fails.
        // A page (new mail) has no transcript: the text stays put — and saved —
        // until the send lands, so closing the sheet or losing the app mid-upload
        // never loses it.
        let sent = draft
        if page == nil {
            draft.text = ""
            draft.attachments = []
        }
        if await onSend(text, files) {
            files.forEach { $0.delete() }
            var fresh = Draft()
            fresh.personaId = draft.personaId
            fresh.isPrivate = draft.isPrivate
            fresh.to = draft.to
            if page == nil {
                // Whatever was typed while it sent stays for the next message.
                fresh.text = draft.text
                fresh.attachments = draft.attachments
            }
            draft = fresh
        } else if page == nil {
            draft.text = draft.text.isEmpty ? sent.text : sent.text + "\n" + draft.text
            draft.attachments = sent.attachments + draft.attachments
        } else {
            show("Not sent — your mail is still here.", seconds: 6)
        }
    }

    private func clearDraft(keepingMeta: Bool) {
        let old = draft
        var fresh = Draft()
        if keepingMeta {
            fresh.personaId = old.personaId
            fresh.isPrivate = old.isPrivate
            fresh.to = old.to
        }
        draft.attachments.forEach { $0.delete() }
        draft = fresh
    }

    private func show(_ text: String, seconds: Double = 3) {
        withAnimation { flash = text }
        Task {
            try? await Task.sleep(for: .seconds(seconds))
            if flash == text { withAnimation { flash = nil } }
        }
    }

    // MARK: Model, effort, Fast, MDX, web

    private var controlsRow: some View {
        let model = session.currentModel
        let effort = model.map { m in session.prefs.effort.flatMap { m.supportedEfforts.contains($0) ? $0 : nil } ?? m.defaultEffort }
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Button { showModels = true } label: {
                    HStack(spacing: 4) {
                        if let e = effort, !(model?.supportedEfforts.isEmpty ?? true) {
                            Text(EffortLabel.text(e)).foregroundStyle(.secondary)
                            Text("·").foregroundStyle(.tertiary)
                        }
                        Text(model?.displayName ?? "Model")
                        Image(systemName: "chevron.down").font(.caption2)
                    }
                }
                .chipStyle(on: false)
                .disabled(busy)

                if model?.hasFast == true {
                    Toggle(isOn: Binding(
                        get: { session.prefs.serviceTier == "priority" },
                        set: { session.prefs.serviceTier = $0 ? "priority" : nil; session.prefs.save() })
                    ) { Label("Fast", systemImage: "bolt.fill") }
                        .toggleStyle(ChipToggle())
                        .disabled(busy)
                }
                Toggle(isOn: Binding(get: { session.webSearch }, set: { session.setWebSearch($0) })) {
                    Label("Web", systemImage: "globe")
                }
                .toggleStyle(ChipToggle())
                Toggle(isOn: Binding(
                    get: { (chatFormat?.value ?? session.prefs.format) == "mdx" },
                    set: { on in
                        let next = on ? "mdx" : "md"
                        if let chatFormat { chatFormat.set(next) }
                        else { session.prefs.format = next; session.prefs.save() }
                    })
                ) { Text("MDX") }
                    .toggleStyle(ChipToggle())
                    .disabled(busy)
            }
            .font(.footnote)
        }
    }
}

struct ChipToggle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: { configuration.label }
            .chipStyle(on: configuration.isOn)
    }
}

extension View {
    func chipStyle(on: Bool) -> some View {
        self.buttonStyle(.plain)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .foregroundStyle(on ? Color.white : Color.primary)
            .background(on ? Color.accentColor : Color(.secondarySystemBackground), in: Capsule())
    }
}

/// Model picker with effort and speed, the phone's version of the desktop's
/// effort slider + searchable model list.
struct ModelSheet: View {
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                if let m = session.currentModel, !m.supportedEfforts.isEmpty {
                    Section("Reasoning effort") {
                        Picker("Effort", selection: Binding(
                            get: { session.prefs.effort.flatMap { m.supportedEfforts.contains($0) ? $0 : nil } ?? m.defaultEffort },
                            set: { session.prefs.effort = $0; session.prefs.save() })
                        ) {
                            ForEach(m.supportedEfforts, id: \.self) { Text(EffortLabel.text($0)).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    }
                }
                ForEach(groups, id: \.0) { provider, models in
                    Section(provider) {
                        ForEach(models) { m in
                            Button {
                                session.selectModel(m.id)
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(m.displayName).foregroundStyle(.primary)
                                        if !m.description.isEmpty {
                                            Text(m.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                        }
                                    }
                                    Spacer()
                                    if m.id == session.currentModel?.id { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                                }
                            }
                        }
                    }
                }
            }
            .searchable(text: $query, prompt: "Search models")
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private var groups: [(String, [ModelSummary])] {
        let q = query.lowercased()
        let filtered = session.models.filter {
            q.isEmpty || $0.displayName.lowercased().contains(q) || $0.id.lowercased().contains(q) || $0.providerName.lowercased().contains(q)
        }
        var order: [String] = []
        var map: [String: [ModelSummary]] = [:]
        for m in filtered {
            if map[m.providerName] == nil { order.append(m.providerName) }
            map[m.providerName, default: []].append(m)
        }
        return order.map { ($0, map[$0]!) }
    }
}

struct CameraPicker: UIViewControllerRepresentable {
    var onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController()
        p.sourceType = .camera
        p.delegate = context.coordinator
        return p
    }

    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ p: CameraPicker) { parent = p }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let img = info[.originalImage] as? UIImage { parent.onImage(img) }
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}
