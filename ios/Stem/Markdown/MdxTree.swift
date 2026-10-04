import Foundation

// The component tree of an MDX reply: runs of plain Markdown (their raw
// source) and the components between them, nested. The desktop's reference
// is src/renderer/mdx/tree.ts; both parsers must produce the same tree for
// every fixture in tests/fixtures/mdx (checked by StemTests and
// tests/unit/mdx-fixtures.test.ts).

struct MdxData: Codable, Hashable {
    var lang: String
    var value: String
}

struct MdxComponent: Hashable {
    var name: String
    var attrs: [String: String]
    var data: MdxData?
    var children: [MdxBlock]
    /// False while a streaming reply hasn't written the closing tag yet.
    var closed = true
}

enum MdxBlock: Hashable {
    case md(String)
    case component(MdxComponent)
}

struct MdxTree: Codable, Hashable {
    var blocks: [MdxBlock]
}

extension MdxBlock: Codable {
    private enum Keys: String, CodingKey { case kind, text, name, attrs, data, children }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "md": self = .md(try c.decode(String.self, forKey: .text))
        default:
            self = .component(MdxComponent(
                name: try c.decode(String.self, forKey: .name),
                attrs: try c.decodeIfPresent([String: String].self, forKey: .attrs) ?? [:],
                data: try c.decodeIfPresent(MdxData.self, forKey: .data),
                children: try c.decodeIfPresent([MdxBlock].self, forKey: .children) ?? []))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .md(let text):
            try c.encode("md", forKey: .kind)
            try c.encode(text, forKey: .text)
        case .component(let comp):
            try c.encode("component", forKey: .kind)
            try c.encode(comp.name, forKey: .name)
            try c.encode(comp.attrs, forKey: .attrs)
            try c.encodeIfPresent(comp.data, forKey: .data)
            try c.encode(comp.children, forKey: .children)
        }
    }
}

enum MdxTreeParser {
    /// Components whose first fenced code child is their data, not prose.
    static let dataComponents: Set<String> = ["Chart", "DataTable", "Stats", "Compare", "Diagram"]

    private final class Frame {
        let name: String
        let attrs: [String: String]
        var children: [MdxBlock] = []
        var md: [String] = []
        var data: MdxData?
        var dataTaken = false
        init(name: String, attrs: [String: String]) { self.name = name; self.attrs = attrs }

        func flush() {
            let text = md.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { children.append(.md(text)) }
            md = []
        }
    }

