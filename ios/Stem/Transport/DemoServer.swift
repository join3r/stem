import Foundation

/// "Try the demo" on the pair screen: a stand-in for the server that keeps
/// sample chats and mail in memory, answers every channel the app calls, and
/// plays replies back as stream events. `StemClient` and `Connection` hand
/// everything to it instead of the network, so the demo never opens a
/// connection: it can't reach anyone's Stem and nothing it "does" (approved
/// commands, sent mail) happens anywhere. Built for App Review, who have no
/// server to pair with. Nothing is saved; leaving the demo forgets it all.
@MainActor
final class DemoServer {
    static let modelId = "demo"
    static let credentials = Credentials(serverUrl: "Demo (no server)", deviceId: "demo", token: "")

    weak var connection: Connection?

    private var chats: [ChatSummary] = []
    private var folders: [ChatFolder] = []
    private var chatInbox = InboxState()
    private var histories: [String: [ChatMessage]] = [:]
    private var conversations: [MailConversation] = []
    private var items: [MailItem] = []
    private var mailInbox = InboxState()
    private var execApprovals: [ExecApprovalRequest] = []
    /// turnId → the chat it runs in and the task playing it.
    private var turns: [String: (threadId: String, task: Task<Void, Never>)] = [:]
    private var mailTasks: [String: Task<Void, Never>] = [:]
    private var webSearch = false
    private var seq = 0

    init() { seed() }

    // MARK: Stream

    func snapshot() -> (live: [LiveTurnInfo], exec: [ExecApprovalRequest]) {
        (turns.map { LiveTurnInfo(threadId: $0.value.threadId, turnId: $0.key) }, execApprovals)
    }

    private func push(_ channel: String, _ payload: JSONValue = .null) {
        connection?.receivePush(channel: channel, payload: payload)
    }

    private func event(_ method: String, _ params: [String: JSONValue]) {
        push("backend:event", ["method": .string(method), "params": .object(params)])
    }

    // MARK: RPC

