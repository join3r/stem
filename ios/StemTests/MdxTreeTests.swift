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

    func testDataComponentLeftOpenClosesAfterItsFence() {
        let src = "<DataTable caption=\"U\">\n```json\n[{\"a\":\"1\"}]\n```\nProse after.\n\n<Callout type=\"warn\">\nCareful.\n</Callout>\n\n</DataTable>"
        let tree = MdxTreeParser.parse(src)
        guard tree.blocks.count == 3, case .component(let table) = tree.blocks[0],
              case .md(let prose) = tree.blocks[1], case .component(let callout) = tree.blocks[2]
        else { return XCTFail("unexpected tree: \(tree.blocks)") }
        XCTAssertEqual(table.name, "DataTable")
        XCTAssertTrue(table.closed)
        XCTAssertEqual(table.data?.value, "[{\"a\":\"1\"}]")
        XCTAssertEqual(prose, "Prose after.")
        XCTAssertEqual(callout.name, "Callout")
    }

    func testDataComponentWaitsForAClosingTagStillStreaming() {
        let tree = MdxTreeParser.parse("<DataTable>\n```json\n[]\n```\n</Data")
        guard case .component(let c) = tree.blocks.first else { return XCTFail("no component") }
        XCTAssertFalse(c.closed)
    }

    func testCodeInsideProseComponentStaysContent() {
        let tree = MdxTreeParser.parse("<Callout>\n```bash\nls\n```\n</Callout>")
        guard case .component(let c) = tree.blocks.first else { return XCTFail("no component") }
        XCTAssertNil(c.data)
        XCTAssertEqual(c.children, [.md("```bash\nls\n```")])
    }
}

