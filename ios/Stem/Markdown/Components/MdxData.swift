import Foundation

// Data children of DataTable, Chart, Stats and Compare: a port of
// src/renderer/mdx/data.ts, the donut fold in chart/scale.ts and the change
// computation in Stats.tsx. Column order is the order keys first appear, so
// the JSON is read with a small order-keeping parser (JSONSerialization
// returns unordered dictionaries).

indirect enum OJSON: Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([OJSON])
    case object([(String, OJSON)])

    static func == (a: OJSON, b: OJSON) -> Bool {
        switch (a, b) {
        case (.null, .null): return true
        case let (.bool(x), .bool(y)): return x == y
        case let (.number(x), .number(y)): return x == y
        case let (.string(x), .string(y)): return x == y
        case let (.array(x), .array(y)): return x == y
        case let (.object(x), .object(y)): return x.map(\.0) == y.map(\.0) && x.map(\.1) == y.map(\.1)
        default: return false
        }
    }

    subscript(key: String) -> OJSON? {
        if case .object(let pairs) = self { return pairs.first { $0.0 == key }?.1 }
        return nil
    }

    var string: String? { if case .string(let s) = self { return s }; return nil }

    /// The value as a table cell shows it (JS `String(v)`; objects as JSON).
    var text: String {
        switch self {
        case .null: return ""
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return MdxFormat.jsNumber(n)
        case .string(let s): return s
        case .array, .object: return json
        }
    }

    var json: String {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return MdxFormat.jsNumber(n)
        case .string(let s):
            let data = (try? JSONSerialization.data(withJSONObject: [s], options: [.fragmentsAllowed])) ?? Data()
            let wrapped = String(data: data, encoding: .utf8) ?? "[\"\"]"
            return String(wrapped.dropFirst().dropLast())
        case .array(let a): return "[" + a.map(\.json).joined(separator: ",") + "]"
        case .object(let o): return "{" + o.map { OJSON.string($0.0).json + ":" + $0.1.json }.joined(separator: ",") + "}"
        }
    }

    static func parse(_ text: String) -> OJSON? {
        var p = Parser(Array(text.unicodeScalars))
        p.skipWS()
        guard let v = p.value() else { return nil }
        p.skipWS()
        return p.i == p.s.count ? v : nil
    }

    private struct Parser {
        let s: [Unicode.Scalar]
        var i = 0
        init(_ s: [Unicode.Scalar]) { self.s = s }

        mutating func skipWS() { while i < s.count, " \t\n\r".unicodeScalars.contains(s[i]) { i += 1 } }

        mutating func lit(_ word: String) -> Bool {
            let w = Array(word.unicodeScalars)
            guard i + w.count <= s.count, Array(s[i..<i + w.count]) == w else { return false }
            i += w.count
            return true
        }

        mutating func value() -> OJSON? {
            guard i < s.count else { return nil }
            switch s[i] {
            case "{":
                i += 1
                var pairs: [(String, OJSON)] = []
                skipWS()
                if i < s.count, s[i] == "}" { i += 1; return .object(pairs) }
                while true {
                    skipWS()
                    guard let k = str() else { return nil }
                    skipWS()
                    guard i < s.count, s[i] == ":" else { return nil }
                    i += 1
                    skipWS()
                    guard let v = value() else { return nil }
                    if let at = pairs.firstIndex(where: { $0.0 == k }) { pairs[at].1 = v } else { pairs.append((k, v)) }
                    skipWS()
                    guard i < s.count else { return nil }
                    if s[i] == "," { i += 1; continue }
                    if s[i] == "}" { i += 1; return .object(pairs) }
                    return nil
                }
            case "[":
                i += 1
                var items: [OJSON] = []
                skipWS()
                if i < s.count, s[i] == "]" { i += 1; return .array(items) }
                while true {
                    skipWS()
                    guard let v = value() else { return nil }
                    items.append(v)
                    skipWS()
                    guard i < s.count else { return nil }
                    if s[i] == "," { i += 1; continue }
                    if s[i] == "]" { i += 1; return .array(items) }
                    return nil
                }
            case "\"":
                return str().map(OJSON.string)
            case "t": return lit("true") ? .bool(true) : nil
            case "f": return lit("false") ? .bool(false) : nil
            case "n": return lit("null") ? .null : nil
            default:
                let start = i
                while i < s.count, "+-0123456789.eE".unicodeScalars.contains(s[i]) { i += 1 }
                let token = String(String.UnicodeScalarView(s[start..<i]))
                guard !token.isEmpty, let n = Double(token) else { return nil }
                return .number(n)
            }
        }

        mutating func str() -> String? {
            guard i < s.count, s[i] == "\"" else { return nil }
            i += 1
            var out = String.UnicodeScalarView()
            while i < s.count {
                let c = s[i]
                i += 1
                if c == "\"" { return String(out) }
                if c == "\\" {
                    guard i < s.count else { return nil }
                    let e = s[i]
                    i += 1
                    switch e {
                    case "n": out.append("\n")
                    case "t": out.append("\t")
                    case "r": out.append("\r")
                    case "b": out.append("\u{8}")
                    case "f": out.append("\u{C}")
                    case "u":
                        guard let u = hex4() else { return nil }
                        if (0xD800...0xDBFF).contains(u), i + 1 < s.count, s[i] == "\\", s[i + 1] == "u" {
                            i += 2
                            guard let lo = hex4() else { return nil }
                            let code = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00)
                            if let sc = Unicode.Scalar(code) { out.append(sc) }
                        } else if let sc = Unicode.Scalar(u) {
                            out.append(sc)
                        }
                    default: out.append(e)
                    }
                } else {
                    out.append(c)
                }
            }
            return nil
        }

        mutating func hex4() -> UInt32? {
            guard i + 4 <= s.count, let v = UInt32(String(String.UnicodeScalarView(s[i..<i + 4])), radix: 16) else { return nil }
            i += 4
            return v
        }
    }
}


