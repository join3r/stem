import Foundation
import Observation

/// What arrives on `/events`, after framing.
enum StreamEvent {
    /// A broadcast frame `{channel, payload}`.
    case push(channel: String, payload: JSONValue)
    /// Sent first on every connect: the turns running now and pending approvals.
    case snapshot(liveTurns: [LiveTurnInfo], execApprovals: [ExecApprovalRequest])
    /// The server could not replay what was missed: every screen refetches.
    case resync
}

/// The SSE stream plus the state every screen shares: whether the server is
/// reachable and which threads have a turn running.
@MainActor @Observable
final class Connection {
    enum Status: Equatable { case connecting, live, offline, unauthorized }

    private(set) var status: Status = .connecting
    /// threadId → turnId of every turn running on the server.
    private(set) var liveTurns: [String: String] = [:]

    let client: StemClient
    @ObservationIgnored private var lastEventId: String?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var attempt = 0
    @ObservationIgnored private var listeners: [UUID: (StreamEvent) -> Void] = [:]

    init(client: StemClient) { self.client = client }

    func subscribe(_ handler: @escaping (StreamEvent) -> Void) -> UUID {
        let id = UUID()
        listeners[id] = handler
        return id
    }

    func unsubscribe(_ id: UUID) { listeners[id] = nil }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in await self?.loop() }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    /// iOS suspension leaves a socket that looks open and is dead: always
    /// drop it and reconnect from the bookmark on foreground.
    func foreground() {
        stop()
        attempt = 0
        start()
    }

    /// Any RPC answer proves the server is up; reconnect right away if the
    /// stream was in backoff.
    func noteReachable() {
        if status == .offline { foreground() }
    }

    private func loop() async {
        while !Task.isCancelled {
            if status != .unauthorized { status = .connecting }
            let outcome = await Self.connectOnce(client: client, lastEventId: lastEventId) { [weak self] block in
                self?.handle(block)
            }
            if Task.isCancelled { return }
            switch outcome {
            case .unauthorized:
                status = .unauthorized
                return
            case .failed:
                // Grace before the red dot: a quick reconnect after resume is
                // not an outage.
                if attempt >= 2 { status = .offline }
            case .ended:
                break
            }
            let delay = min(10.0, 0.25 * pow(2, Double(attempt)))
            attempt += 1
            try? await Task.sleep(for: .seconds(delay))
        }
    }

    private enum Outcome: Sendable { case unauthorized, failed, ended }

    /// Reads one connection off the main actor and hands each block over.
    private nonisolated static func connectOnce(
        client: StemClient, lastEventId: String?, deliver: @escaping @MainActor (SSEBlock) -> Void
    ) async -> Outcome {
        var req = URLRequest(url: client.baseURL.appendingPathComponent("events"), timeoutInterval: 15)
        req.setValue("Bearer \(client.creds.token)", forHTTPHeaderField: "Authorization")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let id = lastEventId { req.setValue(id, forHTTPHeaderField: "Last-Event-ID") }
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 90
        cfg.timeoutIntervalForResource = 60 * 60 * 24
        let session = URLSession(configuration: cfg)
        defer { session.invalidateAndCancel() }

        let bytes: URLSession.AsyncBytes
        do {
            let (b, resp) = try await session.bytes(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 401 { return .unauthorized }
            guard code == 200 else { return .failed }
            bytes = b
        } catch {
            return .failed
        }

        // The server writes a keepalive every 25 s; 60 s of silence means the
        // socket died without telling us.
        let clock = ActivityClock()
        let watchdog = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                if clock.idleSeconds > 60 { session.invalidateAndCancel(); return }
            }
        }
        defer { watchdog.cancel() }

        var parser = SSEParser()
        var line = Data()
        var delivered = false
        do {
            for try await byte in bytes {
                if Task.isCancelled { return .ended }
                if byte != 0x0A { line.append(byte); continue }
                let text = String(decoding: line, as: UTF8.self)
                line.removeAll(keepingCapacity: true)
                guard let block = parser.feed(text) else { continue }
                clock.touch()
                delivered = true
                await deliver(block)
            }
        } catch {
            return delivered ? .ended : .failed
        }
        return .ended
    }

    private func handle(_ block: SSEBlock) {
        if let event = block.event {
            guard let data = block.data?.data(using: .utf8) else { return }
            switch event {
            case "snapshot":
                struct Snap: Decodable { var liveTurns: [LiveTurnInfo]?; var execApprovals: [ExecApprovalRequest]? }
                let snap = (try? JSONDecoder().decode(Snap.self, from: data)) ?? Snap()
                status = .live
                attempt = 0
                var map: [String: String] = [:]
                for t in snap.liveTurns ?? [] { map[t.threadId] = t.turnId ?? "" }
                liveTurns = map
                emit(.snapshot(liveTurns: snap.liveTurns ?? [], execApprovals: snap.execApprovals ?? []))
            case "resync":
                struct Head: Decodable { var head: String }
                if let h = try? JSONDecoder().decode(Head.self, from: data) { lastEventId = h.head }
                emit(.resync)
            default:
                break // per-device requests (mcp-request, exec-request) are for desktops
            }
            return
        }
        guard let data = block.data?.data(using: .utf8) else { return }
        struct Frame: Decodable { var channel: String; var payload: JSONValue? }
        guard let frame = try? JSONDecoder().decode(Frame.self, from: data) else { return }
        let payload = frame.payload ?? .null
        if frame.channel == "backend:event" { trackLiveTurn(payload) }
        emit(.push(channel: frame.channel, payload: payload))
        // Bookmark only after the frame was delivered.
        if let id = block.id { lastEventId = id }
    }

    private func trackLiveTurn(_ env: JSONValue) {
        guard let method = env["method"]?.stringValue else { return }
        let params = env["params"]
        let thread = params?["threadId"]?.stringValue
        switch method {
        case "item/started", "item/agentMessage/delta":
            if let thread, let turn = params?["turnId"]?.stringValue { liveTurns[thread] = turn }
        case "turn/completed", "turn/failed", "turn/aborted":
            if let thread { liveTurns[thread] = nil }
        case "process/exit":
            if let p = params, case .object(let o) = p, o.keys.contains("threadId") {
                if let thread { liveTurns[thread] = nil }
            } else {
                liveTurns = [:]
            }
        default: break
        }
    }

    private func emit(_ e: StreamEvent) {
        for l in listeners.values { l(e) }
    }
}

/// Last time the stream said anything, read by the watchdog task.
private final class ActivityClock: @unchecked Sendable {
    private let lock = NSLock()
    private var last = Date()
    func touch() { lock.withLock { last = Date() } }
    var idleSeconds: TimeInterval { lock.withLock { Date().timeIntervalSince(last) } }
}
