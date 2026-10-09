import SwiftUI

// Callout, Steps, Tabs, Collapsible and the Diagram fallback: components
// whose content is prose (src/renderer/mdx/components.tsx).

struct MdxCallout: View {
    let type: String?
    let children: [MdxBlock]

    private var style: (icon: String, color: Color) {
        switch type {
        case "warn": return ("exclamationmark.triangle.fill", .orange)
        case "success": return ("checkmark.circle.fill", .green)
        case "danger": return ("xmark.octagon.fill", .red)
        default: return ("info.circle.fill", .blue)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: style.icon)
                .foregroundStyle(style.color)
                .font(.body)
                .accessibilityHidden(true)
            MdxBlocksView(blocks: children, spacing: 8)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(style.color.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
        .overlay(alignment: .leading) {
            UnevenRoundedRectangle(topLeadingRadius: 10, bottomLeadingRadius: 10)
                .fill(style.color.opacity(0.7))
                .frame(width: 3)
        }
    }
}

struct MdxSteps: View {
    let children: [MdxBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(numbered, id: \.index) { row in
                if case .component(let c) = row.block, let n = row.step {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("\(n)")
                            .font(.footnote.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 24, height: 24)
                            .background(Color.accentColor.opacity(0.14), in: Circle())
                            .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 5 }
                        MdxBlocksView(blocks: c.children, spacing: 8)
                    }
                } else {
                    MdxBlocksView(blocks: [row.block])
                }
            }
        }
    }

    /// Each child with its 1-based number when it is a Step.
    private var numbered: [(index: Int, block: MdxBlock, step: Int?)] {
        var n = 0
        return children.enumerated().map { i, b in
            if case .component(let c) = b, c.name == "Step" { n += 1; return (i, b, n) }
            return (i, b, nil)
        }
    }
}

struct MdxTabs: View {
    let children: [MdxBlock]
    @State private var active = 0

    var body: some View {
        let tabs = MdxText.components(children, named: "Tab")
        if tabs.isEmpty {
            MdxBlocksView(blocks: children)
        } else {
            let current = min(active, tabs.count - 1)
            VStack(alignment: .leading, spacing: 10) {
                if tabs.count <= 3 {
                    Picker("Tab", selection: $active) {
                        ForEach(Array(tabs.enumerated()), id: \.offset) { i, t in
                            Text(t.attrs["label"] ?? "Tab \(i + 1)").tag(i)
                        }
                    }
                    .pickerStyle(.segmented)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(Array(tabs.enumerated()), id: \.offset) { i, t in
                                Button(t.attrs["label"] ?? "Tab \(i + 1)") { active = i }
                                    .chipStyle(on: i == current)
                                    .font(.subheadline)
                            }
                        }
                    }
                }
                MdxBlocksView(blocks: tabs[current].children)
                    .id(current)
            }
        }
    }
}

struct MdxCollapsible: View {
    let title: String?
    let children: [MdxBlock]
    @State private var open = false

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            MdxBlocksView(blocks: children)
                .padding(.top, 8)
        } label: {
            Text(title ?? "Details")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
        }
        .tint(.secondary)
        .mdxCard()
    }
}

/// A Mermaid diagram, drawn by mermaid in a web view (MermaidView). Source it
/// can't parse falls back to the source in a code block, as on the desktop.
struct MdxDiagram: View {
    let title: String?
    let source: String
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title, !title.isEmpty {
                Label(title, systemImage: "point.3.connected.trianglepath.dotted")
                    .font(.subheadline.weight(.semibold))
            }
            let code = source.trimmingCharacters(in: .whitespacesAndNewlines)
            if !code.isEmpty {
                if failed {
                    CodeBlock(lang: "mermaid", text: source)
                    Text("Couldn’t draw this diagram")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    MermaidView(source: code, onError: { failed = true })
                }
            }
        }
    }
}
