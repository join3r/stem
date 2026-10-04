import Charts
import SwiftUI

// <Chart>: the desktop's hand-drawn SVG chart (src/renderer/mdx/chart/Chart.tsx)
// in Swift Charts. Same data rules (first text column is x, every numeric
// column a series), same kinds and aliases, same categorical palette.

enum MdxChartKind {
    case line, area, bar, stacked, donut, scatter

    init(_ type: String?) {
        switch (type ?? "line").lowercased() {
        case "area": self = .area
        case "bar", "column": self = .bar
        case "stacked", "stacked-bar": self = .stacked
        case "donut", "pie": self = .donut
        case "scatter": self = .scatter
        default: self = .line
        }
    }
}

private struct ChartPoint: Identifiable {
    let id: Int
    let x: String
    let xn: Double
    let series: String
    let value: Double
}

struct MdxChartView: View {
    let type: String?
    let title: String?
    let unit: String?
    let data: String?
    let closed: Bool

    @Environment(\.colorScheme) private var scheme
    @State private var showTable = false
    @State private var selected: String?

    private static let maxSeries = 8
    private static let maxScatterSeries = 3

    var body: some View {
        if let parsed = MdxChartData.from(data) {
            content(parsed)
        } else if closed {
            MdxNote(text: "Could not read chart data.")
        } else {
            MdxNote(text: "Drawing chart…", busy: true)
        }
    }

    private func kind(for d: MdxChartData) -> MdxChartKind {
        let k = MdxChartKind(type)
        // A scatter needs two numeric axes; without them it is a line of categories.
        if k == .scatter, d.xs == nil, d.series.count < 2 { return .line }
        return k
    }

