import AVFoundation
import Combine
import Foundation

/// Streams microphone audio to the Relay STT service and publishes transcript text
/// as it arrives, so the composer fills while the user is still speaking.
///
/// The wire format is fixed by the upstream provider and is NOT negotiable: raw
/// 16 kHz mono little-endian Int16 PCM, base64'd into a JSON text frame. The
/// device microphone is whatever the hardware gives us (commonly 48 kHz float32),
/// so every tap buffer goes through an `AVAudioConverter` before it leaves.
@MainActor
final class RelayStreamingTranscriber: NSObject, ObservableObject {
    enum Phase: Equatable {
        case idle
        case listening
        /// Audio has stopped; the tail of the transcript is still arriving.
        case finalizing
        case failed(String)
    }

    enum TranscriberError: LocalizedError {
        case microphoneDenied
        case unconfigured
        case engineFailed

        var errorDescription: String? {
            switch self {
            case .microphoneDenied: return "Relay needs microphone access to dictate."
            case .unconfigured: return "Dictation is not configured for this build."
            case .engineFailed: return "The microphone could not start."
            }
        }
    }

    @Published private(set) var phase: Phase = .idle
    /// Transcript so far. Grows as segments arrive and is the value the composer mirrors.
    @Published private(set) var transcript = ""
    @Published private(set) var elapsed: TimeInterval = 0
    /// 0...1 short-window loudness, smoothed. Drives the mic control's own reaction.
    @Published private(set) var level: Double = 0
    /// Rolling loudness history, oldest first, for the composer's waveform. A single
    /// level can only pulse; a history draws the shape of what was actually said,
    /// which is what tells the user the microphone is really hearing them.
    @Published private(set) var levels: [Double] = []

    static let waveformSampleCount = 42

    var isActive: Bool {
        switch phase {
        case .listening, .finalizing: return true
        case .idle, .failed: return false
        }
    }

    private let endpoint: URL
    private let sharedSecret: String
    private let session: URLSession
    private let engine = AVAudioEngine()
    private var socket: URLSessionWebSocketTask?
    private var converter: AVAudioConverter?
    private var ticker: Timer?
    private var startedAt: Date?
    private var finalContinuation: CheckedContinuation<String, Never>?
    private var finalizeTask: Task<Void, Never>?
    private var socketGeneration = UUID()
    private var captureGeneration = UUID()
    private var externalAudio = false
    private var tapInstalled = false
    /// Sarvam emits one frame per settled segment rather than a growing whole, so
    /// the utterance is the join of everything received in arrival order.
    private var segments: [String] = []