    func handle(_ channel: String, _ args: [JSONValue]) async throws -> JSONValue {
        func arg(_ i: Int) -> JSONValue { i < args.count ? args[i] : .null }
        func str(_ i: Int) -> String { arg(i).stringValue ?? "" }
        func strings(_ i: Int) -> [String] {
            if case .array(let a) = arg(i) { return a.compactMap(\.stringValue) }
            return []
        }
        func bool(_ i: Int) -> Bool { if case .bool(let b) = arg(i) { return b }; return false }

        switch channel {
        // Shared lists
        case "personas:list":
            return .from([
                Persona(id: "assistant", name: "Assistant", clients: true, builtin: true),
                Persona(id: "researcher", name: "Researcher", clients: true, builtin: false),
            ])
        case "backend:listModels":
            return .from([ModelSummary(
                id: Self.modelId, displayName: "Demo model", description: "Prepared replies for the demo",
                provider: "demo", providerName: "Demo", supportedEfforts: ["low", "medium", "high"],
                defaultEffort: "medium", serviceTiers: [], isDefault: true)])
        case "settings:get":
            return settings()
        case "settings:updateWebSearch":
            if case .bool(let on)? = arg(0)["main"] { webSearch = on }
            return settings()
        case "settings:updateDefaults", "devices:registerPush", "devices:revoke", "chats:setFormat":
            return .null

        // Chats
        case "chats:list":
            return chatList()
        case "chats:open", "chats:history":
            let id = str(0)
            guard let chat = chats.first(where: { $0.threadId == id }) else { throw StemError(message: "That chat is gone.") }
            return .from(ChatHistory(threadId: id, title: chat.title, messages: histories[id] ?? []))
        case "inbox:setRead":
            for id in strings(0) { setRead(&chatInbox, id, bool(1)) }
            return chatList()
        case "inbox:setArchived":
            for id in strings(0) { setArchived(&chatInbox, id, bool(1)) }
            return chatList()
        case "chats:setFolder":
            let folder = arg(1).stringValue
            if let i = chats.firstIndex(where: { $0.threadId == str(0) }) { chats[i].folderId = folder }
            return chatList()
        case "folders:create":
            seq += 1
            folders.append(ChatFolder(id: "demo-folder-\(seq)", name: str(0), parentId: arg(1).stringValue,
                                      order: Double(folders.count)))
            return chatList()
        case "folders:rename":
            if let i = folders.firstIndex(where: { $0.id == str(0) }) { folders[i].name = str(1) }
            return chatList()
        case "folders:delete":
            let id = str(0)
            let parent = folders.first { $0.id == id }?.parentId
            folders.removeAll { $0.id == id }
            for i in folders.indices where folders[i].parentId == id { folders[i].parentId = parent }
            for i in chats.indices where chats[i].folderId == id { chats[i].folderId = parent }
            return chatList()
        case "chats:delete":
            let id = str(0)
            for (turn, t) in turns where t.threadId == id { t.task.cancel(); turns[turn] = nil }
            chats.removeAll { $0.threadId == id }
            histories[id] = nil
            execApprovals.removeAll { $0.threadId == id }
            push("chats:changed")
            return .null
        case "chats:rollbackToTurn":
            let id = str(0), turn = str(1)
            if let all = histories[id], let i = all.firstIndex(where: { $0.turnId == turn }) {
                histories[id] = Array(all[..<i])
            }
            return .null
        case "backend:startTurn":
            return startTurn(arg(0))
        case "backend:interruptTurn":
            interrupt(str(0))
            return .null
        case "exec:resolveApproval":
            return .bool(resolveExec(str(0), str(1)))
        case "memory:addNote":
            return ["saved": true]
        case "skills:learn":
            return ["ok": true, "message": "The demo doesn't save skills. In your own Stem this saves one from the last reply."]
        case "memory:checkState":
            return []
        case "chats:image", "chats:remoteImage":
            return .null

        // Mail
        case "mail:summary", "mail:list":
            return mailList()
        case "mail:open":
            let id = str(0)
            return ["items": .from(items.filter { $0.conversationId == id })]
        case "mail:reply":
            try reply(str(0), body: str(1), attachments: arg(2))
            return .null
        case "mail:compose":
            compose(arg(0))
            return .null
        case "mail:resolveApproval":
            return resolveMailApproval(str(0), allow: str(1) == "allow")
        case "mail:setRead":
            for id in strings(0) { setRead(&mailInbox, id, bool(1)) }
            push("mail:changed")
            return .null
        case "mail:setArchived":
            for id in strings(0) { setArchived(&mailInbox, id, bool(1)) }
            push("mail:changed")
            return .null
        case "mail:delete":
            let id = str(0)
            mailTasks[id]?.cancel()
            conversations.removeAll { $0.id == id }
            items.removeAll { $0.conversationId == id }
            push("mail:changed")
            return .null
        case "mail:stop":
            let id = str(0)
            mailTasks[id]?.cancel()
            mailTasks[id] = nil
            updateConversation(id) { $0.status = "aborted" }
            push("mail:changed")
            return .null
        case "mail:addParticipant":
            updateConversation(str(0)) { if !$0.participants.contains(str(1)) { $0.participants.append(str(1)) } }
            push("mail:changed")
            return .null

        // Not part of the demo: these would reach other people or the internet.
        case "share:status", "share:preview", "share:create", "share:revoke":
            throw StemError(message: "Sharing isn't available in the demo.")
        case "voice:check", "voice:connect":
            throw StemError(message: "Voice chat isn't available in the demo.")
        case "interstem:status":
            throw StemError(message: "Mail with other people isn't available in the demo.")
        default:
            if channel.hasPrefix("interstem:") || channel.hasSuffix("External") || channel == "mail:release" {
                throw StemError(message: "Mail with other people isn't available in the demo.")
            }
            return .null
        }
    }

    // MARK: Chats

    private func settings() -> JSONValue {
        [
            "webSearch": ["main": .bool(webSearch)],
            "defaults": ["model": .string(Self.modelId)],
            "customInstructions": ["main": "", "quickChat": ""],
            "chatFeatures": ["voice": ["allow": false]],
        ]
    }

    private func chatList() -> JSONValue {
        .from(ChatListResult(chats: chats, folders: folders, inbox: chatInbox))
    }

