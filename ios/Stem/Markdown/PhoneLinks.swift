import Foundation

/// Phone numbers in a reply become tel: links, so a tap offers to call. A port
/// of src/shared/phone-links.ts — same shapes, same narrowness (dates, versions,
/// ids and prices never match); change both together.
enum PhoneLinks {
    private static let regex = try! NSRegularExpression(
        pattern: #"(?<![\w/.+=:-])(?:\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,6}|\(?0\d{1,4}\)?(?:[ .-]\d{2,4}){2,4}|\(\d{3}\) ?\d{3}[ .-]\d{4}|\d{3}[.-]\d{3}[.-]\d{4})(?![\w/-]|[.,:]\d)"#)

    /// Each number's range in `text` and its tel: URL.
    static func find(in text: String) -> [(range: Range<String.Index>, url: URL)] {
        let ns = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: ns).compactMap { m in
            guard let r = Range(m.range, in: text) else { return nil }
            let s = text[r]
            let digits = s.filter(\.isASCII).filter(\.isNumber)
            guard (8...15).contains(digits.count),
                  let url = URL(string: "tel:\(s.hasPrefix("+") ? "+" : "")\(digits)") else { return nil }
            return (r, url)
        }
    }

    /// Adds a link to every phone number in a run that is not already a link or code.
    static func link(_ a: inout AttributedString) {
        for run in a.runs.reversed() where run.link == nil && run.inlinePresentationIntent?.contains(.code) != true {
            let text = String(a[run.range].characters)
            for (r, url) in find(in: text).reversed() {
                let lo = text.distance(from: text.startIndex, to: r.lowerBound)
                let hi = text.distance(from: text.startIndex, to: r.upperBound)
                let start = a.characters.index(run.range.lowerBound, offsetBy: lo)
                let end = a.characters.index(run.range.lowerBound, offsetBy: hi)
                a[start..<end].link = url
            }
        }
    }
}
