import Foundation

/// One server-sent-events block.
struct SSEBlock: Equatable {
    var event: String?
    var id: String?
    var data: String?
}

/// Incremental SSE framing: feed it lines, it hands back each block at the
/// blank line that ends it. Tolerates CRLF and a missing space after the colon.
struct SSEParser {
    private var event: String?
    private var id: String?
    private var data: [String] = []
    private var sawField = false

    /// Returns a finished block when `line` is the blank separator.
    /// Comment-only blocks come back as an empty block (proof of life).
    mutating func feed(_ rawLine: String) -> SSEBlock? {
        let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
        if line.isEmpty {
            defer { event = nil; id = nil; data = []; sawField = false }
            return SSEBlock(event: event, id: id, data: data.isEmpty ? nil : data.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { sawField = true; return nil }
        let field: Substring, value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            var v = line[line.index(after: colon)...]
            if v.hasPrefix(" ") { v = v.dropFirst() }
            value = v
        } else {
            field = Substring(line); value = ""
        }
        sawField = true
        switch field {
        case "event": event = String(value)
        case "id": id = String(value)
        case "data": data.append(String(value))
        default: break
        }
        return nil
    }
}