struct MdxTable {
    var columns: [String]
    var rows: [[String: OJSON]]
}

enum MdxDataParse {
    /// An array of objects (keys in first-seen order become columns), or
    /// `{columns, rows}` with rows as arrays.
    static func table(_ raw: String?) -> MdxTable? {
        guard let raw, let parsed = OJSON.parse(raw) else { return nil }
        if case .array(let items) = parsed {
            var columns: [String] = []
            var rows: [[String: OJSON]] = []
            for item in items {
                guard case .object(let pairs) = item else { continue }
                var row: [String: OJSON] = [:]
                for (k, v) in pairs {
                    if !columns.contains(k) { columns.append(k) }
                    row[k] = v
                }
                rows.append(row)
            }
            return MdxTable(columns: columns, rows: rows)
        }
        if case .array(let cols)? = parsed["columns"], case .array(let rowsRaw)? = parsed["rows"] {
            let columns = cols.map(\.text)
            let rows: [[String: OJSON]] = rowsRaw.compactMap { r in
                guard case .array(let cells) = r else { return nil }
                var row: [String: OJSON] = [:]
                for (i, c) in columns.enumerated() { row[c] = i < cells.count ? cells[i] : .null }
                return row
            }
            return MdxTable(columns: columns, rows: rows)
        }
        return nil
    }

    private static let numberPattern = try! NSRegularExpression(
        pattern: #"^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$"#, options: [.caseInsensitive])

    /// A cell as a number: numbers, and strings that are plainly numbers ("1,234", "12.5%").
    static func number(_ v: OJSON?) -> Double? {
        switch v {
        case .number(let n)?: return n.isFinite ? n : nil
        case .string(let s)?:
            var cleaned = s.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: #"[,\s]"#, with: "", options: .regularExpression)
            if cleaned.hasSuffix("%") { cleaned.removeLast() }
            let ns = cleaned as NSString
            guard !cleaned.isEmpty,
                  numberPattern.firstMatch(in: cleaned, range: NSRange(location: 0, length: ns.length)) != nil,
                  let n = Double(cleaned), n.isFinite else { return nil }
            return n
        default: return nil
        }
    }
}

struct MdxChartSeries: Hashable {
    var name: String
    var values: [Double?]
}

struct MdxChartData: Hashable {
    var labels: [String]
    /// Numeric x of each row when no column is text (scatter).
    var xs: [Double?]?
    var xName: String
    var series: [MdxChartSeries]

    /// The first mostly-text column is x; every other column with numbers is a series.
    static func from(_ raw: String?) -> MdxChartData? {
        guard let table = MdxDataParse.table(raw), !table.rows.isEmpty, !table.columns.isEmpty else { return nil }
        let rows = table.rows
        func numericShare(_ c: String) -> Double {
            Double(rows.filter { MdxDataParse.number($0[c]) != nil }.count) / Double(rows.count)
        }
        let textColumn = table.columns.first { numericShare($0) < 0.5 }
        let xName = textColumn ?? table.columns[0]
        let seriesColumns = table.columns.filter { $0 != xName && numericShare($0) > 0 }
        guard !seriesColumns.isEmpty else { return nil }
        return MdxChartData(
            labels: rows.map { $0[xName]?.text ?? "" },
            xs: textColumn == nil ? rows.map { MdxDataParse.number($0[xName]) } : nil,
            xName: xName,
            series: seriesColumns.map { c in MdxChartSeries(name: c, values: rows.map { MdxDataParse.number($0[c]) }) })
    }
}

struct MdxSlice: Hashable {
    var label: String
    var value: Double
    /// Palette index; -1 for the folded "Other".
    var slot: Int
}

enum MdxDonut {
    /// Non-positive values dropped; past `max` slices the smallest fold into "Other".
    static func slices(labels: [String], values: [Double?], max: Int = 6) -> [MdxSlice] {
        let items = labels.enumerated().map { (i, l) in (label: l, value: i < values.count ? values[i] ?? 0 : 0, idx: i) }
            .filter { $0.value > 0 }
        if items.count <= max { return items.enumerated().map { MdxSlice(label: $1.label, value: $1.value, slot: $0) } }
        let kept = Set(items.sorted { $0.value > $1.value }.prefix(max - 1).map(\.idx))
        var out: [MdxSlice] = []
        var other = 0.0
        for s in items {
            if kept.contains(s.idx) { out.append(MdxSlice(label: s.label, value: s.value, slot: out.count)) }
            else { other += s.value }
        }
        out.append(MdxSlice(label: "Other", value: other, slot: -1))
        return out
    }
}

enum MdxFormat {
    static let prefixUnits: Set<String> = ["$", "€", "£", "¥", "₹", "₩", "CHF"]