    private func touchChat(_ id: String, preview: String) {
        guard let i = chats.firstIndex(where: { $0.threadId == id }) else { return }
        chats[i].updatedAt = Self.nowS
        chats[i].preview = Self.plain(preview)
    }

    private func startTurn(_ input: JSONValue) -> JSONValue {
        let text = input["input"]?.stringValue ?? ""
        let turn = input["turnId"]?.stringValue ?? UUID().uuidString.lowercased()
        var names: [String] = []
        if case .array(let files)? = input["attachments"] { names = files.compactMap { $0["name"]?.stringValue } }
        let threadId: String
        if let id = input["threadId"]?.stringValue, chats.contains(where: { $0.threadId == id }) {
            threadId = id
        } else {
            seq += 1
            threadId = "demo-chat-\(seq)"
            let firstLine = text.split(separator: "\n").first.map(String.init) ?? "New chat"
            let title = firstLine.count > 40 ? String(firstLine.prefix(40)) + "…" : firstLine
            chats.append(ChatSummary(
                threadId: threadId, title: title, private: input["private"] == .bool(true) ? true : nil,
                format: input["format"]?.stringValue == "md" ? "md" : nil, createdAt: Self.nowS, updatedAt: Self.nowS))
        }
        histories[threadId, default: []].append(ChatMessage(
            id: "user-\(turn)", role: "user", content: text,
            attachments: names.isEmpty ? nil : names.map { MessageAttachment(kind: "file", name: $0) },
            turnId: turn, runtimeTurnId: turn, createdAt: Self.iso(Date())))
        touchChat(threadId, preview: text)
        push("chats:changed")
        play(threadId: threadId, turn: turn, reply: Self.reply(to: text, files: names))
        return ["threadId": .string(threadId), "turnId": .string(turn)]
    }

    /// Streams a prepared reply like a model would: a moment of thinking,
    /// optionally a tool row, then the text in small pieces.
    private func play(threadId: String, turn: String, reply: String, tool: (type: String, detail: String)? = nil) {
        let base: [String: JSONValue] = ["threadId": .string(threadId), "turnId": .string(turn)]
        let task = Task { [weak self] in
            func pause(_ ms: Int) async -> Bool {
                try? await Task.sleep(for: .milliseconds(ms))
                return !Task.isCancelled && self != nil
            }
            guard await pause(300) else { return }
            self?.event("item/started", base.merging(["item": ["type": "reasoning", "id": .string("reasoning-\(turn)")]]) { $1 })
            guard await pause(800) else { return }
            if let tool {
                let item: JSONValue = ["type": .string(tool.type), "id": .string("tool-\(turn)"), "detail": .string(tool.detail)]
                self?.event("item/started", base.merging(["item": item]) { $1 })
                guard await pause(1200) else { return }
                var done = item
                if case .object(var o) = done { o["status"] = "ok"; done = .object(o) }
                self?.event("item/completed", base.merging(["item": done]) { $1 })
            }
            var offset = 0
            for piece in Self.pieces(reply) {
                self?.event("item/agentMessage/delta", base.merging([
                    "delta": .string(piece), "offset": .number(Double(offset)),
                ]) { $1 })
                offset += piece.utf16.count
                guard await pause(35) else { return }
            }
            self?.finish(threadId: threadId, turn: turn, reply: reply)
        }
        turns[turn] = (threadId, task)
    }

    private func finish(threadId: String, turn: String, reply: String) {
        guard turns.removeValue(forKey: turn) != nil else { return }
        let base: [String: JSONValue] = ["threadId": .string(threadId), "turnId": .string(turn)]
        histories[threadId, default: []].append(ChatMessage(
            id: "assistant-\(turn)", role: "assistant", content: reply, meta: MessageMeta(model: "Demo model"),
            turnId: turn, runtimeTurnId: turn, createdAt: Self.iso(Date())))
        touchChat(threadId, preview: reply)
        event("item/completed", base.merging(["item": ["type": "agentMessage", "id": .string("assistant-\(turn)"), "text": .string(reply)]]) { $1 })
        event("turn/completed", base)
        push("chats:changed")
    }

    private func interrupt(_ turn: String) {
        guard let t = turns.removeValue(forKey: turn) else { return }
        t.task.cancel()
        event("turn/aborted", ["threadId": .string(t.threadId), "turnId": .string(turn)])
        push("chats:changed")
    }

