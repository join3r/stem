import SwiftUI

struct MarkdownView: View {
    let source: String
    private let blocks: [MDBlock]

    init(_ source: String) {
        self.source = source
        blocks = MarkdownParser.parse(source)
    }

    var body: some View {
        BlockList(blocks: blocks)
            .textSelection(.enabled)
    }
}

private struct BlockList: View {
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
                BlockList(blocks: inner).foregroundStyle(.secondary)
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
                        BlockList(blocks: item)
                    }
                }
            }
        case .table(let header, let rows):
            TableBlock(header: header, rows: rows)
        case .rule:
            Divider()
        case .component(let name, let text):
            VStack(alignment: .leading, spacing: 4) {
                Label(name, systemImage: name.lowercased().contains("chart") ? "chart.bar" : "square.dashed")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                if !text.isEmpty { Inline(text).font(.callout) }
                Text("Open on the desktop to see this.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
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

    static func attributed(_ s: String) -> AttributedString {
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

private struct CodeBlock: View {
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
