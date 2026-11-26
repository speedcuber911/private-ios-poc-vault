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
    private let sessionQueue = DispatchQueue(label: "com.parikshit.pocvault.qr-camera", qos: .userInitiated)
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didEmit = false
    private var isStopped = false

    override func layoutSubviews() {
        super.layoutSubviews()
        previewLayer?.frame = bounds
    }

    func start() {
        isStopped = false
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self, !self.isStopped else { return }
                    if granted {
                        self.configureSession()
                    } else {
                        self.onDenied?()
                    }
                }
            }
        default:
            onDenied?()
        }
    }

    func stop() {
        isStopped = true
        sessionQueue.async { [weak self] in
            guard let self, self.session.isRunning else { return }
            self.session.stopRunning()
        }
    }

    private func configureSession() {
        guard !isStopped, previewLayer == nil else { return }
        session.beginConfiguration()

        guard
            let device = AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else {
            session.commitConfiguration()
            onDenied?()
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            onDenied?()
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
        guard output.availableMetadataObjectTypes.contains(.qr) else {
            session.commitConfiguration()
            onDenied?()
            return
        }
        output.metadataObjectTypes = [.qr]

        session.commitConfiguration()

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = bounds
        self.layer.addSublayer(layer)
        previewLayer = layer

        sessionQueue.async { [weak self] in
            guard let self, !self.session.isRunning else { return }
            self.session.startRunning()
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
