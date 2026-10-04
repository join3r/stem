import XCTest
@testable import Stem

/// The phone's MDX parser against the shared corpus in tests/fixtures/mdx,
/// which tests/unit/mdx-fixtures.test.ts checks against the desktop's parser.
final class MdxTreeTests: XCTestCase {
    private func fixtureDir() throws -> URL {
        let bundle = Bundle(for: MdxTreeTests.self)
        let dir = try XCTUnwrap(bundle.url(forResource: "mdx", withExtension: nil), "fixtures folder missing from the test bundle")
        return dir
    }

    func testEveryFixtureMatchesTheDesktopTree() throws {
        let dir = try fixtureDir()
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".mdx") }
            .map { String($0.dropLast(4)) }
            .sorted()
        XCTAssertGreaterThanOrEqual(names.count, 12)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        for name in names {
            let mdx = try String(contentsOf: dir.appendingPathComponent("\(name).mdx"), encoding: .utf8)
            let json = try Data(contentsOf: dir.appendingPathComponent("\(name).tree.json"))
            let expected = try JSONDecoder().decode(MdxTree.self, from: json)
            let actual = MdxTreeParser.parse(mdx)
            if actual != expected {
                let a = String(data: try encoder.encode(actual), encoding: .utf8) ?? ""
                let e = String(data: try encoder.encode(expected), encoding: .utf8) ?? ""
                XCTFail("\(name): tree differs\n--- expected\n\(e)\n--- actual\n\(a)")
            }
        }
    }

    func testUnclosedComponentIsMarkedOpen() {
        let tree = MdxTreeParser.parse("Hi\n\n<Chart type=\"bar\">\n```json\n[{\"a\":")
        guard case .component(let c) = tree.blocks.last else { return XCTFail("no component") }
        XCTAssertEqual(c.name, "Chart")
        XCTAssertFalse(c.closed)
        XCTAssertEqual(c.data?.value, "[{\"a\":")
    }

    func testCodeInsideProseComponentStaysContent() {
        let tree = MdxTreeParser.parse("<Callout>\n```bash\nls\n```\n</Callout>")
        guard case .component(let c) = tree.blocks.first else { return XCTFail("no component") }
        XCTAssertNil(c.data)
        XCTAssertEqual(c.children, [.md("```bash\nls\n```")])
    }
}

final class MdxDataTests: XCTestCase {
    func testChartColumnsKeepOrderAndPickTextX() throws {
        let d = try XCTUnwrap(MdxChartData.from(#"[{"month":"Jan","power":92,"water":"31"},{"month":"Feb","power":88,"water":29}]"#))
        XCTAssertEqual(d.xName, "month")
        XCTAssertEqual(d.labels, ["Jan", "Feb"])
        XCTAssertEqual(d.series.map(\.name), ["power", "water"])
        XCTAssertEqual(d.series[1].values, [31, 29])
        XCTAssertNil(d.xs)
    }

    func testColumnsRowsShape() throws {
        let d = try XCTUnwrap(MdxChartData.from(#"{"columns":["C","2025"],"rows":[["SK","1,200"],["CZ",90]]}"#))
        XCTAssertEqual(d.series[0].values, [1200, 90])
    }

    func testToNumber() {
        XCTAssertEqual(MdxDataParse.number(.string("12.5%")), 12.5)
        XCTAssertEqual(MdxDataParse.number(.string(" 1,234 ")), 1234)
        XCTAssertNil(MdxDataParse.number(.string("2h 14m")))
        XCTAssertNil(MdxDataParse.number(.bool(true)))
    }

    func testDonutFoldsSmallestIntoOther() {
        let s = MdxDonut.slices(labels: ["a", "b", "c", "d", "e", "f", "g"], values: [900, 420, 120, 80, 40, 30, 20])
        XCTAssertEqual(s.map(\.label), ["a", "b", "c", "d", "e", "Other"])
        XCTAssertEqual(s.last?.value, 50)
        XCTAssertEqual(s.last?.slot, -1)
    }

    func testStatsChanges() throws {
        let stats = try XCTUnwrap(MdxStat.list(#"[{"label":"Revenue","value":8200,"previous":8900,"unit":"$"},{"label":"Churn","value":3.1,"previous":3.8,"unit":"%","good":"down"},{"label":"Up","value":"99.98%","delta":"+0.02 pp"},{"label":"Big","value":12500,"previous":0}]"#))
        XCTAssertEqual(stats[0].value, "$8,200")
        XCTAssertEqual(stats[0].change, .init(text: "−7.9%", dir: .down, good: false))
        XCTAssertEqual(stats[1].change, .init(text: "−0.7 pp", dir: .down, good: true))
        XCTAssertEqual(stats[2].value, "99.98%")
        XCTAssertEqual(stats[2].change?.dir, .flat)
        XCTAssertEqual(stats[3].value, "12.5k")
        XCTAssertEqual(stats[3].change?.text, "12.5k")
    }
}
