import AVFoundation
import SwiftUI
import UIKit

/// In-app QR scanner for CLI device-code linking, with always-visible manual entry.
struct CLILinkScannerView: View {
    @StateObject private var model: CLILinkFlowModel
    @Environment(\.dismiss) private var dismiss
    @State private var cameraDenied = false

    init(authClient: RelayAuthClient, bearerToken: String) {
        _model = StateObject(wrappedValue: CLILinkFlowModel(authClient: authClient, bearerToken: bearerToken))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                content
            }
            .background(AppTheme.bgCanvas.ignoresSafeArea())
            .navigationTitle("Link a computer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.step {
        case .scanning:
            scanningBody
        case .inspecting:
            statusBody(title: "Checking code", detail: "Looking up the computer that requested this link…")
        case .confirm(let machineName, let platform):
            confirmBody(machineName: machineName, platform: platform)
        case .approving:
            statusBody(title: "Linking", detail: "Approving this computer…")
        case .linked:
            linkedBody
        case .failed(let reason):
            failedBody(reason: reason)
        }
    }

    private var scanningBody: some View {
        VStack(spacing: 16) {
            #if !targetEnvironment(simulator)
            ZStack {
                CLILinkCameraPreview(onCode: { code in
                    Task { await model.submitScannedPayload(code) }
                }, onDenied: { cameraDenied = true })
                .frame(maxWidth: .infinity)
                .frame(height: 280)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                if cameraDenied {
                    cameraDeniedOverlay
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            #else
            cameraDeniedOverlay
                .padding(.horizontal, 16)
                .padding(.top, 12)
            #endif

            VStack(alignment: .leading, spacing: 8) {
                Text("Or type the code")
                    .font(AppTheme.uiFont(size: 13, weight: .semibold))
                    .foregroundStyle(AppTheme.textSecondary)
                TextField("ABCD-EFGH", text: $model.manualCode)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .font(AppTheme.monoFont(size: 18))
                    .padding(12)
                    .background(AppTheme.textPrimary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                Button("Continue") {
                    Task { await model.submitManualCode() }
                }
                .buttonStyle(RelayPrimaryButtonStyle(isEnabled: !model.manualCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                .disabled(model.manualCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(16)

            Spacer(minLength: 0)
        }
    }

    private var cameraDeniedOverlay: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Camera unavailable")
                .font(AppTheme.uiFont(size: 17, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
            Text("Relay uses the camera to scan the code shown by the relay CLI. You can still type the code below.")
                .font(AppTheme.uiFont(size: 14))
                .foregroundStyle(AppTheme.textSecondary)
            if let url = URL(string: UIApplication.openSettingsURLString) {
                Link("Open Settings", destination: url)
                    .font(AppTheme.uiFont(size: 15, weight: .semibold))
                    .foregroundStyle(AppTheme.accent)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.textPrimary.opacity(0.05), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func confirmBody(machineName: String?, platform: String?) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(machineName?.isEmpty == false ? machineName! : "Unknown computer")
                .font(AppTheme.serifFont(size: 28))
                .foregroundStyle(AppTheme.textPrimary)
            Text(platformLabel(platform))
                .font(AppTheme.uiFont(size: 15))
                .foregroundStyle(AppTheme.textSecondary)
            Text("Only continue if you just ran `relay login` on this computer.")
                .font(AppTheme.uiFont(size: 15))
                .foregroundStyle(AppTheme.textPrimary)
            Spacer(minLength: 12)
            Button("Link computer") {
                Task { await model.confirmLink() }
            }
            .buttonStyle(RelayPrimaryButtonStyle(isEnabled: true))
            Button("Cancel") {
                model.cancelConfirm()
            }
            .font(AppTheme.uiFont(size: 16, weight: .semibold))
            .foregroundStyle(AppTheme.textSecondary)
            .frame(maxWidth: .infinity)
        }
        .padding(24)
    }

    private func statusBody(title: String, detail: String) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Text(title)
                .font(AppTheme.uiFont(size: 20, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
            Text(detail)
                .font(AppTheme.uiFont(size: 15))
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity)
    }

    private var linkedBody: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("Computer linked")
                .font(AppTheme.serifFont(size: 28))
                .foregroundStyle(AppTheme.textPrimary)
            Text("This computer can use `relay handoff` with your Relay account.")
                .font(AppTheme.uiFont(size: 15))
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
            Spacer()
            Button("Done") { dismiss() }
                .buttonStyle(RelayPrimaryButtonStyle(isEnabled: true))
        }
        .padding(24)
    }

    private func failedBody(reason: String) -> some View {
        VStack(spacing: 16) {
            Spacer()
            Text("Couldn't link")
                .font(AppTheme.uiFont(size: 20, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
            Text(reason)
                .font(AppTheme.uiFont(size: 15))
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
            Spacer()
            Button("Try again") { model.resetToScanning() }
                .buttonStyle(RelayPrimaryButtonStyle(isEnabled: true))
        }
        .padding(24)
    }

    private func platformLabel(_ platform: String?) -> String {
        switch platform {
        case "macos": return "macOS"
        case "linux": return "Linux"
        case "windows": return "Windows"
        case "other": return "Other platform"
        case .some(let value) where !value.isEmpty: return value
        default: return "Platform unknown"
        }
    }
}

#if !targetEnvironment(simulator)
private struct CLILinkCameraPreview: UIViewRepresentable {
    let onCode: (String) -> Void
    let onDenied: () -> Void

    func makeUIView(context: Context) -> CLILinkCameraUIView {
        let view = CLILinkCameraUIView()
        view.onCode = onCode
        view.onDenied = onDenied
        view.start()
        return view
    }

    func updateUIView(_ uiView: CLILinkCameraUIView, context: Context) {
        uiView.onCode = onCode
        uiView.onDenied = onDenied
    }

    static func dismantleUIView(_ uiView: CLILinkCameraUIView, coordinator: ()) {
        uiView.stop()
    }
}

private final class CLILinkCameraUIView: UIView, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var onDenied: (() -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didEmit = false

    override func layoutSubviews() {
        super.layoutSubviews()
        previewLayer?.frame = bounds
    }

    func start() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted {
                        self?.configureSession()
                    } else {
                        self?.onDenied?()
                    }
                }
            }
        default:
            onDenied?()
        }
    }

    func stop() {
        if session.isRunning { session.stopRunning() }
    }

    private func configureSession() {
        guard previewLayer == nil else { return }
        session.beginConfiguration()
        defer { session.commitConfiguration() }

        guard
            let device = AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else {
            onDenied?()
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            onDenied?()
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = bounds
        self.layer.addSublayer(layer)
        previewLayer = layer

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.session.startRunning()
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !didEmit,
              let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              object.type == .qr,
              let value = object.stringValue,
              !value.isEmpty
        else { return }
        didEmit = true
        onCode?(value)
    }
}
#endif