    private func resolveExec(_ id: String, _ decision: String) -> Bool {
        guard let i = execApprovals.firstIndex(where: { $0.id == id }) else { return false }
        let r = execApprovals.remove(at: i)
        push("exec:approvalResolved", ["id": .string(id)])
        let turn = UUID().uuidString.lowercased()
        if decision == "deny" {
            play(threadId: r.threadId, turn: turn, reply: "Okay, I left everything where it is. The installers are still in Downloads; ask again whenever you want them gone.")
        } else {
            play(threadId: r.threadId, turn: turn,
                 reply: "Done. I moved **12 installers** older than 30 days to the Trash, which frees **3.4 GB**. Nothing else in Downloads changed, and you can put them back from the Trash.\n\n_This is the demo: no command ran and no files moved._",
                 tool: ("commandExecution", "find ~/Downloads -name '*.dmg' -mtime +30"))
        }
        return true
    }

    // MARK: Mail

    private func mailList() -> JSONValue {
        .from(MailListResult(conversations: conversations, items: items, inbox: mailInbox))
    }

    private func updateConversation(_ id: String, _ change: (inout MailConversation) -> Void) {
        if let i = conversations.firstIndex(where: { $0.id == id }) { change(&conversations[i]) }
    }

    private func addItem(_ conversationId: String, from: String, to: [String], body: String,
                         attachments: [MessageAttachment]? = nil, approval: MailApproval? = nil) {
        seq += 1
        let now = Self.nowMs
        items.append(MailItem(id: "demo-mail-\(seq)", conversationId: conversationId, from: from, to: to, body: body,
                              at: now, attachments: attachments, approval: approval))
        updateConversation(conversationId) { c in
            c.updatedAt = now
            if from == "user" { c.userSentAt = now }
            if to.contains("user") { c.userUpdatedAt = now }
        }
    }

    private func reply(_ id: String, body: String, attachments: JSONValue) throws {
        guard let c = conversations.first(where: { $0.id == id }) else { throw StemError(message: "That conversation is gone.") }
        var files: [MessageAttachment]?
        if case .array(let a) = attachments {
            files = a.compactMap { $0["name"]?.stringValue }.map { MessageAttachment(kind: "file", name: $0) }
        }
        let persona = c.participants.first { !$0.hasPrefix("task:") } ?? "assistant"
        addItem(id, from: "user", to: [persona], body: body, attachments: files)
        updateConversation(id) { $0.status = "working" }
        push("mail:changed")
        answerLater(id, from: persona, body: Self.mailReply(conversation: id, to: body))
    }

    private func compose(_ input: JSONValue) {
        var to: [String] = []
        if case .array(let a)? = input["to"] { to = a.compactMap(\.stringValue) }
        if to.isEmpty { to = ["assistant"] }
        let body = input["body"]?.stringValue ?? ""
        let subject = input["subject"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
            ?? String(body.split(separator: "\n").first ?? "New mail").prefix(60).description
        seq += 1
        let id = "demo-conv-\(seq)"
        let now = Self.nowMs
        conversations.append(MailConversation(
            id: id, subject: subject, participants: to,
            private: input["private"] == .bool(true) ? true : nil, status: "working",
            updatedAt: now, userUpdatedAt: now, createdAt: now))
        addItem(id, from: "user", to: to, body: body)
        push("mail:changed")
        answerLater(id, from: to[0], body: Self.mailReply(conversation: id, to: body))
    }

    private func answerLater(_ id: String, from persona: String, body: String, delay: Int = 2500) {
        mailTasks[id]?.cancel()
        mailTasks[id] = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.addItem(id, from: persona, to: ["user"], body: body)
            self.updateConversation(id) { $0.status = "idle" }
            self.mailTasks[id] = nil
            self.push("mail:changed")
        }
    }