final class MdxDataTests: XCTestCase {
    func testCompleteRowsClosesAfterLastCompleteRow() {
        XCTAssertEqual(MdxDataParse.completeRows(#"[{"a":1},{"a":2},{"a""#), #"[{"a":1},{"a":2}]"#)
        XCTAssertEqual(MdxDataParse.completeRows(#"[{"s":"}]\"{"},{"t":[1,{"u":2}]},{"v":"x"#), #"[{"s":"}]\"{"},{"t":[1,{"u":2}]}]"#)
        XCTAssertEqual(MdxDataParse.completeRows(#"[{"a":1}]"#), #"[{"a":1}]"#)
        XCTAssertNil(MdxDataParse.completeRows(#"[{"a":"#))
        XCTAssertNil(MdxDataParse.completeRows(#"{"columns":["a"],"rows":[[1]"#))
    }

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

    // Data and structure are model output: malformed or hostile input must be
    // refused or flattened, never trap or overflow the stack.
    func testMalformedSurrogatePairIsRefusedNotTrapped() {
        XCTAssertNil(OJSON.parse(#"["\uD800\u0041"]"#))
        XCTAssertNotNil(OJSON.parse(#"["\uD83D\uDE00"]"#))
    }

    func testDeepJSONIsRefused() {
        XCTAssertNil(OJSON.parse(String(repeating: "[", count: 100_000)))
        XCTAssertNotNil(OJSON.parse(String(repeating: "[", count: 10) + String(repeating: "]", count: 10)))
    }

    func testDeepComponentNestingIsCapped() {
        let deep = String(repeating: "<Callout>\n", count: 5_000) + "bottom" + String(repeating: "\n</Callout>", count: 5_000)
        let tree = MdxTreeParser.parse(deep)
        var depth = 0
        var blocks = tree.blocks
        while let next = blocks.compactMap({ block -> [MdxBlock]? in
            if case .component(let c) = block { return c.children }
            return nil
        }).first {
            depth += 1
            blocks = next
        }
        XCTAssertLessThanOrEqual(depth, 17)
    }
}


/// Choice forms answer in the desktop's exact wording: mail reads the prompt
/// line back to tell an answered form from an open one.
final class MdxFormTests: XCTestCase {
    private let source = """
    <Form prompt="Answers to the memory check">
    <Field type="choice" name="q1" label="Where?" hint="A hint." other="true">
    <Option>Home</Option>
    <Option>Work</Option>
    </Field>
    <Field name="q2" label="Which projects?" multiple="true">
    <Option>Join</Option>
    <Option>joinvc</Option>
    </Field>
    <Field name="q3" label="Notes" type="textarea" />
    </Form>
    """

    private var fields: [MdxFieldSpec] {
        guard case .component(let form) = MdxTreeParser.parse(source).blocks.first else { return [] }
        return MdxFieldSpec.list(form.children)
    }

    func testFieldsReadOptionsAndFlags() {
        let fs = fields
        XCTAssertEqual(fs.map(\.type), ["choice", "choice", "textarea"])
        XCTAssertEqual(fs[0].options, ["Home", "Work"])
        XCTAssertEqual(fs[0].hint, "A hint.")
        XCTAssertTrue(fs[0].other)
        XCTAssertTrue(fs[1].multiple)
    }

    func testAnswerTextMatchesTheDesktop() {
        var d = MdxFormDraft()
        d.values["q1"] = [MdxFormDraft.other]
        d.others["q1"] = " Ivka's flat "
        d.values["q2"] = ["Join", "joinvc"]
        XCTAssertEqual(d.answered(fields), 2)
        XCTAssertEqual(d.text(prompt: "Answers to the memory check", fields: fields),
                       "Answers to the memory check\n- Where?: Ivka's flat\n- Which projects?: Join, joinvc\n- Notes: (skipped)")
        XCTAssertEqual(MdxFormDraft().text(prompt: nil, fields: Array(fields.prefix(1))), "- Where?: (skipped)")
    }

    private func mail(_ from: String, _ body: String, at: Double) -> MailItem {
        MailItem(id: "m\(Int(at))", conversationId: "c", from: from, to: from == "user" ? ["memory-check"] : ["user"],
                 body: body, at: at)
    }

    func testMailWithAnOpenFormStaysOpenUntilItsAnswersArrive() {
        let check = mail("memory-check", "Check.\n\n" + source, at: 1)
        let ask = mail("user", "About “Where?”: why?", at: 2)
        let explain = mail("memory-check", "Because.", at: 3)
        XCTAssertTrue(MailThread.layout([check, ask, explain]).open.contains(check.id))
        let answers = mail("user", "Answers to the memory check\n- Where?: Home", at: 4)
        let done = mail("memory-check", "Saved.", at: 5)
        XCTAssertFalse(MailThread.layout([check, ask, explain, answers, done]).open.contains(check.id))
    }

    func testPreviewDropsComponentTags() {
        let body = "I read all 672 facts.\n\n### Fixed\n<FactChange check=\"k\" change=\"c1\" fact=\"2833\" text=\"The user is a cloud engineer.\" />\n<Option>Raycast</Option>"
        XCTAssertEqual(MdxText.preview(body), "I read all 672 facts. Fixed Raycast")
    }
}

final class MarkdownImageLineTests: XCTestCase {
    func testImageOnlyLinesBecomeImageBlocks() {
        let blocks = MarkdownParser.parse("Here:\n\n![Deck-Man](https://is1-ssl.mzstatic.com/a.jpg)\n\n![a](https://x.com/1.png) ![b](https://x.com/2.png \"t\")")
        XCTAssertEqual(blocks, [
            .paragraph("Here:"),
            .image(alt: "Deck-Man", url: "https://is1-ssl.mzstatic.com/a.jpg"),
            .image(alt: "a", url: "https://x.com/1.png"),
            .image(alt: "b", url: "https://x.com/2.png")
        ])
    }

    func testImageInsideTextStaysInline() {
        XCTAssertEqual(MarkdownParser.parse("see ![a](https://x.com/1.png) here"), [.paragraph("see ![a](https://x.com/1.png) here")])
        XCTAssertNil(MarkdownParser.imageLine("![a](https://x.com/1.png) and text"))
    }
}
