import Charts
import SwiftUI

// DataTable, Stats and Compare: the data-carrying components whose JSON
// fence the phone reads with MdxData.swift.

struct MdxDataTable: View {
    let caption: String?
    let data: String?
    let closed: Bool

    var body: some View {
        if let table = MdxDataParse.table(data), !table.columns.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                if let caption, !caption.isEmpty { Text(caption).font(.subheadline.weight(.semibold)) }
                ScrollView(.horizontal, showsIndicators: false) {
                    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                        GridRow {
                            ForEach(table.columns, id: \.self) { Text($0) }
                        }
                        .font(.footnote.weight(.semibold))
                        Divider()
                        ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                            GridRow {
                                ForEach(table.columns, id: \.self) { c in
                                    Text(row[c]?.text ?? "")
                                        .monospacedDigit()
                                        .fixedSize(horizontal: false, vertical: true)
                                        .frame(maxWidth: 240, alignment: .leading)
                                }
                            }
                            .font(.footnote)
                        }
                    }
                }
            }
            .mdxCard()
        } else if closed {
            MdxNote(text: "Could not read table data.")
        } else {
            MdxNote(text: "Building table…", busy: true)
        }
    }
}

struct MdxStatsView: View {
    let data: String?
    let closed: Bool
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if let stats = MdxStat.list(data) {
            // Two to a row; tiles in a row share its height.
            Grid(horizontalSpacing: 8, verticalSpacing: 8) {
                ForEach(Array(stride(from: 0, to: stats.count, by: 2)), id: \.self) { i in
                    GridRow {
                        tile(stats[i])
                        if i + 1 < stats.count { tile(stats[i + 1]) } else { Color.clear.gridCellUnsizedAxes([.horizontal, .vertical]) }
                    }
                }
            }
        } else if closed {
            MdxNote(text: "Could not read the numbers.")
        } else {
            MdxNote(text: "Adding up…", busy: true)
        }
    }

    private func tile(_ s: MdxStat) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(s.label).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            Text(s.value).font(.title3.weight(.semibold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
            if let c = s.change {
                let arrow = c.dir == .up ? "▲" : c.dir == .down ? "▼" : "■"
                Text("\(arrow) \(c.text)")
                    .font(.caption.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(c.good == nil ? Color.secondary : c.good! ? Color.green : Color.red)
                    .accessibilityLabel(c.text + (c.good == nil ? "" : c.good! ? ", better" : ", worse"))
            }
            if s.trend.count >= 2 {
                Chart(Array(s.trend.enumerated()), id: \.offset) { i, v in
                    LineMark(x: .value("i", i), y: .value("v", v))
                        .interpolationMethod(.monotone)
                        .lineStyle(StrokeStyle(lineWidth: 1.5))
                    if i == s.trend.count - 1 {
                        PointMark(x: .value("i", i), y: .value("v", v)).symbolSize(16)
                    }
                }
                .foregroundStyle(MdxPalette.color(0, scheme))
                .chartXAxis(.hidden)
                .chartYAxis(.hidden)
                .chartYScale(domain: .automatic(includesZero: false))
                .frame(height: 24)
                .accessibilityHidden(true)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(.secondarySystemBackground).opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct MdxCompareView: View {
    let recommend: String?
    let data: String?
    let closed: Bool

    private struct Option { var name, summary: String; var pros, cons: [String] }

    private var options: [Option]? {
        guard let table = MdxDataParse.table(data), !table.rows.isEmpty else { return nil }
        func list(_ v: OJSON?) -> [String] {
            if case .array(let a)? = v { return a.map(\.text).filter { !$0.isEmpty } }
            if case .string(let s)? = v, !s.isEmpty { return [s] }
            return []
        }
        return table.rows.prefix(4).map { r in
            Option(name: (r["name"] ?? r["option"])?.text ?? "",
                   summary: (r["summary"] ?? r["bestFor"] ?? r["best_for"])?.text ?? "",
                   pros: list(r["pros"]), cons: list(r["cons"]))
        }
    }

    var body: some View {
        if let options {
            let pick = recommend?.trimmingCharacters(in: .whitespaces).lowercased()
            VStack(spacing: 8) {
                ForEach(Array(options.enumerated()), id: \.offset) { _, o in
                    card(o, picked: pick.map { !$0.isEmpty && o.name.trimmingCharacters(in: .whitespaces).lowercased() == $0 } ?? false)
                }
            }
        } else if closed {
            MdxNote(text: "Could not read the options.")
        } else {
            MdxNote(text: "Lining up the options…", busy: true)
        }
    }

    private func card(_ o: Option, picked: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(o.name).font(.headline)
                Spacer()
                if picked {
                    Text("Recommended")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Color.accentColor, in: Capsule())
                }
            }
            if !o.summary.isEmpty { Text(o.summary).font(.subheadline).foregroundStyle(.secondary) }
            ForEach(Array(o.pros.enumerated()), id: \.offset) { _, p in mark("+", p, .green) }
            ForEach(Array(o.cons.enumerated()), id: \.offset) { _, c in mark("−", c, .red) }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground).opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            if picked { RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor, lineWidth: 1.5) }
        }
    }

    private func mark(_ sign: String, _ text: String, _ color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(sign).font(.subheadline.weight(.bold)).foregroundStyle(color).frame(width: 12)
                .accessibilityLabel(sign == "+" ? "Pro" : "Con")
            Text(text).font(.subheadline).fixedSize(horizontal: false, vertical: true)
        }
    }
}