    static func withUnit(_ text: String, _ unit: String?) -> String {
        guard let unit, !unit.isEmpty else { return text }
        if prefixUnits.contains(unit) { return text.hasPrefix("-") ? "-\(unit)\(text.dropFirst())" : "\(unit)\(text)" }
        if unit == "%" { return "\(text)%" }
        return "\(text) \(unit)"
    }

    /// Compact past ten thousand (12.5k, 3.2M), else grouped with at most two decimals.
    static func compact(_ v: Double, _ unit: String? = nil) -> String {
        let a = abs(v)
        let text: String
        if a >= 1e9 { text = trim(v / 1e9) + "B" }
        else if a >= 1e6 { text = trim(v / 1e6) + "M" }
        else if a >= 1e4 { text = trim(v / 1e3) + "k" }
        else { text = full(v) }
        return withUnit(text, unit)
    }

    static func value(_ v: Double, _ unit: String? = nil) -> String { withUnit(full(v), unit) }

    static func full(_ v: Double) -> String {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US")
        f.numberStyle = .decimal
        f.maximumFractionDigits = abs(v) < 1 ? 3 : 2
        return f.string(from: NSNumber(value: v)) ?? String(v)
    }

    private static func trim(_ v: Double) -> String {
        let a = abs(v)
        var s = String(format: a >= 100 ? "%.0f" : a >= 10 ? "%.1f" : "%.2f", v)
        if s.contains(".") {
            while s.hasSuffix("0") { s.removeLast() }
            if s.hasSuffix(".") { s.removeLast() }
        }
        return s
    }

    /// A number the way JavaScript's String(n) writes it, for plain integers and decimals.
    static func jsNumber(_ n: Double) -> String {
        if n.isFinite, n == n.rounded(), abs(n) < 1e15 { return String(Int64(n)) }
        return String(n)
    }
}

struct MdxStat: Hashable {
    enum Dir: Hashable { case up, down, flat }
    struct Change: Hashable { var text: String; var dir: Dir; var good: Bool? }
    var label: String
    var value: String
    var change: Change?
    var trend: [Double]

    static func list(_ raw: String?) -> [MdxStat]? {
        guard let table = MdxDataParse.table(raw), !table.rows.isEmpty else { return nil }
        return table.rows.map { r in
            let unit = r["unit"]?.string
            let value = MdxDataParse.number(r["value"])
            let shown: String
            if case .number(let n)? = r["value"] { shown = MdxFormat.compact(n, unit) } else { shown = r["value"]?.text ?? "" }
            let goodWhen: Dir? = r["good"]?.string == "down" ? .down : r["good"]?.string == "neither" ? nil : .up
            func judge(_ dir: Dir) -> Bool? { dir == .flat || goodWhen == nil ? nil : dir == goodWhen }
            var change: Change?
            if let value, let previous = MdxDataParse.number(r["previous"]) {
                let diff = value - previous
                let dir: Dir = diff > 0 ? .up : diff < 0 ? .down : .flat
                let sign = diff > 0 ? "+" : diff < 0 ? "−" : ""
                let text: String
                if unit == "%" {
                    text = "\(sign)\(MdxFormat.compact(abs(diff))) pp"
                } else if previous != 0 {
                    var pct = String(format: "%.1f", abs(diff / previous) * 100)
                    if pct.hasSuffix(".0") { pct.removeLast(2) }
                    text = "\(sign)\(pct)%"
                } else {
                    text = MdxFormat.withUnit(MdxFormat.compact(diff), unit)
                }
                change = Change(text: text, dir: dir, good: judge(dir))
            } else if let delta = r["delta"], delta != .null, !delta.text.trimmingCharacters(in: .whitespaces).isEmpty {
                let text = delta.text.trimmingCharacters(in: .whitespaces)
                var numeric = text
                if numeric.hasPrefix("−") { numeric = "-" + numeric.dropFirst() } else if numeric.hasPrefix("+") { numeric.removeFirst() }
                let n = MdxDataParse.number(.string(numeric))
                let dir: Dir = n == nil || n == 0 ? .flat : n! > 0 ? .up : .down
                change = Change(text: text, dir: dir, good: judge(dir))
            }
            var trend: [Double] = []
            if case .array(let t)? = r["trend"] { trend = t.compactMap { MdxDataParse.number($0) } }
            return MdxStat(label: r["label"]?.text ?? "", value: shown, change: change, trend: trend)
        }
    }
}
