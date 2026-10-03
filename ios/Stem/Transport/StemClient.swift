import Foundation

struct StemError: LocalizedError {
    let message: String
    /// True when the request never got an HTTP answer (offline, timeout).
    var unreachable = false
    var unauthorized = false
    var errorDescription: String? { message }
}

/// HTTP side of the server transport: `/rpc`, `/upload`, `/pair`.
struct StemClient: Sendable {
    let creds: Credentials

    var baseURL: URL { URL(string: creds.serverUrl)! }

    private static let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        // A handler may legitimately block for minutes (a mail send waits on a
        // persona); only the transport deciding the server is gone should fail it.
        cfg.timeoutIntervalForRequest = 600
        cfg.timeoutIntervalForResource = 600
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

    private struct Head: Decodable { let ok: Bool?; let error: String? }
    private struct Envelope<T: Decodable>: Decodable { let result: T }

    /// Calls a server channel. Args are positional, like the desktop preload.
    func call<T: Decodable>(_ channel: String, _ args: [JSONValue] = [], as: T.Type = T.self) async throws -> T {
        var req = URLRequest(url: baseURL.appendingPathComponent("rpc"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(creds.token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["channel": JSONValue.string(channel), "args": .array(args)])
        let (data, status) = try await send(req)
        let head = try? JSONDecoder().decode(Head.self, from: data)
        guard (200..<300).contains(status), head?.ok == true else {
            throw StemError(message: head?.error ?? "\(channel) failed (HTTP \(status))", unauthorized: status == 401)
        }
        if T.self == JSONValue.self || T.self == Empty.self {
            let env = try? JSONDecoder().decode(Envelope<JSONValue?>.self, from: data)
            if T.self == Empty.self { return Empty() as! T }
            return ((env?.result ?? nil) ?? .null) as! T
        }
        do {
            return try JSONDecoder().decode(Envelope<T>.self, from: data).result
        } catch {
            throw StemError(message: "\(channel): unexpected answer (\(error))")
        }
    }

    /// Fire-and-check for channels whose answer the caller ignores.
    func run(_ channel: String, _ args: [JSONValue] = []) async throws {
        _ = try await call(channel, args, as: Empty.self)
    }

    struct UploadResult: Decodable { let handle: String; let name: String; let size: Int? }

    /// Stages raw bytes on the server; the handle stands in for a file path
    /// on `startTurn` / `mail:*` attachments.
    func upload(_ data: Data, name: String, mime: String) async throws -> TurnAttachment {
        var comps = URLComponents(url: baseURL.appendingPathComponent("upload"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "name", value: name)]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(creds.token)", forHTTPHeaderField: "Authorization")
        req.setValue(mime, forHTTPHeaderField: "Content-Type")
        req.httpBody = data
        let (body, status) = try await send(req)
        let head = try? JSONDecoder().decode(Head.self, from: body)
        guard (200..<300).contains(status), head?.ok == true,
              let r = try? JSONDecoder().decode(Envelope<UploadResult>.self, from: body).result else {
            throw StemError(message: head?.error ?? (status == 413 ? "\(name) is larger than 100 MB" : "Upload failed (HTTP \(status))"))
        }
        return TurnAttachment(name: r.name, path: r.handle, dataBase64: nil, mime: mime)
    }

    private func send(_ req: URLRequest) async throws -> (Data, Int) {
        do {
            let (data, resp) = try await Self.session.data(for: req)
            return (data, (resp as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            throw StemError(message: "Can't reach the server — \(error.localizedDescription)", unreachable: true)
        }
    }

    // MARK: Pairing

    struct PairResult: Decodable { let deviceId: String; let token: String }

    static func pair(serverUrl: String, code: String) async throws -> Credentials {
        guard let url = URL(string: serverUrl)?.appendingPathComponent("pair") else {
            throw StemError(message: "That server address isn't a URL")
        }
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["code": PairLink.normalizeCode(code), "kind": "mobile"])
        let data: Data, status: Int
        do {
            let (d, r) = try await session.data(for: req)
            data = d; status = (r as? HTTPURLResponse)?.statusCode ?? 0
        } catch {
            throw StemError(message: "Can't reach \(serverUrl) — \(error.localizedDescription)", unreachable: true)
        }
        let head = try? JSONDecoder().decode(Head.self, from: data)
        guard (200..<300).contains(status), head?.ok == true,
              let r = try? JSONDecoder().decode(Envelope<PairResult>.self, from: data).result else {
            throw StemError(message: head?.error ?? "Pairing failed (HTTP \(status))")
        }
        return Credentials(serverUrl: serverUrl, deviceId: r.deviceId, token: r.token)
    }
}

/// Decodes any answer and keeps nothing (void channels answer `null`).
struct Empty: Decodable { init() {} ; init(from decoder: Decoder) throws {} }

enum PairLink {
    /// Must match the server, which hashes the normalized code.
    static func normalizeCode(_ input: String) -> String {
        input.uppercased().filter { ("2"..."9").contains($0) || ("A"..."Z").contains($0) }
    }

    static func normalizeURL(_ input: String) -> String {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        if !s.isEmpty, !s.contains("://") { s = "https://" + s }
        return s
    }

    /// `stem://pair?url=<origin>&code=<ABCD-EFGH>`
    static func parse(_ url: URL) -> (serverUrl: String, code: String)? {
        guard url.scheme?.lowercased() == "stem", url.host?.lowercased() == "pair",
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let items = comps.queryItems ?? []
        func value(_ k: String) -> String? {
            items.first { $0.name == k }?.value?.replacingOccurrences(of: "+", with: " ")
        }
        guard let server = value("url") ?? value("serverUrl"), let code = value("code") else { return nil }
        return (normalizeURL(server), code)
    }

    /// Release builds only talk plain http to loopback; everything else goes
    /// through the TLS proxy in front of the server.
    static func validate(_ serverUrl: String) -> String? {
        guard let u = URL(string: serverUrl), let scheme = u.scheme, let host = u.host else {
            return "That server address isn't a URL"
        }
        #if DEBUG
        _ = scheme; _ = host
        return nil
        #else
        if scheme == "http", !["localhost", "127.0.0.1", "::1"].contains(host) {
            return "Use the https address of your server"
        }
        return nil
        #endif
    }
}