    @ViewBuilder private func content(_ d: MdxChartData) -> some View {
        let kind = kind(for: d)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                if let title, !title.isEmpty { Text(title).font(.subheadline.weight(.semibold)) }
                Spacer()
                Button(showTable ? "Chart" : "Table") { showTable.toggle() }
                    .font(.caption)
                    .buttonStyle(.borderless)
            }
            if showTable {
                MdxChartTable(data: d, unit: unit)
            } else {
                switch kind {
                case .donut: donut(d)
                case .scatter: scatter(d)
                default: cartesian(d, kind: kind)
                }
            }
        }
        .mdxCard()
    }

    // MARK: line / area / bar / stacked

    private func cartesian(_ d: MdxChartData, kind: MdxChartKind) -> some View {
        let series = Array(d.series.prefix(Self.maxSeries))
        let names = series.map(\.name)
        var points: [ChartPoint] = []
        for s in series {
            for (j, v) in s.values.enumerated() {
                if let v { points.append(ChartPoint(id: points.count, x: d.labels[j], xn: Double(j), series: s.name, value: v)) }
            }
        }
        var domain: [String] = []
        for l in d.labels where !domain.contains(l) { domain.append(l) }
        let xName = d.xName
        return Chart {
            ForEach(points) { p in
                if kind == .bar || kind == .stacked {
                    if kind == .bar {
                        BarMark(x: .value(xName, p.x), y: .value("Value", p.value))
                            .foregroundStyle(by: .value("Series", p.series))
                            .position(by: .value("Series", p.series))
                            .cornerRadius(3)
                    } else {
                        BarMark(x: .value(xName, p.x), y: .value("Value", p.value))
                            .foregroundStyle(by: .value("Series", p.series))
                    }
                } else {
                    if kind == .area {
                        AreaMark(x: .value(xName, p.x), y: .value("Value", p.value),
                                 series: .value("Series", p.series), stacking: .unstacked)
                            .foregroundStyle(by: .value("Series", p.series))
                            .opacity(0.18)
                    }
                    LineMark(x: .value(xName, p.x), y: .value("Value", p.value))
                        .foregroundStyle(by: .value("Series", p.series))
                        .lineStyle(StrokeStyle(lineWidth: 2))
                    if d.labels.count <= 24 {
                        PointMark(x: .value(xName, p.x), y: .value("Value", p.value))
                            .foregroundStyle(by: .value("Series", p.series))
                            .symbolSize(18)
                    }
                }
            }
            if let selected {
                RuleMark(x: .value(xName, selected))
                    .foregroundStyle(Color.secondary.opacity(0.35))
                    .annotation(position: .top, spacing: 4,
                                overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        tooltip(title: selected, rows: series.enumerated().compactMap { i, s in
                            guard let j = d.labels.firstIndex(of: selected), let v = s.values[j] else { return nil }
                            return (i, s.name, MdxFormat.value(v, unit))
                        })
                    }
            }
        }
        .chartXScale(domain: domain)
        .chartXSelection(value: $selected)
        .chartForegroundStyleScale(domain: names, range: names.indices.map { MdxPalette.color($0, scheme) })
        .chartLegend(names.count >= 2 ? .visible : .hidden)
        .chartLegend(position: .top, alignment: .leading)
        .chartYAxis { valueAxis }
        .frame(height: 220)
    }

    private var valueAxis: some AxisContent {
        AxisMarks(position: .leading) { v in
            AxisGridLine()
            AxisValueLabel {
                if let n = v.as(Double.self) { Text(MdxFormat.compact(n, unit)) }
            }
        }
    }

    private func tooltip(title: String, rows: [(Int, String, String)]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption.weight(.semibold))
            ForEach(rows, id: \.0) { slot, name, value in
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 2).fill(MdxPalette.color(slot, scheme)).frame(width: 8, height: 8)
                    Text(name).font(.caption2).foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Text(value).font(.caption2.weight(.semibold)).monospacedDigit()
                }
            }
        }
        .padding(8)
        .frame(minWidth: 120)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    }

    // MARK: donut

    private func donut(_ d: MdxChartData) -> some View {
        let slices = MdxDonut.slices(labels: d.labels, values: d.series[0].values)
        let total = slices.reduce(0) { $0 + $1.value }
        let pct = { (v: Double) -> String in
            let p = (v / total * 100).rounded()
            return total > 0 && p.isFinite ? "\(Int(p))%" : ""
        }
        return VStack(alignment: .leading, spacing: 10) {
            Chart(Array(slices.enumerated()), id: \.offset) { _, s in
                SectorMark(angle: .value("Value", s.value), innerRadius: .ratio(0.62), angularInset: 1.5)
                    .cornerRadius(3)
                    .foregroundStyle(MdxPalette.color(s.slot, scheme))
            }
            .chartBackground { _ in
                VStack(spacing: 0) {
                    Text(MdxFormat.compact(total, unit)).font(.headline).monospacedDigit()
                    Text("total").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .frame(height: 180)
            VStack(spacing: 6) {
                ForEach(Array(slices.enumerated()), id: \.offset) { _, s in
                    HStack(spacing: 8) {
                        RoundedRectangle(cornerRadius: 2).fill(MdxPalette.color(s.slot, scheme)).frame(width: 10, height: 10)
                        Text(s.label).font(.footnote).lineLimit(1)
                        Spacer(minLength: 8)
                        Text(MdxFormat.value(s.value, unit)).font(.footnote.weight(.semibold)).monospacedDigit()
                        Text(pct(s.value)).font(.footnote).foregroundStyle(.secondary).monospacedDigit()
                            .frame(minWidth: 36, alignment: .trailing)
                    }
                }
            }
        }
    }

    // MARK: scatter

    private func scatter(_ d: MdxChartData) -> some View {
        // x is the first column when every column is numeric, else the first series.
        let xs: [Double?] = d.xs ?? d.series[0].values
        let xName = d.xs != nil ? d.xName : d.series[0].name
        let ys = Array((d.xs != nil ? d.series : Array(d.series.dropFirst())).prefix(Self.maxScatterSeries))
        let names = ys.map(\.name)
        var points: [ChartPoint] = []
        for s in ys {
            for (j, v) in s.values.enumerated() {
                if let v, j < xs.count, let x = xs[j] {
                    points.append(ChartPoint(id: points.count, x: d.labels[j], xn: x, series: s.name, value: v))
                }
            }
        }
        return Chart(points) { p in
            PointMark(x: .value(xName, p.xn), y: .value("Value", p.value))
                .foregroundStyle(by: .value("Series", p.series))
                .symbolSize(36)
        }
        .chartForegroundStyleScale(domain: names, range: names.indices.map { MdxPalette.color($0, scheme) })
        .chartLegend(names.count >= 2 ? .visible : .hidden)
        .chartLegend(position: .top, alignment: .leading)
        .chartXAxisLabel(xName)
        .chartYAxis { valueAxis }
        .frame(height: 220)
    }
}

/// The chart's numbers as a table (the desktop's Table toggle).
private struct MdxChartTable: View {
    let data: MdxChartData
    let unit: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                GridRow {
                    Text(data.xName)
                    ForEach(data.series, id: \.name) { Text($0.name).gridColumnAlignment(.trailing) }
                }
                .font(.footnote.weight(.semibold))
                Divider()
                ForEach(Array(data.labels.enumerated()), id: \.offset) { j, label in
                    GridRow {
                        Text(label)
                        ForEach(data.series, id: \.name) { s in
                            Text(s.values[j].map { MdxFormat.value($0, unit) } ?? "–").monospacedDigit()
                        }
                    }
                    .font(.footnote)
                }
            }
        }
    }
}
