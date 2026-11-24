import Foundation

// What "Copy" puts on the pasteboard for a reply: plain Markdown with every
// MDX component turned into the Markdown a person would have written for it
// (a Callout a quote, Steps a numbered list, a Chart a table of its numbers).
// A port of src/renderer/mdx/copy.ts; both are checked against the *.copy.md
// files beside the shared fixtures in tests/fixtures/mdx.

enum MdxCopy {
    private static let calloutLabels = ["info": "Note", "warn": "Warning", "success": "Done", "danger": "Caution"]

    /// The reply as Markdown with no component tags left in it.
    static func markdown(_ text: String) -> String {
        tidy(blocks(MdxTreeParser.parse(text).blocks))
    }

    private static func blocks(_ list: [MdxBlock]) -> String {
        list.map(block).filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.joined(separator: "\n\n")
    }

    private static func block(_ b: MdxBlock) -> String {
        guard case .component(let c) = b else {
            if case .md(let text) = b { return stripTags(text) }
            return ""
        }
        let a = c.attrs
        switch c.name {
        case "Callout":
            let label = calloutLabels[a["type"] ?? ""] ?? "Note"
            let body = blocks(c.children)
            let opensWithProse = !matches(#"^(\s*([-*+]|\d+[.)])\s|#|>|```|~~~|\|)"#, body)
            let text = !body.isEmpty && opensWithProse ? "**\(label):** \(body)" : "**\(label)**\n\n\(body)"
            return quote(text.trimmingCharacters(in: .whitespacesAndNewlines))
        case "Steps":
            return numbered(c.children.compactMap { named($0, "Step") }.map { blocks($0.children) })
        case "Collapsible", "Tab":
            return titled(a["title"] ?? a["label"], blocks(c.children))
        case "Tabs":
            return blocks(c.children)
        case "DataTable":
            return titled(a["caption"], MdxDataParse.table(c.data?.value).map(table) ?? "")
        case "Chart":
            var title = a["title"]
            if let t = title, !t.isEmpty, let unit = a["unit"], !unit.isEmpty { title = "\(t) (\(unit))" }
            return titled(title, MdxDataParse.table(c.data?.value).map(table) ?? "")
        case "Stats":
            return stats(c.data?.value)
        case "Compare":
            return compare(c.data?.value, recommend: a["recommend"])
        case "Diagram":
            let source = c.data?.value.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let lang = (c.data?.lang).flatMap { $0.isEmpty ? nil : $0 } ?? "mermaid"
            return titled(a["title"], source.isEmpty ? "" : "```\(lang)\n\(source)\n```")
        case "Quiz":
            return titled(a["topic"], numbered(c.children.compactMap { named($0, "Question") }.map(question)))
        case "Question":
            return question(c)
        case "Form":
            return titled(a["prompt"], c.children.compactMap { named($0, "Field") }.map(field).joined(separator: "\n"))
        case "Field":
            return field(c)
        case "FactChange":
            let custom = a["label"].flatMap { $0.hasSuffix("?") ? nil : $0 }
            let label = custom ?? (a["kind"] == "save" ? "Saved" : "Retired")
            var line = "- **\(label):** \(a["text"] ?? "")"
            while line.last?.isWhitespace == true { line.removeLast() }
            if let reason = a["reason"], !reason.isEmpty { line += " (\(reason))" }
            return line
        case "Replies", "Reply":
            return ""
        default:
            // Step, Choice, Option and unknown tags: their content, without the tag.
            return blocks(c.children)
        }
    }

    private static func named(_ b: MdxBlock, _ name: String) -> MdxComponent? {
        if case .component(let c) = b, c.name == name { return c }
        return nil
    }

    private static func question(_ q: MdxComponent) -> String {
        var lines = [q.attrs["prompt"] ?? ""]
        lines += q.children.compactMap { named($0, "Choice") }.map { "- " + blocks($0.children) }
        if let answer = q.attrs["answer"], !answer.isEmpty { lines += ["", "Answer: \(answer)"] }
        return lines.enumerated().filter { !$0.element.isEmpty || $0.offset > 0 }.map(\.element).joined(separator: "\n")
    }

    private static func field(_ f: MdxComponent) -> String {
        let label = f.attrs["label"] ?? f.attrs["name"] ?? ""
        let options = f.children.compactMap { named($0, "Option") }.map { "  - " + blocks($0.children) }
        return (["- \(label)"] + options).joined(separator: "\n")
    }

    private static func stats(_ raw: String?) -> String {
        guard let t = MdxDataParse.table(raw) else { return "" }
        return t.rows.map { r -> String in
            let unit = r["unit"]?.string
            let value: String
            if case .number(let n)? = r["value"] { value = MdxFormat.compact(n, unit) } else { value = cell(r["value"]) }
            let delta = present(r["delta"]).map { cell($0).trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
            let change: String
            if !delta.isEmpty { change = " (\(delta))" }
            else if let previous = MdxDataParse.number(r["previous"]) { change = " (was \(MdxFormat.compact(previous, unit)))" }
            else { change = "" }
            return "- **\(cell(r["label"])):** \(value)\(change)"
        }.joined(separator: "\n")
    }

    private static func compare(_ raw: String?, recommend: String?) -> String {
        guard let t = MdxDataParse.table(raw) else { return "" }
        let pick = recommend?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        func list(_ v: OJSON?) -> [String] {
            switch v {
            case .array(let items)?: return items.map { cell($0) }.filter { !$0.isEmpty }
            case .string(let s)? where !s.isEmpty: return [s]
            default: return []
            }
        }
        return t.rows.prefix(4).map { r -> String in
            let name = cell(present(r["name"]) ?? r["option"])
            let summary = cell(present(r["summary"]) ?? present(r["bestFor"]) ?? r["best_for"])
            let picked = pick.map { !$0.isEmpty && name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == $0 } ?? false
            let head = "**\(name)**\(picked ? " (recommended)" : "")\(summary.isEmpty ? "" : ": \(summary)")"
            let items = list(r["pros"]).map { "- Pro: \($0)" } + list(r["cons"]).map { "- Con: \($0)" }
            return ([head] + items).joined(separator: "\n")
        }.joined(separator: "\n\n")
    }

    /// JS `??`: a missing key and a JSON null both fall through.
    private static func present(_ v: OJSON?) -> OJSON? {
        if case .null? = v { return nil }
        return v
    }

    private static func cell(_ v: OJSON?) -> String {
        switch v {
        case nil, .null?: return ""
        case .array(let items)?: return items.map { cell($0) }.joined(separator: ", ")
        case let v?: return v.text
        }
    }

    private static func table(_ t: MdxTable) -> String {
        guard !t.columns.isEmpty else { return "" }
        func esc(_ s: String) -> String {
            s.replacingOccurrences(of: "|", with: "\\|").replacingOccurrences(of: "\n", with: " ")
        }
        func line(_ cells: [String]) -> String { "| " + cells.map(esc).joined(separator: " | ") + " |" }
        let rows = t.rows.map { r in line(t.columns.map { cell(r[$0]) }) }
        return ([line(t.columns), line(t.columns.map { _ in "---" })] + rows).joined(separator: "\n")
    }

    private static func titled(_ title: String?, _ body: String) -> String {
        let t = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return [t.isEmpty ? "" : "**\(t)**", body].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    private static func numbered(_ items: [String]) -> String {
        items.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.enumerated().map { i, s in
            let marker = "\(i + 1). "
            let pad = String(repeating: " ", count: marker.count)
            let lines = s.components(separatedBy: "\n").enumerated().map { j, l in j > 0 && !l.isEmpty ? pad + l : l }
            return marker + lines.joined(separator: "\n")
        }.joined(separator: "\n")
    }

    private static func quote(_ body: String) -> String {
        body.components(separatedBy: "\n").map { $0.isEmpty ? ">" : "> \($0)" }.joined(separator: "\n")
    }

    private static let fenceRegex = try! NSRegularExpression(pattern: #"^\s{0,3}(`{3,}|~{3,})"#)
    private static let lonelyTag = try! NSRegularExpression(pattern: #"^\s*</?[A-Z][\w.]*(?:\s[^>]*)?/?>\s*$"#)
    private static let codeSpan = try! NSRegularExpression(pattern: #"`+[^`]*`+"#)
    private static let inlineTag = try! NSRegularExpression(
        pattern: #"</?[A-Z][\w.]*(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?/?>"#)

    /// Component tags left in a Markdown run (an inline <Kbd>, a reply that is
    /// not valid MDX): the tags go, their words stay. Code is left as written.
    private static func stripTags(_ md: String) -> String {
        var out: [String] = []
        var fence: String?
        for line in md.components(separatedBy: "\n") {
            let marker = firstGroup(fenceRegex, line)
            if let f = fence {
                if let m = marker, m.first == f.first, m.count >= f.count,
                   line.trimmingCharacters(in: .whitespaces).dropFirst(m.count).trimmingCharacters(in: .whitespaces).isEmpty {
                    fence = nil
                }
                out.append(line)
                continue
            }
            if let m = marker {
                fence = m
                out.append(line)
                continue
            }
            if matches(lonelyTag, line) { continue }
            out.append(stripInline(line))
        }
        return out.joined(separator: "\n")
    }

    /// Tags removed outside `code spans`.
    private static func stripInline(_ line: String) -> String {
        let ns = line as NSString
        var result = ""
        var at = 0
        func strip(_ s: String) -> String {
            inlineTag.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length), withTemplate: "")
        }
        for m in codeSpan.matches(in: line, range: NSRange(location: 0, length: ns.length)) {
            result += strip(ns.substring(with: NSRange(location: at, length: m.range.location - at)))
            result += ns.substring(with: m.range)
            at = m.range.location + m.range.length
        }
        return result + strip(ns.substring(from: at))
    }

    private static func firstGroup(_ re: NSRegularExpression, _ s: String) -> String? {
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return ns.substring(with: m.range(at: 1))
    }

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }

    private static func matches(_ pattern: String, _ s: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }

    private static func tidy(_ md: String) -> String {
        md.replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