    private func resolveMailApproval(_ itemId: String, allow: Bool) -> JSONValue {
        guard let i = items.firstIndex(where: { $0.id == itemId }), items[i].approval?.status == "pending" else {
            return ["ok": false, "error": "That request was already answered."]
        }
        items[i].approval?.status = allow ? "allowed" : "denied"
        let id = items[i].conversationId
        let persona = items[i].from
        updateConversation(id) { c in
            c.userAnsweredAt = Self.nowMs
            c.status = "working"
        }
        push("mail:changed")
        answerLater(id, from: persona, body: allow
            ? "Added. Your calendar now has:\n\n- **Fri 07:42** train to Vienna (platform 3)\n- **Sat 10:00** Albertina tickets\n- **Sun 18:10** train home\n\n_This is the demo: your calendar was not changed._"
            : "Okay, I didn't add anything to your calendar. Ask again whenever you want the events in.",
            delay: 1800)
        return ["ok": true]
    }

    // MARK: Inbox

    private func setRead(_ inbox: inout InboxState, _ id: String, _ read: Bool) {
        var e = inbox.entries[id] ?? InboxEntry()
        if read { e.readAt = Self.nowMs; e.forcedUnread = nil } else { e.readAt = nil; e.forcedUnread = true }
        inbox.entries[id] = e
    }

    private func setArchived(_ inbox: inout InboxState, _ id: String, _ archived: Bool) {
        var e = inbox.entries[id] ?? InboxEntry()
        e.archivedAt = archived ? Self.nowMs : nil
        inbox.entries[id] = e
    }

    // MARK: Helpers

