import AVFoundation
import SwiftUI

/// First run: scan the QR the desktop shows (Settings → Server → Devices →
/// Pair a phone), or type the address and code.
struct PairView: View {
    @Environment(AppModel.self) private var app
    @State private var serverUrl = ""
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?
    @State private var scanning = false
    /// Filled in from a link: the address is shown for checking, not paired yet.
    @State private var fromLink = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "leaf.fill").font(.largeTitle).foregroundStyle(.green)
                        Text("Connect to your Stem").font(.title2.bold())
                        Text("On the desktop open Settings → Server → Devices → Pair a phone, then scan the code it shows.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                    Button { scanning = true } label: { Label("Scan QR code", systemImage: "qrcode.viewfinder") }
                }
                Section("Or enter it by hand") {
                    TextField("Server address (https://…)", text: $serverUrl)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Pairing code", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                }
                if fromLink, let host = URL(string: PairLink.normalizeURL(serverUrl))?.host {
                    Section {
                        Label("A link filled this in. Pair only if \(host) is your own Stem server.", systemImage: "exclamationmark.shield")
                            .font(.footnote)
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    Button { Task { await pair() } } label: {
                        HStack { Spacer(); if busy { ProgressView() } else { Text("Pair").bold() }; Spacer() }
                    }
                    .disabled(busy || serverUrl.isEmpty || PairLink.normalizeCode(code).count != 8)
                }
            }
            .navigationTitle("Pair")
            .sheet(isPresented: $scanning) {
                QRScanner { value in
                    scanning = false
                    if let url = URL(string: value), let link = PairLink.parse(url) {
                        serverUrl = link.serverUrl
                        code = link.code
                        Task { await pair() }
                    } else {
                        error = "That QR code isn't a Stem pairing code."
                    }
                }
                .ignoresSafeArea()
            }
            .onAppear(perform: takePendingLink)
            .onChange(of: app.pendingPairLink?.code) { _, _ in takePendingLink() }
        }
    }

    private func takePendingLink() {
        guard let link = app.pendingPairLink else { return }
        app.pendingPairLink = nil
        serverUrl = link.serverUrl
        code = link.code
        error = nil
        fromLink = true
    }

    private func pair() async {
        let url = PairLink.normalizeURL(serverUrl)
        if let problem = PairLink.validate(url) { error = problem; return }
        guard PairLink.normalizeCode(code).count == 8 else { error = "The code has 8 characters, like ABCD-EFGH."; return }
        busy = true
        defer { busy = false }
        do {
            let creds = try await StemClient.pair(serverUrl: url, code: code)
            error = nil
            app.paired(creds)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct QRScanner: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let c = ScannerController()
        c.onCode = onCode
        return c
    }

    func updateUIViewController(_ vc: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        private let captureSession = AVCaptureSession()
        private var done = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  captureSession.canAddInput(input) else {
                let label = UILabel()
                label.text = "No camera available"
                label.textColor = .white
                label.frame = view.bounds
                label.textAlignment = .center
                view.addSubview(label)
                return
            }
            captureSession.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard captureSession.canAddOutput(output) else { return }
            captureSession.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let preview = AVCaptureVideoPreviewLayer(session: captureSession)
            preview.videoGravity = .resizeAspectFill
            preview.frame = view.layer.bounds
            view.layer.addSublayer(preview)
            let s = captureSession
            DispatchQueue.global(qos: .userInitiated).async { s.startRunning() }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            view.layer.sublayers?.first { $0 is AVCaptureVideoPreviewLayer }?.frame = view.layer.bounds
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            let s = captureSession
            DispatchQueue.global(qos: .userInitiated).async { s.stopRunning() }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !done, let obj = objects.first as? AVMetadataMachineReadableCodeObject, let value = obj.stringValue else { return }
            done = true
            onCode?(value)
        }
    }
}
