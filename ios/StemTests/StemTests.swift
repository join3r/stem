import XCTest
@testable import Stem

final class SSEParserTests: XCTestCase {
    func testDataFrameAndCRLF() {
        var p = SSEParser()
        XCTAssertNil(p.feed("id: ab.1\r"))
        XCTAssertNil(p.feed("data:{\"channel\":\"x\"}"))
        XCTAssertEqual(p.feed(""), SSEBlock(event: nil, id: "ab.1", data: "{\"channel\":\"x\"}"))
    }

    func testMultiDataAndComments() {
        var p = SSEParser()
        XCTAssertNil(p.feed(": keepalive"))
        XCTAssertEqual(p.feed(""), SSEBlock(event: nil, id: nil, data: nil))
        _ = p.feed("event: resync")
        _ = p.feed("data: a")
        _ = p.feed("data: b")
        XCTAssertEqual(p.feed(""), SSEBlock(event: "resync", id: nil, data: "a\nb"))
    }
}

final class DeltaFoldTests: XCTestCase {
    private func msg(_ content: String, offset: Int = 0) -> ChatMessage {
        ChatMessage(id: "assistant-t", role: "assistant", content: content, streamOffset: offset)
    }

    func testAppendsInOrder() {
        XCTAssertEqual(ThreadStore.fold(msg("Hel"), delta: "lo", offset: 3), "Hello")
    }

    func testReplayedDeltaIsIgnored() {
        XCTAssertEqual(ThreadStore.fold(msg("Hello"), delta: "lo", offset: 3), "Hello")
    }

    func testUTF16Offsets() {
        // The emoji is two UTF-16 units; the server counts in those.
        XCTAssertEqual(ThreadStore.fold(msg("🙂a"), delta: "b", offset: 3), "🙂ab")
    }

    func testNoOffsetAppends() {
        XCTAssertEqual(ThreadStore.fold(msg("a"), delta: "b", offset: nil), "ab")
    }

    func testHydratedIgnoresDeltas() {
        var m = msg("saved")
        m.hydrated = true
        XCTAssertEqual(ThreadStore.fold(m, delta: "x", offset: 5), "saved")
    }
}

final class PairLinkTests: XCTestCase {
    func testParse() {
        let link = PairLink.parse(URL(string: "stem://pair?url=https%3A%2F%2Fstem.example.ts.net%2F&code=ABCD-EFGH")!)
        XCTAssertEqual(link?.serverUrl, "https://stem.example.ts.net")
        XCTAssertEqual(link?.code, "ABCD-EFGH")
    }

    func testNormalizeCode() {
        XCTAssertEqual(PairLink.normalizeCode("abcd-efgh "), "ABCDEFGH")
    }
}

final class InboxTests: XCTestCase {
    func testArchiveLiftsOnNewActivity() {
        var s = InboxState()
        s.entries["t"] = InboxEntry(archivedAt: 2000)
        XCTAssertEqual(Inbox.placement(id: "t", updatedAt: 1.5, state: s), .archived)
        XCTAssertEqual(Inbox.placement(id: "t", updatedAt: 3, state: s), .inbox)
    }

    func testUnreadUsesSecondsAndBaseline() {
        var s = InboxState(baseline: 1000, entries: [:])
        XCTAssertTrue(Inbox.isUnread(id: "t", updatedAt: 2, state: s))
        s.entries["t"] = InboxEntry(readAt: 2500)
        XCTAssertFalse(Inbox.isUnread(id: "t", updatedAt: 2, state: s))
        XCTAssertFalse(Inbox.isUnread(id: "x", updatedAt: 2, state: s, turnRunning: true))
    }
}

final class MarkdownTests: XCTestCase {
    func testBlocks() {
        let src = """
        # Title

        Some **bold** text.

        - one
        - two
          - nested

        ```swift
        let x = 1
        ```

        | a | b |
        |---|---|
        | 1 | 2 |

        <Chart title="Sales" data={[1,2]} />
        """
        let blocks = MarkdownParser.parse(src)
        XCTAssertEqual(blocks.first, .heading(level: 1, text: "Title"))
        XCTAssertTrue(blocks.contains(.code(lang: "swift", text: "let x = 1")))
        XCTAssertTrue(blocks.contains(.table(header: ["a", "b"], rows: [["1", "2"]])))
        XCTAssertTrue(blocks.contains { if case .component(let n, let t) = $0 { return n == "Chart" && t.contains("Sales") }; return false })
        guard case .list(false, _, let items)? = blocks.first(where: { if case .list = $0 { return true }; return false }) else {
            return XCTFail("no list")
        }
        XCTAssertEqual(items.count, 2)
        XCTAssertTrue(items[1].contains { if case .list = $0 { return true }; return false })
    }

    func testMailPreviewDropsMarkdown() {
        XCTAssertEqual(MdxText.preview("**Completed on your Mac.\nBoth ran** fine."), "Completed on your Mac. Both ran fine.")
        XCTAssertEqual(MdxText.preview("## Summary\n\n- one `x`\n- two\n\n> quoted _here_"), "Summary one x two quoted here")
        XCTAssertEqual(MdxText.preview("| a | b |\n|---|---|\n| 1 | 2 |"), "a b 1 2")
        XCTAssertEqual(MdxText.preview("```js\nlet x\n```\nafter"), "let x after")
    }
}
