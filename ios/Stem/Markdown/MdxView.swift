import SwiftUI

/// Lets interactive components (Quiz, Form, Replies) send a message, the same
/// way typing in the composer does. Only a chat provides it, and only for
/// assistant replies; mail, approvals and anything read-only get none.
struct MdxActions {
    var submit: (String) -> Void
    /// A turn is running: sending now would overlap it.
    var running: Bool
}

extension EnvironmentValues {
    @Entry var mdxActions: MdxActions? = nil
    /// The newest assistant reply in a chat, once its turn has settled: the
    /// only place suggested replies show.
    @Entry var mdxIsLatest: Bool = false
}

/// A run of blocks from the component tree: Markdown runs drawn by the
/// Markdown renderer, components by their native views.
struct MdxBlocksView: View {
    let blocks: [MdxBlock]
    var spacing: CGFloat = 10

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                switch b {
                case .md(let text): MarkdownBlocksList(blocks: MarkdownParser.parse(text))
                case .component(let c): MdxComponentView(component: c)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct MdxComponentView: View {
    let component: MdxComponent

    var body: some View {
        let c = component
        switch c.name {
        case "Callout": MdxCallout(type: c.attrs["type"], children: c.children)
        case "Steps": MdxSteps(children: c.children)
        case "Tabs": MdxTabs(children: c.children)
        case "Collapsible": MdxCollapsible(title: c.attrs["title"], children: c.children)
        case "Chart":
            MdxChartView(type: c.attrs["type"], title: c.attrs["title"], unit: c.attrs["unit"],
                         data: c.data?.value, closed: c.closed)
        case "DataTable": MdxDataTable(caption: c.attrs["caption"], data: c.data?.value, closed: c.closed)
        case "Stats": MdxStatsView(data: c.data?.value, closed: c.closed)
        case "Compare": MdxCompareView(recommend: c.attrs["recommend"], data: c.data?.value, closed: c.closed)
        case "Diagram": MdxDiagram(title: c.attrs["title"], source: c.data?.value ?? "")
        case "Quiz": MdxQuiz(topic: c.attrs["topic"], children: c.children)
        case "Form": MdxForm(prompt: c.attrs["prompt"], submitLabel: c.attrs["submitLabel"], children: c.children)
        case "Replies": if c.closed { MdxReplies(children: c.children) }
        case "Reply", "Field": EmptyView()
        // Unknown tags (and parts shown outside their parent): the tag goes, its content stays.
        default: MdxBlocksView(blocks: c.children)
        }
    }
}

enum MdxText {
    /// What a run of blocks reads as, without Markdown markup: a choice's label, a reply's text.
    static func plain(_ blocks: [MdxBlock]) -> String {
        blocks.map { b in
            switch b {
            case .md(let t): return String(Inline.attributed(t).characters)
            case .component(let c): return plain(c.children)
            }
        }
        .joined(separator: "\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func components(_ blocks: [MdxBlock], named name: String) -> [MdxComponent] {
        blocks.compactMap { if case .component(let c) = $0, c.name == name { return c }; return nil }
    }
}

/// Shown where a component is still being written, or can't be read.
struct MdxNote: View {
    let text: String
    var busy = false
    var body: some View {
        HStack(spacing: 8) {
            if busy { ProgressView().controlSize(.small) }
            Text(text).font(.footnote).foregroundStyle(.secondary)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground).opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
    }
}

extension View {
    /// The card every component sits on, matching code blocks and tables.
    func mdxCard(tint: Color? = nil) -> some View {
        self.padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.map { $0.opacity(0.10) } ?? Color(.secondarySystemBackground).opacity(0.6),
                        in: RoundedRectangle(cornerRadius: 10))
    }
}

/// Categorical series colors, in the desktop's fixed order.
enum MdxPalette {
    private static let light: [UInt32] = [0x2a78d6, 0xeb6834, 0x1baf7a, 0xeda100, 0xe87ba4, 0x008300, 0x4a3aa7, 0xe34948]
    private static let dark: [UInt32] = [0x3987e5, 0xd95926, 0x199e70, 0xc98500, 0xd55181, 0x008300, 0x9085e9, 0xe66767]

    static func color(_ slot: Int, _ scheme: ColorScheme) -> Color {
        guard slot >= 0 else { return Color(.systemGray3) }
        let hex = (scheme == .dark ? dark : light)[slot % 8]
        return Color(red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255, blue: Double(hex & 0xff) / 255)
    }
}
