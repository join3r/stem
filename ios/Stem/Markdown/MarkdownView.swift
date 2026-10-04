import SwiftUI

/// A reply, mail or skill body: MDX components drawn natively, the Markdown
/// between them by the block renderer below.
struct MarkdownView: View {
    let source: String
    private let tree: MdxTree

    init(_ source: String) {
        self.source = source
        tree = MdxTreeParser.parse(source)
    }

    var body: some View {
        MdxBlocksView(blocks: tree.blocks)
            .textSelection(.enabled)
    }
}

struct MarkdownBlocksList: View {
    let blocks: [MDBlock]
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in BlockView(block: b) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct BlockView: View {
    let block: MDBlock

    var body: some View {
        switch block {
        case .heading(let level, let text):
            Inline(text)
                .font(level == 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
                .padding(.top, 4)
        case .paragraph(let text):
            Inline(text)
        case .code(let lang, let text):
            CodeBlock(lang: lang, text: text)
        case .quote(let inner):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5).fill(.secondary.opacity(0.4)).frame(width: 3)
                MarkdownBlocksList(blocks: inner).foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { idx, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? "\(start + idx)." : "•")
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .frame(minWidth: ordered ? 22 : 12, alignment: .trailing)
                        MarkdownBlocksList(blocks: item)
                    }
                }
            }
        case .table(let header, let rows):
            TableBlock(header: header, rows: rows)
        case .rule:
            Divider()
        case .component(_, let text):
            // A tag the component parser left inside Markdown (say, nested in a
            // list): like the desktop, the tag goes and its content stays.
            if !text.isEmpty { Inline(text) }
        }
    }
}

/// One run of inline markdown: bold, italics, code spans, links.
struct Inline: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(Self.attributed(text))
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Component tags written mid-sentence (`<Kbd>Cmd</Kbd>`): like the
    /// desktop, the tag goes and its text stays. Code spans keep theirs.
    static func dropInlineTags(_ s: String) -> String {
        guard s.contains("<") else { return s }
        return s.components(separatedBy: "`").enumerated().map { i, part in
            i % 2 == 1 ? part : part.replacingOccurrences(
                of: #"</?[A-Z][A-Za-z0-9]*(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?/?>"#, with: "", options: .regularExpression)
        }.joined(separator: "`")
    }

    static func attributed(_ raw: String) -> AttributedString {
        let s = dropInlineTags(raw)
        let opts = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: true,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible)
        guard var a = try? AttributedString(markdown: s, options: opts) else { return AttributedString(s) }
        for run in a.runs where run.inlinePresentationIntent?.contains(.code) == true {
            a[run.range].font = .system(.body, design: .monospaced)
            a[run.range].backgroundColor = Color.secondary.opacity(0.15)
        }
        return a
    }
}

struct CodeBlock: View {
    let lang: String
    let text: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(lang.isEmpty ? "code" : lang).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = text
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption)
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .padding(.horizontal, 10)
                    .padding(.bottom, 10)
            }
        }
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct TableBlock: View {
    let header: [String]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { _, h in
                        Inline(h).font(.subheadline.weight(.semibold))
                    }
                }
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(0..<header.count, id: \.self) { c in
                            Inline(c < row.count ? row[c] : "").font(.subheadline)
                        }
                    }
                }
            }
            .padding(10)
        }
        .background(Color(.secondarySystemBackground).opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
    }
}