    private static let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: true
    )

    init(
        endpoint: URL = AppConfiguration.sttStreamURL,
        sharedSecret: String = AppConfiguration.sttSharedSecret,
        session: URLSession = .shared
    ) {
        self.endpoint = endpoint
        self.sharedSecret = sharedSecret
        self.session = session
        super.init()
    }

    // MARK: - Lifecycle

    func start() async throws {
        guard !isActive else { return }
        guard !sharedSecret.isEmpty else { throw TranscriberError.unconfigured }
        guard await Self.requestMicrophonePermission() else { throw TranscriberError.microphoneDenied }

        cancel()

        segments = []
        transcript = ""
        elapsed = 0
        level = 0
        levels = []

        try openSocket()
        do {
            try startEngine()
        } catch {
            stopEngine()
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
            closeSocket()
            throw TranscriberError.engineFailed
        }

        startedAt = Date()
        phase = .listening
        startTicking()
    }

    /// The watch supplies PCM through its paired phone. This uses precisely the
    /// same service, authentication and transcript handling as iPhone dictation,
    /// without activating the phone's microphone or its metering timer.
    func startExternalAudio() throws {
        guard !sharedSecret.isEmpty else { throw TranscriberError.unconfigured }
        cancel()
        externalAudio = true
        segments = []
        transcript = ""
        elapsed = 0
        levels = []
        try openSocket()
        phase = .listening
    }

    func appendExternalAudio(_ pcm: Data) async throws {
        guard externalAudio, phase == .listening, let socket else {
            throw RelayWatchError("Dictation stopped. Review the text received so far.")
        }
        let generation = socketGeneration
        try await socket.send(Self.audioMessage(pcm))
        guard generation == socketGeneration, phase == .listening else {
            throw RelayWatchError("Dictation stopped. Review the text received so far.")
        }
    }

    func finishExternalAudio() async throws -> String {
        let generation = captureGeneration
        let text = await stop()
        guard captureGeneration == generation else { throw CancellationError() }
        if case .failed(let message) = phase { throw RelayWatchError(message) }
        guard externalAudio else { throw CancellationError() }
        externalAudio = false
        return text
    }

    /// Stops capture and waits briefly for the provider to flush the tail of the
    /// utterance. Returns the final transcript — empty if nothing was heard.
    @discardableResult
    func stop() async -> String {
        guard isActive else { return transcript }
        guard phase != .finalizing else { return transcript }

        stopEngine()
        stopTicking()
        phase = .finalizing

        let generation = socketGeneration
        let settled = await withCheckedContinuation { (continuation: CheckedContinuation<String, Never>) in
            finalContinuation = continuation
            socket?.send(.string(#"{"type":"flush"}"#)) { [weak self] error in
                guard error != nil else { return }
                Task { @MainActor in
                    guard let self, self.socketGeneration == generation else { return }
                    self.phase = .failed("Dictation could not finish. Review the text received so far.")
                    self.resumeFinal(with: self.transcript)
                }
            }
            // The tail is a courtesy, not a contract: if the provider goes quiet we
            // keep whatever already arrived rather than stranding the user's words.
            finalizeTask = Task { @MainActor in
                do { try await Task.sleep(nanoseconds: Self.finalizeGraceNanoseconds) }
                catch { return }
                guard self.socketGeneration == generation else { return }
                if self.externalAudio {
                    self.phase = .failed("The final words could not be confirmed. Review your text before sending.")
                }
                self.resumeFinal(with: self.transcript)
            }
        }

        guard socketGeneration == generation else { return settled }
        closeSocket()
        if phase == .finalizing { phase = .idle }
        transcript = settled
        return settled
    }

    func cancel() {
        captureGeneration = UUID()
        stopEngine()
        stopTicking()
        closeSocket()
        resumeFinal(with: transcript)
        externalAudio = false
        phase = .idle
    }

    private static let finalizeGraceNanoseconds: UInt64 = 2_500_000_000

    /// Single resume path for the finalize continuation. Guarded and MainActor-bound,
    /// so the provider's `final` frame and the grace timer cannot both resume it —
    /// double-resuming a checked continuation is a hard crash, dropping one is a leak.
    private func resumeFinal(with text: String) {
        finalizeTask?.cancel()
        finalizeTask = nil
        guard let continuation = finalContinuation else { return }
        finalContinuation = nil
        continuation.resume(returning: text)
    }

    // MARK: - Audio

    private func startEngine() throws {
        let configuration = CodexPromptAudioRecordingConfiguration.devicePromptDefaults
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(configuration.category, mode: configuration.mode, options: configuration.options)
        try audioSession.setActive(true, options: [])

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard
            let targetFormat = Self.targetFormat,
            inputFormat.sampleRate > 0,
            let converter = AVAudioConverter(from: inputFormat, to: targetFormat)
        else { throw TranscriberError.engineFailed }
        self.converter = converter

        // ~100 ms per tap at typical hardware rates: small enough that partials feel
        // immediate, large enough that we are not paying JSON overhead per millisecond.
        let tapSize = AVAudioFrameCount(inputFormat.sampleRate / 10)
        input.installTap(onBus: 0, bufferSize: tapSize, format: inputFormat) { [weak self] buffer, _ in
            guard let self else { return }
            guard let pcm = Self.convert(buffer: buffer, using: converter, to: targetFormat) else { return }
            let loudness = Self.loudness(of: pcm)
            Task { @MainActor in
                self.sendAudio(pcm)
                // Asymmetric smoothing: rise fast so speech registers immediately,
                // fall slowly so the bars settle instead of strobing per syllable.
                self.level = max(loudness, self.level * 0.82)
                self.levels.append(loudness)
                if self.levels.count > Self.waveformSampleCount {
                    self.levels.removeFirst(self.levels.count - Self.waveformSampleCount)
                }
            }
        }
        tapInstalled = true

        engine.prepare()
        do { try engine.start() }
        catch { stopEngine(); throw error }
    }

    private func stopEngine() {
        guard tapInstalled else { return }
        engine.inputNode.removeTap(onBus: 0)
        tapInstalled = false
        engine.stop()
        converter = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private nonisolated static func convert(
        buffer: AVAudioPCMBuffer,
        using converter: AVAudioConverter,
        to format: AVAudioFormat
    ) -> Data? {
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1_024
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }

        var consumed = false
        var conversionError: NSError?
        converter.convert(to: output, error: &conversionError) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard conversionError == nil, output.frameLength > 0, let channel = output.int16ChannelData else { return nil }
        return Data(bytes: channel[0], count: Int(output.frameLength) * MemoryLayout<Int16>.size)
    }

    /// RMS mapped through a decibel curve, because linear amplitude spends almost
    /// all of its range on the loudest tenth and a linear rule looks dead at
    /// conversational volume.
    private nonisolated static func loudness(of pcm: Data) -> Double {
        let count = pcm.count / MemoryLayout<Int16>.size
        guard count > 0 else { return 0 }
        let sumSquares = pcm.withUnsafeBytes { raw -> Double in
            let samples = raw.bindMemory(to: Int16.self)
            return samples.reduce(into: 0.0) { total, sample in
                let normalized = Double(sample) / Double(Int16.max)
                total += normalized * normalized
            }
        }
        let rms = (sumSquares / Double(count)).squareRoot()
        guard rms > 0 else { return 0 }
        let decibels = 20 * log10(rms)
        return min(1, max(0, (decibels + 50) / 50))
    }

    // MARK: - Socket

    private func openSocket() throws {
        var request = URLRequest(url: endpoint)
        request.setValue(sharedSecret, forHTTPHeaderField: "x-relay-stt-key")
        let task = session.webSocketTask(with: request)
        socket = task
        socketGeneration = UUID()
        task.resume()
        receiveNext(generation: socketGeneration)
    }

    private func closeSocket() {
        socketGeneration = UUID()
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
    }

    private func sendAudio(_ pcm: Data) {
        guard let socket, phase == .listening else { return }
        guard let message = try? Self.audioMessage(pcm) else { return }
        socket.send(message) { _ in }
    }

    private static func audioMessage(_ pcm: Data) throws -> URLSessionWebSocketTask.Message {
        let frame: [String: Any] = [
            "audio": [
                "data": pcm.base64EncodedString(),
                "sample_rate": "16000",
                "encoding": "audio/wav",
            ]
        ]
        let payload = try JSONSerialization.data(withJSONObject: frame)
        return .string(String(decoding: payload, as: UTF8.self))
    }

    private func receiveNext(generation: UUID) {
        guard generation == socketGeneration else { return }
        socket?.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.socketGeneration == generation else { return }
                switch result {
                case .success(let message):
                    self.handle(message)
                    self.receiveNext(generation: generation)
                case .failure:
                    // A closed socket during finalize is the ordinary end of a session,
                    // not an error worth showing over the words the user just spoke.
                    if self.phase == .listening || self.externalAudio {
                        self.phase = .failed("Dictation stopped unexpectedly.")
                    }
                    self.stopEngine()
                    self.stopTicking()
                    self.resumeFinal(with: self.transcript)
                    self.closeSocket()
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        guard case .string(let raw) = message,
              let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String
        else { return }

        switch type {
        case "partial":
            if let text = object["text"] as? String { transcript = text }
        case "segment":
            if let text = object["text"] as? String, !text.isEmpty {
                segments.append(text)
                transcript = segments.joined(separator: " ")
            }
        case "final":
            let text = (object["text"] as? String) ?? transcript
            transcript = text
            resumeFinal(with: text)
        case "error":
            let message = (object["message"] as? String) ?? "Dictation failed."
            phase = .failed(message)
            stopEngine()
            stopTicking()
            resumeFinal(with: transcript)
            closeSocket()
        default:
            break
        }
    }

    // MARK: - Timing

    private func startTicking() {
        ticker?.invalidate()
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let startedAt = self.startedAt else { return }
                self.elapsed = Date().timeIntervalSince(startedAt)
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        ticker = timer
    }

    private func stopTicking() {
        ticker?.invalidate()
        ticker = nil
    }

    private static func requestMicrophonePermission() async -> Bool {
        if #available(iOS 17.0, *) {
            if AVAudioApplication.shared.recordPermission == .granted { return true }
            return await AVAudioApplication.requestRecordPermission()
        }
        let session = AVAudioSession.sharedInstance()
        if session.recordPermission == .granted { return true }
        return await withCheckedContinuation { continuation in
            session.requestRecordPermission { continuation.resume(returning: $0) }
        }
    }
}

extension RelayStreamingTranscriber {
    /// `m:ss`, monospaced by the caller. Liveness in this UI is a ticking duration,
    /// never a coloured dot (design spec rule 5).
    nonisolated static func durationLabel(_ interval: TimeInterval) -> String {
        let total = max(0, Int(interval))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
