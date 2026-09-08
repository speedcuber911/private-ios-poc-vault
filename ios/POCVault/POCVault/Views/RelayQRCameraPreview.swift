#if !targetEnvironment(simulator)
import AVFoundation
import SwiftUI
import UIKit

/// The app's one QR scanner.
///
/// Both places that scan — pairing a machine and approving a sign-in — use this
/// view. It emits the first QR string it sees and then stops emitting; a caller
/// that wants to scan again re-creates it (`.id(generation)`), which also tears
/// the capture session down and back up rather than leaving the camera running
/// behind an error screen.
///
/// Simulator builds compile this file away: there is no capture device, and
/// both callers already fall back to manual entry there.
struct RelayQRCameraPreview: UIViewRepresentable {
    let onCode: (String) -> Void
    let onDenied: () -> Void

    func makeUIView(context: Context) -> RelayQRCameraUIView {
        let view = RelayQRCameraUIView()
        view.onCode = onCode
        view.onDenied = onDenied
        view.start()
        return view
    }

    func updateUIView(_ uiView: RelayQRCameraUIView, context: Context) {
        uiView.onCode = onCode
        uiView.onDenied = onDenied
    }

    static func dismantleUIView(_ uiView: RelayQRCameraUIView, coordinator: ()) {
        uiView.stop()
    }
}

final class RelayQRCameraUIView: UIView, AVCaptureMetadataOutputObjectsDelegate {
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