    // A complete opening, closing or self-closing tag (same shape as the
    // desktop's stream splitter): attribute values are plain strings.
    private static let tagRegex = try! NSRegularExpression(
        pattern: #"<(/?)([A-Z][A-Za-z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(/?)>"#)
    private static let attrRegex = try! NSRegularExpression(
        pattern: #"([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')"#)

    static func parse(_ source: String) -> MdxTree {
        let text = stripCiteMarkers(source).replacingOccurrences(of: "\r\n", with: "\n")
        let root = Frame(name: "", attrs: [:])
        var stack: [Frame] = [root]
        // Components nest a few levels deep at most (Tabs > Tab > Steps). Past
        // `maxDepth` a tag is dropped (its content stays) so model output can't
        // build a tree deep enough to overflow the stack while it is drawn.
        let maxDepth = 16
        var ignored: [String: Int] = [:]
        var fence: (char: Character, count: Int)?
        var dataLines: [String]?
        var dataLang = ""

        func close(_ frame: Frame, closed: Bool) -> MdxBlock {
            frame.flush()
            return .component(MdxComponent(name: frame.name, attrs: frame.attrs, data: frame.data,
                                           children: frame.children, closed: closed))
        }

        for line in text.components(separatedBy: "\n") {
            let top = stack[stack.count - 1]
            if let f = fence {
                if isFenceClose(line, f) {
                    fence = nil
                    if let d = dataLines {
                        top.data = MdxData(lang: dataLang, value: d.joined(separator: "\n"))
                        dataLines = nil
                    } else {
                        top.md.append(line)
                    }
                } else if dataLines != nil {
                    dataLines!.append(line)
                } else {
                    top.md.append(line)
                }
                continue
            }
            if let open = fenceOpen(line) {
                fence = (open.char, open.count)
                if stack.count > 1, dataComponents.contains(top.name), !top.dataTaken {
                    top.flush()
                    top.dataTaken = true
                    dataLines = []
                    dataLang = open.lang
                } else {
                    top.md.append(line)
                }
                continue
            }
            guard let tokens = tagTokens(line) else {
                top.md.append(line)
                continue
            }
            for token in tokens {
                let top = stack[stack.count - 1]
                switch token {
                case .text(let t):
                    if !t.trimmingCharacters(in: .whitespaces).isEmpty { top.md.append(t) }
                case .open(let name, let attrs):
                    if stack.count > maxDepth {
                        ignored[name, default: 0] += 1
                        continue
                    }
                    top.flush()
                    stack.append(Frame(name: name, attrs: attrs))
                case .selfClosing(let name, let attrs):
                    top.flush()
                    top.children.append(.component(MdxComponent(name: name, attrs: attrs, data: nil, children: [])))
                case .close(let name):
                    if let n = ignored[name], n > 0 {
                        ignored[name] = n - 1
                        continue
                    }
                    guard let at = stack.lastIndex(where: { $0.name == name }), at > 0 else { continue }
                    while stack.count > at {
                        let frame = stack.removeLast()
                        let parent = stack[stack.count - 1]
                        parent.flush()
                        parent.children.append(close(frame, closed: true))
                    }
                }
            }
        }
        // An unfinished fence inside a data component is still its data so far.
        if let d = dataLines { stack[stack.count - 1].data = MdxData(lang: dataLang, value: d.joined(separator: "\n")) }
        while stack.count > 1 {
            let frame = stack.removeLast()
            let parent = stack[stack.count - 1]
            parent.flush()
            parent.children.append(close(frame, closed: false))
        }
        root.flush()
        return MdxTree(blocks: root.children)
    }

    private enum Token {
        case text(String)
        case open(String, [String: String])
        case close(String)
        case selfClosing(String, [String: String])
    }

    /// The line as tags and the text between them, when it starts with a tag.
    private static func tagTokens(_ line: String) -> [Token]? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("<") else { return nil }
        let ns = trimmed as NSString
        let matches = tagRegex.matches(in: trimmed, range: NSRange(location: 0, length: ns.length))
        guard let first = matches.first, first.range.location == 0 else { return nil }
        var tokens: [Token] = []
        var cursor = 0
        for m in matches {
            if m.range.location > cursor {
                tokens.append(.text(ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))))
            }
            let closing = m.range(at: 1).length > 0
            let name = ns.substring(with: m.range(at: 2))
            let attrs = parseAttrs(ns.substring(with: m.range(at: 3)))
            let selfClosing = m.range(at: 4).length > 0
            tokens.append(closing ? .close(name) : selfClosing ? .selfClosing(name, attrs) : .open(name, attrs))
            cursor = m.range.location + m.range.length
        }
        if cursor < ns.length { tokens.append(.text(ns.substring(from: cursor))) }
        return tokens
    }

    private static func parseAttrs(_ s: String) -> [String: String] {
        var out: [String: String] = [:]
        let ns = s as NSString
        for m in attrRegex.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            let name = ns.substring(with: m.range(at: 1))
            let r = m.range(at: 2).location != NSNotFound ? m.range(at: 2) : m.range(at: 3)
            out[name] = ns.substring(with: r)
        }
        return out
    }

    private static func fenceOpen(_ line: String) -> (char: Character, count: Int, lang: String)? {
        let indent = line.prefix { $0 == " " }.count
        guard indent <= 3 else { return nil }
        let rest = line.dropFirst(indent)
        guard let c = rest.first, c == "`" || c == "~" else { return nil }
        let run = rest.prefix { $0 == c }.count
        guard run >= 3 else { return nil }
        let info = rest.dropFirst(run).trimmingCharacters(in: .whitespaces)
        if c == "`", info.contains("`") { return nil }
        let lang = info.split(separator: " ", maxSplits: 1).first.map(String.init) ?? ""
        return (c, run, lang)
    }

    private static func isFenceClose(_ line: String, _ fence: (char: Character, count: Int)) -> Bool {
        let indent = line.prefix { $0 == " " }.count
        guard indent <= 3 else { return false }
        let rest = line.dropFirst(indent)
        let run = rest.prefix { $0 == fence.char }.count
        return run >= fence.count && rest.dropFirst(run).allSatisfy { $0 == " " || $0 == "\t" }
    }

    /// OpenAI web-search citation markers (see src/shared/citations.ts).
    static func stripCiteMarkers(_ s: String) -> String {
        guard s.unicodeScalars.contains(where: { (0xE200...0xE202).contains($0.value) }) else { return s }
        return s
            .replacingOccurrences(of: "\u{E200}[^\u{E200}\u{E201}]*\u{E201}", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\u{E200}[^\u{E200}\u{E201}]*$", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[\u{E200}-\u{E202}]", with: "", options: .regularExpression)
    }
}
