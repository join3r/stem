import XCTest
@testable import Stem

/// "Copy" on a reply against the *.copy.md files in tests/fixtures/mdx, which
/// tests/unit/mdx-copy.test.ts checks against the desktop's converter.
final class MdxCopyTests: XCTestCase {
    func testEveryFixtureCopiesLikeTheDesktop() throws {
        let dir = try XCTUnwrap(Bundle(for: MdxCopyTests.self).url(forResource: "mdx", withExtension: nil))
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".mdx") }
            .map { String($0.dropLast(4)) }
            .sorted()
        XCTAssertGreaterThanOrEqual(names.count, 12)
        for name in names {
            let mdx = try String(contentsOf: dir.appendingPathComponent("\(name).mdx"), encoding: .utf8)
            let expected = try String(contentsOf: dir.appendingPathComponent("\(name).copy.md"), encoding: .utf8)
            XCTAssertEqual(MdxCopy.markdown(mdx) + "\n", expected, name)
        }
    }

    func testCodeKeepsItsTags() {
        XCTAssertEqual(MdxCopy.markdown("Use `<Callout>` like this."), "Use `<Callout>` like this.")
    }
}
