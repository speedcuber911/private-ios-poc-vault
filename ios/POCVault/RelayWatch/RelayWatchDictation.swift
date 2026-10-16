import AVFoundation
import Combine
import Foundation

/// Capture only while requested. One half-second batch is in flight at a time;
/// a slow phone cannot grow the queue beyond four seconds of audio.
@MainActor
final class RelayWatchDictation: ObservableObject {
    enum Phase { case idle, connecting, recording, finishing }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var transcript = ""
    @Published private(set) var errorMessage: String?
    @Published private(set) var elapsedSeconds = 0
    @Published private(set) var level: Double = 0
    var isActive: Bool { phase != .idle }

    private let engine = AVAudioEngine()
    private var tapInstalled = false
    private var audioSessionActive = false
    private var generation = UUID()
    private var sessionID: String?
    private var sourceID = ""
    private weak var store: RelayWatchStore?
    private var buffered = Data()
    private var capturedBytes = 0
    private var sequence = 0
    private var pump: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var interruption: AnyCancellable?

    init() {
        interruption = NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)
            .sink { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.isActive else { return }
                    self.fail("Recording was interrupted. Review the text received so far.")
                }
            }
    }

    func start(store: RelayWatchStore, sourceID: String) async {
        guard !isActive else { return }
        self.store = store
        self.sourceID = sourceID
        generation = UUID()
        let token = generation
        let id = UUID().uuidString
        sessionID = id
        transcript = ""
        errorMessage = nil
        elapsedSeconds = 0
        capturedBytes = 0
        sequence = 0
        buffered = Data()
        phase = .connecting
        let allowed = await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard generation == token else { return }
        guard allowed else { fail("Allow microphone access for Relay in your watch settings."); return }
        do {
            let reply = try await store.dictate(RelayWatchDictationRequest(sessionID: id, sourceID: sourceID, kind: .begin))
            guard generation == token else { return }
            if let error = reply.error { throw RelayWatchError(error) }
            guard !reply.finished, reply.nextSequence == 0 else { throw RelayWatchError("Dictation could not start. Please try again.") }
            phase = .recording
            try startCapture(token: token)
            deadline = Task { @MainActor [weak self] in
                do { try await Task.sleep(nanoseconds: UInt64(RelayWatchDictationWire.maximumSeconds) * 1_000_000_000) }
                catch { return }
                guard self?.generation == token else { return }
                self?.stop()
            }
        } catch {
            guard generation == token else { return }
            fail(error.localizedDescription)
        }
    }

    func stop() {
        guard phase == .recording else { return }
        stopCapture()
        phase = .finishing
        startPump()
    }

    func cancel(discard: Bool = true) {
        let id = sessionID
        let source = sourceID
        let connection = store
        clearSession()
        errorMessage = nil
        if discard { transcript = "" }
        if let id, let connection {
            Task { _ = try? await connection.dictate(RelayWatchDictationRequest(sessionID: id, sourceID: source, kind: .cancel)) }
        }
    }

    private func fail(_ message: String) {
        cancel(discard: false)
        errorMessage = message
    }

    private func clearSession() {
        stopCapture()
        generation = UUID()
        sessionID = nil
        pump?.cancel()
        pump = nil
        buffered = Data()
        phase = .idle
    }

    private func startCapture(token: UUID) throws {
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.record, mode: .default, options: [])
        try audio.setActive(true)
        audioSessionActive = true
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0,
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: format, to: target) else {
            throw RelayWatchError("The watch microphone could not start.")
        }
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 4), format: format) { [weak self] buffer, _ in
            guard let pcm = Self.convert(buffer, converter: converter, target: target) else {
                Task { @MainActor in
                    guard self?.generation == token else { return }
                    self?.fail("The microphone audio could not be read. Please try again.")
                }
                return
            }
            Task { @MainActor in
                guard let self, self.generation == token, self.phase == .recording else { return }
                self.accept(pcm)
            }
        }
        tapInstalled = true
        engine.prepare()
        try engine.start()
    }

    private func stopCapture() {
        deadline?.cancel()
        deadline = nil
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        engine.stop()
        if audioSessionActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
            audioSessionActive = false
        }
        level = 0
    }

    private func accept(_ pcm: Data) {
        let remaining = RelayWatchDictationWire.bytesPerSecond * RelayWatchDictationWire.maximumSeconds - capturedBytes
        let chunk = Data(pcm.prefix(max(0, remaining)))
        guard buffered.count + chunk.count <= RelayWatchDictationWire.maximumBufferedBytes else {
            fail("iPhone could not keep up. Review your text, then try a shorter recording.")
            return
        }
        buffered.append(chunk)
        capturedBytes += chunk.count
        elapsedSeconds = capturedBytes / RelayWatchDictationWire.bytesPerSecond
        level = chunk.withUnsafeBytes { raw -> Double in
            let samples = raw.bindMemory(to: Int16.self)
            guard !samples.isEmpty else { return 0 }
            let square = samples.reduce(0.0) { $0 + pow(Double($1) / Double(Int16.max), 2) } / Double(samples.count)
            return min(1, max(0, (20 * log10(max(square.squareRoot(), 0.00001)) + 50) / 50))
        }
        if remaining <= chunk.count { stop() }
        else { startPump() }
    }

    private func startPump() {
        guard pump == nil, let id = sessionID, let store else { return }
        let token = generation
        pump = Task { @MainActor in
            defer { if self.generation == token { self.pump = nil } }
            do {
                while self.generation == token, !Task.isCancelled {
                    if self.buffered.count >= RelayWatchDictationWire.chunkBytes || (self.phase == .finishing && !self.buffered.isEmpty) {
                        let count = min(self.buffered.count, RelayWatchDictationWire.chunkBytes)
                        let chunk = Data(self.buffered.prefix(count))
                        self.buffered.removeFirst(count)
                        let request = RelayWatchDictationRequest(sessionID: id, sourceID: self.sourceID,
                            kind: .audio, sequence: self.sequence, audio: chunk)
                        let reply = try await store.dictate(request)
                        guard self.generation == token else { return }
                        self.transcript = reply.transcript
                        if let error = reply.error { throw RelayWatchError(error) }
                        guard !reply.finished, reply.nextSequence == self.sequence + 1 else {
                            throw RelayWatchError("Dictation stopped before all audio arrived. Review your text.")
                        }
                        self.sequence += 1
                    } else if self.phase == .finishing {
                        let reply = try await store.dictate(RelayWatchDictationRequest(sessionID: id, sourceID: self.sourceID,
                            kind: .finish, sequence: self.sequence))
                        guard self.generation == token else { return }
                        self.transcript = reply.transcript
                        if let error = reply.error { throw RelayWatchError(error) }
                        guard reply.finished else { throw RelayWatchError("Dictation could not finish. Review your text.") }
                        self.clearSession()
                        if self.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            self.errorMessage = "No speech was received. Try again."
                        }
                        return
                    } else { return }
                }
            } catch {
                guard self.generation == token else { return }
                self.fail(error.localizedDescription)
            }
        }
    }

    private nonisolated static func convert(_ buffer: AVAudioPCMBuffer, converter: AVAudioConverter, target: AVAudioFormat) -> Data? {
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate) + 1_024
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
        var consumed = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, output.frameLength > 0, let channel = output.int16ChannelData else { return nil }
        return Data(bytes: channel[0], count: Int(output.frameLength) * 2)
    }
}
