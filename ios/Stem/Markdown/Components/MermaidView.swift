import SwiftUI
import WebKit

/// Draws Mermaid source the way the desktop's <Diagram> does: mermaid itself,
/// in a web view, with securityLevel "strict" so a diagram can only be a picture.
/// mermaid.min.js ships in the app bundle (project.yml copies it from the repo's
/// node_modules, the same version the desktop renders with) and is injected as a
/// user script; the page itself has no base URL, a CSP that allows no network
/// at all, and may not navigate anywhere. The web view reports the drawing's height back and the cell sizes to
/// it; a source mermaid can't parse reports an error, and the caller shows the
/// source instead.
struct MermaidView: View {
    let source: String
    /// Called once if mermaid could not draw the source.
    var onError: () -> Void = {}

    @Environment(\.colorScheme) private var scheme
    @State private var height: CGFloat = 0

    var body: some View {
        MermaidWebView(source: source, dark: scheme == .dark, height: $height, onError: onError)
            // Keyed on the scheme, so a light/dark flip redraws in the new colors.
            .id(scheme)
            .frame(height: max(height, 60))
            .overlay {
                if height == 0 { ProgressView().controlSize(.small) }
            }
    }
}

private struct MermaidWebView: UIViewRepresentable {
    let source: String
    let dark: Bool
    @Binding var height: CGFloat
    let onError: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        // A weak hop: the controller retains its handlers, and the coordinator owns nothing of the view.
        config.userContentController.add(WeakHandler(context.coordinator), name: "mermaid")
        if let script = Self.mermaidScript {
            // User scripts are not subject to the page's CSP, so mermaid runs while the page may fetch nothing.
            config.userContentController.addUserScript(
                WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )
        }
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.backgroundColor = .clear
        view.navigationDelegate = context.coordinator
        view.loadHTMLString(Self.page(source: source, dark: dark), baseURL: nil)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "mermaid")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: MermaidWebView
        private var failed = false
        private var loaded = false
        init(_ parent: MermaidWebView) { self.parent = parent }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any] else { return }
            if let h = body["height"] as? Double, h > 0 {
                parent.height = CGFloat(h)
            } else if body["error"] != nil, !failed {
                failed = true
                parent.onError()
            }
        }

        // The one page we load, and nothing after it: a diagram never navigates anywhere.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor action: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if !loaded, action.targetFrame?.isMainFrame == true, action.request.url?.absoluteString == "about:blank" {
                loaded = true
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
            }
        }
    }

    private final class WeakHandler: NSObject, WKScriptMessageHandler {
        weak var target: WKScriptMessageHandler?
        init(_ target: WKScriptMessageHandler) { self.target = target }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            target?.userContentController(controller, didReceive: message)
        }
    }

    /// The colors the desktop draws with (Stem's light and dark tokens), as mermaid theme variables.
    private static func themeVariables(dark: Bool) -> [String: String] {
        let surface = dark ? "#2e2a23" : "#fffdf9"
        let ink = dark ? "#f0ece4" : "#23211d"
        let muted = dark ? "#9b948a" : "#6d675d"
        let line = dark ? "#3d382f" : "#e0dccf"
        let soft = dark ? "#2f2b25" : "#efeae0"
        let content = dark ? "#242119" : "#faf8f3"
        return [
            "fontFamily": "-apple-system, system-ui, sans-serif",
            "fontSize": "14px",
            "background": "transparent",
            "primaryColor": surface, "primaryTextColor": ink, "primaryBorderColor": muted,
            "secondaryColor": soft, "tertiaryColor": content,
            "lineColor": muted, "textColor": ink, "mainBkg": surface, "nodeBorder": muted,
            "clusterBkg": content, "clusterBorder": line, "edgeLabelBackground": content,
            "actorBkg": surface, "actorBorder": muted, "actorTextColor": ink,
            "signalColor": ink, "signalTextColor": ink,
            "noteBkgColor": soft, "noteTextColor": ink, "noteBorderColor": line,
        ]
    }

    /// mermaid.min.js from the bundle, read once.
    private static let mermaidScript: String? = Bundle.main
        .url(forResource: "mermaid.min", withExtension: "js")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }

    private static func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
              let text = String(data: data, encoding: .utf8) else { return "null" }
        // Inside a <script>, "</" would end it early.
        return text.replacingOccurrences(of: "</", with: "<\\/")
    }

    static func page(source: String, dark: Bool) -> String {
        """
        <!doctype html>
        <html><head>
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
        <style>
          html, body { margin: 0; padding: 0; background: transparent; }
          #d { display: flex; justify-content: center; }
          #d svg { max-width: 100% !important; height: auto; }
        </style>
        </head><body><div id="d"></div>
        <script>
        (async () => {
          const post = (m) => window.webkit.messageHandlers.mermaid.postMessage(m);
          try {
            mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base',
                                 themeVariables: \(json(themeVariables(dark: dark))) });
            const { svg } = await mermaid.render('stem-diagram', \(json(source)));
            const box = document.getElementById('d');
            box.innerHTML = svg;
            const report = () => post({ height: Math.ceil(box.getBoundingClientRect().height) });
            report();
            new ResizeObserver(report).observe(box);
          } catch (e) {
            post({ error: String(e && e.message || e) });
          }
        })();
        </script>
        </body></html>
        """
    }
}