    static var nowS: Double { Date().timeIntervalSince1970 }
    static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    /// A row preview: the reply's text without Markdown marks.
    static func plain(_ text: String) -> String {
        let stripped = text.replacingOccurrences(of: #"[*_#>|`]+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        return String(stripped.prefix(140))
    }

    static func iso(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }

    /// A reply in word-sized pieces, the way a model's deltas arrive.
    static func pieces(_ text: String) -> [String] {
        var out: [String] = []
        var cur = ""
        for ch in text {
            cur.append(ch)
            if (ch == " " || ch == "\n") && cur.count >= 6 { out.append(cur); cur = "" }
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }

    static func reply(to text: String, files: [String]) -> String {
        let t = text.lowercased()
        let note = "\n\n_This is the demo, so the reply was prepared in advance. In your own Stem, the model you choose writes it, with your memory and the tools you allow._"
        if !files.isEmpty {
            return "Thanks, I have **\(files.joined(separator: ", "))**. In your own Stem I would read \(files.count == 1 ? "it" : "them") and answer about the contents." + note
        }
        if ["hello", "hi ", "hey", "ahoj", "čau"].contains(where: { t.hasPrefix($0) || t == $0.trimmingCharacters(in: .whitespaces) }) {
            return "Hi! I'm Stem, your assistant. Things to try in this demo:\n\n- Ask me to plan something, like a trip or a week of dinners\n- Answer the request waiting in **Clean up my Downloads folder**\n- Open **Mail** and reply to a conversation" + note
        }
        if t.contains("dinner") || t.contains("recipe") || t.contains("cook") || t.contains("meal") {
            return "Here's a simple plan for the week:\n\n| Day | Dinner | Time |\n| --- | --- | --- |\n| Mon | Lemon chicken with rice | 30 min |\n| Tue | Lentil soup | 40 min |\n| Wed | Pasta with spinach and feta | 20 min |\n| Thu | Fish tacos | 25 min |\n| Fri | Homemade pizza | 45 min |\n\nWant a shopping list for it?" + note
        }
        if t.contains("trip") || t.contains("travel") || t.contains("vienna") || t.contains("weekend") || t.contains("plan") {
            return "Here's a first plan:\n\n1. **Morning** — an early train, so you arrive before the crowds\n2. **Midday** — one museum or a walk through the old town, then lunch somewhere small\n3. **Evening** — a concert or a long dinner\n\nTell me your dates and budget and I'll fill in times and tickets." + note
        }
        if t.contains("email") || t.contains("mail") || t.contains("write") || t.contains("draft") {
            return "Here's a short draft:\n\n> Hi,\n>\n> Thanks for getting back to me. Friday works well for me — shall we say 10:00?\n>\n> Best regards\n\nShall I make it more formal, or shorter?" + note
        }
        let quoted = text.count > 120 ? String(text.prefix(120)) + "…" : text
        return "You asked: “\(quoted)”\n\nIn your own Stem, I'd answer this with the model you pick, and could search the web, read your folders, or run a command on your Mac once you approve it.\n\nIn the demo, try:\n\n- Asking me to **plan a trip** or **a week of dinners**\n- Answering the request in **Clean up my Downloads folder**\n- Replying to a mail in **Mail**" + note
    }

    static func mailReply(conversation: String, to body: String) -> String {
        if conversation == "demo-landlord" {
            return "Updated. I kept your wording and added a clear deadline:\n\n> Dear Mr. Novák,\n>\n> The heating in our flat has not worked since Monday. Please arrange a repair by **Friday**. If that isn't possible, let me know when a technician can come.\n>\n> Kind regards\n\nSend it from your own mail when you're happy with it.\n\n_This is the demo: nothing was sent to anyone._"
        }
        return "Thanks, got it. In your own Stem, I would work on this and reply here when it's done, asking first before anything that changes your files, calendar or accounts.\n\n_This is the demo, so this reply was prepared in advance and nothing was sent._"
    }

    // MARK: Sample data

    private func seed() {
        let now = Self.nowS
        let h = 3600.0
        folders = [
            ChatFolder(id: "demo-folder-home", name: "Home", order: 0),
            ChatFolder(id: "demo-folder-work", name: "Work", order: 1),
        ]

        func chat(_ id: String, _ title: String, folder: String? = nil, ago: Double, _ turns: [(String, String)]) {
            var msgs: [ChatMessage] = []
            for (n, t) in turns.enumerated() {
                let turn = "\(id)-t\(n)"
                let at = Self.iso(Date(timeIntervalSince1970: now - ago - Double(turns.count - n) * 60))
                msgs.append(ChatMessage(id: "user-\(turn)", role: "user", content: t.0, turnId: turn, runtimeTurnId: turn, createdAt: at))
                msgs.append(ChatMessage(id: "assistant-\(turn)", role: "assistant", content: t.1, meta: MessageMeta(model: "Demo model"),
                                        turnId: turn, runtimeTurnId: turn, createdAt: at))
            }
            histories[id] = msgs
            chats.append(ChatSummary(threadId: id, title: title, preview: Self.plain(turns.last?.1 ?? ""),
                                     folderId: folder, createdAt: now - ago - 600, updatedAt: now - ago))
        }

        chat("demo-downloads", "Clean up my Downloads folder", ago: 0.05 * h, [(
            "My Mac is almost out of space. Can you clear the old installers out of Downloads?",
            "I found **12 disk images** (.dmg) in Downloads that are older than 30 days, **3.4 GB** in all. The newest is from October, so none of them look like something you're still installing.\n\nI'd move them to the Trash, where you can still get them back. Moving files needs your OK — the request is below."
        )])
        chat("demo-vienna", "Weekend in Vienna", ago: 3 * h, [(
            "Plan a relaxed weekend in Vienna for two, going by train from Bratislava.",
            "Here's a calm plan with plenty of breaks:\n\n### Friday\n- **07:42** train from Bratislava hl. st. (1 h 6 min)\n- Coffee and breakfast at a café near Stephansplatz\n- Afternoon walk through the old town\n\n### Saturday\n- **10:00** Albertina (book tickets online)\n- Lunch at the Naschmarkt\n- Evening: a concert at the Musikverein, if tickets are left\n\n### Sunday\n- Slow morning, then the Prater or Schönbrunn gardens\n- **18:10** train home\n\nWant me to put it in your calendar? I've already started on that in Mail."
        )])
        chat("demo-budget", "Q4 team budget", folder: "demo-folder-work", ago: 26 * h, [(
            "Sum up the Q4 team budget: travel 4 200, software 2 750, training 1 900, events 3 100.",
            "| Item | Amount (€) | Share |\n| --- | ---: | ---: |\n| Travel | 4 200 | 35 % |\n| Events | 3 100 | 26 % |\n| Software | 2 750 | 23 % |\n| Training | 1 900 | 16 % |\n| **Total** | **11 950** | 100 % |\n\nTravel is the biggest line. Moving one trip to a video call would save about €800."
        )])
        chat("demo-plants", "Watering the balcony plants", folder: "demo-folder-home", ago: 50 * h, [(
            "How often should I water basil and rosemary on a sunny balcony in summer?",
            "- **Basil** likes steady moisture: water when the top 2 cm of soil is dry, usually every day in a heatwave.\n- **Rosemary** prefers to dry out between waterings: about twice a week is plenty.\n\nWater in the morning, at the soil rather than the leaves."
        )])
        // Opened already, except the chat with the request waiting.
        for id in ["demo-vienna", "demo-budget", "demo-plants"] { setRead(&chatInbox, id, true) }

        execApprovals = [ExecApprovalRequest(
            id: "demo-exec-downloads", threadId: "demo-downloads",
            command: "find ~/Downloads -name '*.dmg' -mtime +30 -exec mv {} ~/.Trash/ \\;",
            cwd: "~", prefixes: ["find"], judgeVerdict: "ask",
            judgeReason: "Moves files to the Trash", deviceLabel: "MacBook Pro")]

        let ms = Self.nowMs
        let mh = 3600_000.0
        func conv(_ id: String, _ subject: String, _ participants: [String], status: String = "idle", ago: Double) {
            let at = ms - ago * mh
            conversations.append(MailConversation(id: id, subject: subject, participants: participants, status: status,
                                                  updatedAt: at, userUpdatedAt: at, createdAt: at - mh))
        }
        func mail(_ conv: String, _ from: String, _ to: [String], ago: Double, _ body: String, approval: MailApproval? = nil) {
            seq += 1
            items.append(MailItem(id: "demo-mail-\(seq)", conversationId: conv, from: from, to: to, body: body,
                                  at: ms - ago * mh, approval: approval))
        }

        conv("demo-calendar", "Add the Vienna trip to my calendar", ["assistant"], status: "awaiting-user", ago: 0.2)
        mail("demo-calendar", "user", ["assistant"], ago: 0.4,
             "Put the Vienna weekend in my calendar, with the train times.")
        mail("demo-calendar", "assistant", ["user"], ago: 0.2,
             "I made three events from the plan: both trains and the Albertina visit. Adding them changes your calendar, so I need your OK first.",
             approval: MailApproval(id: "demo-approval-calendar", kind: "exec",
                                    command: "stem-calendar add --file vienna-weekend.ics   # 3 events, Fri–Sun",
                                    cwd: "~", deviceLabel: "MacBook Pro", reason: "Adds events to your calendar", status: "pending"))
        updateConversation("demo-calendar") { c in c.userSentAt = ms - 0.4 * mh }

        conv("demo-landlord", "Heating repair — email to the landlord", ["assistant", "researcher"], ago: 1.5)
        mail("demo-landlord", "user", ["assistant"], ago: 2,
             "Our heating has been broken since Monday. Can you draft a polite but firm email to the landlord asking for a repair this week?")
        mail("demo-landlord", "assistant", ["researcher"], ago: 1.9,
             "What repair deadline is reasonable to ask for when a flat has no heating?")
        mail("demo-landlord", "researcher", ["assistant"], ago: 1.7,
             "Tenancy guidance treats a heating failure in winter as urgent. Asking for a repair within 3–5 working days is reasonable, and it helps to say when you first reported it.")
        mail("demo-landlord", "assistant", ["user"], ago: 1.5,
             "Here's a draft:\n\n> Dear Mr. Novák,\n>\n> The heating in our flat has not worked since Monday. Could you please arrange a repair this week? I'm happy to be at home for a technician any afternoon.\n>\n> Kind regards\n\nResearcher says asking for a repair within 3–5 working days is reasonable. Shall I add a firm date?")
        updateConversation("demo-landlord") { c in c.userSentAt = ms - 2 * mh }

        conv("demo-briefing", "Morning briefing", ["task:demo-morning"], ago: 8)
        mail("demo-briefing", "task:demo-morning", ["user"], ago: 8,
             "Good morning! Here's your day:\n\n- **Weather:** sunny, 14 °C, light wind\n- **10:30** dentist (bring the insurance card)\n- **Today:** the library books are due\n\nNothing urgent in your inbox.")
        setRead(&mailInbox, "demo-briefing", true)
    }
}
