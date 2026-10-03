import Foundation

/// Block-level structure of a reply. Inline styling (bold, links, code
/// spans) is left to `AttributedString(markdown:)` per text run.
enum MDBlock: Hashable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case code(lang: String, text: String)
    case quote([MDBlock])
    case list(ordered: Bool, start: Int, items: [[MDBlock]])
    case table(header: [String], rows: [[String]])
    case rule
    /// An MDX component the phone can't draw (charts, cards): shown as a note.
    case component(name: String, text: String)
}

enum MarkdownParser {
    static func parse(_ source: String) -> [MDBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var i = 0
        return parseBlocks(lines, &i, stopAtDedent: nil)
    }

    private static func parseBlocks(_ lines: [String], _ i: inout Int, stopAtDedent: Int?) -> [MDBlock] {
        var out: [MDBlock] = []
        var para: [String] = []
        func flush() {
            if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))); para = [] }
        }
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty { flush(); i += 1; continue }

            // Fenced code.
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush()
                let fence = String(trimmed.prefix(3))
                let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    body.append(lines[i]); i += 1
                }
                i += 1
                out.append(.code(lang: lang, text: body.joined(separator: "\n")))
                continue
            }

            // MDX import/export lines are build-time noise.
            if trimmed.hasPrefix("import ") || trimmed.hasPrefix("export ") { flush(); i += 1; continue }

            // A capitalized JSX tag starts a component block.
            if let name = componentName(trimmed) {
                flush()
                var body: [String] = [trimmed]
                let selfClosingOneLine = trimmed.hasSuffix("/>") || trimmed.contains("</\(name)>")
                i += 1
                if !selfClosingOneLine {
                    while i < lines.count {
                        let l = lines[i]
                        body.append(l)
                        i += 1
                        let t = l.trimmingCharacters(in: .whitespaces)
                        if t.contains("</\(name)>") || t == "/>" || (t.hasSuffix("/>") && !t.hasPrefix("<")) { break }
                    }
                }
                out.append(.component(name: name, text: componentText(body.joined(separator: "\n"))))
                continue
            }

            if let h = heading(trimmed) { flush(); out.append(h); i += 1; continue }

            if isRule(trimmed) { flush(); out.append(.rule); i += 1; continue }

            if trimmed.hasPrefix(">") {
                flush()
                var inner: [String] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    guard t.hasPrefix(">") else { break }
                    var rest = t.dropFirst()
                    if rest.hasPrefix(" ") { rest = rest.dropFirst() }
                    inner.append(String(rest))
                    i += 1
                }
                var j = 0
                out.append(.quote(parseBlocks(inner, &j, stopAtDedent: nil)))
                continue
            }

            if trimmed.hasPrefix("|"), i + 1 < lines.count, isTableSeparator(lines[i + 1]) {
                flush()
                let header = cells(trimmed)
                i += 2
                var rows: [[String]] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    guard t.hasPrefix("|") else { break }
                    rows.append(cells(t))
                    i += 1
                }
                out.append(.table(header: header, rows: rows))
                continue
            }

            if let marker = listMarker(line) {
                flush()
                out.append(parseList(lines, &i, indent: marker.indent, ordered: marker.ordered, start: marker.number))
                continue
            }

            para.append(trimmed)
            i += 1
        }
        flush()
        return out
    }

    private struct Marker { var indent: Int; var ordered: Bool; var number: Int; var contentStart: Int }

    private static func listMarker(_ line: String) -> Marker? {
        let chars = Array(line)
        var indent = 0
        while indent < chars.count, chars[indent] == " " || chars[indent] == "\t" { indent += chars[indent] == "\t" ? 4 : 1; if indent > 40 { break } }
        let rest = line.drop { $0 == " " || $0 == "\t" }
        if let c = rest.first, "-*+".contains(c), rest.dropFirst().first == " " {
            return Marker(indent: indent, ordered: false, number: 1, contentStart: 2)
        }
        let digits = rest.prefix { $0.isNumber }
        if !digits.isEmpty, digits.count < 10 {
            let after = rest.dropFirst(digits.count)
            if let d = after.first, d == "." || d == ")", after.dropFirst().first == " " {
                return Marker(indent: indent, ordered: true, number: Int(digits) ?? 1, contentStart: digits.count + 2)
            }
        }
        return nil
    }

    private static func parseList(_ lines: [String], _ i: inout Int, indent: Int, ordered: Bool, start: Int) -> MDBlock {
        var items: [[MDBlock]] = []
        while i < lines.count {
            guard let m = listMarker(lines[i]), m.indent == indent, m.ordered == ordered else { break }
            let first = String(lines[i].drop { $0 == " " || $0 == "\t" }.dropFirst(m.contentStart))
            var body: [String] = [first]
            i += 1
            // Continuation: deeper-indented lines, and blank lines followed by them.
            while i < lines.count {
                let l = lines[i]
                if l.trimmingCharacters(in: .whitespaces).isEmpty {
                    if i + 1 < lines.count, leadingSpaces(lines[i + 1]) > indent, !lines[i + 1].trimmingCharacters(in: .whitespaces).isEmpty {
                        body.append(""); i += 1; continue
                    }
                    break
                }
                if leadingSpaces(l) > indent { body.append(String(l.dropFirst(min(leadingSpaces(l), indent + m.contentStart)))); i += 1; continue }
                if listMarker(l) != nil { break }
                // Lazy continuation of the item's paragraph.
                body.append(l.trimmingCharacters(in: .whitespaces)); i += 1
            }
            var j = 0
            items.append(parseBlocks(body, &j, stopAtDedent: nil))
            // Skip one blank line between items of a loose list.
            if i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).isEmpty,
               i + 1 < lines.count, let next = listMarker(lines[i + 1]), next.indent == indent, next.ordered == ordered {
                i += 1
            }
        }
        return .list(ordered: ordered, start: start, items: items)
    }

    private static func leadingSpaces(_ s: String) -> Int {
        var n = 0
        for c in s { if c == " " { n += 1 } else if c == "\t" { n += 4 } else { break } }
        return n
    }

    private static func heading(_ t: String) -> MDBlock? {
        let hashes = t.prefix { $0 == "#" }
        guard (1...6).contains(hashes.count), t.dropFirst(hashes.count).first == " " else { return nil }
        var text = t.dropFirst(hashes.count + 1).trimmingCharacters(in: .whitespaces)
        while text.hasSuffix("#") { text.removeLast() }
        return .heading(level: hashes.count, text: text.trimmingCharacters(in: .whitespaces))
    }

    private static func isRule(_ t: String) -> Bool {
        let s = t.replacingOccurrences(of: " ", with: "")
        guard s.count >= 3, let c = s.first, "-*_".contains(c) else { return false }
        return s.allSatisfy { $0 == c }
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.contains("-"), t.hasPrefix("|") || t.contains("|") else { return false }
        return t.allSatisfy { "|-: ".contains($0) }
    }

    private static func cells(_ row: String) -> [String] {
        var t = row
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func componentName(_ t: String) -> String? {
        guard t.hasPrefix("<"), let first = t.dropFirst().first, first.isUppercase else { return nil }
        let name = t.dropFirst().prefix { $0.isLetter || $0.isNumber || $0 == "." }
        return name.isEmpty ? nil : String(name)
    }

    /// The readable text inside a component: string props like title/label
    /// and any children, with the tags removed.
    private static func componentText(_ src: String) -> String {
        var parts: [String] = []
        for key in ["title", "label", "caption"] {
            if let r = src.range(of: "\(key)=\"") {
                let rest = src[r.upperBound...]
                if let end = rest.firstIndex(of: "\"") { parts.append(String(rest[..<end])) }
            }
        }
        let stripped = src.replacingOccurrences(of: "<[^>]*>", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !stripped.isEmpty, !stripped.contains("{"), stripped.count < 2000 { parts.append(stripped) }
        return parts.joined(separator: "\n")
    }
}
